/**
 * Inbound calendar sync gaps, one describe per gap:
 *
 *   REPEATING EVENTS. A notification reports a series by its parent, which was
 *   imported as one event on the first date and then duplicated by the full
 *   poll (which lists occurrences). A deleted series left its occurrences.
 *
 *   A SHARED ITEM DELETED FROM ONE MEMBER'S CALENDAR. A matter event removed
 *   from one member's Google calendar was cancelled for the whole firm, while
 *   every other member's copy stayed on their calendar.
 *
 *   THE CALENDAR-WIDE ECHO WINDOW. Any push to a member's Google calendar made
 *   the webhook drop every notification for 90 seconds, holding back real
 *   changes to unrelated events.
 *
 *   SWITCHING THE CALENDAR TARGET. The watch channel / subscription stayed on
 *   the old calendar, so live import from the new one never started.
 *
 *   DELETIONS THE POLL NEVER SAW. The full poll added and updated but never
 *   removed, so an event whose delete notification was missed stayed forever.
 *
 *   DISCONNECTING A PROVIDER. Every event imported from it stayed on the
 *   Paralegix calendar with nothing able to update or remove it.
 *
 *   NON-APPOINTMENTS. Google working-location markers, birthdays and declined
 *   invitations were imported as events.
 *
 *   A DURATION CHANGED IN THE PROVIDER on an event with no end of its own was
 *   dropped, and the next push reset it to one hour.
 *
 *   ONE MEETING ON BOTH CALENDARS. An invitation sent to a member's Google and
 *   Outlook calendars was imported once from each, and each import was then
 *   copied to the other calendar, so it showed twice everywhere.
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
  googleCalls,
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
const { normalizeICalUid } = require('../../src/modules/calendar/shared/calendarHelpers');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');

/** Newer than any fixture row's `updated_at`, so an inbound edit is not stale. */
const FUTURE = '2030-01-01T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

let firm: Firm;
let originalWebhookBase: string | undefined;

beforeAll(() => {
  originalWebhookBase = process.env.WEBHOOK_BASE_URL;
  process.env.WEBHOOK_BASE_URL = 'https://api-test.paralegix.test';
});

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  await drainEvents();
  // Let fire-and-forget cross-sync settle before the harness truncates.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

afterAll(() => {
  if (originalWebhookBase === undefined) delete process.env.WEBHOOK_BASE_URL;
  else process.env.WEBHOOK_BASE_URL = originalWebhookBase;
  uninstallGoogleFetchWall();
});

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function connectGoogle(uid: string, opts: { syncToken?: string; preferences?: object; appCalendarId?: string } = {}) {
  const res = await testPool.query(
    `with touched as (update users set preferences = $3::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens
       (user_id, provider, access_token, refresh_token, is_sync_to_provider, is_sync_from_provider, sync_cursor, app_calendar_id)
     values ($1, 'google', $2, 'refresh-seed', true, true, $4, $5)`,
    [uid, `g-${randomUUID().slice(0, 8)}`, JSON.stringify({ googleCalendarTarget: 'default', ...opts.preferences }),
      opts.syncToken ?? 'token-live', opts.appCalendarId ?? null],
  );
  expect(res.rowCount).toBe(1);
}

/** The mailbox timezone is seeded so no case has to route the lookup. */
async function connectMicrosoft(uid: string) {
  const res = await testPool.query(
    `insert into user_oauth_tokens
       (user_id, provider, access_token, refresh_token, meta, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', $2, 'ms-refresh-seed', $3::jsonb, true, true)`,
    [uid, `ms-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ outlookTimezone: 'UTC', outlookMailboxTimezoneWritable: true })],
  );
  expect(res.rowCount).toBe(1);
}

async function seedGoogleChannel(uid: string, opts: { lastOutboundPushAt?: Date } = {}) {
  const channelId = `chan-${randomUUID()}`;
  const res = await testPool.query(
    `insert into calendar_subscriptions
       (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration, last_outbound_push_at)
     values ('google', $1, $2, $3, 'primary', $4, 'channel-token', now() + interval '7 days', $5)`,
    [channelId, uid, firm.id, `res-${channelId}`, opts.lastOutboundPushAt ?? null],
  );
  expect(res.rowCount).toBe(1);
  return channelId;
}

/** A row imported from `provider` for `uid`, optionally also copied to the other one. */
async function seedImported(uid: string, opts: {
  provider: 'google' | 'outlook';
  googleEventId?: string | null;
  outlookId?: string | null;
  startsAt?: string;
  title?: string;
}) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into calendar_events (id, law_firm_id, title, starts_at, ends_at, provider, source,
       external_event_id, google_event_id, outlook_id, created_by, updated_at)
     values ($1, $2, $3, $4, $4::timestamptz + interval '1 hour', $5, 'external', $6, $7, $8, $9, '2026-01-01T00:00:00Z')`,
    [id, firm.id, opts.title ?? 'Imported', opts.startsAt ?? '2026-10-07T15:00:00Z', opts.provider,
      opts.provider === 'google' ? opts.googleEventId : opts.outlookId,
      opts.googleEventId ?? null, opts.outlookId ?? null, uid],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** The mapping every copy Paralegix pushes to a calendar gets, before anything else. */
async function seedCopyMapping(provider: 'google' | 'outlook', externalEventId: string, userId: string, rowId: string) {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, item_key)
     values ($1, $2, 'primary', $3, $4, 'externalEvent', $5, 'external')`,
    [provider, externalEventId, userId, firm.id, rowId],
  );
  expect(res.rowCount).toBe(1);
}

async function seedMatterEvent(opts: { createdBy: string; date: string; endsAt?: string | null; calendarSync: object }) {
  const matterId = randomUUID();
  const matter = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Bell v. Ward', $3)`,
    [matterId, firm.id, `M-${matterId.slice(0, 8)}`],
  );
  expect(matter.rowCount).toBe(1);
  const eventId = randomUUID();
  const event = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, type, title, date, ends_at, created_by, calendar_sync)
     values ($1, $2, $3, 'hearing', 'Motion hearing', $4, $5, $6, $7::jsonb)`,
    [eventId, firm.id, matterId, opts.date, opts.endsAt ?? null, opts.createdBy, JSON.stringify(opts.calendarSync)],
  );
  expect(event.rowCount).toBe(1);
  return { matterId, eventId };
}

async function seedMatterMapping(provider: 'google' | 'outlook', externalEventId: string, userId: string, eventId: string, matterId: string) {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, scope_id, item_key)
     values ($1, $2, 'primary', $3, $4, 'matterEvent', $5, $6, 'event')`,
    [provider, externalEventId, userId, firm.id, eventId, matterId],
  );
  expect(res.rowCount).toBe(1);
}

const importedTitles = async (uid: string) => (await testPool.query(
  `select title, provider from calendar_events where created_by = $1 order by title`, [uid],
)).rows;

async function waitFor<T>(check: () => Promise<T | null | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function googleOccurrence(seriesId: string, startIso: string, title = 'Weekly team sync') {
  const stamp = startIso.replace(/[-:]/g, '').replace('.000', '');
  const end = new Date(new Date(startIso).getTime() + 30 * 60 * 1000).toISOString();
  return {
    id: `${seriesId}_${stamp}`, recurringEventId: seriesId, summary: title, status: 'confirmed', updated: FUTURE,
    start: { dateTime: startIso }, end: { dateTime: end },
  };
}

describeNetworkWall();

// ── repeating events ────────────────────────────────────────────────────────

describe('a repeating event', () => {
  const soon = (days: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + days, 15)).toISOString();

  /**
   * Goes red if the parent is imported instead of its occurrences (one row on
   * the first date, and the legacy parent row survives), or if occurrences are
   * copied to the member's Outlook calendar as one-off events.
   */
  test('Google: arrives as its occurrences, replaces a parent imported the old way, and is not copied to Outlook', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'gweekly', title: 'Legacy parent row' });
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'gweekly', summary: 'Weekly team sync', status: 'confirmed', updated: FUTURE,
          recurrence: ['RRULE:FREQ=WEEKLY'], start: { dateTime: soon(1) }, end: { dateTime: soon(1) },
        }],
      },
    });
    route('/events/gweekly/instances', {
      status: 200,
      json: { items: [googleOccurrence('gweekly', soon(1)), googleOccurrence('gweekly', soon(8)), googleOccurrence('gweekly', soon(15))] },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(
      `select google_event_id, starts_at from calendar_events where created_by = $1 order by starts_at`, [owner.uid],
    );
    expect(rows.map((r: any) => r.google_event_id)).toEqual([
      googleOccurrence('gweekly', soon(1)).id,
      googleOccurrence('gweekly', soon(8)).id,
      googleOccurrence('gweekly', soon(15)).id,
    ]);
    expect(rows[1].starts_at.toISOString()).toBe(soon(8));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(googleCalls().filter((c) => c.url.includes('graph.microsoft.com'))).toEqual([]);
  });

  /** Goes red if a deleted series leaves its occurrences behind. */
  test('Google: deleting the series removes every occurrence', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'gweekly_20261001T150000Z', title: 'Occurrence 1' });
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'gweekly_20261008T150000Z', title: 'Occurrence 2' });
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'gother', title: 'Unrelated' });
    route('syncToken=token-live', {
      status: 200,
      json: { nextSyncToken: 'token-after', items: [{ id: 'gweekly', status: 'cancelled' }] },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect(await importedTitles(owner.uid)).toEqual([{ title: 'Unrelated', provider: 'google' }]);
  });

  /** Goes red if an Outlook series master is imported as one event. */
  test('Outlook: a series master arrives as its occurrences', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    route('/me/events/AAMk-series/instances', {
      status: 200,
      json: {
        value: [1, 8].map((d) => ({
          id: `AAMk-occ-${d}`, type: 'occurrence', seriesMasterId: 'AAMk-series', subject: 'Standup',
          isAllDay: false, lastModifiedDateTime: FUTURE,
          start: { dateTime: soon(d).replace('Z', ''), timeZone: 'UTC' },
          end: { dateTime: soon(d).replace('.000Z', '.500'), timeZone: 'UTC' },
        })),
      },
    }, { method: 'GET' });
    route(/\/me\/events\/AAMk-series$/, {
      status: 200,
      json: {
        id: 'AAMk-series', type: 'seriesMaster', subject: 'Standup', isAllDay: false, lastModifiedDateTime: FUTURE,
        start: { dateTime: soon(1).replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: soon(1).replace('Z', ''), timeZone: 'UTC' },
      },
    }, { method: 'GET' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'created',
      resource: 'me/events/AAMk-series', resourceData: { id: 'AAMk-series' },
    });

    const { rows } = await testPool.query(
      `select outlook_id, series_event_id from calendar_events where created_by = $1 order by starts_at`, [owner.uid],
    );
    expect(rows).toEqual([
      { outlook_id: 'AAMk-occ-1', series_event_id: 'AAMk-series' },
      { outlook_id: 'AAMk-occ-8', series_event_id: 'AAMk-series' },
    ]);
  });
});

// ── a shared matter event removed from one member's calendar ────────────────

describe('a synced matter event deleted from one member\'s Google calendar', () => {
  /**
   * Goes red if the delete cancels the event for the firm again, or if it
   * stops unlinking this member's copies (the Google entry and mapping stay,
   * or the Outlook copy is never removed).
   */
  test('unlinks that member\'s copies and leaves the event active for everyone', async () => {
    const owner = await ownerOf(firm.id);
    const member = await memberWith(firm.id, ['calendar.sync']);
    await connectGoogle(member.uid);
    await connectMicrosoft(member.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, date: '2026-10-12T14:00:00Z',
      calendarSync: {
        google: { [member.uid]: { event: { eventId: 'g-hearing' } }, [owner.uid]: { event: { eventId: 'g-owner-copy' } } },
        outlook: { [member.uid]: { event: { eventId: 'AAMk-hearing', changeKey: 'CK-1' } } },
      },
    });
    await seedMatterMapping('google', 'g-hearing', member.uid, eventId, matterId);
    await seedMatterMapping('outlook', 'AAMk-hearing', member.uid, eventId, matterId);
    route('syncToken=token-live', {
      status: 200,
      json: { nextSyncToken: 'token-after', items: [{ id: 'g-hearing', status: 'cancelled' }] },
    });
    route('/me/events/AAMk-hearing', { status: 204 }, { method: 'DELETE' });

    await googleService.processWatchNotification({ userId: member.uid, lawFirmId: firm.id });

    expect(callsMatching('/me/events/AAMk-hearing').map((c) => c.method)).toEqual(['DELETE']);
    const { rows } = await testPool.query(`select status, calendar_sync from events where id = $1`, [eventId]);
    expect(rows[0].status).not.toBe('cancelled');
    expect(rows[0].calendar_sync.google[member.uid]?.event).toBeUndefined();
    expect(rows[0].calendar_sync.outlook[member.uid]?.event).toBeUndefined();
    expect(rows[0].calendar_sync.google[owner.uid].event.eventId).toBe('g-owner-copy');
    const mappings = await testPool.query(`select provider from calendar_mappings where entity_id = $1`, [eventId]);
    expect(mappings.rows).toEqual([]);
  });
});

// ── the calendar-wide echo window ───────────────────────────────────────────

describe('a Google notification right after a push to that calendar', () => {
  /**
   * Goes red if the webhook drops notifications for a while after any push:
   * the new event below never arrives.
   */
  test('is still processed, so an unrelated new event arrives', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const channelId = await seedGoogleChannel(owner.uid, { lastOutboundPushAt: new Date() });
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-fresh', summary: 'Added a moment later', status: 'confirmed', updated: FUTURE,
          start: { dateTime: '2026-10-05T15:00:00Z' }, end: { dateTime: '2026-10-05T16:00:00Z' },
        }],
      },
    });

    const ack = await request().post('/api/webhooks/google-calendar').set({
      'x-goog-channel-id': channelId, 'x-goog-resource-state': 'exists', 'x-goog-channel-token': 'channel-token',
    }).send();
    expect(ack.status).toBe(200);

    await waitFor(async () => (await testPool.query(
      `select 1 from calendar_events where google_event_id = 'g-fresh'`,
    )).rows[0], 'the new event to be imported');
  });
});

// ── switching the calendar target ───────────────────────────────────────────

describe('switching which calendar Paralegix uses', () => {
  /**
   * Goes red if the target change stops re-pointing the watch channel: the old
   * channel stays and nothing watches the Paralegix calendar.
   */
  test('Google: the watch moves to the new calendar with a token read from it', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, { syncToken: 'token-of-primary', appCalendarId: 'paralegix-cal' });
    const oldChannel = await seedGoogleChannel(owner.uid);
    route('/channels/stop', { status: 204 }, { method: 'POST' });
    route('/calendars/paralegix-cal/events/watch', {
      status: 200, json: { resourceId: 'res-new', expiration: String(Date.now() + 7 * DAY_MS) },
    }, { method: 'POST' });
    route('/calendars/paralegix-cal/events?maxResults=2500&showDeleted=true', {
      status: 200, json: { items: [], nextSyncToken: 'token-of-paralegix-cal' },
    }, { method: 'GET' });

    const res = await owner.api.post(`/api/settings/user?lawFirmId=${firm.id}`)
      .send({ preferences: { googleCalendarTarget: 'paralegix' } });
    expect(res.status).toBe(200);

    expect(callsMatching('/channels/stop').map((c) => c.body.id)).toEqual([oldChannel]);
    expect(googleCalls().findIndex((call) => call.url.includes('/events/watch'))).toBeLessThan(googleCalls().findIndex((call) => call.url.includes('/channels/stop')));
    const channels = await testPool.query(
      `select id, calendar_id, law_firm_id from calendar_subscriptions where provider = 'google' and user_id = $1`, [owner.uid],
    );
    expect(channels.rows).toHaveLength(1);
    expect(channels.rows[0]).toMatchObject({ calendar_id: 'paralegix-cal', law_firm_id: firm.id });
    expect(channels.rows[0].id).not.toBe(oldChannel);
    const token = await testPool.query(
      `select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    );
    expect(token.rows[0].sync_cursor).toBe('token-of-paralegix-cal');

    // Saving the same target again re-points nothing.
    const again = await owner.api.post(`/api/settings/user?lawFirmId=${firm.id}`)
      .send({ preferences: { googleCalendarTarget: 'paralegix' } });
    expect(again.status).toBe(200);
    expect(callsMatching('/channels/stop')).toHaveLength(1);
  });

  /**
   * A channel created before the target changed (or before a target change
   * re-pointed it) still watches the main calendar, while every read goes to the
   * Paralegix calendar with the main calendar's token.
   *
   * Goes red if the notification stops re-pointing that channel: the delta is
   * read from the Paralegix calendar with a token Google issued for another
   * calendar, the channel stays on the main calendar, and nothing arrives.
   */
  test('Google: a notification on a channel still watching the old calendar moves it', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, {
      syncToken: 'token-of-primary',
      appCalendarId: 'paralegix-cal',
      preferences: { googleCalendarTarget: 'paralegix' },
    });
    const oldChannel = await seedGoogleChannel(owner.uid);
    route('/channels/stop', { status: 204 }, { method: 'POST' });
    route('/calendars/paralegix-cal/events/watch', {
      status: 200, json: { resourceId: 'res-new', expiration: String(Date.now() + 7 * DAY_MS) },
    }, { method: 'POST' });
    route('/calendars/paralegix-cal/events?maxResults=2500&showDeleted=true', {
      status: 200, json: { items: [], nextSyncToken: 'token-of-paralegix-cal' },
    }, { method: 'GET' });
    route('/calendars/paralegix-cal/events?timeMin=', {
      status: 200,
      json: {
        items: [{
          id: 'g-on-paralegix', summary: 'Added on the Paralegix calendar', status: 'confirmed', updated: FUTURE,
          start: { dateTime: '2026-10-05T15:00:00Z' }, end: { dateTime: '2026-10-05T16:00:00Z' },
        }],
      },
    }, { method: 'GET' });

    const ack = await request().post('/api/webhooks/google-calendar').set({
      'x-goog-channel-id': oldChannel, 'x-goog-resource-state': 'exists', 'x-goog-channel-token': 'channel-token',
    }).send();
    expect(ack.status).toBe(200);

    await waitFor(async () => (await testPool.query(
      `select 1 from calendar_events where google_event_id = 'g-on-paralegix'`,
    )).rows[0], 'the Paralegix calendar event to be imported');

    expect(callsMatching('/channels/stop').map((c) => c.body.id)).toEqual([oldChannel]);
    expect(callsMatching('syncToken=token-of-primary')).toHaveLength(0);
    const channels = await testPool.query(
      `select id, calendar_id from calendar_subscriptions where provider = 'google' and user_id = $1`, [owner.uid],
    );
    expect(channels.rows).toHaveLength(1);
    expect(channels.rows[0].calendar_id).toBe('paralegix-cal');
    const token = await testPool.query(
      `select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    );
    expect(token.rows[0].sync_cursor).toBe('token-of-paralegix-cal');
  });

  /** A member who never turned on live import is not given it by a target change. */
  test('Google: without a watch channel, only the stale token is cleared', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, { syncToken: 'token-of-primary', appCalendarId: 'paralegix-cal' });

    const res = await owner.api.post(`/api/settings/user?lawFirmId=${firm.id}`)
      .send({ preferences: { googleCalendarTarget: 'paralegix' } });
    expect(res.status).toBe(200);

    expect(googleCalls()).toEqual([]);
    const token = await testPool.query(
      `select sync_cursor from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    );
    expect(token.rows[0].sync_cursor).toBeNull();
  });

  /** Goes red if the Outlook subscription is not re-pointed at the new calendar. */
  test('Outlook: the subscription moves to the new calendar', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const prefs = await testPool.query(
      `update users set preferences = '{"outlookCalendarTarget":"default","paralegixCalendarId":"AAMk-cal"}'::jsonb where id = $1`,
      [owner.uid],
    );
    expect(prefs.rowCount).toBe(1);
    const seeded = await testPool.query(
      `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, resource, secret, expiration)
       values ('outlook', 'sub-old', $1, $2, '/me/calendar/events', 'client-state', now() + interval '2 days')`,
      [owner.uid, firm.id],
    );
    expect(seeded.rowCount).toBe(1);
    route('/v1.0/subscriptions/sub-old', { status: 204 }, { method: 'DELETE' });
    route(/\/v1\.0\/subscriptions$/, {
      status: 201, json: { id: 'sub-new', expirationDateTime: new Date(Date.now() + 2 * DAY_MS).toISOString() },
    }, { method: 'POST' });

    const res = await owner.api.post(`/api/settings/user?lawFirmId=${firm.id}`)
      .send({ preferences: { outlookCalendarTarget: 'paralegix' } });
    expect(res.status).toBe(200);

    expect(callsMatching('/v1.0/subscriptions/sub-old').map((c) => c.method)).toEqual(['DELETE']);
    const [create] = callsMatching(/\/v1\.0\/subscriptions$/);
    expect(create.body.resource).toBe('/me/calendars/AAMk-cal/events');
    const subs = await testPool.query(
      `select id, resource from calendar_subscriptions where provider = 'outlook' and user_id = $1`, [owner.uid],
    );
    expect(subs.rows).toEqual([{ id: 'sub-new', resource: '/me/calendars/AAMk-cal/events' }]);
  });

  /** A member on the Paralegix calendar whose subscription still watches the main one. */
  async function staleOutlookSubscription(uid: string, expiresIn = '2 days', replacementStatus = 201) {
    await connectMicrosoft(uid);
    const prefs = await testPool.query(
      `update users set preferences = '{"outlookCalendarTarget":"paralegix","paralegixCalendarId":"AAMk-cal"}'::jsonb where id = $1`,
      [uid],
    );
    expect(prefs.rowCount).toBe(1);
    const seeded = await testPool.query(
      `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, resource, secret, expiration)
       values ('outlook', 'sub-old', $1, $2, '/me/calendar/events', 'client-state', now() + $3::interval)`,
      [uid, firm.id, expiresIn],
    );
    expect(seeded.rowCount).toBe(1);
    route('/v1.0/subscriptions/sub-old', { status: 204 }, { method: 'DELETE' });
    route(/\/v1\.0\/subscriptions$/, replacementStatus === 201
      ? { status: 201, json: { id: 'sub-new', expirationDateTime: new Date(Date.now() + 2 * DAY_MS).toISOString() } }
      : { status: replacementStatus, json: { error: { code: 'InternalServerError' } } }, { method: 'POST' });
  }

  const outlookSubs = async (uid: string) => (await testPool.query(
    `select id, resource from calendar_subscriptions where provider = 'outlook' and user_id = $1`, [uid],
  )).rows;

  /**
   * Goes red if a notification from a subscription on the old calendar is
   * processed as usual: the main calendar's event is imported although the
   * member syncs only the Paralegix calendar, and the subscription stays where
   * it is (renewal extends it in place).
   */
  test('Outlook: a notification from a subscription on the old calendar moves it and imports nothing from there', async () => {
    const owner = await ownerOf(firm.id);
    await staleOutlookSubscription(owner.uid);
    route(/\/me\/events\/AAMk-main-evt/, {
      status: 200,
      json: {
        id: 'AAMk-main-evt', subject: 'On the main calendar', lastModifiedDateTime: FUTURE,
        start: { dateTime: '2026-10-05T15:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-10-05T16:00:00.0000000', timeZone: 'UTC' },
      },
    }, { method: 'GET' });
    route(/\/me\/calendars\/AAMk-cal$/, { status: 200, json: { id: 'AAMk-cal', name: 'Paralegix' } }, { method: 'GET' });
    route(/\/me\/calendars\/AAMk-cal\/calendarView\?/, {
      status: 200,
      json: {
        value: [{
          id: 'AAMk-paralegix-evt', subject: 'On the Paralegix calendar', lastModifiedDateTime: FUTURE,
          start: { dateTime: '2026-10-06T15:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-10-06T16:00:00.0000000', timeZone: 'UTC' },
        }],
      },
    }, { method: 'GET' });

    const ack = await request().post('/api/webhooks/outlook-calendar').send({
      value: [{
        subscriptionId: 'sub-old', changeType: 'created', clientState: 'client-state',
        resource: 'me/events/AAMk-main-evt', resourceData: { id: 'AAMk-main-evt' },
      }],
    });
    expect(ack.status).toBe(202);

    await waitFor(async () => (await testPool.query(
      `select 1 from calendar_events where outlook_id = 'AAMk-paralegix-evt'`,
    )).rows[0], 'the Paralegix calendar event to be imported');

    expect(callsMatching(/\/me\/events\/AAMk-main-evt/)).toHaveLength(0);
    expect(await importedTitles(owner.uid)).toEqual([{ title: 'On the Paralegix calendar', provider: 'outlook' }]);
    expect(callsMatching('/v1.0/subscriptions/sub-old').map((c) => c.method)).toEqual(['DELETE']);
    expect(await outlookSubs(owner.uid)).toEqual([{ id: 'sub-new', resource: '/me/calendars/AAMk-cal/events' }]);
  });

  /**
   * Goes red if renewal goes back to extending every subscription in place: a
   * PATCH keeps the resource, so one on the old calendar would stay there.
   */
  test('Outlook: renewal recreates a subscription on the old calendar instead of extending it', async () => {
    const owner = await ownerOf(firm.id);
    await staleOutlookSubscription(owner.uid, '2 hours');
    route('/v1.0/subscriptions/sub-old', { status: 200, json: {} }, { method: 'PATCH' });

    const result = await outlookService.renewExpiringSubscriptions();

    expect(result).toMatchObject({ renewed: 1, failed: 0 });
    expect(callsMatching('/v1.0/subscriptions/sub-old').map((c) => c.method)).toEqual(['DELETE']);
    expect(await outlookSubs(owner.uid)).toEqual([{ id: 'sub-new', resource: '/me/calendars/AAMk-cal/events' }]);
  });

  /**
   * Goes red if renewal stops the old subscription before its replacement
   * exists: when the create fails, the member is left with no subscription at
   * all and live import stops silently until they re-enable it.
   */
  test('Outlook: renewal keeps the old-calendar subscription when its replacement cannot be created', async () => {
    const owner = await ownerOf(firm.id);
    await staleOutlookSubscription(owner.uid, '2 hours', 500);

    const result = await outlookService.renewExpiringSubscriptions();

    expect(result).toMatchObject({ renewed: 0, failed: 1 });
    expect(callsMatching(/\/v1\.0\/subscriptions$/).map((c) => c.method)).toEqual(['POST']);
    expect(callsMatching('/v1.0/subscriptions/sub-old')).toEqual([]);
    expect(await outlookSubs(owner.uid)).toEqual([{ id: 'sub-old', resource: '/me/calendar/events' }]);
  });
});

// ── deletions the full poll catches ─────────────────────────────────────────

describe('the full poll', () => {
  const inWindow = () => new Date(Date.now() + 30 * DAY_MS).toISOString();

  /**
   * Goes red if the poll stops removing an event the provider no longer lists
   * (the missed delete survives), removes one it still lists, touches another
   * provider's import, or leaves the removed event's Outlook copy behind.
   */
  test('Google: removes an imported event Google no longer lists, and its Outlook copy', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    const start = inWindow();
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'g-still-there', title: 'Still there', startsAt: start });
    const deletedId = await seedImported(owner.uid, { provider: 'google', googleEventId: 'g-deleted', outlookId: 'AAMk-copy', title: 'Deleted in Google', startsAt: start });
    await seedCopyMapping('outlook', 'AAMk-copy', owner.uid, deletedId);
    await seedImported(owner.uid, { provider: 'outlook', outlookId: 'AAMk-own', title: 'From Outlook', startsAt: start });
    route('/calendars/primary/events?timeMin', {
      status: 200,
      json: { items: [{ id: 'g-still-there', summary: 'Still there', status: 'confirmed', updated: '2020-01-01T00:00:00Z', start: { dateTime: start }, end: { dateTime: start } }] },
    });
    route('/me/events/AAMk-copy', { status: 204 }, { method: 'DELETE' });

    const result = await googleService.syncFromGoogle({ userId: owner.uid, lawFirmId: firm.id });

    expect(result.removedCount).toBe(1);
    expect(await importedTitles(owner.uid)).toEqual([
      { title: 'From Outlook', provider: 'outlook' },
      { title: 'Still there', provider: 'google' },
    ]);
    expect(callsMatching('/me/events/AAMk-copy').map((c) => c.method)).toEqual(['DELETE']);
  });

  /**
   * With the Paralegix calendar targeted, the listing is a different calendar
   * from the one events were imported from. Goes red if its absences are read
   * as deletions.
   */
  test('Google: removes nothing when it lists the separate Paralegix calendar', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, { preferences: { googleCalendarTarget: 'paralegix' }, appCalendarId: 'paralegix-cal' });
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'g-main-cal', title: 'From the main calendar', startsAt: inWindow() });
    route('/calendars/paralegix-cal/events?timeMin', { status: 200, json: { items: [] } });

    const result = await googleService.syncFromGoogle({ userId: owner.uid, lawFirmId: firm.id });

    expect(result.removedCount).toBe(0);
    expect(await importedTitles(owner.uid)).toEqual([{ title: 'From the main calendar', provider: 'google' }]);
  });

  /** The Outlook mirror of the first case. */
  test('Outlook: removes an imported event Outlook no longer lists', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    const start = inWindow();
    await seedImported(owner.uid, { provider: 'outlook', outlookId: 'AAMk-gone', title: 'Deleted in Outlook', startsAt: start });
    await seedImported(owner.uid, { provider: 'outlook', outlookId: 'AAMk-kept', title: 'Still in Outlook', startsAt: start });
    route('/me/calendar/calendarView', {
      status: 200,
      json: { value: [{ id: 'AAMk-kept', subject: 'Still in Outlook', isAllDay: false, lastModifiedDateTime: '2020-01-01T00:00:00Z', start: { dateTime: start.replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: start.replace('Z', ''), timeZone: 'UTC' } }] },
    });

    const result = await outlookService.syncFromOutlook({ userId: owner.uid, lawFirmId: firm.id });

    expect(result.removedCount).toBe(1);
    expect(await importedTitles(owner.uid)).toEqual([{ title: 'Still in Outlook', provider: 'outlook' }]);
  });
});

// ── disconnecting a provider ────────────────────────────────────────────────

describe('disconnecting Google', () => {
  /**
   * Goes red if disconnecting leaves Google imports behind, deletes one that
   * is still on the member's connected Outlook calendar (it should move to
   * Outlook instead), or touches Outlook imports or another member's rows.
   */
  test('removes what came from Google, keeps what is also on Outlook, and leaves the rest', async () => {
    const owner = await ownerOf(firm.id);
    const colleague = await memberWith(firm.id, ['calendar.sync']);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'g-only', title: 'Only in Google' });
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'g-copied', outlookId: 'AAMk-copied', title: 'Also in Outlook' });
    await seedImported(owner.uid, { provider: 'outlook', outlookId: 'AAMk-native', title: 'From Outlook' });
    await seedImported(colleague.uid, { provider: 'google', googleEventId: 'g-colleague', title: 'Colleague import' });

    const res = await owner.api.post('/api/auth/unlink-google').send({});
    expect(res.status).toBe(200);

    expect(await importedTitles(owner.uid)).toEqual([
      { title: 'Also in Outlook', provider: 'outlook' },
      { title: 'From Outlook', provider: 'outlook' },
    ]);
    expect(await importedTitles(colleague.uid)).toEqual([{ title: 'Colleague import', provider: 'google' }]);
  });

  /** With the other calendar not connected, nothing from Google stays. */
  test('removes every Google import when Outlook is not connected', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const rowId = await seedImported(owner.uid, { provider: 'google', googleEventId: 'g-copied', outlookId: 'AAMk-copied', title: 'Also in Outlook' });
    await seedCopyMapping('outlook', 'AAMk-copied', owner.uid, rowId);

    const res = await owner.api.post('/api/auth/unlink-google').send({});
    expect(res.status).toBe(200);

    expect(await importedTitles(owner.uid)).toEqual([]);
    // Goes red if the removed row's mappings are left behind, pointing at nothing.
    const mappings = await testPool.query(`select 1 from calendar_mappings where entity_id = $1`, [rowId]);
    expect(mappings.rows).toEqual([]);
  });
});

// ── entries that are not appointments ───────────────────────────────────────

describe('Google entries that are not appointments', () => {
  /**
   * Goes red if working-location markers, birthdays or declined invitations
   * are imported, if one imported earlier is not removed, or if the filter
   * starts dropping real events (out-of-office and accepted invites stay).
   */
  test('are not imported, and earlier imports of them are removed', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await seedImported(owner.uid, { provider: 'google', googleEventId: 'g-home', title: 'Home (imported earlier)' });
    const at = { start: { dateTime: '2026-10-05T15:00:00Z' }, end: { dateTime: '2026-10-05T16:00:00Z' }, status: 'confirmed', updated: FUTURE };
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [
          { ...at, id: 'g-home', summary: 'Home', eventType: 'workingLocation' },
          { ...at, id: 'g-bday', summary: 'Sam\'s birthday', eventType: 'birthday' },
          { ...at, id: 'g-declined', summary: 'Vendor pitch', attendees: [{ email: 'me@firm.test', self: true, responseStatus: 'declined' }] },
          { ...at, id: 'g-accepted', summary: 'Client meeting', attendees: [{ email: 'me@firm.test', self: true, responseStatus: 'accepted' }] },
          { ...at, id: 'g-ooo', summary: 'Out of office', eventType: 'outOfOffice' },
        ],
      },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect(await importedTitles(owner.uid)).toEqual([
      { title: 'Client meeting', provider: 'google' },
      { title: 'Out of office', provider: 'google' },
    ]);
  });
});

// ── a duration changed in the provider ──────────────────────────────────────

describe('a synced matter event with no end of its own, changed in Google', () => {
  async function applyGoogleChange(start: string, end: string) {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    const { matterId, eventId } = await seedMatterEvent({
      createdBy: owner.uid, date: '2026-10-12T14:00:00Z',
      calendarSync: { google: { [owner.uid]: { event: { eventId: 'g-hearing' } } } },
    });
    await seedMatterMapping('google', 'g-hearing', owner.uid, eventId, matterId);
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{ id: 'g-hearing', summary: 'Motion hearing', status: 'confirmed', updated: FUTURE, start: { dateTime: start }, end: { dateTime: end } }],
      },
    });
    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });
    return (await testPool.query(`select date, ends_at from events where id = $1`, [eventId])).rows[0];
  }

  /** Goes red if a lengthened event's new end is dropped. */
  test('takes a lengthened duration', async () => {
    const row = await applyGoogleChange('2026-10-12T14:00:00Z', '2026-10-12T17:00:00Z');
    expect(row.ends_at.toISOString()).toBe('2026-10-12T17:00:00.000Z');
  });

  /** Goes red if the one-hour block the push itself filled in is saved as a real end. */
  test('does not invent an end from the default one-hour block', async () => {
    const row = await applyGoogleChange('2026-10-13T14:00:00Z', '2026-10-13T15:00:00Z');
    expect(row.date.toISOString()).toBe('2026-10-13T14:00:00.000Z');
    expect(row.ends_at).toBeNull();
  });
});

// ── an Outlook series deleted in Outlook ────────────────────────────────────

describe('an Outlook series deleted in Outlook', () => {
  /**
   * Graph reports only the series master's id. Goes red if the occurrences,
   * which name it in series_event_id, are not removed with it.
   */
  test('removes every imported occurrence at once', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    for (const [id, series] of [['AAMk-occ-1', 'AAMk-series'], ['AAMk-occ-2', 'AAMk-series'], ['AAMk-single', null]]) {
      const res = await testPool.query(
        `insert into calendar_events (law_firm_id, title, starts_at, provider, source, external_event_id, outlook_id, series_event_id, created_by)
         values ($1, $2, '2026-10-07T15:00:00Z', 'outlook', 'external', $2, $2, $3, $4)`,
        [firm.id, id, series, owner.uid],
      );
      expect(res.rowCount).toBe(1);
    }

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'deleted',
      resource: 'me/events/AAMk-series', resourceData: { id: 'AAMk-series' },
    });

    expect(await importedTitles(owner.uid)).toEqual([{ title: 'AAMk-single', provider: 'outlook' }]);
  });
});

// ── one meeting on both calendars ───────────────────────────────────────────

/**
 * What Graph reports as `iCalUId` for a meeting organized outside Exchange: the
 * hex of its Global Object Id, which wraps the invitation's own UID after the
 * "vCal-Uid" tag (MS-OXOCAL 2.2.1.27).
 */
function exchangeGlobalObjectIdHex(uid: string) {
  const header = Buffer.from('040000008200E00074C5B7101A82E008' + '00'.repeat(20), 'hex');
  const data = Buffer.concat([Buffer.from('vCal-Uid', 'latin1'), Buffer.from([1, 0, 0, 0]), Buffer.from(uid, 'utf8'), Buffer.from([0])]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([header, size, data]).toString('hex').toUpperCase();
}

describe('normalizeICalUid', () => {
  /** Goes red if Graph's wrapped form stops decoding to the UID Google reports. */
  test('unwraps a Google invitation\'s UID from the id Graph reports', () => {
    expect(normalizeICalUid(exchangeGlobalObjectIdHex('7kq2v9@google.com'))).toBe('7kq2v9@google.com');
    expect(normalizeICalUid('7KQ2V9@google.com')).toBe('7kq2v9@google.com');
  });

  /** A meeting organized in Exchange reaches Google with the hex id as its UID. */
  test('leaves an Exchange-generated id as lower-case hex on both sides', () => {
    const exchangeId = '040000008200E00074C5B7101A82E00800000000A1B2C3D4E5F6A7B8000000000000000010000000D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6';
    expect(normalizeICalUid(exchangeId)).toBe(exchangeId.toLowerCase());
    expect(normalizeICalUid(exchangeId.toLowerCase())).toBe(exchangeId.toLowerCase());
  });

  test('is null for nothing', () => {
    expect(normalizeICalUid(undefined)).toBeNull();
    expect(normalizeICalUid('  ')).toBeNull();
  });
});

describe('one meeting invited to both of a member\'s calendars', () => {
  const at = { start: { dateTime: '2026-10-09T15:00:00Z' }, end: { dateTime: '2026-10-09T16:00:00Z' } };
  const outlookAt = {
    start: { dateTime: '2026-10-09T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-09T16:00:00.0000000', timeZone: 'UTC' },
  };

  /**
   * The Google invitation is imported and copied to Outlook as usual; then the
   * same invitation arrives natively in Outlook.
   *
   * Goes red if the Outlook invitation is imported as a second event, if the
   * copy Paralegix pushed to Outlook is left there beside the real invitation,
   * or if the row is left pointing at that deleted copy.
   */
  test('ends as one event linked to both invitations, with Paralegix\'s copy removed', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{ ...at, id: 'g-invite', iCalUID: '7kq2v9@google.com', summary: 'Mediation', status: 'confirmed', updated: FUTURE }],
      },
    });
    route(/\/v1\.0\/me\/events$/, { status: 201, json: { id: 'AAMk-copy', changeKey: 'CK-1' } }, { method: 'POST' });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });
    const row = await waitFor(async () => (await testPool.query(
      `select id, ical_uid from calendar_events where google_event_id = 'g-invite' and outlook_id = 'AAMk-copy'`,
    )).rows[0], 'the Google invitation to be imported and copied to Outlook');
    expect(row.ical_uid).toBe('7kq2v9@google.com');

    route('/me/events/AAMk-native', {
      status: 200,
      json: {
        ...outlookAt, id: 'AAMk-native', subject: 'Mediation', isAllDay: false, changeKey: 'CK-N',
        iCalUId: exchangeGlobalObjectIdHex('7kq2v9@google.com'), lastModifiedDateTime: FUTURE,
      },
    }, { method: 'GET' });
    route('/me/events/AAMk-copy', { status: 204 }, { method: 'DELETE' });

    await outlookService.processSubscriptionNotification({
      userId: owner.uid, lawFirmId: firm.id, changeType: 'created',
      resource: 'me/events/AAMk-native', resourceData: { id: 'AAMk-native' },
    });

    const rows = (await testPool.query(
      `select id, provider, google_event_id, outlook_id from calendar_events where created_by = $1`, [owner.uid],
    )).rows;
    expect(rows).toEqual([{ id: row.id, provider: 'google', google_event_id: 'g-invite', outlook_id: 'AAMk-native' }]);
    expect(callsMatching('/me/events/AAMk-copy').map((c) => c.method)).toEqual(['DELETE']);
    const copyMapping = await testPool.query(`select 1 from calendar_mappings where external_event_id = 'AAMk-copy'`);
    expect(copyMapping.rows).toEqual([]);
  });

  async function seedLinkedPair(uid: string) {
    const res = await testPool.query(
      `insert into calendar_events (law_firm_id, title, starts_at, ends_at, provider, source, external_event_id,
         google_event_id, outlook_id, ical_uid, created_by, updated_at)
       values ($1, 'Mediation', '2026-10-09T15:00:00Z', '2026-10-09T16:00:00Z', 'google', 'external', 'g-invite',
         'g-invite', 'AAMk-native', '7kq2v9@google.com', $2, '2026-01-01T00:00:00Z')`,
      [firm.id, uid],
    );
    expect(res.rowCount).toBe(1);
  }

  /**
   * Both ids are the member's own invitations. Goes red if removing it from
   * Google deletes the member's real Outlook meeting, or drops the event from
   * Paralegix while it is still on their Outlook calendar.
   */
  test('removing it from Google leaves the Outlook invitation, and the event, in place', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    await seedLinkedPair(owner.uid);
    route('syncToken=token-live', {
      status: 200, json: { nextSyncToken: 'token-after', items: [{ id: 'g-invite', status: 'cancelled' }] },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

    expect(googleCalls().filter((c) => c.url.includes('graph.microsoft.com'))).toEqual([]);
    const { rows } = await testPool.query(
      `select provider, google_event_id, outlook_id from calendar_events where created_by = $1`, [owner.uid],
    );
    expect(rows).toEqual([{ provider: 'outlook', google_event_id: null, outlook_id: 'AAMk-native' }]);
  });

  /**
   * Goes red if a change to one invitation is pushed onto the member's other
   * invitation, overwriting it with Paralegix's copy of the details.
   */
  test('an edit on Google is applied here and not pushed onto the Outlook invitation', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    await connectMicrosoft(owner.uid);
    await seedLinkedPair(owner.uid);
    route('syncToken=token-live', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{ ...at, id: 'g-invite', iCalUID: '7kq2v9@google.com', summary: 'Mediation (moved room)', status: 'confirmed', updated: FUTURE }],
      },
    });

    await googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { rows } = await testPool.query(`select title from calendar_events where created_by = $1`, [owner.uid]);
    expect(rows).toEqual([{ title: 'Mediation (moved room)' }]);
    expect(googleCalls().filter((c) => c.url.includes('graph.microsoft.com'))).toEqual([]);
  });
});
