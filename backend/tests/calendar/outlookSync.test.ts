/**
 * Outlook (Microsoft Graph) calendar sync: the decisions, not the API calls.
 *
 * `outlook.service.ts` is the largest untested file in the calendar module, and
 * the parts worth pinning are the ones that decide WHICH row is written rather
 * than the ones that shape a Graph request body: the `calendar_mappings`
 * reverse-index that stops a second copy of a court date landing on a lawyer's
 * real calendar, the `calendar_subscriptions` lifecycle, the retry/terminal
 * classification of a failed event fetch, and the firm scoping on every inbound
 * lookup. A defect in any of those is invisible on screen and expensive in a
 * law firm.
 *
 * ── NO LIVE MICROSOFT CALL IS POSSIBLE HERE ─────────────────────────────────
 *
 * `backend/.env` is loaded by the harness (`tests/support/db.ts`) and may hold a
 * real `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`. Every Graph and OAuth
 * request in this module goes through ONE mechanism, the global `fetch`
 * (`makeMicrosoftGraphCall` and `refreshMicrosoftToken` in
 * `shared/calendarHelpers.ts` both call it directly, and nothing here uses an
 * HTTP client of its own). So containment is:
 *
 *   1. `globalThis.fetch` is replaced for the lifetime of this file by a router
 *      that answers only URLs a test registered and THROWS on everything else.
 *      An escape is a loud failure, never a silent request.
 *   2. The Microsoft OAuth credentials are replaced with deliberately invalid
 *      values, so even a call that somehow bypassed the router could not
 *      authenticate. This mirrors `tests/stripe/stripeWebhookState.test.ts`,
 *      which runs against an invalid key to prove no path depends on the real
 *      one.
 *
 * The first two cases below assert both are in force AND that a real service
 * surface reaches the router. Without that, every later "no call was made"
 * assertion would be vacuous.
 *
 * Fixtures are plain SQL through `testPool`. Every seed asserts its own
 * rowCount, because a fixture that silently failed to insert turns an
 * absence-of-effect assertion into a false green.
 */

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';

const outlookService = require('../../src/modules/calendar/outlook/outlook.service');
const { getAdapter } = require('../../src/modules/calendar/shared/calendarAdapters');
const calendarSyncRepo = require('../../src/modules/calendar/shared/calendarSync.repository');

// ── the outbound-request router ─────────────────────────────────────────────

/** Marker every blocked request carries, so a test can assert on the refusal. */
const BLOCKED = 'BLOCKED OUTBOUND REQUEST';

interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
  authorization: string | null;
}

type RouteHandler = (call: RecordedCall) => Response;

interface Route {
  method: string;
  fragment: string;
  handler: RouteHandler;
}

let routes: Route[] = [];
let calls: RecordedCall[] = [];
let realFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

/** Register a canned answer. First registration that matches wins. */
function graph(method: string, fragment: string, handler: RouteHandler): void {
  routes.push({ method: method.toUpperCase(), fragment, handler });
}

/** Answer with the same response every time, described once. */
function always(status: number, body?: unknown): RouteHandler {
  return () => (body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));
}

/**
 * Answer differently on each call, so a spec can express "401 then 200": the
 * exact shape of a token that expires mid-request and is refreshed.
 */
function inSequence(...responses: RouteHandler[]): RouteHandler {
  let n = 0;
  return (call) => {
    const handler = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return handler(call);
  };
}

/** Every recorded request whose url contains `fragment`. */
function callsTo(fragment: string): RecordedCall[] {
  return calls.filter((c) => c.url.includes(fragment));
}

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    const method = (init.method || 'GET').toUpperCase();
    const headers = (init.headers || {}) as Record<string, string>;
    const call: RecordedCall = {
      url,
      method,
      body: init.body == null ? null : String(init.body),
      authorization: headers.Authorization ?? headers.authorization ?? null,
    };
    calls.push(call);

    const route = routes.find((r) => r.method === method && url.includes(r.fragment));
    if (!route) throw new Error(`${BLOCKED}: ${method} ${url}`);
    return route.handler(call);
  }) as typeof globalThis.fetch;

  // Even a request that escaped the router could not authenticate. The service
  // reads these at call time, so overwriting the process env is enough.
  for (const key of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'WEBHOOK_BASE_URL']) {
    savedEnv[key] = process.env[key];
  }
  process.env.MICROSOFT_CLIENT_ID = 'invalid-client-id-for-tests';
  process.env.MICROSOFT_CLIENT_SECRET = 'invalid-client-secret-for-tests';
  // createSubscription refuses to run without an https webhook base.
  process.env.WEBHOOK_BASE_URL = 'https://webhook.invalid';
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  routes = [];
  calls = [];
});

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A firm member with Microsoft connected.
 *
 * `outlookTimezone` is pre-cached in the token meta on purpose: without it the
 * first outbound call fetches `/me/mailboxSettings/timeZone`, which would make
 * every outbound test carry a route that has nothing to do with what it checks.
 *
 * A FRESH uid per call is deliberate. `calendarHelpers` holds a 5-second
 * user-data cache keyed by user id that the harness does not reset, so reusing
 * a uid across cases would let one case read the tokens another one seeded.
 */
async function connectMicrosoft(
  lawFirmId: string,
  opts: {
    accessToken?: string | null;
    refreshToken?: string | null;
    outbound?: boolean;
    inbound?: boolean;
  } = {},
): Promise<string> {
  const { uid } = await createFirmMember(lawFirmId);

  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, meta)
     values ($1, 'microsoft', $2, $3, $4::jsonb)`,
    [
      uid,
      opts.accessToken === undefined ? 'access-token-seed' : opts.accessToken,
      opts.refreshToken === undefined ? 'refresh-token-seed' : opts.refreshToken,
      JSON.stringify({ outlookTimezone: 'America/New_York', outlookMailboxTimezoneWritable: true }),
    ],
  );
  expect(tokens.rowCount).toBe(1);

  const settings = await testPool.query(
    `with touched as (update users set timezone = 'America/New_York', updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', $2, $3)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid, opts.outbound ?? true, opts.inbound ?? true],
  );
  expect(settings.rowCount).toBe(1);

  return uid;
}

/** An external calendar event row, the shape inbound sync creates and updates. */
async function seedExternalEvent(
  lawFirmId: string,
  fields: { title: string; outlookId?: string | null; stableId?: string | null },
): Promise<string> {
  const id = randomUUID();
  const inserted = await testPool.query(
    `insert into calendar_events
       (id, law_firm_id, stable_id, title, starts_at, ends_at, provider, source, outlook_id)
     values ($1, $2, $3, $4, '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z', 'outlook', 'external', $5)`,
    [id, lawFirmId, fields.stableId ?? null, fields.title, fields.outlookId ?? null],
  );
  expect(inserted.rowCount).toBe(1);
  return id;
}

/** A matter, for the matterEvent adapter's per-user calendar_sync writeback. */
async function seedMatter(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  const inserted = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Bell v. Ward', $3)`,
    [id, lawFirmId, `M-${id.slice(0, 8)}`],
  );
  expect(inserted.rowCount).toBe(1);
  return id;
}

/**
 * A matter event, optionally carrying a per-user Outlook writeback already.
 * Mirrors `seedMatterEvent` in `googleCalendarSync.test.ts`.
 */
async function seedMatterEvent(
  lawFirmId: string,
  matterId: string,
  opts: { title?: string; syncedEventId?: string; userId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const calendarSync = opts.syncedEventId && opts.userId
    ? { outlook: { [opts.userId]: { event: { eventId: opts.syncedEventId } } } }
    : {};
  const inserted = await testPool.query(
    `insert into events (id, law_firm_id, matter_id, type, title, date, calendar_sync)
     values ($1, $2, $3, 'hearing', $4, '2026-09-10T14:00:00Z', $5::jsonb)`,
    [id, lawFirmId, matterId, opts.title ?? 'Preliminary hearing', JSON.stringify(calendarSync)],
  );
  expect(inserted.rowCount).toBe(1);
  return id;
}

/** The entity snapshot the outbound adapters are handed by the event listeners. */
async function matterEventEntityData(lawFirmId: string, matterId: string, eventId: string) {
  const { rows } = await testPool.query(
    `select id, title, date, calendar_sync from events where id = $1`,
    [eventId],
  );
  expect(rows).toHaveLength(1);
  return {
    id: eventId,
    lawFirmId,
    matterId,
    title: rows[0].title,
    date: rows[0].date,
    calendarSync: rows[0].calendar_sync,
  };
}

/** A Graph subscription row, the bookkeeping the webhook route verifies against. */
async function seedSubscription(fields: {
  id: string;
  userId: string;
  lawFirmId: string;
  clientState: string;
  expiresInMs?: number;
  lastOutboundPushAt?: Date | null;
}): Promise<void> {
  const inserted = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, resource, secret, expiration, last_outbound_push_at)
     values ('outlook', $1, $2, $3, '/me/calendar/events', $4, $5, $6)`,
    [
      fields.id,
      fields.userId,
      fields.lawFirmId,
      fields.clientState,
      new Date(Date.now() + (fields.expiresInMs ?? 3 * 24 * 60 * 60 * 1000)),
      fields.lastOutboundPushAt ?? null,
    ],
  );
  expect(inserted.rowCount).toBe(1);
}

/** A minimal Graph event payload, in the shape Microsoft actually delivers. */
function graphEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'EVT-DEFAULT',
    subject: 'Deposition prep',
    body: { contentType: 'text', content: 'Bring the exhibit binder.' },
    start: { dateTime: '2026-09-01T14:00:00.0000000', timeZone: 'Eastern Standard Time' },
    end: { dateTime: '2026-09-01T15:00:00.0000000', timeZone: 'Eastern Standard Time' },
    isAllDay: false,
    parentFolderId: 'calendar-1',
    lastModifiedDateTime: '2026-08-30T10:00:00Z',
    ...overrides,
  };
}

/** Let fire-and-forget cross-sync work settle before the harness truncates. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Poll until `check` returns truthy. The webhook route answers before it works. */
async function waitFor<T>(check: () => Promise<T | null | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ── 1. containment ──────────────────────────────────────────────────────────

describe('outbound network containment', () => {
  /**
   * Goes red if the router is not installed, or if a real request could be
   * issued with the real Microsoft credentials from `.env`.
   */
  test('the fetch router is in force and the Microsoft credentials are invalid', async () => {
    expect(globalThis.fetch).not.toBe(realFetch);
    expect(process.env.MICROSOFT_CLIENT_ID).toBe('invalid-client-id-for-tests');
    expect(process.env.MICROSOFT_CLIENT_SECRET).toBe('invalid-client-secret-for-tests');

    await expect(fetch('https://graph.microsoft.com/v1.0/me')).rejects.toThrow(BLOCKED);
    await expect(
      fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST' }),
    ).rejects.toThrow(BLOCKED);
  });

  /**
   * The service's own Graph traffic goes through the router, not around it.
   *
   * Goes red if `makeMicrosoftGraphCall` ever stops using the global `fetch`
   * (an SDK, an https client). Without this case, every "no call was made"
   * assertion in this file would prove nothing: an unrouted request could be
   * leaving by another door.
   */
  test('a service call with no registered route is refused, not sent', async () => {
    const firm: Firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);

    await expect(outlookService.getCalendars(uid)).rejects.toThrow(BLOCKED);

    // The refusal happened at the router, which means the service really did
    // try to reach Graph rather than short-circuiting somewhere earlier.
    expect(callsTo('graph.microsoft.com/v1.0/me/calendars')).toHaveLength(1);
  });
});

// ── 2. token refresh ────────────────────────────────────────────────────────

describe('Microsoft token refresh', () => {
  /**
   * Microsoft ROTATES refresh tokens: the response to a refresh carries a new
   * one, and the old one is dead. Goes red if the rotated refresh token stops
   * being persisted (the next refresh would then redeem a dead token and strand
   * the user in `requiresReAuth`), or if the retry reuses the expired bearer.
   */
  test('a 401 refreshes the token, persists the rotated refresh token and retries', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: 'rotating-refresh-1',
    });

    graph('GET', '/me/calendars', inSequence(
      always(401, { error: { code: 'InvalidAuthenticationToken' } }),
      always(200, { value: [{ id: 'cal-1', name: 'Work', isDefaultCalendar: true, canEdit: true }] }),
    ));
    graph('POST', 'login.microsoftonline.com', always(200, {
      access_token: 'refreshed-access',
      refresh_token: 'rotating-refresh-2',
    }));

    const result = await outlookService.getCalendars(uid);

    // The retry actually succeeded, so the assertions below are about a call
    // that happened rather than about an early return.
    expect(result.calendars).toEqual([
      { id: 'cal-1', name: 'Work', isDefault: true, color: '#000000', canEdit: true },
    ]);

    const attempts = callsTo('/me/calendars');
    expect(attempts).toHaveLength(2);
    expect(attempts[0].authorization).toBe('Bearer expired-access');
    expect(attempts[1].authorization).toBe('Bearer refreshed-access');

    const refresh = callsTo('login.microsoftonline.com');
    expect(refresh).toHaveLength(1);
    const sent = new URLSearchParams(refresh[0].body || '');
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('rotating-refresh-1');

    const { rows } = await testPool.query(
      `select access_token, refresh_token from user_oauth_tokens
        where user_id = $1 and provider = 'microsoft'`,
      [uid],
    );
    expect(rows[0].access_token).toBe('refreshed-access');
    expect(rows[0].refresh_token).toBe('rotating-refresh-2');
  });

  /**
   * Microsoft is permitted to omit `refresh_token` from a successful refresh
   * response. In that shape the previously-issued refresh token remains the
   * only credential that can recover the next expired access token. Replacing
   * it with null would make the current retry work but strand the connection
   * at its following expiry.
   *
   * Goes red if the refresh path stops carrying the stored refresh token
   * forward when Graph returns only a new access token.
   */
  test('an access-token-only Microsoft refresh preserves the existing refresh token for the next recovery', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: 'still-valid-refresh',
    });

    graph('GET', '/me/calendars', inSequence(
      always(401, { error: { code: 'InvalidAuthenticationToken' } }),
      always(200, { value: [] }),
    ));
    graph('POST', 'login.microsoftonline.com', always(200, {
      access_token: 'refreshed-access-without-rotation',
    }));

    const result = await outlookService.getCalendars(uid);

    // The successful retry proves this exercised refresh rather than returning
    // from an early failure, and the persisted row protects the *next* expiry.
    expect(result.calendars).toEqual([]);
    expect(callsTo('login.microsoftonline.com')).toHaveLength(1);
    const { rows } = await testPool.query(
      `select access_token, refresh_token from user_oauth_tokens
        where user_id = $1 and provider = 'microsoft'`,
      [uid],
    );
    expect(rows).toEqual([{
      access_token: 'refreshed-access-without-rotation',
      refresh_token: 'still-valid-refresh',
    }]);
  });

  /**
   * A refresh token Microsoft rejects is terminal. Goes red if the call is
   * retried anyway with the dead bearer, or if the error stops carrying
   * `NO_REFRESH_TOKEN` / `requiresReAuth`. The route layer keys its 401
   * reconnect prompt off exactly those two fields, and an uncoded 401 makes the
   * browser reload the page in a loop instead.
   */
  test('a rejected refresh token surfaces as NO_REFRESH_TOKEN and stops the call', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: 'revoked-refresh',
    });

    graph('GET', '/me/calendars', always(401, { error: { code: 'InvalidAuthenticationToken' } }));
    graph('POST', 'login.microsoftonline.com', always(400, { error: 'invalid_grant' }));

    await expect(outlookService.getCalendars(uid)).rejects.toMatchObject({
      code: 'NO_REFRESH_TOKEN',
      requiresReAuth: true,
    });

    // Exactly one attempt: the refresh failed, so there was no retry. The count
    // being 1 rather than 0 is what proves the request was really made.
    expect(callsTo('/me/calendars')).toHaveLength(1);
    expect(callsTo('login.microsoftonline.com')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select access_token, refresh_token from user_oauth_tokens
        where user_id = $1 and provider = 'microsoft'`,
      [uid],
    );
    expect(rows[0].access_token).toBe('expired-access');
    expect(rows[0].refresh_token).toBe('revoked-refresh');
  });

  /**
   * Goes red if `syncFromOutlook` stops translating a dead Microsoft grant into
   * a 401 with `NO_REFRESH_TOKEN`. The generic rethrow underneath it becomes a
   * scrubbed 500, which tells the user nothing and hides the one action that
   * fixes it: reconnecting the Microsoft account.
   */
  test('syncFromOutlook turns a dead grant into a 401, not a 500', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: null,
    });

    graph('GET', '/me/calendar/calendarView', always(401, { error: { code: 'InvalidAuthenticationToken' } }));

    await expect(outlookService.syncFromOutlook({ userId: uid, lawFirmId: firm.id }))
      .rejects.toMatchObject({ statusCode: 401, code: 'NO_REFRESH_TOKEN', requiresReAuth: true });

    expect(callsTo('/me/calendar/calendarView')).toHaveLength(0);
    // No refresh token was stored, so no redemption should have been attempted.
    expect(callsTo('login.microsoftonline.com')).toHaveLength(0);
  });

  /**
   * Microsoft answering 200 with a body that carries no `access_token` is not
   * hypothetical: it is what a misconfigured app registration or an
   * unexpected token-endpoint error shape looks like. `refreshMicrosoftToken`
   * does not validate the shape before persisting, so this pins the two things
   * that keep that safe: the falsy token still fails the call as
   * `NO_REFRESH_TOKEN` (nothing retries with `Bearer undefined`), and
   * `saveTokens`'s `coalesce` means writing `null` leaves the previously
   * stored access token intact instead of overwriting it with garbage.
   *
   * Goes red if a malformed response starts being treated as a successful
   * refresh, or if the stored access token gets clobbered with `null`.
   */
  test('a malformed refresh response with no access_token fails the call without corrupting the stored token', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: 'refresh-malformed',
    });

    graph('GET', '/me/calendars', always(401, { error: { code: 'InvalidAuthenticationToken' } }));
    // 200 OK, but the body Microsoft's real token endpoint would never send.
    graph('POST', 'login.microsoftonline.com', always(200, { token_type: 'Bearer', expires_in: 3600 }));

    await expect(outlookService.getCalendars(uid)).rejects.toMatchObject({
      code: 'NO_REFRESH_TOKEN',
      requiresReAuth: true,
    });

    expect(callsTo('/me/calendars')).toHaveLength(1);
    expect(callsTo('login.microsoftonline.com')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select access_token, refresh_token from user_oauth_tokens
        where user_id = $1 and provider = 'microsoft'`,
      [uid],
    );
    expect(rows[0]).toEqual({ access_token: 'expired-access', refresh_token: 'refresh-malformed' });
  });

  /**
   * A refresh that never gets an HTTP response at all (DNS failure, connection
   * reset, timeout) is a different failure shape than a 400 `invalid_grant`:
   * `fetch` itself rejects rather than resolving with a non-ok Response.
   * `refreshMicrosoftToken`'s try/catch must still turn that into a clean
   * `null`, not an unhandled rejection that takes the whole request down as an
   * unclassified 500.
   *
   * Goes red if the try/catch around the token fetch is narrowed to only cover
   * `response.ok` checks: a thrown network error would then escape
   * `refreshMicrosoftToken` uncaught.
   */
  test('a network failure during refresh fails the call cleanly instead of throwing unhandled', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: 'refresh-timeout',
    });

    graph('GET', '/me/calendars', always(401, { error: { code: 'InvalidAuthenticationToken' } }));
    graph('POST', 'login.microsoftonline.com', () => {
      throw new Error('ETIMEDOUT: connection timed out');
    });

    const failure = await outlookService.getCalendars(uid).catch((err: any) => err);
    expect(failure).toMatchObject({ statusCode: 503, code: 'CALENDAR_REFRESH_UNAVAILABLE' });
    expect(failure.requiresReAuth).toBeUndefined();

    expect(callsTo('/me/calendars')).toHaveLength(1);
    expect(callsTo('login.microsoftonline.com')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select access_token, refresh_token from user_oauth_tokens
        where user_id = $1 and provider = 'microsoft'`,
      [uid],
    );
    expect(rows[0]).toEqual({ access_token: 'expired-access', refresh_token: 'refresh-timeout' });
  });

  /**
   * Two overlapping calls for the SAME connection (e.g. two tabs, or a manual
   * sync racing the silent one) both meet a 401 before either has refreshed.
   * `refreshUnderLock`'s in-process `dedupeRefresh` is supposed to collapse
   * that into ONE token-endpoint call, with the second caller awaiting the
   * first's result instead of redeeming the refresh token a second time.
   *
   * This matters specifically for Microsoft: its refresh tokens ROTATE, so a
   * second, independent redemption of the same (now-dead) refresh token would
   * fail outright and strand that caller in `requiresReAuth` even though the
   * connection is perfectly healthy.
   *
   * The token endpoint is held open with a manually-released gate until BOTH
   * calls have made their original (401) request, which is what proves the two
   * calls genuinely overlapped at the refresh boundary rather than running
   * sequentially by luck.
   *
   * Goes red if `dedupeRefresh`/`refreshUnderLock` is removed: the token
   * endpoint would then be hit twice, and the second hit would redeem an
   * already-rotated refresh token and fail.
   */
  test('one refresh is shared by two concurrent calls for the same connection', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: 'shared-refresh-1',
    });

    let releaseToken: () => void = () => {};
    const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
    let tokenCalls = 0;

    graph('GET', '/me/calendars', inSequence(
      always(401, { error: { code: 'InvalidAuthenticationToken' } }),
      always(401, { error: { code: 'InvalidAuthenticationToken' } }),
      always(200, { value: [{ id: 'cal-1', name: 'Work', isDefaultCalendar: true, canEdit: true }] }),
      always(200, { value: [{ id: 'cal-1', name: 'Work', isDefaultCalendar: true, canEdit: true }] }),
    ));
    graph('POST', 'login.microsoftonline.com', ((() => {
      tokenCalls += 1;
      return (async () => {
        await tokenGate;
        return new Response(JSON.stringify({
          access_token: 'shared-refreshed-access',
          refresh_token: 'shared-refresh-2',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      })();
    }) as unknown) as RouteHandler);

    const callA = outlookService.getCalendars(uid);
    // Wait for A's 401 to have driven it into the refresh call, which is
    // paused at the gate. Only THEN start B, so B's own original request also
    // sees the stale token (the DB has not been updated yet) and both calls
    // are provably inside the refresh window together.
    await waitFor(async () => (tokenCalls >= 1 ? true : null), 'the first refresh to reach the token endpoint');

    const callB = outlookService.getCalendars(uid);
    // Give B's original (401) request a chance to land before releasing the
    // gate; it does not need the token endpoint to get there.
    await waitFor(async () => (callsTo('/me/calendars').length >= 2 ? true : null), "B's original request to be recorded");

    releaseToken();
    const [resultA, resultB] = await Promise.all([callA, callB]);

    const expectedCalendars = [{ id: 'cal-1', name: 'Work', isDefault: true, color: '#000000', canEdit: true }];
    expect(resultA.calendars).toEqual(expectedCalendars);
    expect(resultB.calendars).toEqual(expectedCalendars);

    // The one fact that proves sharing rather than "both happened to succeed":
    // exactly one token-endpoint call for two 401s on the same connection.
    expect(tokenCalls).toBe(1);
    expect(callsTo('login.microsoftonline.com')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select access_token, refresh_token from user_oauth_tokens
        where user_id = $1 and provider = 'microsoft'`,
      [uid],
    );
    expect(rows[0]).toEqual({ access_token: 'shared-refreshed-access', refresh_token: 'shared-refresh-2' });
  });

  /**
   * The in-process dedup key is `${provider}:${userId}`. Two different users
   * refreshing at the same moment must NOT collapse onto one call: that would
   * hand user B the access token minted for user A's refresh token (or worse,
   * silently redeem user A's refresh token on user B's behalf).
   *
   * Goes red if the dedupe key is ever narrowed to just the provider (or
   * dropped entirely, e.g. a single shared in-flight slot): the assertions on
   * `tokenCalls` and on which user ends up with which token would catch it.
   */
  test('concurrent refreshes for two different users do not share a refresh or cross-write tokens', async () => {
    const firm = await createFirm();
    const uidA = await connectMicrosoft(firm.id, { accessToken: 'expired-a', refreshToken: 'refresh-a-1' });
    const uidB = await connectMicrosoft(firm.id, { accessToken: 'expired-b', refreshToken: 'refresh-b-1' });

    graph('GET', '/me/calendars', always(401, { error: { code: 'InvalidAuthenticationToken' } }));
    graph('POST', 'login.microsoftonline.com', (call) => {
      const sent = new URLSearchParams(call.body || '');
      const refreshToken = sent.get('refresh_token');
      if (refreshToken === 'refresh-a-1') {
        return new Response(JSON.stringify({ access_token: 'refreshed-a', refresh_token: 'refresh-a-2' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (refreshToken === 'refresh-b-1') {
        return new Response(JSON.stringify({ access_token: 'refreshed-b', refresh_token: 'refresh-b-2' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected refresh_token in test: ${refreshToken}`);
    });

    // Both users 401 and refresh at once. Each carries its own refresh token
    // in the request, so a correct implementation keeps them independent
    // regardless of the exact interleaving. Both retries land on the
    // (unregistered-for-retry) 401-only route above, which is fine: the
    // test only cares that each user's OWN refresh_token was redeemed and
    // stored under that same user, not about the retry's own status.
    await Promise.all([
      outlookService.getCalendars(uidA).catch(() => null),
      outlookService.getCalendars(uidB).catch(() => null),
    ]);

    expect(callsTo('login.microsoftonline.com')).toHaveLength(2);

    const { rows } = await testPool.query(
      `select user_id, access_token, refresh_token from user_oauth_tokens
        where provider = 'microsoft' and user_id = any($1) order by user_id`,
      [[uidA, uidB]],
    );
    const byUser = Object.fromEntries(rows.map((r: any) => [r.user_id, r]));
    expect(byUser[uidA]).toEqual({ user_id: uidA, access_token: 'refreshed-a', refresh_token: 'refresh-a-2' });
    expect(byUser[uidB]).toEqual({ user_id: uidB, access_token: 'refreshed-b', refresh_token: 'refresh-b-2' });
  });

  /**
   * `user_oauth_tokens` holds both providers' rows for the same user. A
   * refresh scoped only by `user_id` (dropping the `provider` predicate) would
   * silently overwrite this user's Google row while refreshing Microsoft.
   *
   * Goes red if `saveTokens`/`saveAccessToken` lose the `provider` column from
   * their WHERE clause.
   */
  test("refreshing the Microsoft token does not touch this user's stored Google token", async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: 'refresh-cross-provider',
    });
    const google = await testPool.query(
      `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
       values ($1, 'google', 'google-access-untouched', 'google-refresh-untouched')`,
      [uid],
    );
    expect(google.rowCount).toBe(1);

    graph('GET', '/me/calendars', inSequence(
      always(401, { error: { code: 'InvalidAuthenticationToken' } }),
      always(200, { value: [] }),
    ));
    graph('POST', 'login.microsoftonline.com', always(200, {
      access_token: 'refreshed-microsoft-access',
      refresh_token: 'refreshed-microsoft-refresh',
    }));

    await outlookService.getCalendars(uid);

    const { rows } = await testPool.query(
      `select provider, access_token, refresh_token from user_oauth_tokens
        where user_id = $1 order by provider`,
      [uid],
    );
    expect(rows).toEqual([
      { provider: 'google', access_token: 'google-access-untouched', refresh_token: 'google-refresh-untouched' },
      { provider: 'microsoft', access_token: 'refreshed-microsoft-access', refresh_token: 'refreshed-microsoft-refresh' },
    ]);
  });
});

// ── calendar resolution ──────────────────────────────────────────────────────

describe('calendar resolution', () => {
  /**
   * The cached Paralegix calendar id can go stale in a way an EVENT id never
   * does for a create: the whole calendar was deleted directly on the user's
   * Outlook mailbox, not just one event inside it. A 404/410 posting an event
   * to that calendar's endpoint is a calendar-level miss, the Outlook twin of
   * the Google case in `googleCalendarSync.test.ts`. The default target can
   * never hit this: it posts to `/me/events` with no calendar id in the URL
   * at all.
   *
   * Goes red if `createOutlookEventForItem` stops recreating the calendar on
   * this signal: the create would keep failing, the cached calendar id would
   * stay pointed at the dead one forever, and every future sync for this user
   * would repeat the same failing POST with no path back to a working
   * calendar - unlike a lost event, which self-heals on the very next save.
   */
  test('recreates the Paralegix calendar and retries when Microsoft reports it gone', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    await testPool.query(
      `update users set preferences = $2::jsonb where id = $1`,
      [uid, JSON.stringify({
        outlookCalendarTarget: 'paralegix',
        paralegixCalendarId: 'cal-deleted',
        outlookCalendarId: 'cal-deleted',
      })],
    );
    const eventRowId = await seedExternalEvent(firm.id, { title: 'Mediation' });

    // Routes are matched in registration order and by substring, so the two
    // specific `/me/calendars/<id>/events` urls must be registered BEFORE the
    // generic `POST /me/calendars` (create) route below - otherwise the
    // generic route's substring match would win over both of them.
    graph('POST', '/me/calendars/cal-deleted/events', always(404, { error: { code: 'ErrorItemNotFound' } }));
    graph('POST', '/me/calendars/cal-recreated/events', always(200, { id: 'EVT-RECREATED', changeKey: 'ck-1' }));
    // The stored id was cleared with the dead calendar, so a fresh one is created.
    graph('POST', '/me/calendars', always(200, { id: 'cal-recreated', name: 'Paralegix' }));

    const result = await outlookService.createEventsFromEntity(
      getAdapter('externalEvent'),
      {
        id: eventRowId,
        lawFirmId: firm.id,
        title: 'Mediation',
        start: new Date('2026-09-01T14:00:00Z'),
        allDay: false,
      },
      uid,
    );

    expect(result).toEqual([{ key: 'external', outlookId: 'EVT-RECREATED' }]);

    // The dead calendar was tried first, then creation, then the retry against
    // the fresh calendar - not a retry that skipped the failed attempt, and
    // not a recreation that never actually retried the event.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      expect.stringContaining('POST https://graph.microsoft.com/v1.0/me/calendars/cal-deleted/events'),
      expect.stringContaining('POST https://graph.microsoft.com/v1.0/me/calendars'),
      expect.stringContaining('POST https://graph.microsoft.com/v1.0/me/calendars/cal-recreated/events'),
    ]);

    // The mapping records the calendar the event actually lives on, and the
    // cached preference id must move on or the NEXT sync repeats today's
    // failure against the same dead calendar.
    const { rows } = await testPool.query(
      `select entity_type, entity_id, item_key, user_id
         from calendar_mappings where provider = 'outlook' and external_event_id = 'EVT-RECREATED'`,
    );
    expect(rows).toEqual([{
      entity_type: 'externalEvent', entity_id: eventRowId, item_key: 'external', user_id: uid,
    }]);

    const settings = await testPool.query(
      `select preferences from users where id = $1`, [uid],
    );
    expect(settings.rows[0].preferences).toMatchObject({
      paralegixCalendarId: 'cal-recreated',
      outlookCalendarId: 'cal-recreated',
    });

    await settle();
  });
});

describe('privacy on a copied meeting', () => {
  async function imported(lawFirmId: string, provider: 'google' | 'outlook') {
    const id = await seedExternalEvent(lawFirmId, { title: 'Settlement talks' });
    return {
      id, lawFirmId, title: 'Settlement talks', provider,
      start: new Date('2026-09-01T14:00:00Z'), allDay: false, meeting: { isPrivate: true },
    };
  }

  /**
   * Goes red if the copy Paralegix pushes to Outlook drops the privacy of a
   * Google meeting: delegates who can open the Outlook calendar read it.
   */
  test('a private Google meeting is copied to Outlook as private', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    graph('POST', '/me/events', always(200, { id: 'EVT-PRIVATE', changeKey: 'ck-1' }));

    const result = await outlookService.createEventsFromEntity(getAdapter('externalEvent'), await imported(firm.id, 'google'), uid);

    expect(result).toEqual([{ key: 'external', outlookId: 'EVT-PRIVATE' }]);
    const [create] = callsTo('/me/events').filter((c) => c.method === 'POST');
    expect(JSON.parse(create.body as string).sensitivity).toBe('private');
  });

  /**
   * Goes red if a Paralegix edit writes privacy back onto the meeting's own
   * Outlook event: Outlook's "confidential" would be overwritten as "private".
   */
  test('an edit of an Outlook meeting does not rewrite its own sensitivity', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    graph('POST', '/me/events', always(200, { id: 'EVT-OWN', changeKey: 'ck-1' }));

    const result = await outlookService.createEventsFromEntity(getAdapter('externalEvent'), await imported(firm.id, 'outlook'), uid);

    expect(result).toEqual([{ key: 'external', outlookId: 'EVT-OWN' }]);
    const [create] = callsTo('/me/events').filter((c) => c.method === 'POST');
    expect(JSON.parse(create.body as string)).not.toHaveProperty('sensitivity');
  });
});

describe('the dedicated Paralegix calendar is identified by its stored id', () => {
  async function onParalegixCalendar(storedId: string) {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const prefs = await testPool.query(
      `update users set preferences = $2::jsonb where id = $1`,
      [uid, JSON.stringify({ outlookCalendarTarget: 'paralegix', paralegixCalendarId: storedId, outlookCalendarId: storedId })],
    );
    expect(prefs.rowCount).toBe(1);
    // A calendar of the user's own that happens to share the name.
    graph('GET', '/me/calendars/cal-impostor', always(200, { id: 'cal-impostor', name: 'Paralegix' }));
    return { firm, uid };
  }

  const listCalls = () => calls.filter((c) => c.method === 'GET' && /\/me\/calendars(\?|$)/.test(c.url));

  /**
   * Goes red if the read goes back to matching calendars by name: it lists the
   * user's calendars and imports from whichever one is called "Paralegix",
   * which need not be the one Paralegix made.
   */
  test('a full read uses the stored calendar even when another calendar is named Paralegix', async () => {
    const { firm, uid } = await onParalegixCalendar('cal-stored');
    graph('GET', '/me/calendars/cal-stored/calendarView', always(200, {
      value: [graphEvent({ id: 'EVT-ON-STORED', subject: 'On the dedicated calendar' })],
    }));
    graph('GET', '/me/calendars/cal-stored', always(200, { id: 'cal-stored', name: 'Paralegix (work)' }));
    graph('GET', '/me/calendars', always(200, { value: [{ id: 'cal-impostor', name: 'Paralegix' }] }));

    const result = await outlookService.syncFromOutlook({ userId: uid, lawFirmId: firm.id });

    expect(result).toMatchObject({ createdCount: 1 });
    expect(callsTo('/me/calendars/cal-stored/calendarView')).toHaveLength(1);
    expect(callsTo('cal-impostor')).toHaveLength(0);
    expect(listCalls()).toHaveLength(0);

    await settle();
  });

  /**
   * Goes red if a deleted dedicated calendar is replaced by adopting another
   * calendar with the same name instead of creating a new one, or if the new
   * id is not stored for the next read.
   */
  test('a stored calendar Microsoft reports gone is recreated and the new id stored', async () => {
    const { uid } = await onParalegixCalendar('cal-gone');
    graph('GET', '/me/calendars/cal-gone', always(404, { error: { code: 'ErrorItemNotFound' } }));
    graph('GET', '/me/calendars', always(200, { value: [{ id: 'cal-impostor', name: 'Paralegix' }] }));
    graph('POST', '/me/calendars', always(201, { id: 'cal-new', name: 'Paralegix' }));

    const result = await outlookService.initParalegixCalendar(uid);

    expect(result).toMatchObject({ success: true, calendar: { id: 'cal-new' } });
    expect(callsTo('/me/calendars/cal-gone')).toHaveLength(1);
    expect(listCalls()).toHaveLength(0);
    const { rows } = await testPool.query(`select preferences from users where id = $1`, [uid]);
    expect(rows[0].preferences).toMatchObject({ paralegixCalendarId: 'cal-new', outlookCalendarId: 'cal-new' });
  });

  /**
   * Goes red if any failure to read the stored calendar is treated as "gone":
   * a refused or failed check creates a second Paralegix calendar beside the
   * one that still exists.
   */
  test('a stored calendar that cannot be checked is not replaced', async () => {
    const { uid } = await onParalegixCalendar('cal-unreadable');
    graph('GET', '/me/calendars/cal-unreadable', always(403, { error: { code: 'ErrorAccessDenied' } }));
    graph('GET', '/me/calendars', always(200, { value: [{ id: 'cal-impostor', name: 'Paralegix' }] }));
    graph('POST', '/me/calendars', always(201, { id: 'cal-duplicate', name: 'Paralegix' }));

    const result = await outlookService.initParalegixCalendar(uid);

    expect(result).toMatchObject({ status: 500 });
    expect(callsTo('/me/calendars/cal-unreadable')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const { rows } = await testPool.query(`select preferences from users where id = $1`, [uid]);
    expect(rows[0].preferences).toMatchObject({ paralegixCalendarId: 'cal-unreadable' });
  });
});

// ── 3. calendar_mappings: the duplicate-event guard ─────────────────────────

describe('calendar_mappings reverse index', () => {
  /**
   * The durable answer to "have we already created this event?".
   *
   * Two saves landing concurrently both read the entity row before either
   * writeback commits, both see no `outlookId`, and both POST, putting two
   * copies of the same court date on the lawyer's real calendar. The mapping
   * row is written immediately after a create, so consulting it closes that
   * window.
   *
   * Goes red if the `findMappingForEntityItem` fallback in
   * `updateEventsFromEntity` is removed: the push becomes a POST and a second
   * remote event is created.
   */
  test('an existing mapping makes the push a PATCH of that event, not a second create', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const eventRowId = await seedExternalEvent(firm.id, { title: 'Status conference' });

    const mapping = await testPool.query(
      `insert into calendar_mappings
         (provider, external_event_id, user_id, law_firm_id, entity_type, entity_id, item_key)
       values ('outlook', 'EVT-ALREADY-MAPPED', $1, $2, 'externalEvent', $3, 'external')`,
      [uid, firm.id, eventRowId],
    );
    expect(mapping.rowCount).toBe(1);

    graph('PATCH', '/me/events/EVT-ALREADY-MAPPED', always(200, { id: 'EVT-ALREADY-MAPPED' }));
    graph('POST', '/me/events', always(200, { id: 'EVT-DUPLICATE' }));

    const result = await outlookService.updateEventsFromEntity(
      getAdapter('externalEvent'),
      {
        id: eventRowId,
        lawFirmId: firm.id,
        title: 'Status conference',
        start: new Date('2026-09-01T14:00:00Z'),
        end: new Date('2026-09-01T15:00:00Z'),
        allDay: false,
        outlookId: null,
      },
      uid,
    );

    // The push resolved to the mapped remote event. Asserting the result first
    // means the "no create" assertion below is about a push that ran.
    expect(result).toEqual([
      { key: 'external', action: 'updated', outlookId: 'EVT-ALREADY-MAPPED' },
    ]);
    expect(callsTo('/me/events/EVT-ALREADY-MAPPED')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/me/events'))).toHaveLength(0);

    await settle();
  });

  /**
   * Writeback/mapping disagreement recovery, the Outlook twin of the Google
   * case in `googleCalendarSync.test.ts`. The mapping still names an event
   * Microsoft no longer has - deleted directly on the user's mailbox, or left
   * behind by a delete whose `deleteMapping` write failed after the Graph
   * delete already succeeded. Before the fix, a PATCH against a gone id just
   * logged an error and the item never synced again: every later save repeated
   * the same failing PATCH forever with no way to reconcile.
   *
   * Goes red if `updateEventsFromEntity` stops treating a 404/410 on the PATCH
   * as "the mapped event is gone": it would keep failing the same PATCH every
   * sync instead of dropping the stale mapping and creating a replacement.
   */
  test('recreates the event and replaces the mapping when Microsoft reports the mapped id gone', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const eventRowId = await seedExternalEvent(firm.id, { title: 'Status conference' });

    const mapping = await testPool.query(
      `insert into calendar_mappings
         (provider, external_event_id, user_id, law_firm_id, entity_type, entity_id, item_key)
       values ('outlook', 'EVT-GONE', $1, $2, 'externalEvent', $3, 'external')`,
      [uid, firm.id, eventRowId],
    );
    expect(mapping.rowCount).toBe(1);

    graph('PATCH', '/me/events/EVT-GONE', always(404, { error: { code: 'ErrorItemNotFound' } }));
    graph('POST', '/me/events', always(200, { id: 'EVT-FRESH', changeKey: 'ck-fresh' }));

    const result = await outlookService.updateEventsFromEntity(
      getAdapter('externalEvent'),
      {
        id: eventRowId,
        lawFirmId: firm.id,
        title: 'Status conference',
        start: new Date('2026-09-01T14:00:00Z'),
        end: new Date('2026-09-01T15:00:00Z'),
        allDay: false,
        outlookId: null,
      },
      uid,
    );

    expect(result).toEqual([{ key: 'external', action: 'recreated', outlookId: 'EVT-FRESH' }]);

    // The failed PATCH happened first, and the recovery POST second.
    expect(callsTo('/me/events/EVT-GONE').map((c) => c.method)).toEqual(['PATCH']);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/me/events'))).toHaveLength(1);

    const { rows } = await testPool.query(
      `select external_event_id, user_id from calendar_mappings where entity_id = $1`,
      [eventRowId],
    );
    expect(rows).toEqual([{ external_event_id: 'EVT-FRESH', user_id: uid }]);

    const stored = await testPool.query(
      `select outlook_id, outlook_change_key from calendar_events where id = $1`,
      [eventRowId],
    );
    expect(stored.rows[0]).toEqual({ outlook_id: 'EVT-FRESH', outlook_change_key: 'ck-fresh' });

    await settle();
  });

  /**
   * C06 (delete replay after the provider already deleted the event), the
   * Outlook twin of the Google case in `googleCalendarSync.test.ts`. A 404 on
   * the delete means Microsoft already does not have this event - the same end
   * state the caller wanted - so the mapping and the entity's own writeback
   * must converge on "no event" rather than surviving forever pointed at a
   * dead id. Recovery must NOT create a replacement: unlike the update path's
   * 404 handling, a delete asked for the event to be gone, so "gone" is
   * success.
   *
   * Goes red if `deleteOutlookEventByKey` stops treating 404/410 as a
   * converged delete: it would keep returning `false` and leave the stale
   * mapping row and writeback in place.
   */
  test('converges the mapping and writeback when Microsoft answers 404 on delete (already gone)', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const matterId = await seedMatter(firm.id);
    const eventId = await seedMatterEvent(firm.id, matterId, {
      syncedEventId: 'EVT-GHOST', userId: uid,
    });

    const mapping = await testPool.query(
      `insert into calendar_mappings
         (provider, external_event_id, user_id, law_firm_id, entity_type, entity_id, scope_id, item_key)
       values ('outlook', 'EVT-GHOST', $1, $2, 'matterEvent', $3, $4, 'event')`,
      [uid, firm.id, eventId, matterId],
    );
    expect(mapping.rowCount).toBe(1);

    graph('DELETE', '/me/events/EVT-GHOST', always(404, { error: { code: 'ErrorItemNotFound' } }));

    const results = await outlookService.deleteEventsFromEntity(
      getAdapter('matterEvent'),
      await matterEventEntityData(firm.id, matterId, eventId),
      uid,
    );

    // The DELETE was really attempted; convergence is a reaction to the 404,
    // not a no-op that never noticed the row existed.
    expect(callsTo('/me/events/EVT-GHOST')).toHaveLength(1);
    expect(results).toEqual([{ key: 'event', action: 'deleted' }]);

    // No new event is created by recovery: the DELETE call above is the only
    // Graph request made.
    expect(calls).toHaveLength(1);

    // The stale mapping is gone.
    const remainingMappings = await testPool.query(
      `select external_event_id from calendar_mappings where entity_id = $1`,
      [eventId],
    );
    expect(remainingMappings.rows).toHaveLength(0);

    // The entity's own writeback no longer names the dead event.
    const { rows } = await testPool.query(
      `select calendar_sync from events where id = $1`, [eventId],
    );
    expect(rows[0].calendar_sync.outlook?.[uid]?.event).toBeUndefined();

    await settle();
  });

  /**
   * Mappings are per (provider, user, entity, item). A colleague who synced the
   * same firm event to THEIR mailbox owns a different remote event id, and
   * pushing this user's copy at it would edit the colleague's calendar entry
   * and leave this user with none.
   *
   * Goes red if `user_id` is dropped from the `findMappingForEntityItem`
   * predicate.
   */
  test("another user's mapping for the same entity does not capture this user's push", async () => {
    const firm = await createFirm();
    const mine = await connectMicrosoft(firm.id);
    const colleague = await connectMicrosoft(firm.id);
    const eventRowId = await seedExternalEvent(firm.id, { title: 'Client intake' });

    const mapping = await testPool.query(
      `insert into calendar_mappings
         (provider, external_event_id, user_id, law_firm_id, entity_type, entity_id, item_key)
       values ('outlook', 'EVT-COLLEAGUE', $1, $2, 'externalEvent', $3, 'external')`,
      [colleague, firm.id, eventRowId],
    );
    expect(mapping.rowCount).toBe(1);

    graph('PATCH', '/me/events/EVT-COLLEAGUE', always(200, { id: 'EVT-COLLEAGUE' }));
    graph('POST', '/me/events', always(200, { id: 'EVT-MINE', changeKey: 'ck-1' }));

    const result = await outlookService.updateEventsFromEntity(
      getAdapter('externalEvent'),
      {
        id: eventRowId,
        lawFirmId: firm.id,
        title: 'Client intake',
        start: new Date('2026-09-01T14:00:00Z'),
        allDay: false,
        outlookId: null,
      },
      mine,
    );

    expect(result).toEqual([{ key: 'external', action: 'created', outlookId: 'EVT-MINE' }]);
    expect(callsTo('/me/events/EVT-COLLEAGUE')).toHaveLength(0);

    const { rows } = await testPool.query(
      `select external_event_id, user_id from calendar_mappings
        where entity_id = $1 order by external_event_id`,
      [eventRowId],
    );
    expect(rows).toEqual([
      { external_event_id: 'EVT-COLLEAGUE', user_id: colleague },
      { external_event_id: 'EVT-MINE', user_id: mine },
    ]);

    await settle();
  });

  /**
   * The mapping written after a create is what every later reconciliation reads.
   *
   * Goes red if `saveMapping` stops being called after a successful create, or
   * if it loses the entity's own `lawFirmId`. A mapping with a null or wrong
   * firm resolves the inbound writeback to the wrong tenant.
   */
  test('a create records the mapping under the entity own firm and writes the id back', async () => {
    const owningFirm = await createFirm({ name: 'Owning Firm' });
    const otherFirm = await createFirm({ name: 'Other Firm' });
    const uid = await connectMicrosoft(owningFirm.id);
    const eventRowId = await seedExternalEvent(owningFirm.id, { title: 'Mediation' });

    graph('POST', '/me/events', always(200, { id: 'EVT-CREATED', changeKey: 'ck-9' }));

    const result = await outlookService.createEventsFromEntity(
      getAdapter('externalEvent'),
      {
        id: eventRowId,
        lawFirmId: owningFirm.id,
        title: 'Mediation',
        start: new Date('2026-09-01T14:00:00Z'),
        allDay: false,
      },
      uid,
    );

    expect(result).toEqual([{ key: 'external', outlookId: 'EVT-CREATED' }]);

    const { rows } = await testPool.query(
      `select law_firm_id, entity_type, entity_id, item_key, user_id
         from calendar_mappings where provider = 'outlook' and external_event_id = 'EVT-CREATED'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      law_firm_id: owningFirm.id,
      entity_type: 'externalEvent',
      entity_id: eventRowId,
      item_key: 'external',
      user_id: uid,
    });
    expect(rows[0].law_firm_id).not.toBe(otherFirm.id);

    const stored = await testPool.query(
      `select outlook_id, outlook_change_key from calendar_events where id = $1`,
      [eventRowId],
    );
    expect(stored.rows[0]).toEqual({ outlook_id: 'EVT-CREATED', outlook_change_key: 'ck-9' });

    await settle();
  });

  /**
   * C03, the Outlook twin of the Google case in `googleCalendarSync.test.ts`.
   * The Graph create succeeds but recording it locally does not, so without
   * reconciliation the next pass over this item (an outbox replay, or simply
   * the next save) cannot find it and posts a SECOND event - a genuine
   * duplicate on the user's real mailbox, not merely a stuck sync.
   *
   * Microsoft Graph's event-create endpoint offers no client-supplied
   * idempotency key here either, so the only recovery available is a
   * compensating delete: undo the Graph-side create when the local record
   * fails to save, so the next attempt starts clean instead of duplicating.
   *
   * Goes red if `createOutlookEventForItem` stops attempting that
   * compensating delete: the orphaned `EVT-ORPHAN` would never be removed,
   * and the retry below would leave TWO live Outlook events for one
   * Paralegix item.
   */
  test('compensates with a delete when the mapping save fails after a successful create, so a retry does not duplicate', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const eventRowId = await seedExternalEvent(firm.id, { title: 'Mediation' });

    graph('POST', '/me/events', inSequence(
      always(200, { id: 'EVT-ORPHAN', changeKey: 'ck-orphan' }),
      always(200, { id: 'EVT-FINAL', changeKey: 'ck-final' }),
    ));
    graph('DELETE', '/me/events/EVT-ORPHAN', always(204));

    const saveMappingSpy = jest.spyOn(calendarSyncRepo, 'saveMapping')
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    const entityData = {
      id: eventRowId,
      lawFirmId: firm.id,
      title: 'Mediation',
      start: new Date('2026-09-01T14:00:00Z'),
      allDay: false,
    };

    try {
      const firstPass = await outlookService.createEventsFromEntity(
        getAdapter('externalEvent'),
        entityData,
        uid,
      );

      // The item failed this pass (its mapping never recorded), so it
      // produces no result entry - but the compensating delete must have
      // already run.
      expect(firstPass).toBeNull();
      const mappingsAfterFirstPass = await testPool.query(
        `select external_event_id from calendar_mappings where entity_id = $1`,
        [eventRowId],
      );
      expect(mappingsAfterFirstPass.rows).toHaveLength(0);

      expect(calls.map((c) => `${c.method} ${callsTo('/me/events/EVT-ORPHAN').includes(c) ? 'EVT-ORPHAN' : 'create'}`))
        .toEqual(['POST create', 'DELETE EVT-ORPHAN']);

      // Retry (the real next pass, e.g. the outbox redelivering the same
      // create): the mapping save succeeds this time.
      const secondPass = await outlookService.createEventsFromEntity(
        getAdapter('externalEvent'),
        entityData,
        uid,
      );

      expect(secondPass).toEqual([{ key: 'external', outlookId: 'EVT-FINAL' }]);

      // Exactly one live mapping, pointing at the surviving event - not the
      // compensated-away orphan, and not two rows for the same item.
      const finalMappings = await testPool.query(
        `select external_event_id, user_id from calendar_mappings where entity_id = $1`,
        [eventRowId],
      );
      expect(finalMappings.rows).toEqual([{ external_event_id: 'EVT-FINAL', user_id: uid }]);

      const stored = await testPool.query(
        `select outlook_id, outlook_change_key from calendar_events where id = $1`,
        [eventRowId],
      );
      expect(stored.rows[0]).toEqual({ outlook_id: 'EVT-FINAL', outlook_change_key: 'ck-final' });

      // Two creates were attempted (one orphaned, one that stuck) and exactly
      // one compensating delete - never a second delete, never a third create.
      expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/me/events'))).toHaveLength(2);
      expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    } finally {
      saveMappingSpy.mockRestore();
    }

    await settle();
  });
});

// ── 4. tenant scoping on inbound reads ──────────────────────────────────────

describe('inbound sync firm scoping', () => {
  /**
   * The worst outcome available in this module: one firm's calendar event
   * rewritten by another firm's sync run.
   *
   * Two firms can legitimately hold the same Outlook event id: the id is
   * unique to a mailbox, not to Paralegix, and nothing stops two mailboxes
   * carrying an invitation to the same meeting. `findByOutlookId` is scoped by
   * `law_firm_id` for exactly that reason.
   *
   * Goes red if that scope is dropped: firm B's run then resolves firm A's row
   * and reports `updated` instead of `created`.
   */
  test('an inbound event id that another firm already holds creates a row here, not there', async () => {
    const firmA = await createFirm({ name: 'Firm A' });
    const firmB = await createFirm({ name: 'Firm B' });
    const theirEventRowId = await seedExternalEvent(firmA.id, {
      title: 'Firm A hearing',
      outlookId: 'EVT-SHARED',
      stableId: 'outlook_EVT-SHARED',
    });
    const uid = await connectMicrosoft(firmB.id);

    graph('GET', '/me/calendar/calendarView', always(200, {
      value: [graphEvent({ id: 'EVT-SHARED', subject: 'Firm B standup' })],
    }));

    const result = await outlookService.syncFromOutlook({ userId: uid, lawFirmId: firmB.id });

    // `created`, not `updated`, is the discriminator: an unscoped lookup would
    // have found firm A's row and taken the update branch.
    expect(result).toMatchObject({ createdCount: 1, updatedCount: 0, syncedCount: 1 });

    const theirs = await testPool.query(
      `select title, law_firm_id from calendar_events where id = $1`,
      [theirEventRowId],
    );
    expect(theirs.rows[0]).toEqual({ title: 'Firm A hearing', law_firm_id: firmA.id });

    const ours = await testPool.query(
      `select title from calendar_events where law_firm_id = $1 and outlook_id = 'EVT-SHARED'`,
      [firmB.id],
    );
    expect(ours.rows).toEqual([{ title: 'Firm B standup' }]);

    await settle();
  });

  /**
   * `$top` caps a Graph page at 100 events, so a firm with a busy year is
   * delivered across several pages. Goes red if the `@odata.nextLink` loop is
   * removed or stops after the first page: everything past event 100 is
   * silently dropped, and a dropped event is a missed court date.
   */
  test('syncFromOutlook follows @odata.nextLink instead of stopping at page one', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);

    graph('GET', '/me/calendar/calendarView', inSequence(
      always(200, {
        value: [graphEvent({ id: 'EVT-PAGE-1', subject: 'First page event' })],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendar/calendarView?$skiptoken=page2',
      }),
      always(200, {
        value: [graphEvent({ id: 'EVT-PAGE-2', subject: 'Second page event' })],
      }),
    ));

    const result = await outlookService.syncFromOutlook({ userId: uid, lawFirmId: firm.id });

    // Two created events, one per page. A loop that stopped after the first
    // page would report one, and the second page's event would never exist.
    expect(result).toMatchObject({ createdCount: 2, updatedCount: 0 });
    expect(callsTo('$skiptoken=page2')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select outlook_id from calendar_events where law_firm_id = $1 order by outlook_id`,
      [firm.id],
    );
    expect(rows).toEqual([{ outlook_id: 'EVT-PAGE-1' }, { outlook_id: 'EVT-PAGE-2' }]);

    await settle();
  });

  /**
   * A listing still paging when the page budget runs out is incomplete, and
   * the catch-up retry that ran it must stay queued rather than resolve.
   *
   * Goes red if the page cap goes back to a warning: `syncFromOutlook`
   * resolves, the sweep deletes the catch-up row, and everything past the cap
   * is never imported.
   */
  test('a listing cut off at the page budget leaves the catch-up retry queued', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const recorded = await calendarSyncRepo.recordWebhookFailure({
      provider: 'outlook', userId: uid, lawFirmId: firm.id, changeType: 'catch_up', eventId: 'reconnect', pending: true,
    });
    expect(recorded?.dedupeKey).toBeTruthy();

    let page = 0;
    graph('GET', '/me/calendar/calendarView', () => {
      page += 1;
      return new Response(JSON.stringify({
        value: [graphEvent({ id: `EVT-CAP-${page}` })],
        '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/calendar/calendarView?$skiptoken=p${page + 1}`,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { retryFailedWebhooks } = require('../../src/modules/calendar/shared/calendarWebhookRetry');
    const result = await retryFailedWebhooks();

    // The sweep reached the row and read the listing up to the cap.
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(callsTo('/me/calendar/calendarView')).toHaveLength(100);

    const { rows } = await testPool.query(
      `select payload->>'changeType' as change_type from calendar_sync_failures where dedupe_key = $1`,
      [recorded.dedupeKey],
    );
    expect(rows).toEqual([{ change_type: 'catch_up' }]);

    await settle();
  });

  /**
   * Goes red if a per-event failure is swallowed again: the full read resolves,
   * the catch-up retry is deleted, and the event that failed is never imported.
   * The other events in the listing are still imported.
   */
  test('an event that fails to import makes the full read fail after importing the rest', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);

    graph('GET', '/me/calendar/calendarView', always(200, {
      value: [
        graphEvent({ id: 'EVT-BROKEN', subject: 'Will fail' }),
        graphEvent({ id: 'EVT-FINE', subject: 'Imports fine' }),
      ],
    }));
    const realLookup = calendarSyncRepo.getMappingByExternalId;
    const lookup = jest.spyOn(calendarSyncRepo, 'getMappingByExternalId')
      .mockImplementation(async (...args: any[]) => {
        if (args[0] === 'EVT-BROKEN') throw new Error('mapping read failed');
        return realLookup(...args);
      });

    try {
      await expect(outlookService.syncFromOutlook({ userId: uid, lawFirmId: firm.id }))
        .rejects.toThrow('mapping read failed');
    } finally {
      lookup.mockRestore();
    }

    const { rows } = await testPool.query(
      `select outlook_id from calendar_events where law_firm_id = $1 order by outlook_id`, [firm.id],
    );
    expect(rows).toEqual([{ outlook_id: 'EVT-FINE' }]);

    await settle();
  });
});

// ── 5. the event that is gone, and retry classification ─────────────────────

describe('processSubscriptionNotification failure classification', () => {
  /**
   * The event was deleted between Microsoft emitting the notification and us
   * fetching it. Nothing to upsert and nothing a retry could fix.
   *
   * Goes red if 404/410 stops being a silent skip: a throw here makes the
   * webhook route record a durable retry, and the retry re-fetches the same
   * missing event about eight times over two hours, coalescing every other
   * change for that user onto the stalled row.
   */
  test('a remote event that is gone (404) is skipped, not retried', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);

    graph('GET', '/me/events/EVT-GONE', always(404, { error: { code: 'ErrorItemNotFound' } }));

    await expect(outlookService.processSubscriptionNotification({
      userId: uid,
      lawFirmId: firm.id,
      changeType: 'updated',
      resource: 'me/events/EVT-GONE',
      resourceData: { id: 'EVT-GONE' },
    })).resolves.toBeUndefined();

    // The fetch happened, so the empty result below is a decision, not a
    // short-circuit somewhere earlier.
    expect(callsTo('/me/events/EVT-GONE')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select id from calendar_events where law_firm_id = $1`,
      [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  /**
   * Goes red if a 429 or 5xx stops being classified retryable. The change is
   * then dropped silently: Microsoft does not redeliver, so the Paralegix side
   * never learns the event moved.
   */
  test('a throttled fetch (429) is thrown as retryable', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);

    graph('GET', '/me/events/EVT-THROTTLED', always(429, { error: { code: 'TooManyRequests' } }));

    await expect(outlookService.processSubscriptionNotification({
      userId: uid,
      lawFirmId: firm.id,
      changeType: 'updated',
      resource: 'me/events/EVT-THROTTLED',
      resourceData: { id: 'EVT-THROTTLED' },
    })).rejects.toMatchObject({ statusCode: 429, retryable: true });

    // Three attempts: the bounded in-request retry ran out before the durable
    // retry took over.
    expect(callsTo('/me/events/EVT-THROTTLED')).toHaveLength(3);
  });

  /**
   * A dead Microsoft grant cannot be fixed by retrying, only by the user
   * reconnecting. Goes red if the `requiresReAuth` swallow is removed from the
   * catch: the error escapes, the webhook route records a retry, and this
   * user's whole retry budget burns down on a token that will never work.
   *
   * Note the 401 never reaches the status classification inside
   * `processSubscriptionNotification`: `makeMicrosoftGraphCall` intercepts it
   * first, finds no refresh token, and throws `NO_REFRESH_TOKEN`.
   */
  test('a 401 with no refresh token is terminal and does not throw', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: null,
    });

    graph('GET', '/me/events/EVT-UNAUTHORIZED', always(401, { error: { code: 'InvalidAuthenticationToken' } }));

    await expect(outlookService.processSubscriptionNotification({
      userId: uid,
      lawFirmId: firm.id,
      changeType: 'updated',
      resource: 'me/events/EVT-UNAUTHORIZED',
      resourceData: { id: 'EVT-UNAUTHORIZED' },
    })).resolves.toBeUndefined();

    expect(callsTo('/me/events/EVT-UNAUTHORIZED')).toHaveLength(0);
    expect(callsTo('login.microsoftonline.com')).toHaveLength(0);
  });

  /**
   * The `deleted` change type never fetches the event: it is already gone at
   * Microsoft. Goes red if the delete branch starts issuing a fetch (the router
   * refuses it) or if it stops removing the local event.
   */
  test('a deleted notification removes the local event without fetching it', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const eventRowId = await seedExternalEvent(firm.id, {
      title: 'Cancelled hearing',
      outlookId: 'EVT-REMOVED',
      stableId: 'outlook_EVT-REMOVED',
    });

    await outlookService.processSubscriptionNotification({
      userId: uid,
      lawFirmId: firm.id,
      changeType: 'deleted',
      resource: 'me/events/EVT-REMOVED',
      resourceData: { id: 'EVT-REMOVED' },
    });

    const { rows } = await testPool.query(
      `select id from calendar_events where id = $1`,
      [eventRowId],
    );
    expect(rows).toHaveLength(0);
    expect(calls).toHaveLength(0);

    await settle();
  });
});

// ── 6. the webhook route: unknown subscription, wrong clientState ───────────

describe('outlook webhook delivery gates', () => {
  const deliver = (body: unknown) => request()
    .post('/api/webhooks/outlook-calendar')
    .send(body as object);

  /**
   * Both notifications go out in ONE batch, bad first. The route processes the
   * array in order, so once the good one's row exists the bad one has provably
   * already been through the loop: that is what makes the absence meaningful
   * rather than a race the test happened to win.
   *
   * Goes red if the unknown-subscription guard is removed. A subscription id
   * nobody issued would then be trusted, and anyone who can reach the webhook
   * URL could write events into a firm's calendar.
   */
  test('a notification for an unknown subscription is dropped', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const clientState = 'client-state-known';
    await seedSubscription({ id: 'sub-known', userId: uid, lawFirmId: firm.id, clientState });

    graph('GET', '/me/events/EVT-SPOOFED', always(200, graphEvent({ id: 'EVT-SPOOFED', subject: 'Spoofed' })));
    graph('GET', '/me/events/EVT-LEGITIMATE', always(200, graphEvent({ id: 'EVT-LEGITIMATE', subject: 'Legitimate' })));

    const res = await deliver({
      value: [
        { subscriptionId: 'sub-nobody-issued', changeType: 'created', resource: 'me/events/EVT-SPOOFED', resourceData: { id: 'EVT-SPOOFED' }, clientState },
        { subscriptionId: 'sub-known', changeType: 'created', resource: 'me/events/EVT-LEGITIMATE', resourceData: { id: 'EVT-LEGITIMATE' }, clientState },
      ],
    });
    expect(res.status).toBe(202);

    await waitFor(async () => {
      const { rows } = await testPool.query(
        `select id from calendar_events where law_firm_id = $1 and outlook_id = 'EVT-LEGITIMATE'`,
        [firm.id],
      );
      return rows[0];
    }, 'the legitimate notification to be processed');

    const spoofed = await testPool.query(
      `select id from calendar_events where outlook_id = 'EVT-SPOOFED'`,
    );
    expect(spoofed.rows).toHaveLength(0);
    expect(callsTo('/me/events/EVT-SPOOFED')).toHaveLength(0);

    await settle();
  });

  /**
   * `clientState` is the only thing authenticating a delivery: the route has no
   * auth middleware, because Microsoft cannot send our bearer tokens.
   *
   * Goes red if the comparison is loosened back to "verify only when a stored
   * value is present", or if a mismatch stops being dropped.
   */
  test('a notification whose clientState does not match is dropped', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    await seedSubscription({
      id: 'sub-guarded',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'the-real-client-state',
    });

    graph('GET', '/me/events/EVT-FORGED', always(200, graphEvent({ id: 'EVT-FORGED', subject: 'Forged' })));
    graph('GET', '/me/events/EVT-SIGNED', always(200, graphEvent({ id: 'EVT-SIGNED', subject: 'Signed' })));

    const res = await deliver({
      value: [
        { subscriptionId: 'sub-guarded', changeType: 'created', resource: 'me/events/EVT-FORGED', resourceData: { id: 'EVT-FORGED' }, clientState: 'guessed-client-state' },
        { subscriptionId: 'sub-guarded', changeType: 'created', resource: 'me/events/EVT-SIGNED', resourceData: { id: 'EVT-SIGNED' }, clientState: 'the-real-client-state' },
      ],
    });
    expect(res.status).toBe(202);

    await waitFor(async () => {
      const { rows } = await testPool.query(
        `select id from calendar_events where law_firm_id = $1 and outlook_id = 'EVT-SIGNED'`,
        [firm.id],
      );
      return rows[0];
    }, 'the correctly signed notification to be processed');

    const forged = await testPool.query(
      `select id from calendar_events where outlook_id = 'EVT-FORGED'`,
    );
    expect(forged.rows).toHaveLength(0);
    expect(callsTo('/me/events/EVT-FORGED')).toHaveLength(0);

    await settle();
  });

  /**
   * A transient Graph failure must become a durable work item rather than a
   * dropped change. Goes red if the route stops recording the failure, or if
   * `processSubscriptionNotification` swallows the 429 instead of throwing.
   */
  test('a transient Graph failure is persisted as a retryable work item', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const clientState = 'client-state-retry';
    await seedSubscription({ id: 'sub-retry', userId: uid, lawFirmId: firm.id, clientState });

    graph('GET', '/me/events/EVT-TRANSIENT', always(503, { error: { code: 'ServiceUnavailable' } }));

    const res = await deliver({
      value: [{
        subscriptionId: 'sub-retry',
        changeType: 'created',
        resource: 'me/events/EVT-TRANSIENT',
        resourceData: { id: 'EVT-TRANSIENT' },
        clientState,
      }],
    });
    expect(res.status).toBe(202);

    const failure = await waitFor(async () => {
      const { rows } = await testPool.query(
        `select provider, user_id, law_firm_id, payload->>'eventId' as event_id, attempts
           from calendar_sync_failures where kind = 'webhook' and provider = 'outlook'`,
      );
      return rows[0];
    }, 'the durable retry row to be written');

    expect(failure).toEqual({
      provider: 'outlook',
      user_id: uid,
      law_firm_id: firm.id,
      event_id: 'EVT-TRANSIENT',
      attempts: 1,
    });
  });

  /**
   * Echo suppression is per item, not per mailbox. Right after we push to a
   * mailbox, an `updated` delivery for a DIFFERENT event is a real edit and is
   * applied; the one for the event we just pushed is our own echo and is not.
   *
   * Goes red if a mailbox-wide "recent push" skip comes back (the edit to the
   * other event is dropped), or if the per-item recent-sync window is removed
   * (the echo overwrites the event we just pushed).
   */
  test('right after a push, a real edit to another event is applied while the echo of the pushed one is not', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const clientState = 'client-state-echo';
    await seedSubscription({
      id: 'sub-echo',
      userId: uid,
      lawFirmId: firm.id,
      clientState,
      lastOutboundPushAt: new Date(),
    });
    const seeded = await testPool.query(
      `insert into calendar_events (law_firm_id, title, starts_at, provider, source, external_event_id, outlook_id, created_by, last_synced_to_outlook, updated_at)
       values ($1, 'Pushed a moment ago', '2026-09-01T18:00:00Z', 'outlook', 'external', 'EVT-ECHO', 'EVT-ECHO', $2, now(), '2026-01-01T00:00:00Z'),
              ($1, 'Imported last week',  '2026-09-01T18:00:00Z', 'outlook', 'external', 'EVT-EDITED', 'EVT-EDITED', $2, null, '2026-01-01T00:00:00Z')`,
      [firm.id, uid],
    );
    expect(seeded.rowCount).toBe(2);

    await testPool.query(
      `insert into calendar_mappings (provider, external_event_id, user_id, law_firm_id, pushed_version)
       values ('outlook', 'EVT-ECHO', $1, $2, 'pushed-version')`, [uid, firm.id],
    );
    graph('GET', '/me/events/EVT-ECHO', always(200, graphEvent({ id: 'EVT-ECHO', subject: 'Echo of our push', changeKey: 'pushed-version' })));
    graph('GET', '/me/events/EVT-EDITED', always(200, graphEvent({ id: 'EVT-EDITED', subject: 'Renamed in Outlook' })));

    const res = await deliver({
      value: [
        { subscriptionId: 'sub-echo', changeType: 'updated', resource: 'me/events/EVT-ECHO', resourceData: { id: 'EVT-ECHO' }, clientState },
        { subscriptionId: 'sub-echo', changeType: 'updated', resource: 'me/events/EVT-EDITED', resourceData: { id: 'EVT-EDITED' }, clientState },
      ],
    });
    expect(res.status).toBe(202);

    // The batch runs in order, so once the second is applied the first has
    // provably been through the loop.
    await waitFor(async () => {
      const { rows } = await testPool.query(
        `select id from calendar_events where outlook_id = 'EVT-EDITED' and title = 'Renamed in Outlook'`,
      );
      return rows[0];
    }, 'the edit to the other event to be applied');

    expect(callsTo('/me/events/EVT-ECHO')).toHaveLength(1);
    const echo = await testPool.query(`select title from calendar_events where outlook_id = 'EVT-ECHO'`);
    expect(echo.rows[0].title).toBe('Pushed a moment ago');

    await settle();
  });

  /**
   * Microsoft can (and does) deliver the same change more than once inside a
   * single webhook POST. The route dedupes within a batch by
   * `(subscriptionId, eventId, changeType)` before processing anything, so a
   * duplicated notification costs one Graph fetch and produces one row, not
   * two lookups plus a second `calendar_events` insert racing the first.
   *
   * Goes red if the in-batch `seen` dedupe is removed: the event would be
   * fetched twice and this asserts on both the call count and the row count.
   */
  test('the same change delivered twice in one batch is processed once', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const clientState = 'client-state-dup';
    await seedSubscription({ id: 'sub-dup', userId: uid, lawFirmId: firm.id, clientState });

    graph('GET', '/me/events/EVT-DUP', always(200, graphEvent({ id: 'EVT-DUP', subject: 'Duplicate' })));

    const res = await deliver({
      value: [
        { subscriptionId: 'sub-dup', changeType: 'created', resource: 'me/events/EVT-DUP', resourceData: { id: 'EVT-DUP' }, clientState },
        { subscriptionId: 'sub-dup', changeType: 'created', resource: 'me/events/EVT-DUP', resourceData: { id: 'EVT-DUP' }, clientState },
      ],
    });
    expect(res.status).toBe(202);

    await waitFor(async () => {
      const { rows } = await testPool.query(
        `select id from calendar_events where law_firm_id = $1 and outlook_id = 'EVT-DUP'`,
        [firm.id],
      );
      return rows[0];
    }, 'the duplicated notification to be processed');

    expect(callsTo('/me/events/EVT-DUP')).toHaveLength(1);

    const { rows } = await testPool.query(
      `select id from calendar_events where law_firm_id = $1 and outlook_id = 'EVT-DUP'`,
      [firm.id],
    );
    expect(rows).toHaveLength(1);

    await settle();
  });

  /**
   * A subscription row can outlive the connection it was made for: the user
   * disconnects Microsoft (or the token is revoked out of band) while the
   * subscription is still active and Microsoft keeps delivering to it until
   * it naturally expires. `processSubscriptionNotification` must recognize
   * "no access token" and stop before ever reaching Graph, rather than
   * attempting a fetch with no credential.
   *
   * A second, connected user's notification in the SAME batch, processed
   * after and waited on here, is what proves the loop actually reached and
   * passed over the disconnected one instead of the batch being empty for an
   * unrelated reason.
   *
   * Goes red if the `!userData?.microsoftAccessToken` guard is removed: the
   * fetch would either be attempted with an empty bearer or throw uncaught.
   */
  test('a notification for a user with no Microsoft connection is dropped without contacting Graph', async () => {
    const firm = await createFirm();
    const disconnected = await connectMicrosoft(firm.id);
    const connected = await connectMicrosoft(firm.id);
    const clientStateA = 'client-state-disconnected';
    const clientStateB = 'client-state-connected';
    await seedSubscription({ id: 'sub-disconnected', userId: disconnected, lawFirmId: firm.id, clientState: clientStateA });
    await seedSubscription({ id: 'sub-connected', userId: connected, lawFirmId: firm.id, clientState: clientStateB });

    const deleted = await testPool.query(
      `delete from user_oauth_tokens where user_id = $1 and provider = 'microsoft'`,
      [disconnected],
    );
    expect(deleted.rowCount).toBe(1);

    graph('GET', '/me/events/EVT-LATER', always(200, graphEvent({ id: 'EVT-LATER', subject: 'Later' })));

    const res = await deliver({
      value: [
        { subscriptionId: 'sub-disconnected', changeType: 'created', resource: 'me/events/EVT-ORPHAN', resourceData: { id: 'EVT-ORPHAN' }, clientState: clientStateA },
        { subscriptionId: 'sub-connected', changeType: 'created', resource: 'me/events/EVT-LATER', resourceData: { id: 'EVT-LATER' }, clientState: clientStateB },
      ],
    });
    expect(res.status).toBe(202);

    await waitFor(async () => {
      const { rows } = await testPool.query(
        `select id from calendar_events where law_firm_id = $1 and outlook_id = 'EVT-LATER'`,
        [firm.id],
      );
      return rows[0];
    }, 'the connected user notification, processed after the disconnected one in the same batch');

    expect(callsTo('/me/events/EVT-ORPHAN')).toHaveLength(0);
    const orphan = await testPool.query(`select id from calendar_events where outlook_id = 'EVT-ORPHAN'`);
    expect(orphan.rows).toHaveLength(0);

    await settle();
  });
});

// ── 7. subscription lifecycle ───────────────────────────────────────────────

describe('calendar_subscriptions lifecycle', () => {
  /**
   * Graph's PATCH reply is the whole subscription. These cases renew one
   * created with lifecycle notifications, which renewal extends in place.
   */
  const LIFECYCLE_URL = 'https://webhook.invalid/api/webhooks/outlook-calendar/lifecycle';

  /**
   * Renewal is bounded to subscriptions expiring inside 24 hours, because each
   * one costs at least one serial Graph round trip.
   *
   * Goes red if the cutoff is dropped or widened: every subscription in the
   * table is renewed on every cron pass, and the run stops fitting in its
   * budget.
   */
  test('only a subscription expiring inside 24 hours is renewed', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    await seedSubscription({
      id: 'sub-due',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-due',
      expiresInMs: 60 * 60 * 1000,
    });
    await seedSubscription({
      id: 'sub-not-due',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-not-due',
      expiresInMs: 5 * 24 * 60 * 60 * 1000,
    });

    graph('PATCH', '/subscriptions/sub-due', always(200, { id: 'sub-due', lifecycleNotificationUrl: LIFECYCLE_URL }));
    graph('PATCH', '/subscriptions/sub-not-due', always(200, { id: 'sub-not-due', lifecycleNotificationUrl: LIFECYCLE_URL }));

    const before = await testPool.query(
      `select id, expiration from calendar_subscriptions where provider = 'outlook' order by id`,
    );
    expect(before.rows).toHaveLength(2);

    const result = await outlookService.renewExpiringSubscriptions();
    expect(result).toEqual({ renewed: 1, failed: 0, truncated: false });

    expect(callsTo('/subscriptions/sub-due')).toHaveLength(1);
    expect(callsTo('/subscriptions/sub-not-due')).toHaveLength(0);

    const after = await testPool.query(
      `select id, expiration from calendar_subscriptions where provider = 'outlook' order by id`,
    );
    const dueBefore = before.rows.find((r) => r.id === 'sub-due').expiration;
    const dueAfter = after.rows.find((r) => r.id === 'sub-due').expiration;
    const idleBefore = before.rows.find((r) => r.id === 'sub-not-due').expiration;
    const idleAfter = after.rows.find((r) => r.id === 'sub-not-due').expiration;
    expect(dueAfter.getTime()).toBeGreaterThan(dueBefore.getTime());
    expect(idleAfter.getTime()).toBe(idleBefore.getTime());
  });

  /**
   * The cutoff test above uses a 1-hour-vs-5-day gap, which would still pass
   * even if the 24-hour window were off by several hours. This pins the
   * boundary itself, seconds either side of it, using `expiration < cutoff`
   * (strict, from `calendarSync.repository.ts`): a subscription expiring
   * exactly ON the cutoff is NOT due yet.
   *
   * Goes red if the comparison flips to `<=` (the on-the-boundary case would
   * start renewing early) or the window widens/narrows by more than the ~20s
   * margin this test leaves for its own runtime.
   */
  test('a subscription seconds inside the 24-hour cutoff is renewed; one seconds past it is not', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    await seedSubscription({
      id: 'sub-just-inside',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-inside',
      expiresInMs: TWENTY_FOUR_HOURS_MS - 10_000,
    });
    await seedSubscription({
      id: 'sub-just-outside',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-outside',
      expiresInMs: TWENTY_FOUR_HOURS_MS + 10_000,
    });

    graph('PATCH', '/subscriptions/sub-just-inside', always(200, { id: 'sub-just-inside', lifecycleNotificationUrl: LIFECYCLE_URL }));
    graph('PATCH', '/subscriptions/sub-just-outside', always(200, { id: 'sub-just-outside', lifecycleNotificationUrl: LIFECYCLE_URL }));

    const result = await outlookService.renewExpiringSubscriptions();
    expect(result).toEqual({ renewed: 1, failed: 0, truncated: false });

    expect(callsTo('/subscriptions/sub-just-inside')).toHaveLength(1);
    expect(callsTo('/subscriptions/sub-just-outside')).toHaveLength(0);
  });

  /**
   * Microsoft refuses a PATCH on a subscription that already lapsed, and the
   * only recovery is a fresh one. Goes red if the recreate branch is removed:
   * the row is deleted (or left stale) and the user's silent sync stops without
   * anything reporting an error.
   */
  test('a subscription Microsoft has already expired is recreated under a new id', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    await seedSubscription({
      id: 'sub-expired',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-expired',
      expiresInMs: 60 * 60 * 1000,
    });

    graph('PATCH', '/subscriptions/sub-expired', always(404, { error: { code: 'ResourceNotFound' } }));
    graph('POST', '/v1.0/subscriptions', always(201, {
      id: 'sub-recreated',
      expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const result = await outlookService.renewExpiringSubscriptions();
    expect(result).toEqual({ renewed: 1, failed: 0, truncated: false });

    const { rows } = await testPool.query(
      `select id, user_id, law_firm_id, resource, secret from calendar_subscriptions where provider = 'outlook'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'sub-recreated',
      user_id: uid,
      law_firm_id: firm.id,
      resource: '/me/calendar/events',
    });
    // A recreated subscription gets its OWN random clientState; reusing the dead
    // one would let a delivery captured against the old subscription verify.
    // Migration 0203 stores it in the merged table's provider-neutral `secret`
    // column, which holds Google's channel token and Outlook's clientState.
    expect(rows[0].secret).not.toBe('cs-expired');
    expect(rows[0].secret).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The Graph DELETE is best-effort; the bookkeeping row is not.
   *
   * Disconnecting Microsoft is exactly when the grant is already dead, so the
   * DELETE throws `NO_REFRESH_TOKEN` rather than returning a status. Goes red if
   * `deleteSubscription` moves inside the try: the row survives, and the next
   * `enable-silent-sync` finds a subscription id Microsoft no longer honours.
   */
  test('stopSubscription removes the row even when the Graph delete throws', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id, {
      accessToken: 'expired-access',
      refreshToken: null,
    });
    await seedSubscription({
      id: 'sub-to-stop',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-stop',
    });

    graph('DELETE', '/subscriptions/sub-to-stop', always(401, { error: { code: 'InvalidAuthenticationToken' } }));

    await outlookService.stopSubscription('sub-to-stop');

    // The call was attempted, so the deleted row below is the catch path doing
    // its job rather than the service skipping Graph altogether.
    expect(callsTo('/subscriptions/sub-to-stop')).toHaveLength(1);
    const { rows } = await testPool.query(
      `select id from calendar_subscriptions where provider = 'outlook' and id = 'sub-to-stop'`,
    );
    expect(rows).toHaveLength(0);
  });

  /**
   * Subscriptions cascade with the firm, and the row holds the only copy of the
   * id the Graph DELETE needs, so they must be stopped BEFORE the firm row is
   * removed. Goes red if this stops walking every subscription the firm owns,
   * or if one failure aborts the rest: Microsoft keeps posting change
   * notifications for a firm that no longer exists.
   */
  test('deleting a firm stops every subscription it owns, even past a failure', async () => {
    const firm = await createFirm();
    const otherFirm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    const otherUid = await connectMicrosoft(otherFirm.id);

    await seedSubscription({ id: 'sub-firm-1', userId: uid, lawFirmId: firm.id, clientState: 'cs-1' });
    await seedSubscription({ id: 'sub-firm-2', userId: uid, lawFirmId: firm.id, clientState: 'cs-2' });
    await seedSubscription({ id: 'sub-other', userId: otherUid, lawFirmId: otherFirm.id, clientState: 'cs-3' });

    // The first delete fails at Graph; the second must still be attempted.
    graph('DELETE', '/subscriptions/sub-firm-1', always(500, { error: { code: 'InternalServerError' } }));
    graph('DELETE', '/subscriptions/sub-firm-2', always(204));

    const stopped = await outlookService.stopSubscriptionsForLawFirm(firm.id);
    expect(stopped).toBe(2);

    // A DELETE answered 500 is retried in-request, three attempts in all.
    expect(callsTo('/subscriptions/sub-firm-1')).toHaveLength(3);
    expect(callsTo('/subscriptions/sub-firm-2')).toHaveLength(1);
    expect(callsTo('/subscriptions/sub-other')).toHaveLength(0);

    const { rows } = await testPool.query(`select id from calendar_subscriptions where provider = 'outlook' order by id`);
    expect(rows).toEqual([{ id: 'sub-other' }]);
  });

  /**
   * A PATCH renewal can fail for a reason OTHER than "Microsoft already expired
   * it" (a transient 500, a permission hiccup): the subscription is still LIVE
   * at Microsoft. The recreate branch used to jump straight to
   * `calendarSyncRepo.deleteSubscription` and never call Graph at all, so the
   * still-live subscription was simply abandoned: Microsoft keeps pushing to it
   * for up to `SUBSCRIPTION_MAX_MINUTES` (~3 days) with no local row to resolve
   * it against, and every one of those notifications is dropped as "unknown
   * subscription". Google's equivalent path (`renewExpiringChannels` ->
   * `stopWatchChannel`) always attempts the remote stop first.
   *
   * Goes red if the renewal failure branch stops routing through
   * `stopSubscription` (or an equivalent Graph DELETE attempt) before recreating.
   */
  test('a PATCH failure that is not "already gone" still asks Microsoft to stop the old subscription once its replacement exists', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    await seedSubscription({
      id: 'sub-transient-fail',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-transient',
      expiresInMs: 60 * 60 * 1000,
    });

    // Still alive at Microsoft: the PATCH fails for an unrelated reason.
    graph('PATCH', '/subscriptions/sub-transient-fail', always(500, { error: { code: 'InternalServerError' } }));
    graph('DELETE', '/subscriptions/sub-transient-fail', always(204));
    graph('POST', '/v1.0/subscriptions', always(201, {
      id: 'sub-transient-recreated',
      expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const result = await outlookService.renewExpiringSubscriptions();
    expect(result).toEqual({ renewed: 1, failed: 0, truncated: false });

    // The defect: this used to be 0, because nothing ever told Microsoft the
    // old subscription id was being abandoned.
    expect(callsTo('/subscriptions/sub-transient-fail')).toEqual([
      expect.objectContaining({ method: 'PATCH' }),
      expect.objectContaining({ method: 'DELETE' }),
    ]);

    // The replacement is created first, so a failed create never leaves the
    // user with nothing watching their calendar.
    const order = calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')}`);
    expect(order.indexOf('POST /subscriptions')).toBeGreaterThan(-1);
    expect(order.indexOf('POST /subscriptions')).toBeLessThan(order.indexOf('DELETE /subscriptions/sub-transient-fail'));

    const { rows } = await testPool.query(`select id from calendar_subscriptions where provider = 'outlook' order by id`);
    expect(rows).toEqual([{ id: 'sub-transient-recreated' }]);
  });

  /**
   * Goes red if the failed-PATCH branch stops the old subscription before its
   * replacement is created: a failed create then leaves no subscription at all,
   * though the old one was still live at Microsoft and still delivering.
   */
  test('a failed PATCH whose replacement cannot be created leaves the old subscription recorded and running', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm.id);
    await seedSubscription({
      id: 'sub-keep',
      userId: uid,
      lawFirmId: firm.id,
      clientState: 'cs-keep',
      expiresInMs: 60 * 60 * 1000,
    });

    graph('PATCH', '/subscriptions/sub-keep', always(500, { error: { code: 'InternalServerError' } }));
    graph('DELETE', '/subscriptions/sub-keep', always(204));
    graph('POST', '/v1.0/subscriptions', always(500, { error: { code: 'InternalServerError' } }));

    const result = await outlookService.renewExpiringSubscriptions();
    expect(result).toEqual({ renewed: 0, failed: 1, truncated: false });

    expect(callsTo('/v1.0/subscriptions').filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(callsTo('/subscriptions/sub-keep').map((c) => c.method)).toEqual(['PATCH']);

    const { rows } = await testPool.query(
      `select id, secret from calendar_subscriptions where provider = 'outlook' and user_id = $1`, [uid],
    );
    expect(rows).toEqual([{ id: 'sub-keep', secret: 'cs-keep' }]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
