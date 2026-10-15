/**
 * B07.1: two DIFFERENT users' independent Google/Outlook connections, both
 * syncing their own copy of the SAME shared matter/client event, racing on a
 * plain read-then-write.
 *
 * Documented (not fixed) in an earlier tick on `calendarUpdateReplay.test.ts`:
 * `CALENDAR_WEBHOOK`'s advisory lock is keyed by the calling user, and the
 * outbound `CALENDAR_SYNC` lock by `entityType:entityId:userId` - neither
 * serializes two DIFFERENT users touching the same matterEvent/clientEvent,
 * and Outlook's inbound path (`processSubscriptionNotification`) carries no
 * lock at all. Two independent inbound streams can both read the entity
 * before either writes it, both pass their own `siblingOrParalegixIsNewer`
 * check against that stale snapshot, and whichever write lands second in
 * Postgres wins the shared `title`/`notes` fields - regardless of which
 * provider's edit is actually newer.
 *
 * This file pins the fix: `providerSyncEngine.ts`'s mapped-entity branch now
 * runs under a `CALENDAR_ENTITY` advisory lock keyed by `entityType:entityId`
 * alone (no user, no provider), with a FRESH re-read of the entity taken
 * INSIDE the lock rather than reusing the snapshot resolved before it was
 * acquired. That re-read is what lets the pre-existing sibling-newer-
 * timestamp rule (`siblingOrParalegixIsNewer`, unchanged) actually see a
 * sibling's just-committed write instead of racing past it.
 *
 * Two tests:
 *  - a CHARACTERIZATION test that proves the danger this closes. It disables
 *    just the new `CALENDAR_ENTITY` lock (by replacing `advisoryLock.withLock`
 *    for the duration of the test) and drives the exact race through the
 *    real Google/Outlook services, deterministically, using `gate.ts` to hold
 *    both inbound calls at the moment they have each ALREADY decided to
 *    write off a stale read. It stays meaningful forever: it proves what
 *    happens with nothing serializing the two streams, independent of
 *    whether the lock exists elsewhere in the file.
 *  - a fix-verification test with no monkeypatching and no gate, just two
 *    real concurrent calls through `Promise.all`, relying on the real
 *    Postgres advisory lock to serialize them. The assertion does not assume
 *    a particular acquisition order (a real `pg_advisory_xact_lock` race
 *    between two independent connections is not something a test should
 *    pretend to control): whichever caller runs first, the second one's
 *    fresh re-read sees it, so the genuinely newer edit always survives.
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
const advisoryLock = require('../../src/shared/database/advisoryLock');

const DELTA = 'syncToken=';

/** Two fixed instants, comfortably apart and comfortably newer than any
 * fixture row's `updated_at`, mirroring `calendarUpdateReplay.test.ts`'s
 * convention so the ONLY thing that can reject an update is the
 * cross-provider `*_last_modified` comparison, never the generic wall-clock
 * fallback against `updatedAt`. */
const OLDER = '2030-01-01T00:00:00.000Z';
const NEWER = '2030-06-01T00:00:00.000Z';

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

// ── fixtures ─────────────────────────────────────────────────────────────

const matterEventRow = async (eventId: string) => (await testPool.query(
  `select title, outlook_last_modified, google_last_modified from events where id = $1`,
  [eventId],
)).rows[0];

function googleEvent(id: string, summary: string, updatedIso: string) {
  return {
    id,
    summary,
    status: 'confirmed',
    updated: updatedIso,
    start: { dateTime: '2026-09-11T15:00:00Z' },
    end: { dateTime: '2026-09-11T16:00:00Z' },
  };
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

describe('cross-user, cross-provider race on one shared matter event', () => {
  test('CHARACTERIZATION: without the CALENDAR_ENTITY lock, a genuinely older Outlook edit silently clobbers a newer Google one', async () => {
    const uidGoogle = await connectGoogle(firm);
    const uidOutlook = await connectMicrosoft(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing');
    await allowMatterEdits(uidOutlook, matterId);
    await seedMapping({
      provider: 'google', externalEventId: 'g-shared', lawFirmId: firm.id, userId: uidGoogle, entityId: eventId, scopeId: matterId,
    });
    await seedMapping({
      provider: 'outlook', externalEventId: 'o-shared', lawFirmId: firm.id, userId: uidOutlook, entityId: eventId, scopeId: matterId,
    });

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [googleEvent('g-shared', 'Amended via Google, genuinely newer', NEWER)],
      },
    });
    route('/me/events/o-shared', {
      status: 200,
      json: outlookEvent('o-shared', 'Amended via Outlook, actually older', OLDER),
    }, { method: 'GET' });

    // Simulate the world this fix closes: nothing serializes two different
    // users' inbound streams touching the same shared entity. This is the
    // ONLY lock this scenario would ever reach (Google's own CALENDAR_WEBHOOK
    // lock is keyed by uidGoogle alone and Outlook's inbound path takes no
    // lock at all), so disabling `withLock` here is equivalent to the
    // CALENDAR_ENTITY lock never having been added.
    const realWithLock = advisoryLock.withLock;
    advisoryLock.withLock = (_domain: string, _key: string, fn: (...a: any[]) => any) => fn();

    const gate = gateMethod(matterEventsRepo, 'applyInboundUpdate');
    try {
      const workerA = googleService.processWatchNotification({ userId: uidGoogle, lawFirmId: firm.id });
      await gate.arrived(1);

      const workerB = outlookService.processSubscriptionNotification({
        userId: uidOutlook,
        lawFirmId: firm.id,
        changeType: 'updated',
        resource: 'me/events/o-shared',
        resourceData: { id: 'o-shared' },
      });
      // PROOF, not hope: both inbound streams are paused at the point where
      // they have ALREADY decided what to write, off a read taken before
      // either committed anything. Neither has seen the other's edit.
      await gate.arrived(2);

      // Let Google's (genuinely newer) write land first...
      gate.openOne();
      await workerA;
      // ...then Outlook's (genuinely older) write, decided from the same
      // stale pre-race snapshot, lands second and unconditionally overwrites
      // the shared `title` column - `applyInboundUpdate` never re-checks
      // anything at write time, the decision was already made.
      gate.openOne();
      await workerB;
    } finally {
      gate.restore();
      advisoryLock.withLock = realWithLock;
    }

    // Both network calls really happened; a no-op guard can't be mistaken
    // for a path that never fired.
    expect(callsMatching(DELTA)).toHaveLength(1);
    expect(callsMatching('/me/events/o-shared')).toHaveLength(1);

    const row = await matterEventRow(eventId);
    // The bug: Outlook's edit is OLDER than Google's, yet it wins the title,
    // because Outlook's decision was made before Google's write committed.
    expect(row.title).toBe('Amended via Outlook, actually older');
    // Each provider's own stamp still lands correctly (different columns),
    // which is exactly what makes the result internally inconsistent: this
    // row claims a google_last_modified newer than its own title reflects.
    expect(new Date(row.google_last_modified).toISOString()).toBe(NEWER);
    expect(new Date(row.outlook_last_modified).toISOString()).toBe(OLDER);
  });

  test('THE FIX: the CALENDAR_ENTITY lock makes the genuinely newer edit survive regardless of acquisition order', async () => {
    const uidGoogle = await connectGoogle(firm);
    const uidOutlook = await connectMicrosoft(firm);
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Original hearing');
    await allowMatterEdits(uidOutlook, matterId);
    await seedMapping({
      provider: 'google', externalEventId: 'g-shared-2', lawFirmId: firm.id, userId: uidGoogle, entityId: eventId, scopeId: matterId,
    });
    await seedMapping({
      provider: 'outlook', externalEventId: 'o-shared-2', lawFirmId: firm.id, userId: uidOutlook, entityId: eventId, scopeId: matterId,
    });

    route(DELTA, {
      status: 200,
      json: {
        nextSyncToken: 'token-after-2',
        items: [googleEvent('g-shared-2', 'Amended via Google, genuinely newer', NEWER)],
      },
    });
    route('/me/events/o-shared-2', {
      status: 200,
      json: outlookEvent('o-shared-2', 'Amended via Outlook, actually older', OLDER),
    }, { method: 'GET' });

    // PROOF, not hope, in both directions:
    //  - `readGate` (on the mapping-resolution read, which happens BEFORE
    //    either caller could attempt the entity lock) proves the two inbound
    //    streams genuinely overlap at the same point they did in the
    //    characterization test above - this isn't a different, easier race.
    //  - `writeGate` (on the write, now reached only from INSIDE the
    //    CALENDAR_ENTITY lock) then proves the fix actually serializes them:
    //    once one caller is paused there, the other is provably NOT also
    //    there, because it is blocked in Postgres on the same advisory lock
    //    key, not queued behind this JS-level gate.
    const readGate = gateMethod(matterEventsRepo, 'findById');
    const writeGate = gateMethod(matterEventsRepo, 'applyInboundUpdate');
    try {
      const workerA = googleService.processWatchNotification({ userId: uidGoogle, lawFirmId: firm.id });
      await readGate.arrived(1);

      const workerB = outlookService.processSubscriptionNotification({
        userId: uidOutlook,
        lawFirmId: firm.id,
        changeType: 'updated',
        resource: 'me/events/o-shared-2',
        resourceData: { id: 'o-shared-2' },
      });
      await readGate.arrived(2);
      readGate.open();

      // Exactly one of the two reaches the write gate...
      await writeGate.arrived(1);
      expect(writeGate.waiting()).toBe(1);
      // ...and the other one does NOT join it, however long we wait: it is
      // parked on the real `pg_advisory_xact_lock` for this entity, held by
      // whichever caller is paused here. This is the assertion that goes red
      // without the fix: reverting the CALENDAR_ENTITY lock lets BOTH callers
      // reach this same write gate together, exactly like the
      // characterization test above.
      await expect(writeGate.arrived(2, 750)).rejects.toThrow();

      writeGate.open();
      await Promise.all([workerA, workerB]);
    } finally {
      readGate.restore();
      writeGate.restore();
    }

    expect(callsMatching(DELTA)).toHaveLength(1);
    expect(callsMatching('/me/events/o-shared-2')).toHaveLength(1);

    const row = await matterEventRow(eventId);
    // Whichever caller wins the entity lock first, the other one's fresh
    // re-read (taken INSIDE the lock) sees that commit, so
    // `siblingOrParalegixIsNewer` correctly compares real state instead of a
    // stale snapshot. The genuinely newer Google edit survives either way.
    expect(row.title).toBe('Amended via Google, genuinely newer');
    expect(new Date(row.google_last_modified).toISOString()).toBe(NEWER);
    // outlook_last_modified depends on acquisition order and both outcomes
    // are correct: null if Google ran first (Outlook's update was then
    // rejected outright by the freshness guard), or OLDER if Outlook ran
    // first and was simply superseded by Google's later, genuinely newer
    // write. Either way the title above is what actually proves the fix;
    // this only rules out Outlook's edit having silently won.
    if (row.outlook_last_modified !== null) {
      expect(new Date(row.outlook_last_modified).toISOString()).toBe(OLDER);
    }
  });
});

export {};
