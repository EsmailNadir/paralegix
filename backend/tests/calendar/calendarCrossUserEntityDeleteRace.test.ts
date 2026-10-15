/**
 * Does the inbound delete branch of `providerSyncEngine.ts`'s
 * `processInboundDelete` race with an inbound update, or with another member's
 * delete, on the SAME shared matter event?
 *
 * Removing a shared event from one member's calendar UNLINKS that member's copy:
 * it drops their entry from the event's per-user `calendar_sync` map and their
 * `calendar_mappings` row, and never cancels the event for the firm. So the
 * delete branch writes only `calendar_sync` (one key path, removed in SQL) and
 * the mapping table, while the update branch writes `title` / `notes` / `date`
 * and the provider stamps. Those are disjoint, and two deletes remove two
 * different key paths from the same jsonb value.
 *
 * Both tests below hold the two callers at `matterEventsRepo.findById` (the
 * read each branch starts with) until both are there, so they provably read
 * the same snapshot before either writes, then check that every effect landed:
 *
 *  1. A Google delete by one member and an Outlook edit by another.
 *  2. Two deletes, one from each provider, by two members: both copies are
 *     unlinked, which would lose one if either delete rewrote the whole map
 *     from the snapshot it read.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
} from './support/googleFetch';

installGoogleFetchWall();

import {
  testPool,
  createFirm,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';
import { connectGoogle, connectMicrosoft, seedMapping, seedMatterWithEvent } from './support/calendarWorld';
import { gateMethod } from '../support/gate';

const googleService = require('../../src/modules/calendar/google/google.service');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');
const matterEventsRepo = require('../../src/modules/matters/matterEvents.repository');

const DELTA = 'syncToken=';

const SOME_MODIFIED = '2030-06-01T00:00:00.000Z';

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

// ── fixtures (mirrors calendarCrossUserEntityRace.test.ts) ──────────────────

const matterEventRow = async (eventId: string) => (await testPool.query(
  `select title, status, calendar_sync, outlook_last_modified, google_last_modified from events where id = $1`,
  [eventId],
)).rows[0];

function googleCancelledEvent(id: string) {
  // A real Google delta cancellation carries only the id and a 'cancelled'
  // status - the rest of the event body is omitted by the API, and
  // `googleStrategy.isGoneForUser` never looks past `status` for this shape.
  return { id, status: 'cancelled' };
}

function outlookEvent(id: string, subject: string, lastModifiedIso: string) {
  return {
    id,
    subject,
    isAllDay: false,
    start: { dateTime: '2026-09-11T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-11T16:00:00.0000000', timeZone: 'UTC' },
    lastModifiedDateTime: lastModifiedIso,
  };
}

// ── the race ─────────────────────────────────────────────────────────────

const mappingProviders = async (eventId: string) => (await testPool.query(
  `select provider from calendar_mappings where entity_id = $1 order by provider`, [eventId],
)).rows.map((r: any) => r.provider);

/**
 * Lets the Outlook member edit the matter's events: `matters.update` on their
 * role and a seat on the matter. An inbound edit to a matter event is written
 * only for a member who may make it in Paralegix.
 */
async function allowMatterEdits(uid: string, matterId: string) {
  const role = await testPool.query(
    `update roles set permissions = array_append(permissions, 'matters.update')
      where id = (select role_id from members where law_firm_id = $1 and user_id = $2)`,
    [firm.id, uid],
  );
  expect(role.rowCount).toBe(1);
  const seat = await testPool.query(
    'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)', [firm.id, matterId, uid],
  );
  expect(seat.rowCount).toBe(1);
}

describe('cross-user, cross-provider race on the inbound delete branch', () => {
  test('a concurrent delete (Google) and update (Outlook) both land intact, and the event stays active', async () => {
    const uidGoogle = await connectGoogle(firm);
    const uidOutlook = await connectMicrosoft(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing', {
      google: { [uidGoogle]: { event: { eventId: 'g-del-shared' } } },
      outlook: { [uidOutlook]: { event: { eventId: 'o-del-shared' } } },
    });
    await allowMatterEdits(uidOutlook, matterId);
    await seedMapping({
      provider: 'google', externalEventId: 'g-del-shared', lawFirmId: firm.id, userId: uidGoogle, entityId: eventId, scopeId: matterId,
    });
    await seedMapping({
      provider: 'outlook', externalEventId: 'o-del-shared', lawFirmId: firm.id, userId: uidOutlook, entityId: eventId, scopeId: matterId,
    });

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after-delete',
        items: [googleCancelledEvent('g-del-shared')],
      },
    });
    route('/me/events/o-del-shared', {
      status: 200,
      json: outlookEvent('o-del-shared', 'Amended via Outlook while Google deletes', SOME_MODIFIED),
    }, { method: 'GET' });

    const gate = gateMethod(matterEventsRepo, 'findById');
    try {
      const workerDelete = googleService.processWatchNotification({ userId: uidGoogle, lawFirmId: firm.id });
      const workerUpdate = outlookService.processSubscriptionNotification({
        userId: uidOutlook,
        lawFirmId: firm.id,
        changeType: 'updated',
        resource: 'me/events/o-del-shared',
        resourceData: { id: 'o-del-shared' },
      });

      // PROOF, not hope: both have reached the read they start from.
      await gate.arrived(2);
      expect(gate.waiting()).toBe(2);

      gate.open();
      await Promise.all([workerDelete, workerUpdate]);
    } finally {
      gate.restore();
    }

    expect(callsMatching(DELTA)).toHaveLength(1);
    expect(callsMatching('/me/events/o-del-shared')).toHaveLength(1);

    const row = await matterEventRow(eventId);
    // The delete unlinked only the Google member's copy:
    expect(row.status).not.toBe('cancelled');
    expect(row.calendar_sync.google[uidGoogle]?.event).toBeUndefined();
    expect(row.calendar_sync.outlook[uidOutlook].event.eventId).toBe('o-del-shared');
    expect(await mappingProviders(eventId)).toEqual(['outlook']);
    // ...and the Outlook edit landed beside it.
    expect(row.title).toBe('Amended via Outlook while Google deletes');
    expect(new Date(row.outlook_last_modified).toISOString()).toBe(SOME_MODIFIED);
  });

  test('two simultaneous deletes by two members unlink both copies and leave the event active', async () => {
    const uidGoogle = await connectGoogle(firm);
    const uidOutlook = await connectMicrosoft(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing', {
      google: { [uidGoogle]: { event: { eventId: 'g-del-both' } } },
      outlook: { [uidOutlook]: { event: { eventId: 'o-del-both' } } },
    });
    await allowMatterEdits(uidOutlook, matterId);
    await seedMapping({
      provider: 'google', externalEventId: 'g-del-both', lawFirmId: firm.id, userId: uidGoogle, entityId: eventId, scopeId: matterId,
    });
    await seedMapping({
      provider: 'outlook', externalEventId: 'o-del-both', lawFirmId: firm.id, userId: uidOutlook, entityId: eventId, scopeId: matterId,
    });

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after-both-delete',
        items: [googleCancelledEvent('g-del-both')],
      },
    });

    const gate = gateMethod(matterEventsRepo, 'findById');
    try {
      const workerGoogleDelete = googleService.processWatchNotification({ userId: uidGoogle, lawFirmId: firm.id });
      const workerOutlookDelete = outlookService.processSubscriptionNotification({
        userId: uidOutlook,
        lawFirmId: firm.id,
        changeType: 'deleted',
        resource: 'me/events/o-del-both',
        resourceData: { id: 'o-del-both' },
      });

      await gate.arrived(2);
      expect(gate.waiting()).toBe(2);

      gate.open();
      await Promise.all([workerGoogleDelete, workerOutlookDelete]);
    } finally {
      gate.restore();
    }

    expect(callsMatching(DELTA)).toHaveLength(1);

    const row = await matterEventRow(eventId);
    expect(row.status).not.toBe('cancelled');
    expect(row.title).toBe('Original hearing');
    expect(row.calendar_sync.google[uidGoogle]?.event).toBeUndefined();
    expect(row.calendar_sync.outlook[uidOutlook]?.event).toBeUndefined();
    expect(await mappingProviders(eventId)).toEqual([]);
  });
});

export {};
