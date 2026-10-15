/**
 * What `calendar/google/google.service.ts` does to Paralegix data, with Google
 * itself replaced by a wall.
 *
 * The service is 1570 lines and was almost entirely uncovered. Its API calls are
 * the least interesting part of it: the expensive defects live in the bookkeeping
 * around them, because those are the ones that put a court date on the wrong
 * calendar or lose it altogether.
 *
 *   THE MAPPING TABLE decides create-versus-update. `calendar_mappings` is the
 *   durable answer to "have we already pushed this event?", consulted because
 *   the writeback field on the in-memory entity was read before the sync began.
 *   Lose that lookup and a firm gets two of every event on a concurrent save;
 *   lose the row on delete and the next sync patches an event that is gone.
 *
 *   THE TOKEN REFRESH decides whether the sync happens at all. A 401 has to
 *   drive exactly one refresh, persist the new access token, and retry with it;
 *   a REJECTED refresh token has to surface as "reconnect your account" without
 *   clobbering what is stored.
 *
 *   THE FIRM SCOPE decides whose calendar an inbound event lands on. An event
 *   arriving from a shared Google calendar must not create or update a row for a
 *   firm the syncing user does not belong to.
 *
 * NO LIVE GOOGLE CALL IS POSSIBLE HERE. `google.service.ts` imports no Google
 * SDK: every request it makes runs through `makeGoogleApiCall`, and every token
 * refresh through `refreshGoogleToken`, both of which call the global `fetch`.
 * `tests/calendar/support/googleFetch.ts` replaces `globalThis.fetch` at module
 * load with a router that answers only what a test registered and THROWS on
 * anything else. That wall is what makes the "no call was made" assertions in
 * this file mean something, so the first case below proves it is up before any
 * other case relies on it. It also matters for credentials: `tests/support/db.ts`
 * loads `backend/.env`, so a real `GOOGLE_CLIENT_SECRET` is in `process.env`
 * while these run, and an unmocked refresh would post it to Google.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  googleCalls,
  wallIsUp,
  BLOCKED,
} from './support/googleFetch';

// Before `setupInProcess` pulls in the app graph, so nothing can reach the
// network on the way in.
installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';

const googleService = require('../../src/modules/calendar/google/google.service');
const { getAdapter } = require('../../src/modules/calendar/shared/calendarAdapters');
const calendarSyncRepo = require('../../src/modules/calendar/shared/calendarSync.repository');

const CAL_LIST = 'users/me/calendarList';
const TOKEN_URL = 'oauth2.googleapis.com/token';

// ── fixtures ────────────────────────────────────────────────────────────────
// Plain SQL through the test pool. A fixture built by the repository under test
// cannot fail when that repository is wrong.

interface ConnectedUser {
  uid: string;
  accessToken: string;
}

/**
 * A firm member with Google connected.
 *
 * `getUserDataAndSettings` caches per user id for 5 seconds inside the process,
 * so every case gets its OWN user rather than a shared one. A reused id would
 * serve a later case the settings the earlier one saw.
 */
async function connectGoogle(
  firm: Firm,
  opts: {
    accessToken?: string;
    refreshToken?: string | null;
    outbound?: boolean;
    inbound?: boolean;
    target?: 'default' | 'paralegix';
    paralegixCalendarId?: string | null;
    syncToken?: string | null;
    member?: boolean;
  } = {},
): Promise<ConnectedUser> {
  const accessToken = opts.accessToken ?? `access-${randomUUID().slice(0, 8)}`;
  const uid = opts.member === false
    ? await seedBareUser()
    : (await createFirmMember(firm.id)).uid;

  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, $3)`,
    [uid, accessToken, opts.refreshToken === undefined ? 'refresh-seed' : opts.refreshToken],
  );
  expect(tokens.rowCount).toBe(1);

  const settings = await testPool.query(
    `with touched as (update users set preferences = $6::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider, app_calendar_id, sync_cursor)
     values ($1, 'google', $2, $3, $4, $5)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider, app_calendar_id = excluded.app_calendar_id, sync_cursor = excluded.sync_cursor`,
    [
      uid,
      opts.outbound ?? true,
      opts.inbound ?? true,
      opts.paralegixCalendarId ?? null,
      opts.syncToken ?? null,
      JSON.stringify({ googleCalendarTarget: opts.target ?? 'default' }),
    ],
  );
  expect(settings.rowCount).toBe(1);

  return { uid, accessToken };
}

/** A `users` row with no membership anywhere, for the cross-firm cases. */
async function seedBareUser() {
  const uid = `outsider-${randomUUID().slice(0, 8)}`;
  const res = await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, $3, 'firm_member')`,
    [uid, `${uid}@example.test`, 'Outsider'],
  );
  expect(res.rowCount).toBe(1);
  return uid;
}

async function seedMatter(firm: Firm) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Bell v. Ward', $3)`,
    [id, firm.id, `M-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/**
 * A matter event, optionally already carrying a per-user Google writeback.
 * `calendar_sync` is the jsonb map the adapters read through
 * `getGoogleEventId(data, key, userId)`.
 */
async function seedMatterEvent(
  firm: Firm,
  matterId: string,
  opts: { title?: string; date?: string; syncedEventId?: string; userId?: string } = {},
) {
  const id = randomUUID();
  const calendarSync = opts.syncedEventId && opts.userId
    ? { google: { [opts.userId]: { event: { eventId: opts.syncedEventId } } } }
    : {};
  const res = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, type, title, date, calendar_sync)
     values ($1, $2, $3, 'hearing', $4, $5, $6::jsonb)`,
    [id, firm.id, matterId, opts.title ?? 'Preliminary hearing',
      opts.date ?? '2026-09-10T14:00:00Z', JSON.stringify(calendarSync)],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMapping(opts: {
  externalEventId: string;
  firm: Firm;
  userId: string;
  entityType: string;
  entityId: string;
  scopeId?: string | null;
  itemKey?: string | null;
  calendarId?: string;
}) {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id,
        entity_type, entity_id, scope_id, item_key)
     values ('google', $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.externalEventId, opts.calendarId ?? 'primary', opts.userId, opts.firm.id,
      opts.entityType, opts.entityId, opts.scopeId ?? null, opts.itemKey ?? 'event',
    ],
  );
  expect(res.rowCount).toBe(1);
}

/** The entity snapshot the outbound adapters are handed by the event listeners. */
async function matterEventEntityData(firm: Firm, matterId: string, eventId: string) {
  const { rows } = await testPool.query(
    `select id, title, date, calendar_sync from events where id = $1`,
    [eventId],
  );
  expect(rows).toHaveLength(1);
  return {
    id: eventId,
    lawFirmId: firm.id,
    matterId,
    title: rows[0].title,
    date: rows[0].date,
    calendarSync: rows[0].calendar_sync,
  };
}

const mappingRows = async () => (await testPool.query(
  `select external_event_id, law_firm_id, entity_type, entity_id, scope_id, item_key,
          user_id, calendar_id
     from calendar_mappings order by external_event_id`,
)).rows;

const storedAccessToken = async (uid: string) => (await testPool.query(
  `select access_token from user_oauth_tokens where user_id = $1 and provider = 'google'`,
  [uid],
)).rows[0]?.access_token;

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  // Cross-sync to Outlook and the watch-channel stamp are both fire-and-forget.
  // Let them land against a live pool before the next truncate.
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

// ── the wall ────────────────────────────────────────────────────────────────

describe('the network wall', () => {
  /**
   * Goes red if `globalThis.fetch` is no longer replaced, if the router starts
   * answering unregistered urls instead of throwing, or if `getCalendars` stops
   * reaching Google at all. Every later case that asserts a call was NOT made
   * depends on this one holding.
   */
  test('blocks an unrouted Google request and records the attempt', async () => {
    const user = await connectGoogle(firm);

    expect(wallIsUp()).toBe(true);
    await expect(googleService.getCalendars(user.uid)).rejects.toThrow(BLOCKED);

    // The attempt is recorded, so this is not a case that passes because
    // nothing ran: the service really did try to reach googleapis.com.
    const attempts = callsMatching(CAL_LIST);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].method).toBe('GET');
    expect(attempts[0].bearer).toBe(user.accessToken);
  });
});

// ── token refresh ───────────────────────────────────────────────────────────

describe('token refresh', () => {
  /**
   * Goes red if the 401 branch stops refreshing, if the retry is dropped, if the
   * retry stops presenting the refreshed token, or if `saveAccessToken` stops
   * persisting it. The next case covers what happens to the REST of a call
   * sequence after a mid-sequence refresh, which this one cannot see.
   */
  test('refreshes on 401 and retries the call with the new access token', async () => {
    const user = await connectGoogle(firm, { accessToken: 'stale-token', refreshToken: 'refresh-abc' });

    route(CAL_LIST, [
      { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } },
      { status: 200, json: { items: [] } },
    ]);
    route(TOKEN_URL, { status: 200, json: { access_token: 'fresh-token', expires_in: 3599 } });

    const result = await googleService.getCalendars(user.uid);
    expect(result).toEqual({ calendars: [] });

    const refreshCalls = callsMatching(TOKEN_URL);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].body.grant_type).toBe('refresh_token');
    expect(refreshCalls[0].body.refresh_token).toBe('refresh-abc');

    // The retry must carry the NEW token, not the one that just got a 401.
    const profileCalls = callsMatching(CAL_LIST);
    expect(profileCalls.map((c) => c.bearer)).toEqual(['stale-token', 'fresh-token']);

    expect(await storedAccessToken(user.uid)).toBe('fresh-token');
  });

  /**
   * The refreshed token is written back onto the in-memory `userData` object,
   * which every remaining call in the same operation reads its bearer from. A
   * paged sync is the cheapest place to see that: the 401 lands on page one, and
   * page two has to go out on the new token.
   *
   * Goes red if `makeGoogleApiCall` stops assigning
   * `userData.googleAccessToken = newAccessToken`. Nothing breaks visibly in that
   * case, which is what makes it worth pinning: every subsequent request in the
   * operation would 401 and refresh again, so one page turn becomes two round
   * trips to Google's token endpoint and a long fan-out becomes dozens.
   */
  test('carries the refreshed token through the rest of a paged sync', async () => {
    const user = await connectGoogle(firm, { accessToken: 'stale-token', refreshToken: 'refresh-abc' });

    route(/\/calendars\/primary\/events\?/, (call, hit) => {
      if (hit === 0) return { status: 401, json: { error: { code: 401 } } };
      if (hit === 1) return { status: 200, json: { nextPageToken: 'page-2', items: [] } };
      return { status: 200, json: { items: [] } };
    });
    route(TOKEN_URL, { status: 200, json: { access_token: 'fresh-token' } });

    await googleService.syncFromGoogle({ userId: user.uid, lawFirmId: firm.id });

    // One refresh for the whole sequence, not one per page.
    expect(callsMatching(TOKEN_URL)).toHaveLength(1);
    expect(callsMatching('/calendars/primary/events?').map((c) => c.bearer))
      .toEqual(['stale-token', 'fresh-token', 'fresh-token']);
  });

  /**
   * A refresh token Google refuses (revoked access, changed password) must ask
   * the user to reconnect and leave the stored token alone.
   *
   * Goes red if `refreshGoogleToken` starts persisting on a non-ok response, if
   * the failed refresh stops raising `NO_REFRESH_TOKEN`, or if `getCalendars`
   * stops translating that code into `requiresReAuth`.
   */
  test('asks for re-auth when Google rejects the refresh token, leaving the stored token intact', async () => {
    const user = await connectGoogle(firm, { accessToken: 'stale-token', refreshToken: 'revoked-abc' });

    route(CAL_LIST, { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } });
    route(TOKEN_URL, { status: 400, json: { error: 'invalid_grant' } });

    const result = await googleService.getCalendars(user.uid);
    expect(result).toEqual({
      error: 'Token expired. Please reconnect your Google account.',
      status: 401,
      requiresReAuth: true,
    });

    expect(callsMatching(TOKEN_URL)).toHaveLength(1);
    // No retry: the original call was made once and never repeated.
    expect(callsMatching(CAL_LIST)).toHaveLength(1);
    expect(await storedAccessToken(user.uid)).toBe('stale-token');
  });

  /**
   * Goes red if a row with no refresh token is used at all: it cannot be
   * renewed, so it is answered as a reconnect without calling Google, and in
   * particular without calling Google's token endpoint with an empty token.
   *
   * The returned shape alone would NOT catch that: a blocked refresh throws,
   * `refreshGoogleToken` swallows it and returns null, and the caller lands on
   * the same `requiresReAuth` answer either way. The call counts are the
   * assertion that distinguishes them, and the previous case is what proves the
   * token endpoint is genuinely reachable through this wall when a refresh
   * token exists.
   */
  test('makes no token request at all when the user has no refresh token', async () => {
    const user = await connectGoogle(firm, { refreshToken: null });

    route(CAL_LIST, { status: 401, json: { error: { code: 401 } } });

    const result = await googleService.getCalendars(user.uid);
    expect(result).toEqual({
      error: 'Token expired. Please reconnect your Google account.',
      status: 401,
      requiresReAuth: true,
    });

    expect(callsMatching(CAL_LIST)).toHaveLength(0);
    expect(callsMatching(TOKEN_URL)).toHaveLength(0);
  });

  /**
   * `user_oauth_tokens` stores both providers for one user. Refreshing Google
   * must update only the Google row: losing the provider predicate would
   * silently replace the user's Microsoft bearer, disconnecting a healthy
   * Outlook calendar after an unrelated Google refresh.
   *
   * The successful retry proves this is a real refresh, rather than merely an
   * assertion over two untouched seed rows.
   */
  test("refreshing Google's token leaves this user's Microsoft token untouched", async () => {
    const user = await connectGoogle(firm, { accessToken: 'stale-google', refreshToken: 'google-refresh' });
    const microsoft = await testPool.query(
      `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
       values ($1, 'microsoft', 'microsoft-access-untouched', 'microsoft-refresh-untouched')`,
      [user.uid],
    );
    expect(microsoft.rowCount).toBe(1);

    route(CAL_LIST, [
      { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } },
      { status: 200, json: { items: [] } },
    ]);
    route(TOKEN_URL, { status: 200, json: { access_token: 'fresh-google' } });

    await expect(googleService.getCalendars(user.uid)).resolves.toEqual({ calendars: [] });

    expect(callsMatching(TOKEN_URL)).toHaveLength(1);
    expect(callsMatching(CAL_LIST).map((call) => call.bearer)).toEqual(['stale-google', 'fresh-google']);

    const { rows } = await testPool.query(
      `select provider, access_token, refresh_token from user_oauth_tokens
        where user_id = $1 order by provider`,
      [user.uid],
    );
    expect(rows).toEqual([
      { provider: 'google', access_token: 'fresh-google', refresh_token: 'google-refresh' },
      {
        provider: 'microsoft',
        access_token: 'microsoft-access-untouched',
        refresh_token: 'microsoft-refresh-untouched',
      },
    ]);
  });
});

// ── which calendar the events go to ─────────────────────────────────────────

describe('calendar resolution', () => {
  /**
   * The stored Paralegix calendar id is a fast path that exists to avoid
   * fetching the user's whole calendar list on every single sync.
   *
   * Goes red if `resolveCalendarId` stops consulting
   * `settings.paralegixGoogleCalendarId`: the list call would then appear, and
   * the event would be posted to a calendar this test did not name.
   */
  test('posts to the stored Paralegix calendar without listing calendars', async () => {
    const user = await connectGoogle(firm, { target: 'paralegix', paralegixCalendarId: 'cal-stored' });
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId);

    route('/calendars/cal-stored/events', { status: 200, json: { id: 'evt-created' } }, { method: 'POST' });

    const results = await googleService.createEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm, matterId, eventId),
      user.uid,
    );

    expect(results).toEqual([{ key: 'event', googleEventId: 'evt-created' }]);
    expect(callsMatching(CAL_LIST)).toHaveLength(0);
    expect(callsMatching('/calendars/')).toHaveLength(1);
  });

  /**
   * Goes red if the discovered/created calendar id stops being persisted through
   * `calendarTokens.saveSettings`, which is what turns the slow discovery path
   * into the fast path the previous case covers.
   */
  test('creates the Paralegix calendar when none exists and remembers its id', async () => {
    const user = await connectGoogle(firm, { target: 'paralegix' });

    route(CAL_LIST, { status: 200, json: { items: [{ id: 'primary', summary: 'Personal' }] } });
    route(/\/calendar\/v3\/calendars$/, {
      status: 200,
      json: { id: 'cal-new', summary: 'Paralegix', backgroundColor: '#112233' },
    }, { method: 'POST' });

    const result = await googleService.initParalegixCalendar(user.uid, 'America/New_York');
    expect(result).toMatchObject({
      success: true,
      calendar: { id: 'cal-new', name: 'Paralegix', color: '#112233' },
    });

    const { rows } = await testPool.query(
      `select app_calendar_id as paralegix_google_calendar_id from user_oauth_tokens
       where user_id = $1 and provider = 'google'`,
      [user.uid],
    );
    expect(rows[0].paralegix_google_calendar_id).toBe('cal-new');
  });

  /**
   * The cached Paralegix calendar id can go stale in a way an EVENT id never
   * does for a create: the whole calendar was deleted directly on the user's
   * Google account (or by hand in the API), not just one event inside it. A
   * 404/410 posting an event to that calendar id is a calendar-level miss,
   * distinct from the event-level 404/410 the update and delete paths already
   * recover from elsewhere in this file.
   *
   * Goes red if `createGoogleEventForItem` stops recreating the calendar on
   * this signal: the create would keep failing, `paralegixGoogleCalendarId`
   * would stay pointed at the dead id forever, and every future sync for this
   * user would repeat the same failing POST with no path back to a working
   * calendar - unlike a lost event, which self-heals on the very next save.
   */
  test('recreates the Paralegix calendar and retries when Google reports it gone', async () => {
    const user = await connectGoogle(firm, { target: 'paralegix', paralegixCalendarId: 'cal-deleted' });
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId);

    route('/calendars/cal-deleted/events', { status: 404, json: { error: { code: 404, message: 'Not Found' } } }, { method: 'POST' });
    // No "Paralegix" calendar left in the list, so it has to be created fresh.
    route(CAL_LIST, { status: 200, json: { items: [{ id: 'primary', summary: 'Personal' }] } });
    route(/\/calendar\/v3\/calendars$/, { status: 200, json: { id: 'cal-recreated', summary: 'Paralegix' } }, { method: 'POST' });
    route('/calendars/cal-recreated/events', { status: 200, json: { id: 'evt-recreated' } }, { method: 'POST' });

    const results = await googleService.createEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm, matterId, eventId),
      user.uid,
    );

    expect(results).toEqual([{ key: 'event', googleEventId: 'evt-recreated' }]);

    // The dead calendar was tried first, then discovery/creation, then the
    // retry against the fresh calendar - not a retry that skipped the failed
    // attempt, and not a recreation that never actually retried the event.
    const calls = googleCalls();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      expect.stringContaining('POST https://www.googleapis.com/calendar/v3/calendars/cal-deleted/events'),
      expect.stringContaining('POST https://www.googleapis.com/calendar/v3/calendars'),
      expect.stringContaining('POST https://www.googleapis.com/calendar/v3/calendars/cal-recreated/events'),
    ]);

    // The stored calendar id must move on, or the NEXT sync repeats today's
    // failure against the same dead id.
    const { rows } = await testPool.query(
      `select app_calendar_id as paralegix_google_calendar_id from user_oauth_tokens
       where user_id = $1 and provider = 'google'`,
      [user.uid],
    );
    expect(rows[0].paralegix_google_calendar_id).toBe('cal-recreated');

    // The mapping records the calendar the event actually lives on.
    expect(await mappingRows()).toEqual([{
      external_event_id: 'evt-recreated',
      law_firm_id: firm.id,
      entity_type: 'matterEvent',
      entity_id: eventId,
      scope_id: matterId,
      item_key: 'event',
      user_id: user.uid,
      calendar_id: 'cal-recreated',
    }]);
  });
});

// ── the mapping table ───────────────────────────────────────────────────────

describe('outbound sync and calendar_mappings', () => {
  /**
   * The duplicate guard. The entity snapshot was loaded before this sync began,
   * so its writeback field can be stale; `calendar_mappings` is written the
   * instant a create succeeds and is the row that stops a second POST.
   *
   * Goes red if `updateEventsFromEntity` drops the
   * `findMappingForEntityItem` fallback: it would POST a new event, and this
   * firm's calendar would carry two of the same hearing.
   */
  test('patches the mapped event instead of creating a second one', async () => {
    const user = await connectGoogle(firm);
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId);
    await seedMapping({
      externalEventId: 'evt-mapped',
      firm,
      userId: user.uid,
      entityType: 'matterEvent',
      entityId: eventId,
      scopeId: matterId,
    });

    route('/events/evt-mapped', { status: 200, json: { id: 'evt-mapped' } }, { method: 'PATCH' });

    const results = await googleService.updateEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm, matterId, eventId),
      user.uid,
    );

    expect(results).toEqual([{ key: 'event', action: 'updated', googleEventId: 'evt-mapped' }]);

    // One request only, and it is the PATCH. A create would show up here as a
    // POST to `/events` (which no route answers), so this is not an absence
    // assertion over an action that never ran.
    const calls = googleCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');

    expect(await mappingRows()).toHaveLength(1);
  });

  /**
   * Goes red if `saveMapping` is dropped from the create path, or if any of the
   * scoping columns stop being written: without `law_firm_id` on the row the
   * mapping cannot be attributed to a firm at all, and without `scope_id` the
   * matter event cannot be resolved back from an inbound webhook.
   */
  test('records the mapping under the entity firm when it creates the event', async () => {
    const user = await connectGoogle(firm);
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId);

    route('/calendars/primary/events', { status: 200, json: { id: 'evt-fresh' } }, { method: 'POST' });

    const results = await googleService.createEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm, matterId, eventId),
      user.uid,
    );
    expect(results).toEqual([{ key: 'event', googleEventId: 'evt-fresh' }]);

    expect(await mappingRows()).toEqual([{
      external_event_id: 'evt-fresh',
      law_firm_id: firm.id,
      entity_type: 'matterEvent',
      entity_id: eventId,
      scope_id: matterId,
      item_key: 'event',
      user_id: user.uid,
      calendar_id: 'primary',
    }]);

    // The per-user writeback is what the NEXT outbound sync reads before it
    // falls back to the mapping table.
    const { rows } = await testPool.query(
      `select calendar_sync from events where id = $1`, [eventId],
    );
    expect(rows[0].calendar_sync.google[user.uid].event.eventId).toBe('evt-fresh');
  });

  /**
   * C03: the provider create succeeds but recording it locally does not.
   * Neither `calendar_mappings` nor the entity writeback names the just-created
   * event, so without reconciliation the next pass over this item (an outbox
   * replay, or simply the next save) cannot find it and posts a SECOND event -
   * a genuine duplicate on the user's real calendar, not merely a stuck sync.
   *
   * Google's create endpoint offers no client-supplied idempotency key here (no
   * `id` field is sent), so the only reconciliation available is a compensating
   * delete: undo the provider-side create when the local record fails to save,
   * so the next attempt starts clean instead of creating a duplicate.
   *
   * Goes red if `createGoogleEventForItem` stops attempting that compensating
   * delete: the orphaned `evt-orphan` would never be removed, and the retry
   * below would leave TWO live Google events for one Paralegix item.
   */
  test('compensates with a delete when the mapping save fails after a successful create, so a retry does not duplicate', async () => {
    const user = await connectGoogle(firm);
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId);

    route('/calendars/primary/events', [
      { status: 200, json: { id: 'evt-orphan' } },
      { status: 200, json: { id: 'evt-final' } },
    ], { method: 'POST' });
    route('/events/evt-orphan', { status: 204 }, { method: 'DELETE' });

    const saveMappingSpy = jest.spyOn(calendarSyncRepo, 'saveMapping')
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    try {
      const firstPass = await googleService.createEventsFromEntity(
        getAdapter('matterEvent'),
        await matterEventEntityData(firm, matterId, eventId),
        user.uid,
      );

      // The item failed this pass (its mapping never recorded), so it produces
      // no result entry - but the compensating delete must have already run.
      expect(firstPass).toBeNull();
      expect(await mappingRows()).toHaveLength(0);

      const callsAfterFirstPass = googleCalls();
      expect(callsAfterFirstPass.map((c) => `${c.method} ${c.url.includes('/events/evt-orphan') ? 'evt-orphan' : 'create'}`))
        .toEqual(['POST create', 'DELETE evt-orphan']);

      // Retry (the real next pass, e.g. the outbox redelivering the same
      // create): the mapping save succeeds this time.
      const secondPass = await googleService.createEventsFromEntity(
        getAdapter('matterEvent'),
        await matterEventEntityData(firm, matterId, eventId),
        user.uid,
      );

      expect(secondPass).toEqual([{ key: 'event', googleEventId: 'evt-final' }]);

      // Exactly one live mapping, pointing at the surviving event - not the
      // compensated-away orphan, and not two rows for the same item.
      expect(await mappingRows()).toEqual([{
        external_event_id: 'evt-final',
        law_firm_id: firm.id,
        entity_type: 'matterEvent',
        entity_id: eventId,
        scope_id: matterId,
        item_key: 'event',
        user_id: user.uid,
        calendar_id: 'primary',
      }]);

      // Two creates were attempted (one orphaned, one that stuck) and exactly
      // one compensating delete - never a second delete, never a third create.
      const allCalls = googleCalls();
      expect(allCalls.filter((c) => c.method === 'POST')).toHaveLength(2);
      expect(allCalls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    } finally {
      saveMappingSpy.mockRestore();
    }
  });

  /**
   * Writeback/mapping disagreement recovery. The mapping still names an event
   * Google no longer has - deleted directly on the user's real calendar, or left
   * behind by a delete whose `deleteMapping` write failed after the provider
   * side already succeeded (`deleteGoogleEventByKey` clears the writeback and
   * removes the mapping as two separate steps; a failure of the second alone
   * leaves exactly this state). Before the fix, a PATCH against a gone id just
   * logged an error and the item never synced again: every later save repeated
   * the same failing PATCH forever with no way to reconcile.
   *
   * Goes red if `updateEventsFromEntity` stops treating a 404/410 on the PATCH
   * as "the mapped event is gone": it would keep failing the same PATCH every
   * sync instead of dropping the stale mapping and creating a replacement.
   */
  test('recreates the event and replaces the mapping when Google reports the mapped id gone', async () => {
    const user = await connectGoogle(firm);
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId);
    await seedMapping({
      externalEventId: 'evt-stale',
      firm,
      userId: user.uid,
      entityType: 'matterEvent',
      entityId: eventId,
      scopeId: matterId,
    });

    route('/events/evt-stale', { status: 404, json: { error: { code: 404, message: 'Not Found' } } }, { method: 'PATCH' });
    route('/calendars/primary/events', { status: 200, json: { id: 'evt-fresh' } }, { method: 'POST' });

    const results = await googleService.updateEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm, matterId, eventId),
      user.uid,
    );

    expect(results).toEqual([{ key: 'event', action: 'recreated', googleEventId: 'evt-fresh' }]);

    // The failed PATCH happened first, and the recovery POST second - not a
    // create that ran without ever noticing the mapped id was dead.
    const calls = googleCalls();
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);

    // The stale row is gone; only the fresh event is mapped now.
    expect(await mappingRows()).toEqual([{
      external_event_id: 'evt-fresh',
      law_firm_id: firm.id,
      entity_type: 'matterEvent',
      entity_id: eventId,
      scope_id: matterId,
      item_key: 'event',
      user_id: user.uid,
      calendar_id: 'primary',
    }]);

    const { rows } = await testPool.query(
      `select calendar_sync from events where id = $1`, [eventId],
    );
    expect(rows[0].calendar_sync.google[user.uid].event.eventId).toBe('evt-fresh');
  });

  /**
   * Goes red if `deleteGoogleEventByKey` stops calling `deleteMapping`, which
   * would leave a mapping pointing at an event that no longer exists and make
   * the next outbound sync patch a dead id forever.
   */
  test('drops the mapping when Google accepts the delete', async () => {
    const user = await connectGoogle(firm);
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId, {
      syncedEventId: 'evt-live', userId: undefined,
    });
    // Writeback has to be keyed by the syncing user for the adapter to see it.
    await testPool.query(
      `update events set calendar_sync = $2::jsonb where id = $1`,
      [eventId, JSON.stringify({ google: { [user.uid]: { event: { eventId: 'evt-live' } } } })],
    );
    await seedMapping({
      externalEventId: 'evt-live',
      firm,
      userId: user.uid,
      entityType: 'matterEvent',
      entityId: eventId,
      scopeId: matterId,
    });

    route('/events/evt-live', { status: 204 }, { method: 'DELETE' });

    const results = await googleService.deleteEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm, matterId, eventId),
      user.uid,
    );
    expect(results).toEqual([{ key: 'event', action: 'deleted' }]);
    expect(await mappingRows()).toHaveLength(0);
  });

  /**
   * A 404 on the delete means the remote event is ALREADY gone, which is the
   * same end state the caller asked for. This is C06 (delete replay after the
   * provider already deleted the event): the mapping and the entity's own
   * writeback must converge on "no event" instead of surviving forever pointed
   * at a dead id, and recovery must not create a replacement (unlike the
   * update-side 404 handling, which correctly DOES recreate - a delete asked
   * for the event to be gone, so "gone" is success, not something to repair
   * by making a new one).
   *
   * Goes red if `deleteGoogleEventByKey` stops treating 404/410 as a converged
   * delete: it would keep returning `false` and leave the stale mapping row and
   * writeback in place, as it did before this fix (see git history for the
   * previous version of this test, which pinned that behaviour deliberately
   * without endorsing it).
   */
  test('converges the mapping and writeback when Google answers 404 on delete (already gone)', async () => {
    const user = await connectGoogle(firm);
    const matterId = await seedMatter(firm);
    const eventId = await seedMatterEvent(firm, matterId);
    await testPool.query(
      `update events set calendar_sync = $2::jsonb where id = $1`,
      [eventId, JSON.stringify({ google: { [user.uid]: { event: { eventId: 'evt-ghost' } } } })],
    );
    await seedMapping({
      externalEventId: 'evt-ghost',
      firm,
      userId: user.uid,
      entityType: 'matterEvent',
      entityId: eventId,
      scopeId: matterId,
    });

    route('/events/evt-ghost', { status: 404, json: { error: { code: 404 } } }, { method: 'DELETE' });

    const results = await googleService.deleteEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm, matterId, eventId),
      user.uid,
    );

    // The DELETE was really attempted; convergence is a real reaction to the
    // 404, not a no-op that never noticed the row existed.
    expect(callsMatching('/events/evt-ghost')).toHaveLength(1);
    expect(results).toEqual([{ key: 'event', action: 'deleted' }]);

    // No new event is created by recovery: the DELETE call above is the only
    // Google request made.
    expect(googleCalls()).toHaveLength(1);

    // The stale mapping is gone.
    expect(await mappingRows()).toHaveLength(0);

    // The entity's own writeback no longer names the dead event.
    const { rows } = await testPool.query(
      `select calendar_sync from events where id = $1`, [eventId],
    );
    expect(rows[0].calendar_sync.google?.[user.uid]?.event).toBeUndefined();
  });
});

// ── inbound ─────────────────────────────────────────────────────────────────

describe('privacy on a copied meeting', () => {
  async function seedImported(provider: 'google' | 'outlook', isPrivate: boolean) {
    const id = randomUUID();
    const inserted = await testPool.query(
      `insert into calendar_events (id, law_firm_id, title, starts_at, ends_at, provider, source, provider_details)
       values ($1, $2, 'Settlement talks', '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z', $3, 'external', $4::jsonb)`,
      [id, firm.id, provider, JSON.stringify({ isPrivate })],
    );
    expect(inserted.rowCount).toBe(1);
    return {
      id, lawFirmId: firm.id, title: 'Settlement talks', provider,
      start: new Date('2026-09-01T14:00:00Z'), end: new Date('2026-09-01T15:00:00Z'), allDay: false,
      meeting: { isPrivate },
    };
  }

  /**
   * Goes red if the copy Paralegix pushes to Google drops the privacy of an
   * Outlook meeting: colleagues who can see the Google calendar read a private
   * meeting's title and details.
   */
  test('a private Outlook meeting is copied to Google as private', async () => {
    const user = await connectGoogle(firm);
    route('/calendars/primary/events', { status: 200, json: { id: 'evt-private-copy' } }, { method: 'POST' });

    const results = await googleService.createEventsFromEntity(getAdapter('externalEvent'), await seedImported('outlook', true), user.uid);

    expect(results).toEqual([{ key: 'external', googleEventId: 'evt-private-copy' }]);
    const [create] = callsMatching('/calendars/primary/events').filter((c) => c.method === 'POST');
    expect(create.body.visibility).toBe('private');
  });

  /**
   * Goes red if privacy is set on every push rather than only on a private
   * meeting's copy: an ordinary meeting would turn private.
   */
  test('a meeting that is not private is copied without a visibility', async () => {
    const user = await connectGoogle(firm);
    route('/calendars/primary/events', { status: 200, json: { id: 'evt-public-copy' } }, { method: 'POST' });

    const results = await googleService.createEventsFromEntity(getAdapter('externalEvent'), await seedImported('outlook', false), user.uid);

    expect(results).toEqual([{ key: 'external', googleEventId: 'evt-public-copy' }]);
    const [create] = callsMatching('/calendars/primary/events').filter((c) => c.method === 'POST');
    expect(create.body).not.toHaveProperty('visibility');
  });
});

describe('syncFromGoogle', () => {
  /**
   * Goes red if the `nextPageToken` loop is removed (the second page's event
   * disappears) or if the `status === 'cancelled'` skip is removed (the
   * cancelled event turns into a live local row).
   */
  test('follows nextPageToken and skips cancelled events', async () => {
    const user = await connectGoogle(firm);

    route(/\/calendars\/primary\/events\?/, (call, hit) => (hit === 0
      ? {
        status: 200,
        json: {
          nextPageToken: 'page-2',
          items: [
            { id: 'g-live-1', summary: 'Deposition of Ward', status: 'confirmed', start: { dateTime: '2026-09-01T15:00:00Z' }, end: { dateTime: '2026-09-01T16:00:00Z' } },
            { id: 'g-dead', summary: 'Cancelled conference', status: 'cancelled', start: { dateTime: '2026-09-02T15:00:00Z' } },
          ],
        },
      }
      : {
        status: 200,
        json: {
          items: [
            { id: 'g-live-2', summary: 'Status conference', status: 'confirmed', start: { dateTime: '2026-09-03T15:00:00Z' }, end: { dateTime: '2026-09-03T16:00:00Z' } },
          ],
        },
      }));

    const result = await googleService.syncFromGoogle({ userId: user.uid, lawFirmId: firm.id });
    expect(result).toMatchObject({ createdCount: 2, updatedCount: 0, syncedCount: 2 });

    // Two list requests, so the paging really happened.
    expect(callsMatching('/calendars/primary/events?')).toHaveLength(2);
    expect(callsMatching('pageToken=page-2')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select title, google_event_id from calendar_events where law_firm_id = $1 order by title`,
      [firm.id],
    );
    expect(rows.map((r) => r.google_event_id)).toEqual(['g-live-1', 'g-live-2']);
    // 'g-dead' was in the payload and is not here, which is the skip working
    // rather than the sync having failed: its two siblings landed.
    expect(rows.map((r) => r.title)).toEqual(['Deposition of Ward', 'Status conference']);
  });

  /**
   * The inbound toggle has to be checked BEFORE Google is called, not after.
   *
   * One test covers both users so the absence for the disabled one is measured
   * against a user who did produce a call from the same fixture shape. Goes red
   * if the `allowGoogleToParalegixSync` guard moves below the fetch or is
   * dropped.
   */
  test('refuses a disabled inbound sync without contacting Google', async () => {
    const off = await connectGoogle(firm, { inbound: false });
    const on = await connectGoogle(firm, { inbound: true });

    route(/\/calendars\/primary\/events\?/, { status: 200, json: { items: [] } });

    await expect(googleService.syncFromGoogle({ userId: off.uid, lawFirmId: firm.id }))
      .rejects.toThrow('Google to Paralegix sync not enabled');
    expect(googleCalls()).toHaveLength(0);

    await googleService.syncFromGoogle({ userId: on.uid, lawFirmId: firm.id });
    expect(googleCalls()).toHaveLength(1);
  });

  /**
   * Firm scoping on the create path. A brand-new external event is only written
   * after `membersRepo.findByUserId(lawFirmId, userId)` confirms the syncing
   * user belongs to the firm the sync was requested for.
   *
   * Goes red if that membership check is dropped: the outsider's identical event
   * would then land in a firm they have no relationship with.
   */
  test('creates the external event for a member and nothing for a non-member', async () => {
    const member = await connectGoogle(firm);
    const outsider = await connectGoogle(firm, { member: false });

    const payload = {
      status: 200,
      json: {
        items: [{
          id: 'g-scoped',
          summary: 'Client intake',
          status: 'confirmed',
          start: { dateTime: '2026-09-04T15:00:00Z' },
          end: { dateTime: '2026-09-04T16:00:00Z' },
        }],
      },
    };
    route(/\/calendars\/primary\/events\?/, payload);

    const refused = await googleService.syncFromGoogle({ userId: outsider.uid, lawFirmId: firm.id });
    expect(refused).toMatchObject({ createdCount: 0, syncedCount: 0 });
    expect(callsMatching('/calendars/primary/events?')).toHaveLength(1);
    expect((await testPool.query(
      `select id from calendar_events where law_firm_id = $1`, [firm.id],
    )).rowCount).toBe(0);

    const accepted = await googleService.syncFromGoogle({ userId: member.uid, lawFirmId: firm.id });
    expect(accepted).toMatchObject({ createdCount: 1 });
    const { rows } = await testPool.query(
      `select title, created_by from calendar_events where law_firm_id = $1`, [firm.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Client intake', created_by: member.uid });
  });
});

export {};
