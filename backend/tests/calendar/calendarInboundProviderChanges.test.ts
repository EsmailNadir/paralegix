/**
 * Something a member puts on, moves in, or removes from their own Google or
 * Outlook calendar has to arrive in Paralegix correctly.
 *
 * The first two cases run the whole inbound path through the real webhook
 * routes and read the result back through `GET /calendar-events`, the way the
 * calendar page does. The rest pin four inbound defects:
 *
 *   A MATTER EVENT MOVED PAST ITS OWN END. `events` has a CHECK that `ends_at`
 *   is after `date`, and the inbound update rewrote only `date`. Rescheduling a
 *   two-hour hearing to next week in Google or Outlook therefore failed the
 *   constraint, and the change was retried until it dead-lettered.
 *
 *   ONE MEMBER'S OUTLOOK ID ON A SHARED EVENT. The Outlook inbound builder
 *   carries the event's id and change key, and the matter-event branch wrote
 *   both into the shared scalar columns, which the adapters hand to the
 *   event's creator as their own Outlook event.
 *
 *   A REAL-TIME-SYNCED TASK DELETED IN THE PROVIDER. Its event is known only
 *   through `calendar_mappings`, and the delete path's mapping branch handled
 *   matter and client events only, so it logged "unhandled" and did nothing.
 *
 *   A MEETING ITS ORGANIZER CANCELLED. Outlook keeps it in an attendee's
 *   calendar with `isCancelled` set and notifies `updated`, so it was upserted
 *   and stayed on the Paralegix calendar as a live event.
 *
 * `support/googleFetch` replaces `globalThis.fetch` for Google and Graph alike;
 * any request no case registered is recorded and rejected.
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
  request,
  type Firm,
} from '../support/setupInProcess';
import { describeNetworkWall } from './support/calendarWorld';

const googleService = require('../../src/modules/calendar/google/google.service');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');

/** Newer than any fixture row's `updated_at`, so an inbound edit is not stale. */
const FUTURE = '2030-01-01T00:00:00.000Z';

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

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function connectGoogle(uid: string, syncToken = 'token-live') {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, 'refresh-seed')`,
    [uid, `g-${randomUUID().slice(0, 8)}`],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set preferences = $2::jsonb, updated_at = now() where id = $1)
     update user_oauth_tokens set is_sync_to_provider = true, is_sync_from_provider = true, sync_cursor = $3
      where user_id = $1 and provider = 'google'`,
    [uid, JSON.stringify({ googleCalendarTarget: 'default' }), syncToken],
  );
  expect(settings.rowCount).toBe(1);
}

/** The mailbox timezone is seeded so no case has to route the lookup. */
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

async function seedGoogleChannel(uid: string) {
  const channelId = `chan-${randomUUID()}`;
  const res = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
     values ('google', $1, $2, $3, 'primary', $4, 'channel-token', now() + interval '7 days')`,
    [channelId, uid, firm.id, `res-${channelId}`],
  );
  expect(res.rowCount).toBe(1);
  return channelId;
}

async function seedOutlookSubscription(uid: string) {
  const id = `sub-${randomUUID()}`;
  const res = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, resource, secret, expiration)
     values ('outlook', $1, $2, $3, '/me/calendar/events', 'client-state', now() + interval '2 days')`,
    [id, uid, firm.id],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMatterEvent(opts: {
  createdBy: string;
  date: string;
  endsAt: string | null;
  allDay?: boolean;
  calendarSync: object;
}) {
  const matterId = randomUUID();
  const matter = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Bell v. Ward', $3)`,
    [matterId, firm.id, `M-${matterId.slice(0, 8)}`],
  );
  expect(matter.rowCount).toBe(1);
  const eventId = randomUUID();
  const event = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, type, title, date, ends_at, all_day, created_by, calendar_sync)
     values ($1, $2, $3, 'hearing', 'Motion hearing', $4, $5, $6, $7, $8::jsonb)`,
    [eventId, firm.id, matterId, opts.date, opts.endsAt, opts.allDay ?? false, opts.createdBy,
      JSON.stringify(opts.calendarSync)],
  );
  expect(event.rowCount).toBe(1);
  return { matterId, eventId };
}

async function seedMapping(opts: {
  provider: 'google' | 'outlook';
  externalEventId: string;
  userId: string;
  entityType: 'task' | 'matterEvent';
  entityId: string;
  scopeId?: string | null;
  itemKey: string;
}) {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, scope_id, item_key)
     values ($1, $2, 'primary', $3, $4, $5, $6, $7, $8)`,
    [opts.provider, opts.externalEventId, opts.userId, firm.id, opts.entityType, opts.entityId,
      opts.scopeId ?? null, opts.itemKey],
  );
  expect(res.rowCount).toBe(1);
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const externalRow = (column: 'google_event_id' | 'outlook_id', id: string) => waitFor(async () => (
  await testPool.query(
    `select starts_at, ends_at, all_day, title, provider, created_by
       from calendar_events where law_firm_id = $1 and ${column} = $2`,
    [firm.id, id],
  )).rows[0], `the ${id} calendar_events row`);

const WINDOW = { from: '2026-09-01', to: '2026-10-31', tz: 'UTC' };

describeNetworkWall('https://graph.microsoft.com/v1.0/me/events');

// ── a new event reaches Paralegix, end to end ───────────────────────────────

describe('an event a member adds to their own calendar', () => {
  /**
   * Google pushes headers only; the route answers, then reads the delta. The
   * timed event and the all-day one must both land on the right day and time,
   * visible to the member who owns the calendar and to no one else.
   *
   * Goes red if the webhook stops reaching the delta read, if the new-event
   * branch of the inbound chain stops creating the row, if an all-day event's
   * day shifts, or if one member's imported events leak to a colleague.
   */
  test('Google: arrives through the webhook and shows on that member\'s calendar only', async () => {
    const owner = await ownerOf(firm.id);
    const colleague = await memberWith(firm.id, ['calendar.view']);
    await connectGoogle(owner.uid);
    const channelId = await seedGoogleChannel(owner.uid);
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [
          {
            id: 'g-deposition', summary: 'Deposition prep', status: 'confirmed', updated: FUTURE,
            start: { dateTime: '2026-10-05T15:00:00Z' }, end: { dateTime: '2026-10-05T17:30:00Z' },
          },
          {
            id: 'g-offsite', summary: 'Firm offsite', status: 'confirmed', updated: FUTURE,
            start: { date: '2026-10-08' }, end: { date: '2026-10-10' },
          },
        ],
      },
    });

    const ack = await request().post('/api/webhooks/google-calendar').set({
      'x-goog-channel-id': channelId,
      'x-goog-resource-state': 'exists',
      'x-goog-channel-token': 'channel-token',
    }).send();
    expect(ack.status).toBe(200);

    const timed = await externalRow('google_event_id', 'g-deposition');
    expect(timed).toMatchObject({ title: 'Deposition prep', provider: 'google', all_day: false, created_by: owner.uid });
    expect(timed.starts_at.toISOString()).toBe('2026-10-05T15:00:00.000Z');
    expect(timed.ends_at.toISOString()).toBe('2026-10-05T17:30:00.000Z');
    const allDay = await externalRow('google_event_id', 'g-offsite');
    expect(allDay.all_day).toBe(true);
    expect(allDay.starts_at.toISOString().slice(0, 10)).toBe('2026-10-08');
    expect(allDay.ends_at.toISOString().slice(0, 10)).toBe('2026-10-10');

    const mine = await owner.api.get(`/api/lawfirms/${firm.id}/calendar-events`).query(WINDOW);
    expect(mine.status).toBe(200);
    expect(mine.body.events.map((e: any) => [e.title, e.start, e.allDay]).sort()).toEqual([
      ['Deposition prep', '2026-10-05T15:00:00.000Z', false],
      ['Firm offsite', allDay.starts_at.toISOString(), true],
    ]);
    const theirs = await colleague.api.get(`/api/lawfirms/${firm.id}/calendar-events`).query(WINDOW);
    expect(theirs.status).toBe(200);
    expect(theirs.body.events).toEqual([]);
  });

  /**
   * Graph posts one notification per change; the route answers 202, fetches
   * the event by id, and imports it.
   *
   * Goes red if the `created` notification stops being fetched and upserted,
   * or if the Graph wall-clock time stops being read in the event's own zone.
   */
  test('Outlook: arrives through the webhook and shows on that member\'s calendar', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const subscriptionId = await seedOutlookSubscription(owner.uid);
    route('/me/events/AAMk-client-call', {
      status: 200,
      json: {
        id: 'AAMk-client-call', subject: 'Client call', isAllDay: false, isCancelled: false,
        lastModifiedDateTime: FUTURE, changeKey: 'CK-1',
        start: { dateTime: '2026-10-06T09:00:00.0000000', timeZone: 'Eastern Standard Time' },
        end: { dateTime: '2026-10-06T09:45:00.0000000', timeZone: 'Eastern Standard Time' },
        body: { contentType: 'text', content: 'Dial-in in invite' },
      },
    }, { method: 'GET' });

    const ack = await request().post('/api/webhooks/outlook-calendar').send({
      value: [{
        subscriptionId, changeType: 'created', clientState: 'client-state',
        resource: 'me/events/AAMk-client-call', resourceData: { id: 'AAMk-client-call' },
      }],
    });
    expect(ack.status).toBe(202);

    const row = await externalRow('outlook_id', 'AAMk-client-call');
    expect(row).toMatchObject({ title: 'Client call', provider: 'outlook', all_day: false, created_by: owner.uid });
    // 09:00 New York in October is 13:00 UTC.
    expect(row.starts_at.toISOString()).toBe('2026-10-06T13:00:00.000Z');
    expect(row.ends_at.toISOString()).toBe('2026-10-06T13:45:00.000Z');

    const mine = await owner.api.get(`/api/lawfirms/${firm.id}/calendar-events`).query(WINDOW);
    expect(mine.body.events.map((e: any) => [e.title, e.provider, e.start])).toEqual([
      ['Client call', 'outlook', '2026-10-06T13:00:00.000Z'],
    ]);
  });
});

// ── a matter event moved past its own end ───────────────────────────────────

describe('a synced matter event rescheduled in the provider', () => {
  /**
   * A two-hour hearing moved a week later, and lengthened, in Google.
   *
   * Goes red if the inbound update stops writing `ends_at`: the CHECK rejects
   * the row and `processWatchNotification` throws instead of applying it.
   */
  test('Google: moves the end with the start, taking the provider\'s new end', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, date: '2026-09-10T14:00:00Z', endsAt: '2026-09-10T16:00:00Z',
      calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMapping({
      provider: 'google', externalEventId: 'g-hearing', userId: owner.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event',
    });
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-hearing', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE,
          start: { dateTime: '2026-09-17T14:00:00Z' }, end: { dateTime: '2026-09-17T17:00:00Z' },
        }],
      },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select date, ends_at from events where id = $1`, [eventId]);
    expect(rows[0].date.toISOString()).toBe('2026-09-17T14:00:00.000Z');
    expect(rows[0].ends_at.toISOString()).toBe('2026-09-17T17:00:00.000Z');
  });

  /**
   * A two-day all-day event moved ten days later by a member who did not
   * create it. An all-day end is a day, not an instant, so the event keeps the
   * span it had.
   *
   * Goes red if the end stops moving with the start (the CHECK fails again),
   * or if this member's Outlook id and change key are written into the shared
   * scalar columns, where the creator's pushes would pick them up.
   */
  test('Outlook: keeps an all-day span, and leaves the shared provider columns alone', async () => {
    const owner = await ownerOf(firm.id);
    // Staffed on the matter and allowed to edit its events, as a provider
    // edit must be to be written at all.
    const member = await memberWith(firm.id, ['calendar.sync', 'matters.update']);
    await connectMicrosoft(member.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, date: '2026-09-10T12:00:00Z', endsAt: '2026-09-12T12:00:00Z', allDay: true,
      calendarSync: { outlook: { [member.uid]: { event: { eventId: 'AAMk-trial', changeKey: 'CK-1' } } } },
    });
    const staffed = await testPool.query(
      'insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)', [firm.id, matterId, member.uid],
    );
    expect(staffed.rowCount).toBe(1);
    await seedMapping({
      provider: 'outlook', externalEventId: 'AAMk-trial', userId: member.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event',
    });
    route('/me/events/AAMk-trial', {
      status: 200,
      json: {
        id: 'AAMk-trial', subject: 'Motion hearing', isAllDay: true, isCancelled: false,
        lastModifiedDateTime: FUTURE, changeKey: 'CK-2',
        start: { dateTime: '2026-09-20T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-22T00:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });

    await outlookService.processSubscriptionNotification({
      userId: member.uid, lawFirmId: firm.id, changeType: 'updated',
      resource: 'me/events/AAMk-trial', resourceData: { id: 'AAMk-trial' },
    });

    const { rows } = await testPool.query(
      `select date, ends_at, all_day, outlook_id, outlook_change_key from events where id = $1`, [eventId],
    );
    expect(rows[0].date.toISOString()).toBe('2026-09-20T12:00:00.000Z');
    expect(rows[0].ends_at.toISOString()).toBe('2026-09-22T12:00:00.000Z');
    expect(rows[0].all_day).toBe(true);
    expect(rows[0].outlook_id).toBeNull();
    expect(rows[0].outlook_change_key).toBeNull();
  });
});

describe('a synced task with an end, rescheduled in the provider', () => {
  /**
   * A two-hour task moved a week later, and lengthened, in Google.
   *
   * Goes red if the inbound task update stops writing `ends_at`: the old end
   * is before the new start, so tasks_ends_after_start rejects the row and
   * the change is never applied.
   */
  test('Google: moves the end with the start, taking the provider\'s new end', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, due_at, ends_at, created_by, calendar_sync)
       values ($1, $2, 'Prep session', '2026-09-10', '2026-09-10T14:00:00Z', '2026-09-10T16:00:00Z', $3, $4::jsonb)`,
      [taskId, firm.id, owner.uid, JSON.stringify({ google: { [owner.uid]: { dueDate: { eventId: 'g-prep' } } } })],
    );
    expect(task.rowCount).toBe(1);
    await seedMapping({ provider: 'google', externalEventId: 'g-prep', userId: owner.uid, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-prep', summary: 'Prep session', status: 'confirmed', updated: FUTURE,
          start: { dateTime: '2026-09-17T14:00:00Z' }, end: { dateTime: '2026-09-17T17:00:00Z' },
        }],
      },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select due_at, ends_at from tasks where id = $1`, [taskId]);
    expect(rows[0].due_at.toISOString()).toBe('2026-09-17T14:00:00.000Z');
    expect(rows[0].ends_at.toISOString()).toBe('2026-09-17T17:00:00.000Z');
  });
});

describe('an end changed in the provider by switching all-day or lengthening a span', () => {
  /**
   * An all-day task stretched to three days in Google. Goes red if the inbound
   * update ignores the provider's own end day, which left the task one day
   * long in Paralegix and the next push shrank it back in Google.
   */
  test('Google: an all-day task lengthened there takes the new last day', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, all_day, created_by, calendar_sync)
       values ($1, $2, 'Document review', '2026-09-10', true, $3, $4::jsonb)`,
      [taskId, firm.id, owner.uid, JSON.stringify({ google: { [owner.uid]: { dueDate: { eventId: 'g-review' } } } })],
    );
    expect(task.rowCount).toBe(1);
    await seedMapping({ provider: 'google', externalEventId: 'g-review', userId: owner.uid, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-review', summary: 'Document review', status: 'confirmed', updated: FUTURE,
          start: { date: '2026-09-10' }, end: { date: '2026-09-13' },
        }],
      },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select ends_at from tasks where id = $1`, [taskId]);
    // The 10th through the 12th: the exclusive 13th at its noon anchor.
    expect(rows[0].ends_at.toISOString()).toBe('2026-09-13T12:00:00.000Z');
  });

  /**
   * A two-hour hearing made a one-day all-day event in Google. Goes red if
   * the old timed end is shifted along instead, which leaves an instant where
   * an all-day end must be a day.
   */
  test('Google: a timed event made all-day there drops its timed end', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, date: '2026-09-10T14:00:00Z', endsAt: '2026-09-10T16:00:00Z',
      calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-flip' } } } },
    });
    await seedMapping({
      provider: 'google', externalEventId: 'g-flip', userId: owner.uid,
      entityType: 'matterEvent', entityId: eventId, scopeId: matterId, itemKey: 'event',
    });
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-flip', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE,
          start: { date: '2026-09-17' }, end: { date: '2026-09-18' },
        }],
      },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select date, ends_at, all_day from events where id = $1`, [eventId]);
    expect(rows[0].all_day).toBe(true);
    expect(rows[0].date.toISOString()).toBe('2026-09-17T12:00:00.000Z');
    expect(rows[0].ends_at).toBeNull();
  });

  /**
   * A task linked by its scalar Google id rather than a mapping row: the
   * engine's other task branch. Goes red if that branch stops writing the end,
   * since the move past the old end then fails tasks_ends_after_start.
   */
  test('Google: a task found by its own event id keeps a valid end when moved', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, due_at, ends_at, google_event_id, created_by)
       values ($1, $2, 'Prep session', '2026-09-10', '2026-09-10T14:00:00Z', '2026-09-10T16:00:00Z', 'g-scalar', $3)`,
      [taskId, firm.id, owner.uid],
    );
    expect(task.rowCount).toBe(1);
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-scalar', summary: 'Prep session', status: 'confirmed', updated: FUTURE,
          start: { dateTime: '2026-09-17T14:00:00Z' }, end: { dateTime: '2026-09-17T17:00:00Z' },
        }],
      },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select due_at, ends_at from tasks where id = $1`, [taskId]);
    expect(rows[0].due_at.toISOString()).toBe('2026-09-17T14:00:00.000Z');
    expect(rows[0].ends_at.toISOString()).toBe('2026-09-17T17:00:00.000Z');
  });

  /** The same move arriving from Outlook. Goes red if Outlook's task path stops writing the end. */
  test('Outlook: a synced task moved there takes the new end', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, due_at, ends_at, created_by, calendar_sync)
       values ($1, $2, 'Prep session', '2026-09-10', '2026-09-10T14:00:00Z', '2026-09-10T16:00:00Z', $3, $4::jsonb)`,
      [taskId, firm.id, owner.uid, JSON.stringify({ outlook: { [owner.uid]: { dueDate: { eventId: 'AAMk-prep', changeKey: 'CK-1' } } } })],
    );
    expect(task.rowCount).toBe(1);
    await seedMapping({ provider: 'outlook', externalEventId: 'AAMk-prep', userId: owner.uid, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    route('/me/events/AAMk-prep', {
      status: 200,
      json: {
        id: 'AAMk-prep', subject: 'Prep session', isAllDay: false, isCancelled: false,
        lastModifiedDateTime: FUTURE, changeKey: 'CK-2',
        start: { dateTime: '2026-09-17T14:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-09-17T17:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'updated',
      resource: 'me/events/AAMk-prep', resourceData: { id: 'AAMk-prep' },
    });

    const { rows } = await testPool.query(`select due_at, ends_at from tasks where id = $1`, [taskId]);
    expect(rows[0].due_at.toISOString()).toBe('2026-09-17T14:00:00.000Z');
    expect(rows[0].ends_at.toISOString()).toBe('2026-09-17T17:00:00.000Z');
  });
});

// ── a real-time-synced task deleted in the provider ─────────────────────────

describe('a task\'s event deleted from a member\'s Google calendar', () => {
  /**
   * The task was pushed to both of this member's calendars by the real-time
   * sync, so each copy is known only through the per-user map and a mapping.
   *
   * Goes red if the delete path's mapping branch stops handling tasks: the
   * Google entry and mapping survive, and the Outlook copy is never removed.
   * Also red if the delete starts removing the shared task itself.
   */
  test('unlinks this member\'s copies, removes the Outlook one, and keeps the task', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    const taskId = randomUUID();
    const task = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, due_at, created_by, calendar_sync)
       values ($1, $2, 'File the motion', '2026-09-10', '2026-09-10T16:00:00Z', $3, $4::jsonb)`,
      [taskId, firm.id, owner.uid, JSON.stringify({
        google: { [owner.uid]: { dueDate: { eventId: 'g-task' } } },
        outlook: { [owner.uid]: { dueDate: { eventId: 'AAMk-task', changeKey: 'CK-1' } } },
      })],
    );
    expect(task.rowCount).toBe(1);
    await seedMapping({ provider: 'google', externalEventId: 'g-task', userId: owner.uid, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    await seedMapping({ provider: 'outlook', externalEventId: 'AAMk-task', userId: owner.uid, entityType: 'task', entityId: taskId, itemKey: 'dueDate' });
    route('syncToken=token-live', {
      status: 200,
      json: { nextSyncToken: 'token-after', items: [{ id: 'g-task', status: 'cancelled' }] },
    });
    route('/me/events/AAMk-task', { status: 204 }, { method: 'DELETE' });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect(callsMatching('/me/events/AAMk-task').map((c) => c.method)).toEqual(['DELETE']);
    const { rows } = await testPool.query(`select title, calendar_sync from tasks where id = $1`, [taskId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('File the motion');
    expect(rows[0].calendar_sync.google?.[owner.uid]?.dueDate).toBeUndefined();
    expect(rows[0].calendar_sync.outlook?.[owner.uid]?.dueDate).toBeUndefined();
    const mappings = await testPool.query(`select provider from calendar_mappings where entity_id = $1`, [taskId]);
    expect(mappings.rows).toEqual([]);
  });
});

// ── a meeting cancelled by its organizer ────────────────────────────────────

describe('an Outlook meeting its organizer cancelled', () => {
  /**
   * The meeting was imported earlier; the cancellation arrives as `updated`
   * with `isCancelled` set.
   *
   * Goes red if a cancelled meeting is upserted instead of removed: the row
   * survives with its title unchanged.
   */
  test('is removed from the member\'s Paralegix calendar', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const rowId = randomUUID();
    const seeded = await testPool.query(
      `insert into calendar_events (id, law_firm_id, title, starts_at, ends_at, provider, source,
         external_event_id, outlook_id, created_by)
       values ($1, $2, 'Opposing counsel sync', '2026-10-07T15:00:00Z', '2026-10-07T16:00:00Z',
         'outlook', 'external', 'AAMk-meeting', 'AAMk-meeting', $3)`,
      [rowId, firm.id, owner.uid],
    );
    expect(seeded.rowCount).toBe(1);
    route('/me/events/AAMk-meeting', {
      status: 200,
      json: {
        id: 'AAMk-meeting', subject: 'Canceled: Opposing counsel sync', isAllDay: false, isCancelled: true,
        lastModifiedDateTime: FUTURE,
        start: { dateTime: '2026-10-07T15:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-10-07T16:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'updated',
      resource: 'me/events/AAMk-meeting', resourceData: { id: 'AAMk-meeting' },
    });

    expect(callsMatching('/me/events/AAMk-meeting')).toHaveLength(1);
    const { rows } = await testPool.query(`select id from calendar_events where id = $1`, [rowId]);
    expect(rows).toEqual([]);
  });
});
