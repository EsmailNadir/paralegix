/**
 * What a member changes on a Paralegix item in their own Google or Outlook
 * calendar has to come back into Paralegix as exactly that change: no more,
 * no less, and only when that member may make it.
 *
 * Every case drives the real inbound path (`processWatchNotification` for
 * Google, `processSubscriptionNotification` for Outlook) and reads the result
 * back from Postgres. The defects pinned here:
 *
 *   A PUSHED EVENT MADE RECURRING. The series path removed the "parent
 *   imported the old way" unconditionally, so a Paralegix event the member
 *   turned into a series was unlinked and its copy on the other calendar was
 *   deleted.
 *
 *   A FIELD CLEARED IN GOOGLE. Google omits an empty field from the event
 *   resource, so a cleared location or description never reached Paralegix.
 *
 *   LOCATION PRECEDENCE. Outbound pushes `location` first, inbound wrote
 *   `location_name`, so the provider edit was overwritten on the next push and
 *   a court name was copied into `location_name`.
 *
 *   THE STALE GUARD AND OUTBOUND PUSHES. Every push bumps `updated_at`, so a
 *   genuine edit made before some push to another member was skipped.
 *
 *   A SYNC GAP. After a 410 the full listing removed only imported rows, so a
 *   Paralegix item deleted in the provider during the gap stayed linked.
 *
 *   THE FOOTER DELETED IN THE PROVIDER. Without the marker the header sections
 *   stayed in the text and were written into the notes.
 *
 *   A VIEW-ONLY MEMBER. The inbound write ignored the member's write access.
 *
 *   ONE MEMBER'S ZONE. A member's edit replaced the shared row's time zone.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';
import { describeNetworkWall } from './support/calendarWorld';

const googleService = require('../../src/modules/calendar/google/google.service');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');

/** Newer than any fixture row's `updated_at`, so an inbound edit is not stale. */
const FUTURE = '2030-01-01T00:00:00.000Z';
const DELTA = 'syncToken=';
const FULL_SYNC = 'singleEvents=true';
const INIT_TOKEN = 'maxResults=2500&showDeleted=true';

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

describeNetworkWall();

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function connectGoogle(uid: string, syncToken = 'token-live') {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, is_sync_from_provider, sync_cursor)
     values ($1, 'google', $2, 'refresh-seed', true, true, $3)`,
    [uid, `g-${randomUUID().slice(0, 8)}`, syncToken],
  );
  expect(tokens.rowCount).toBe(1);
}

async function connectMicrosoft(uid: string) {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens
       (user_id, provider, access_token, refresh_token, meta, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', $2, 'ms-refresh-seed', $3::jsonb, true, true)`,
    [uid, `ms-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ outlookTimezone: 'UTC', outlookMailboxTimezoneWritable: true })],
  );
  expect(tokens.rowCount).toBe(1);
}

async function seedMatter() {
  const matterId = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Bell v. Ward', $3)`,
    [matterId, firm.id, `M-${matterId.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return matterId;
}

async function seedMatterEvent(opts: {
  createdBy: string;
  calendarSync: object;
  matterId?: string;
  title?: string;
  date?: string;
  notes?: string | null;
  location?: string | null;
  locationName?: string | null;
  timeZone?: string | null;
}) {
  const matterId = opts.matterId ?? await seedMatter();
  const eventId = randomUUID();
  const res = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, type, title, date, notes, location, location_name,
       time_zone, created_by, calendar_sync)
     values ($1, $2, $3, 'hearing', $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [eventId, firm.id, matterId, opts.title ?? 'Motion hearing', opts.date ?? '2026-09-10T14:00:00Z',
      opts.notes ?? null, opts.location ?? null, opts.locationName ?? null, opts.timeZone ?? null,
      opts.createdBy, JSON.stringify(opts.calendarSync)],
  );
  expect(res.rowCount).toBe(1);
  return { matterId, eventId };
}

async function seedMapping(opts: {
  provider: 'google' | 'outlook';
  externalEventId: string;
  userId: string;
  entityType: 'task' | 'matterEvent' | 'clientEvent';
  entityId: string;
  scopeId?: string | null;
  itemKey: string;
  pushedModifiedAt?: string | null;
}) {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, scope_id, item_key,
        pushed_modified_at)
     values ($1, $2, 'primary', $3, $4, $5, $6, $7, $8, $9)`,
    [opts.provider, opts.externalEventId, opts.userId, firm.id, opts.entityType, opts.entityId,
      opts.scopeId ?? null, opts.itemKey, opts.pushedModifiedAt ?? null],
  );
  expect(res.rowCount).toBe(1);
}

/** One Google delta page carrying `items`, answered to the stored token. */
function googleDelta(items: object[]) {
  route(DELTA, { status: 200, json: { nextSyncToken: 'token-after', items } });
}

async function eventRow(eventId: string) {
  const { rows } = await testPool.query(
    `select title, notes, location, location_name, time_zone, calendar_sync from events where id = $1`, [eventId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function mappingIds(entityId: string) {
  const { rows } = await testPool.query(
    `select external_event_id from calendar_mappings where entity_id = $1 order by 1`, [entityId],
  );
  return rows.map((r) => r.external_event_id);
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── 1. a pushed event made recurring in the provider ────────────────────────

describe('a Paralegix event the member makes recurring in their calendar', () => {
  /**
   * The member's Google copy of a hearing becomes a weekly series. Its
   * occurrences carry the Paralegix marker and are skipped; the series id is
   * the copy Paralegix pushed, which `calendar_mappings` holds.
   *
   * Goes red if the series path still runs the parent through the delete path
   * regardless of what the id names: the mapping and the per-user link go, and
   * the member's Outlook copy is deleted.
   */
  test('Google: keeps the item linked and leaves the Outlook copy alone', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid,
      calendarSync: {
        google: { [owner.uid]: { event: { eventId: 'g-hearing' } } },
        outlook: { [owner.uid]: { event: { eventId: 'AAMk-hearing', changeKey: 'CK-1' } } },
      },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    await seedMapping({ provider: 'outlook', externalEventId: 'AAMk-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    const marker = 'Hearing: Motion hearing\n\n(Matter event from Paralegix)';
    googleDelta([{
      id: 'g-hearing', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE, description: marker,
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);
    route('/events/g-hearing/instances', {
      status: 200,
      json: { items: [{
        id: 'g-hearing_20260917T140000Z', recurringEventId: 'g-hearing', summary: 'Motion hearing', status: 'confirmed',
        updated: FUTURE, description: marker,
        start: { dateTime: '2026-09-17T14:00:00Z' }, end: { dateTime: '2026-09-17T15:00:00Z' },
      }] },
    });
    route('/me/events/AAMk-hearing', { status: 204 }, { method: 'DELETE' });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    // The series was read, so the removal step was reached.
    expect(callsMatching('/events/g-hearing/instances')).toHaveLength(1);
    expect(callsMatching('/me/events/AAMk-hearing')).toEqual([]);
    expect(await mappingIds(eventId)).toEqual(['AAMk-hearing', 'g-hearing']);
    const row = await eventRow(eventId);
    expect(row.calendar_sync.google[owner.uid].event.eventId).toBe('g-hearing');
  });

  /**
   * The same on Outlook: the series master is the copy Paralegix pushed.
   * Goes red if `syncOutlookSeries` still deletes through the mapping branch,
   * which removes the Google copy.
   */
  test('Outlook: keeps the item linked and leaves the Google copy alone', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid,
      calendarSync: {
        google: { [owner.uid]: { event: { eventId: 'g-hearing' } } },
        outlook: { [owner.uid]: { event: { eventId: 'AAMk-hearing', changeKey: 'CK-1' } } },
      },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    await seedMapping({ provider: 'outlook', externalEventId: 'AAMk-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    route('/me/events/AAMk-hearing/instances', { status: 200, json: { value: [] } });
    route('/me/events/AAMk-hearing', {
      status: 200,
      json: {
        id: 'AAMk-hearing', type: 'seriesMaster', subject: 'Motion hearing', isAllDay: false, isCancelled: false,
        lastModifiedDateTime: FUTURE, changeKey: 'CK-2',
        start: { dateTime: '2026-09-10T14:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-10T15:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });
    route('/events/g-hearing', { status: 204 }, { method: 'DELETE' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'updated',
      resource: 'me/events/AAMk-hearing', resourceData: { id: 'AAMk-hearing' },
    });

    expect(callsMatching('/me/events/AAMk-hearing/instances')).toHaveLength(1);
    expect(callsMatching('/events/g-hearing')).toEqual([]);
    expect(await mappingIds(eventId)).toEqual(['AAMk-hearing', 'g-hearing']);
  });

  /**
   * The case the removal exists for: a series the member's own calendar holds,
   * imported once as a single event before series were read as occurrences.
   * Goes red if the guard above stops removing a parent that really was
   * imported.
   */
  test('Google: still removes a series parent imported as one event', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const rowId = randomUUID();
    const seeded = await testPool.query(
      `insert into calendar_events (id, law_firm_id, title, starts_at, ends_at, provider, source,
         external_event_id, google_event_id, created_by)
       values ($1, $2, 'Weekly standup', '2026-09-10T14:00:00Z', '2026-09-10T14:30:00Z',
         'google', 'external', 'g-weekly', 'g-weekly', $3)`,
      [rowId, firm.id, owner.uid],
    );
    expect(seeded.rowCount).toBe(1);
    googleDelta([{
      id: 'g-weekly', summary: 'Weekly standup', status: 'confirmed', updated: FUTURE,
      recurrence: ['RRULE:FREQ=WEEKLY'],
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T14:30:00Z' },
    }]);
    route('/events/g-weekly/instances', { status: 200, json: { items: [] } });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select id from calendar_events where id = $1`, [rowId]);
    expect(rows).toEqual([]);
  });
});

// ── 2. a field cleared in Google ────────────────────────────────────────────

describe('a location or description cleared in Google', () => {
  /**
   * Google leaves an empty field out of the event resource altogether. A full
   * resource (it has a start) without one therefore means the member cleared it.
   *
   * Goes red if an absent description is still read as "not reported": the
   * task keeps it. (A task's location is the member's own in the provider and
   * is not read back, so it is left alone.)
   */
  test('a task loses its description', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, description, location, due_date, due_at, created_by, calendar_sync)
       values ($1, $2, 'Prep session', 'Bring exhibits', 'Room 4', '2026-09-10', '2026-09-10T14:00:00Z', $3, $4::jsonb)`,
      [taskId, firm.id, owner.uid, JSON.stringify({ google: { [owner.uid]: { dueDate: { eventId: 'g-prep' } } } })],
    );
    expect(task.rowCount).toBe(1);
    await seedMapping({ provider: 'google', externalEventId: 'g-prep', userId: owner.uid, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    googleDelta([{
      id: 'g-prep', summary: 'Prep session', status: 'confirmed', updated: FUTURE,
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select description, location from tasks where id = $1`, [taskId]);
    expect(rows[0]).toEqual({ description: '', location: 'Room 4' });
  });

  /** The matter-event branch. Goes red if it keeps the old notes or location. */
  test('a matter event loses both', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, notes: 'Bring exhibits', location: '12 King St',
      calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    googleDelta([{
      id: 'g-hearing', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE,
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const row = await eventRow(eventId);
    expect({ notes: row.notes, location: row.location, locationName: row.location_name })
      .toEqual({ notes: '', location: null, locationName: null });
  });
});

// ── 3. location precedence ──────────────────────────────────────────────────

describe('a location changed in the provider', () => {
  /**
   * Outbound pushes `location || location_name`, so the member's new address
   * must land in `location`, where the next push reads it first.
   *
   * Goes red if inbound writes `location_name` instead: the stored `location`
   * still wins on the next push and the member's edit is reverted.
   */
  test('lands in the field the next push reads first', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, location: '1 Court Plaza', locationName: 'Main office',
      calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    googleDelta([{
      id: 'g-hearing', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE, location: '12 King St',
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const row = await eventRow(eventId);
    expect({ location: row.location, locationName: row.location_name })
      .toEqual({ location: '12 King St', locationName: 'Main office' });
  });

  /**
   * A client event at a court is pushed with the court's name as its location.
   * That name coming back unchanged is not a new location.
   *
   * Goes red if the court name is copied into a column of the event.
   */
  test('a court name pushed as the location is not copied back', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const courtId = randomUUID();
    const court = await testPool.query(
      `insert into courts (id, law_firm_id, name) values ($1, $2, 'Superior Court')`, [courtId, firm.id],
    );
    expect(court.rowCount).toBe(1);
    const clientId = randomUUID();
    const client = await testPool.query(
      `insert into clients (id, law_firm_id, name) values ($1, $2, 'Jane Doe')`,
      [clientId, firm.id],
    );
    expect(client.rowCount).toBe(1);
    const eventId = randomUUID();
    const event = await testPool.query(
      `insert into events (id, law_firm_id, client_id, type, title, date, court_id, created_by, calendar_sync)
       values ($1, $2, $3, 'hearing', 'Arraignment', '2026-09-10T14:00:00Z', $4, $5, $6::jsonb)`,
      [eventId, firm.id, clientId, courtId, owner.uid,
        JSON.stringify({ outlook: { [owner.uid]: { event: { eventId: 'AAMk-arraign', changeKey: 'CK-1' } } } })],
    );
    expect(event.rowCount).toBe(1);
    await seedMapping({ provider: 'outlook', externalEventId: 'AAMk-arraign', userId: owner.uid, entityType: 'clientEvent', entityId: eventId, scopeId: clientId, itemKey: 'event' });
    route('/me/events/AAMk-arraign', {
      status: 200,
      json: {
        id: 'AAMk-arraign', subject: 'Arraignment (moved)', isAllDay: false, isCancelled: false,
        lastModifiedDateTime: FUTURE, changeKey: 'CK-2', location: { displayName: 'Superior Court' },
        start: { dateTime: '2026-09-10T14:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-10T15:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'updated',
      resource: 'me/events/AAMk-arraign', resourceData: { id: 'AAMk-arraign' },
    });

    const row = await eventRow(eventId);
    // The change itself was applied, so the location decision was reached.
    expect(row.title).toBe('Arraignment (moved)');
    expect({ location: row.location, locationName: row.location_name }).toEqual({ location: null, locationName: null });
  });
});

// ── 4. the stale guard and outbound pushes ──────────────────────────────────

describe('a genuine edit that arrives after a push to another member', () => {
  /**
   * `updated_at` is now. A null `lastSynced` stamps the push in the same
   * statement, so the two are equal, which is what `touchProviderSync` leaves.
   */
  async function seedSharedTask(uid: string, opts: { lastSynced: string | null; pushedModifiedAt: string }) {
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, due_at, created_by, calendar_sync, last_synced_to_google, updated_at)
       values ($1, $2, 'Prep session', '2026-09-10', '2026-09-10T14:00:00Z', $3, $4::jsonb, coalesce($5::timestamptz, now()), now())`,
      [taskId, firm.id, uid, JSON.stringify({ google: { [uid]: { dueDate: { eventId: 'g-prep' } } } }), opts.lastSynced],
    );
    expect(task.rowCount).toBe(1);
    await seedMapping({
      provider: 'google', externalEventId: 'g-prep', userId: uid, entityType: 'task', entityId: taskId,
      itemKey: 'dueDate', pushedModifiedAt: opts.pushedModifiedAt,
    });
    return taskId;
  }

  /**
   * Member A edited their copy a minute ago. Since then a push to member B
   * stamped the task, which moved `updated_at` past A's edit. A's copy was
   * last pushed two hours ago, so the edit is A's own.
   *
   * Goes red if the guard still compares against `updated_at`: A's edit is
   * skipped and the next fan-out overwrites it.
   */
  test('is applied', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const taskId = await seedSharedTask(owner.uid, { lastSynced: null, pushedModifiedAt: iso(-2 * HOUR) });
    googleDelta([{
      id: 'g-prep', summary: 'Prep session with client', status: 'confirmed', updated: iso(-MINUTE),
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select title from tasks where id = $1`, [taskId]);
    expect(rows[0].title).toBe('Prep session with client');
  });

  /**
   * The other half: a Paralegix edit not yet pushed anywhere (`updated_at`
   * after every push) that is newer than the provider edit still wins.
   * Goes red if the new rule ignores unpushed Paralegix edits.
   */
  test('loses to a newer Paralegix edit that has not been pushed', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const taskId = await seedSharedTask(owner.uid, { lastSynced: iso(-2 * HOUR), pushedModifiedAt: iso(-3 * HOUR) });
    googleDelta([{
      id: 'g-prep', summary: 'Older provider title', status: 'confirmed', updated: iso(-MINUTE),
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect(callsMatching(DELTA)).toHaveLength(1);
    const { rows } = await testPool.query(`select title from tasks where id = $1`, [taskId]);
    expect(rows[0].title).toBe('Prep session');
  });
});

// ── 5. a mapped item deleted during a sync gap ──────────────────────────────

describe('a Paralegix item deleted from the calendar while sync was down', () => {
  async function seedLinkedHearing(uid: string, googleId: string) {
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: uid, date: iso(10 * DAY),
      calendarSync: { google: { [uid]: { event: { eventId: googleId } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: googleId, userId: uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    return eventId;
  }

  function fullResyncListing(items: object[]) {
    route(DELTA, { status: 410, text: '{"error":{"code":410,"errors":[{"reason":"fullSyncRequired"}]}}' });
    route(INIT_TOKEN, { status: 200, json: { items: [], nextSyncToken: 'token-reissued' } });
    route(FULL_SYNC, { status: 200, json: { items } });
  }

  /**
   * The delete notification was lost behind a 410. The full listing after it
   * does not have the event, and Google confirms it is gone.
   *
   * Goes red if the full resync reconciles only imported rows: the item stays
   * linked to an event that no longer exists.
   */
  test('is unlinked by the full resync after a 410', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, 'token-dead');
    const eventId = await seedLinkedHearing(owner.uid, 'g-gone');
    fullResyncListing([]);
    route('/calendars/primary/events/g-gone', { status: 404 }, { method: 'GET' });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect(callsMatching(FULL_SYNC)).toHaveLength(1);
    expect(await mappingIds(eventId)).toEqual([]);
    const row = await eventRow(eventId);
    expect(row.calendar_sync.google?.[owner.uid]?.event).toBeUndefined();
    expect(row.title).toBe('Motion hearing');
  });

  /**
   * An event missing from the listing that Google still has (on another of
   * the member's calendars) is not a deletion.
   * Goes red if the reconciliation unlinks on absence alone.
   */
  test('keeps an item the provider still has', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, 'token-dead');
    const eventId = await seedLinkedHearing(owner.uid, 'g-moved');
    fullResyncListing([]);
    route('/calendars/primary/events/g-moved', {
      status: 200, json: { id: 'g-moved', status: 'confirmed', start: { dateTime: iso(10 * DAY) } },
    }, { method: 'GET' });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect(callsMatching('/calendars/primary/events/g-moved')).toHaveLength(1);
    expect(await mappingIds(eventId)).toEqual(['g-moved']);
  });
});

// ── 6. the footer deleted in the provider ───────────────────────────────────

describe('a description whose Paralegix footer the member deleted', () => {
  /**
   * Without the marker the text cannot say which entity wrote it, but the
   * mapping can. Goes red if the client section, the type label and the
   * location line are written into the notes, where every round trip adds
   * another copy.
   */
  test('Google: the matter event keeps only its notes', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, notes: 'Bring exhibits', locationName: 'Room 4',
      calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    googleDelta([{
      id: 'g-hearing', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE,
      description: 'Clients:\nJane Doe\nAcme Holdings - 555-0100\n\nHearing: Motion hearing\n\nLocation: Room 4\n\nBring exhibits and the binder',
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect((await eventRow(eventId)).notes).toBe('Bring exhibits and the binder');
  });

  /** The task form, from Outlook. Goes red if the client line stays in the description. */
  test('Outlook: the task keeps only its description', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, description, due_date, due_at, created_by, calendar_sync)
       values ($1, $2, 'Prep session', 'Bring exhibits', '2026-09-10', '2026-09-10T14:00:00Z', $3, $4::jsonb)`,
      [taskId, firm.id, owner.uid, JSON.stringify({ outlook: { [owner.uid]: { dueDate: { eventId: 'AAMk-prep', changeKey: 'CK-1' } } } })],
    );
    expect(task.rowCount).toBe(1);
    await seedMapping({ provider: 'outlook', externalEventId: 'AAMk-prep', userId: owner.uid, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    route('/me/events/AAMk-prep', {
      status: 200,
      json: {
        id: 'AAMk-prep', subject: 'Prep session', isAllDay: false, isCancelled: false,
        lastModifiedDateTime: FUTURE, changeKey: 'CK-2',
        body: { contentType: 'text', content: 'Client: Jane Doe - 555-0100\n\nBring exhibits and the binder' },
        start: { dateTime: '2026-09-10T14:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-10T15:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'updated',
      resource: 'me/events/AAMk-prep', resourceData: { id: 'AAMk-prep' },
    });

    const { rows } = await testPool.query(`select description from tasks where id = $1`, [taskId]);
    expect(rows[0].description).toBe('Bring exhibits and the binder');
  });
});

// ── 7. a member without write access ────────────────────────────────────────

describe('an edit from a member who may not change the item', () => {
  /**
   * A member who can see the matter but not update its events renames their
   * own copy in Google. Paralegix refuses that edit in its own routes, so it
   * refuses it here, and puts the firm's version back on the member's copy.
   *
   * Goes red if the inbound write skips the access check (the shared title
   * changes) or if the member's copy is left showing their edit.
   */
  test('is not written, and the member\'s copy is put back', async () => {
    const viewer = await memberWith(firm.id, ['calendar.sync', 'matters.view']);
    await connectGoogle(viewer.uid);
    const matterId = await seedMatter();
    const joined = await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)', [firm.id, matterId, viewer.uid],
    );
    expect(joined.rowCount).toBe(1);
    const { eventId } = await seedMatterEvent({
      matterId, createdBy: viewer.uid,
      calendarSync: { google: { [viewer.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: viewer.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    googleDelta([{
      id: 'g-hearing', summary: 'Renamed by a viewer', status: 'confirmed', updated: FUTURE,
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);
    route('/calendars/primary/events/g-hearing', {
      status: 200, json: { id: 'g-hearing', etag: '"repushed"', updated: FUTURE },
    }, { method: 'PATCH' });

    await googleService.processWatchNotification({ userId: viewer.uid, lawFirmId: firm.id });

    expect((await eventRow(eventId)).title).toBe('Motion hearing');
    const patches = callsMatching('/calendars/primary/events/g-hearing').filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.body.summary)).toEqual(['Motion hearing']);
  });

  /** The control: a member holding `matters.update` is applied. */
  test('from a member who may change it is applied', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    googleDelta([{
      id: 'g-hearing', summary: 'Renamed by the owner', status: 'confirmed', updated: FUTURE,
      start: { dateTime: '2026-09-10T14:00:00Z' }, end: { dateTime: '2026-09-10T15:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect((await eventRow(eventId)).title).toBe('Renamed by the owner');
  });
});

// ── 8. one member's time zone ───────────────────────────────────────────────

describe('the time zone of a shared event edited by one member', () => {
  /**
   * The event has no zone of its own, so each member's copy was pushed in a
   * zone the push filled in, here the member's own. A Los Angeles member's
   * rename must not give the firm's event their zone.
   *
   * Goes red if the inbound update still copies the copy's start zone.
   */
  test('a zone-less event stays zone-less when the copy is in the member\'s own zone', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const zoned = await testPool.query(`update users set timezone = 'America/Los_Angeles' where id = $1`, [owner.uid]);
    expect(zoned.rowCount).toBe(1);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    googleDelta([{
      id: 'g-hearing', summary: 'Motion hearing (renamed)', status: 'confirmed', updated: FUTURE,
      start: { dateTime: '2026-09-10T07:00:00-07:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-09-10T08:00:00-07:00', timeZone: 'America/Los_Angeles' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const row = await eventRow(eventId);
    expect(row.title).toBe('Motion hearing (renamed)');
    expect(row.time_zone).toBeNull();
  });

  /**
   * A copy pushed in the event's own zone and moved to another zone in the
   * provider is a real change. Goes red if the rule above keeps the zone even
   * then.
   */
  test('a zone changed in the provider is taken', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, timeZone: 'America/New_York',
      calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({ provider: 'google', externalEventId: 'g-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    googleDelta([{
      id: 'g-hearing', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE,
      start: { dateTime: '2026-09-10T15:00:00+01:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-09-10T16:00:00+01:00', timeZone: 'Europe/London' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect((await eventRow(eventId)).time_zone).toBe('Europe/London');
  });

  /**
   * An equivalent name for the same zone (Graph reports Windows names, which
   * map to one IANA zone) is not a change. Goes red if the row's zone is
   * replaced by an alias that keeps the same clock.
   */
  test('an alias of the event\'s own zone is not a change', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, timeZone: 'America/Detroit',
      calendarSync: { outlook: { [owner.uid]: { event: { eventId: 'AAMk-hearing', changeKey: 'CK-1' } } } },
    });
    await seedMapping({ provider: 'outlook', externalEventId: 'AAMk-hearing', userId: owner.uid, entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event' });
    route('/me/events/AAMk-hearing', {
      status: 200,
      json: {
        id: 'AAMk-hearing', subject: 'Motion hearing (renamed)', isAllDay: false, isCancelled: false,
        lastModifiedDateTime: FUTURE, changeKey: 'CK-2', originalStartTimeZone: 'Eastern Standard Time',
        start: { dateTime: '2026-09-10T14:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-10T15:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'updated',
      resource: 'me/events/AAMk-hearing', resourceData: { id: 'AAMk-hearing' },
    });

    const row = await eventRow(eventId);
    expect(row.title).toBe('Motion hearing (renamed)');
    expect(row.time_zone).toBe('America/Detroit');
  });
});

// ── 10. an imported event's start zone ──────────────────────────────────────

describe('an imported event updated without a start zone', () => {
  /**
   * Goes red if the update writes null over the zone the import recorded,
   * which the builder's own comment says it never does.
   */
  test('keeps the zone it was imported with', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const rowId = randomUUID();
    const seeded = await testPool.query(
      `insert into calendar_events (id, law_firm_id, title, starts_at, ends_at, provider, source,
         external_event_id, google_event_id, created_by, start_time_zone)
       values ($1, $2, 'Client lunch', '2026-09-10T17:00:00Z', '2026-09-10T18:00:00Z',
         'google', 'external', 'g-lunch', 'g-lunch', $3, 'America/Chicago')`,
      [rowId, firm.id, owner.uid],
    );
    expect(seeded.rowCount).toBe(1);
    googleDelta([{
      id: 'g-lunch', summary: 'Client lunch (moved)', status: 'confirmed', updated: FUTURE,
      start: { dateTime: '2026-09-11T17:00:00Z' }, end: { dateTime: '2026-09-11T18:00:00Z' },
    }]);

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select title, start_time_zone from calendar_events where id = $1`, [rowId]);
    expect(rows[0]).toEqual({ title: 'Client lunch (moved)', start_time_zone: 'America/Chicago' });
  });
});
