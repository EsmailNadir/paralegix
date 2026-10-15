/**
 * The Google calendar-sync ROUTES, driven through the real Express app.
 *
 * `googleCalendarSync.test.ts` covers the SERVICE by calling it directly, so it
 * never sees a middleware. This file covers the layer above it: the six
 * per-route gates in `calendar/shared/calendarSyncGates.ts`, the timezone
 * requirement, the route's own validation, and the exact envelope each endpoint
 * answers with.
 *
 * WHY THE GATES ARE WORTH A FILE. These endpoints push firm data OUT to Google
 * and pull events back IN, and the firm they act on is named in the request
 * BODY rather than in the url, so none of them can use the ordinary
 * `/api/lawfirms/:lawFirmId` wiring that guards every other firm-scoped router.
 * The whole tenancy boundary for this module is those six functions. A caller
 * who is not a member of the firm they name must not be able to copy that
 * firm's hearings into a personal Google calendar, and a firm whose plan does
 * not include calendar sync (or whose billing has lapsed) must not get the
 * feature for free, because this router mounts outside the workspace billing
 * gate and `requireCalendarSync*` is the only place that is checked.
 *
 * The batch routes are the sharpest edge: their gate resolves ONE firm id from
 * the first item of the array, so a mixed batch is authorized against a firm the
 * caller does belong to while carrying items for one they do not. The route
 * layer alone cannot close that, and the case below proves the service's
 * per-firm re-check does.
 *
 * Every refusal case is paired with a permitted caller on the SAME route with
 * the SAME fixtures. A 403 alone proves nothing: it is also what a broken
 * fixture, a missing seed, or a typo'd path produces.
 *
 * NO LIVE GOOGLE CALL IS POSSIBLE HERE. `support/googleFetch.ts` replaces
 * `globalThis.fetch` at module load with a router that answers only registered
 * urls and THROWS on anything else, so a route that reaches for an endpoint no
 * test anticipated fails loudly. The first case proves the wall is up; without
 * it, every "and nothing was pushed to Google" assertion below would be
 * worthless. It also protects real credentials: `tests/support/db.ts` loads
 * `backend/.env`, so a genuine `GOOGLE_CLIENT_SECRET` is in `process.env` while
 * these run.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  googleCalls,
  wallIsUp,
} from './support/googleFetch';

// Before `setupInProcess` pulls in the app graph, so nothing can reach the
// network on the way in.
installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool, unfreezeClock,
  createFirm,
  ownerOf,
  memberWith,
  request,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { seedMatterEvent } from './support/calendarWorld';

const BASE = '/api/google-calendar-sync';

// Google urls the routes reach for. Kept narrow so one registration cannot
// accidentally answer a call the test did not mean to allow.
const USERINFO = 'oauth2/v1/userinfo';
const TOKENINFO = 'oauth2.googleapis.com/tokeninfo';
const GOOGLE_CALENDAR = 'https://www.googleapis.com/auth/calendar';
const CAL_LIST = 'users/me/calendarList';
const CAL_PATCH = /\/calendars\/primary$/;
const EVENTS_LIST = /\/calendars\/primary\/events\?/;
const EVENTS_CREATE = /\/calendars\/primary\/events(?:\?sendUpdates=none)?$/;
const EVENT_BY_ID = /\/calendars\/primary\/events\/[^/?]+$/;
const WATCH = /\/calendars\/primary\/events\/watch$/;
const CHANNELS_STOP = 'channels/stop';

let firm: Firm;

// ── fixtures ────────────────────────────────────────────────────────────────
// Plain SQL through the test pool, never the code under test: a fixture built
// by a broken repository produces both the data and the expectation.

/**
 * Give an existing user a connected Google account.
 *
 * `getUserDataAndSettings` memoizes per user id for 5 seconds inside the
 * process and nothing resets it between cases, so every test connects its OWN
 * freshly created actor rather than a shared one.
 */
async function connectGoogle(
  uid: string,
  opts: {
    accessToken?: string;
    refreshToken?: string | null;
    outbound?: boolean;
    inbound?: boolean;
    scope?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const accessToken = opts.accessToken ?? `access-${randomUUID().slice(0, 8)}`;
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, scope, meta)
     values ($1, 'google', $2, $3, $4, $5::jsonb)`,
    [uid, accessToken, opts.refreshToken === undefined ? 'refresh-seed' : opts.refreshToken,
      opts.scope ?? null, JSON.stringify(opts.meta ?? {})],
  );
  expect(tokens.rowCount).toBe(1);

  const settings = await testPool.query(
    `with touched as (update users set preferences = $4::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', $2, $3)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid, opts.outbound ?? true, opts.inbound ?? true, JSON.stringify({ googleCalendarTarget: 'default' })],
  );
  expect(settings.rowCount).toBe(1);
  return accessToken;
}

/** An owner of `lawFirmId` with Google already connected. */
async function connectedOwner(lawFirmId: string): Promise<Actor & { accessToken: string }> {
  const actor = await ownerOf(lawFirmId);
  const accessToken = await connectGoogle(actor.uid);
  return { ...actor, accessToken };
}

/** A member holding exactly `permissions`, with Google already connected. */
async function connectedMember(lawFirmId: string, permissions: string[]): Promise<Actor> {
  const actor = await memberWith(lawFirmId, permissions);
  await connectGoogle(actor.uid);
  return actor;
}

/** `createdBy` is who a "sync existing" press may push the unassigned task to. */
async function seedTask(lawFirmId: string, title = 'File the motion', createdBy: string | null = null) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into tasks (id, law_firm_id, title, due_date, due_at, created_by)
     values ($1, $2, $3, '2026-09-10', '2026-09-10T16:00:00Z', $4)`,
    [id, lawFirmId, title, createdBy],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedMatter(lawFirmId: string) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Bell v. Ward', $3)`,
    [id, lawFirmId, `M-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/**
 * Staff a user on a matter.
 *
 * The batch push routes apply the matter wall as well as the firm one
 * (`resolveSyncableMatterKeys`), so a permitted caller in a matter-event case has
 * to be a member of the matter or the push is refused per item for a reason that
 * has nothing to do with the gate under test. Owners are exempt (they read every
 * matter in the firm), which is why only the plain-member cases need this.
 */
async function addMatterMember(lawFirmId: string, matterId: string, userId: string) {
  const res = await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'member', now())`,
    [matterId, userId, lawFirmId],
  );
  expect(res.rowCount).toBe(1);
}

/** A client with one event recorded against the client directly (no matter). */
async function seedClientEvent(lawFirmId: string, title = 'Client check-in', createdBy: string | null = null) {
  const clientId = randomUUID();
  const client = await testPool.query(
    `insert into clients (id, law_firm_id, name, client_type) values ($1, $2, 'Ada Bello', 'person')`,
    [clientId, lawFirmId],
  );
  expect(client.rowCount).toBe(1);
  const eventId = randomUUID();
  const event = await testPool.query(
    `insert into events (id, law_firm_id, client_id, type, title, date, created_by)
     values ($1, $2, $3, 'meeting', $4, '2026-09-02T17:00:00Z', $5)`,
    [eventId, lawFirmId, clientId, title, createdBy],
  );
  expect(event.rowCount).toBe(1);
  return { clientId, eventId };
}

async function seedWatchChannel(userId: string, lawFirmId: string, overrides: { expiration?: string } = {}) {
  const channelId = `chan-${randomUUID().slice(0, 8)}`;
  const res = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
     values ('google', $1, $2, $3, 'primary', $4, 'tok', $5)`,
    [channelId, userId, lawFirmId, `res-${channelId}`, overrides.expiration ?? '2026-12-01T00:00:00Z'],
  );
  expect(res.rowCount).toBe(1);
  return { channelId, resourceId: `res-${channelId}` };
}

const taskRow = async (taskId: string) => (await testPool.query(
  `select google_event_id, google_calendar_id from tasks where id = $1`, [taskId],
)).rows[0];

const watchChannelRows = async () => (await testPool.query(
  `select id, user_id, law_firm_id, calendar_id from calendar_subscriptions where provider = 'google' order by id`,
)).rows;

let webhookBaseUrl: string | undefined;

beforeAll(() => {
  // `createWatchChannel` refuses to do anything without an https webhook base,
  // so enable-silent-sync would answer 500 for a reason unrelated to its gate.
  webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
  process.env.WEBHOOK_BASE_URL = 'https://hooks.paralegix.test';
});

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-08-01T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  // Cross-sync to Outlook and the watch-channel stamp are fire-and-forget; let
  // them land against a live pool before the next truncate.
  await drainEvents();
  unfreezeClock();
});

afterAll(() => {
  uninstallGoogleFetchWall();
  if (webhookBaseUrl === undefined) delete process.env.WEBHOOK_BASE_URL;
  else process.env.WEBHOOK_BASE_URL = webhookBaseUrl;
});

// ── the wall ────────────────────────────────────────────────────────────────

describe('the network wall', () => {
  /**
   * Goes red if `globalThis.fetch` is no longer replaced, or if the router stops
   * throwing on an unregistered url. Every "nothing was pushed to Google" case
   * below is only as good as this one.
   */
  test('an unrouted Google request fails the request instead of reaching Google', async () => {
    const owner = await connectedOwner(firm.id);
    expect(wallIsUp()).toBe(true);

    const res = await owner.api.get(`${BASE}/calendars`);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    // The attempt is recorded, so this is not passing because nothing ran: the
    // route really did try to reach googleapis.com, on the caller's own token.
    const attempts = callsMatching(CAL_LIST);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toContain('https://www.googleapis.com/');
    expect(attempts[0].bearer).toBe(owner.accessToken);
  });
});

// ── authentication ──────────────────────────────────────────────────────────

describe('verifyToken', () => {
  /**
   * Every route on this router carries `verifyToken`. Goes red if it is dropped
   * from the read route or the mutating one, which would expose a user's Google
   * connection state and their outbound push to anyone.
   */
  test('refuses an unauthenticated caller on both a read and a write route', async () => {
    const read = await request().get(`${BASE}/check-auth`);
    expect(read.status).toBe(401);
    expect(read.body.code).toBe('NO_TOKEN');

    const write = await request()
      .post(`${BASE}/sync-from-google`)
      .set('x-timezone', 'America/New_York')
      .send({ lawFirmId: firm.id });
    expect(write.status).toBe(401);
    expect(write.body.code).toBe('NO_TOKEN');

    expect(googleCalls()).toHaveLength(0);
  });
});

// ── check-auth ──────────────────────────────────────────────────────────────

describe('GET /check-auth', () => {
  /**
   * Deliberately NOT firm-scoped: it reports the caller's own Google grant, so
   * it carries no gate beyond `verifyToken`. Goes red if the route goes back to
   * an identity probe, or if the answer stops carrying the connected email.
   */
  test('answers the caller their own Google state', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, { scope: `${GOOGLE_CALENDAR} openid`, meta: { accountEmail: 'lawyer@firm.test' } });
    route(USERINFO, { status: 200, json: { email: 'lawyer@firm.test' } });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true, state: 'connected', email: 'lawyer@firm.test' });
    expect(callsMatching(USERINFO)).toHaveLength(0);
  });

  /**
   * A token that proves who the person is but carries no calendar permission
   * is not a connection. Goes red if any 200 from Google is read as connected.
   */
  test('reports permission_required, not connected, when only identity scopes were granted', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid, { scope: 'https://www.googleapis.com/auth/userinfo.email openid' });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: false, state: 'permission_required', email: null });
    expect(googleCalls()).toHaveLength(0);
  });

  /**
   * A row stored before scopes were recorded is resolved once, through
   * tokeninfo, and the answer is kept. Goes red if the legacy row is reported
   * as connected without checking, or if the resolved scope is not stored.
   */
  test('resolves a legacy row through tokeninfo and records its scope', async () => {
    const owner = await connectedOwner(firm.id);
    route(TOKENINFO, { status: 200, json: { scope: 'openid email' } });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: false, state: 'permission_required' });
    const [probe] = callsMatching(TOKENINFO);
    expect(probe.method).toBe('POST');
    expect(probe.body).toEqual({ access_token: owner.accessToken });
    expect(probe.url).not.toContain(owner.accessToken);
    const { rows } = await testPool.query(
      `select scope from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    );
    expect(rows[0].scope).toBe('openid email');
  });

  /**
   * Storing the resolved scope can fail, and a database error's message names
   * the query parameters, one of which is the access token. Goes red if that
   * failure escapes to the central handler (which logs the message) instead of
   * being logged here by code alone.
   */
  test('logs a failed scope write by code, never the token, and still answers', async () => {
    const util = require('util');
    const calendarTokens = require('../../src/modules/calendar/shared/calendarTokens');
    const { logger } = require('../../src/shared/utils/logger');
    const owner = await connectedOwner(firm.id);
    route(TOKENINFO, { status: 200, json: { scope: `${GOOGLE_CALENDAR} openid` } });
    const failure = Object.assign(new Error(`Failed query: update user_oauth_tokens\nparams: ${owner.accessToken}`), {
      cause: { code: '57014' },
    });
    const failing = jest.spyOn(calendarTokens, 'saveAccessToken').mockRejectedValueOnce(failure);
    const logged: string[] = [];
    const capture = (...args: unknown[]) => { logged.push(args.map((a) => util.inspect(a, { depth: 5 })).join(' ')); };
    const spies = [
      jest.spyOn(console, 'error').mockImplementation(capture),
      jest.spyOn(console, 'warn').mockImplementation(capture),
      jest.spyOn(logger, 'error').mockImplementation(capture),
      jest.spyOn(logger, 'warn').mockImplementation(capture),
    ];

    let res: any;
    try {
      res = await owner.api.get(`${BASE}/check-auth`);
      expect(failing).toHaveBeenCalled();
    } finally {
      failing.mockRestore();
      for (const spy of spies) spy.mockRestore();
    }

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: false, state: 'unverified' });
    expect(logged.join('\n')).toContain('57014');
    expect(logged.join('\n')).not.toContain(owner.accessToken);
  });

  /**
   * A tokeninfo request that cannot reach Google is not a server fault: the row
   * stays unverified and the answer says so. Goes red if the fetch is not
   * caught, which turns check-auth into a 500.
   */
  test('reports a legacy row as unverified when tokeninfo and the refresh are unreachable', async () => {
    const owner = await connectedOwner(firm.id);

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: false, state: 'unverified' });
    expect(callsMatching(TOKENINFO)).toHaveLength(1);
  });

  /**
   * Goes red if the `googleAccessToken` guard is dropped: the route would then
   * call Google with no bearer at all. Measured against the case above, which
   * proves this fixture shape does produce a call when a token exists.
   */
  test('answers 400 and contacts nobody when the caller has no Google connection', async () => {
    const owner = await ownerOf(firm.id);
    route(USERINFO, { status: 200, json: { email: 'should-not-be-reached@firm.test' } });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'No Google token available' });
    expect(googleCalls()).toHaveLength(0);
  });
});

// ── calendars ───────────────────────────────────────────────────────────────

describe('GET /calendars', () => {
  /**
   * The route reshapes Google's calendar list rather than forwarding it. Goes
   * red if the mapping changes or if the raw provider payload starts leaking
   * through (access roles, owner emails, conference config).
   */
  test('returns the caller calendar list in the app shape', async () => {
    const owner = await connectedOwner(firm.id);
    route(CAL_LIST, {
      status: 200,
      json: {
        items: [
          { id: 'primary', summary: 'Work', primary: true, backgroundColor: '#123456', accessRole: 'owner' },
          { id: 'readonly@group.calendar.google.com', summary: 'Court holidays', accessRole: 'reader' },
        ],
      },
    });

    const res = await owner.api.get(`${BASE}/calendars`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      calendars: [
        { id: 'primary', name: 'Work', isDefault: true, color: '#123456', canEdit: true },
        {
          id: 'readonly@group.calendar.google.com',
          name: 'Court holidays',
          isDefault: false,
          color: '#000000',
          canEdit: false,
        },
      ],
    });
  });

  test('answers 400 and contacts nobody when the caller has no Google connection', async () => {
    const owner = await ownerOf(firm.id);
    route(CAL_LIST, { status: 200, json: { items: [{ id: 'primary', summary: 'Work' }] } });

    const res = await owner.api.get(`${BASE}/calendars`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'No Google token available' });
    expect(googleCalls()).toHaveLength(0);
  });
});

// ── init-paralegix-calendar ─────────────────────────────────────────────────

describe('POST /init-paralegix-calendar', () => {
  /**
   * `requireTimezone` is live here and the calendar is created IN the caller's
   * zone, so a missing header must refuse rather than silently default to UTC.
   * Goes red if `requireTimezone` is removed from this route.
   */
  test('refuses a request with no timezone before contacting Google', async () => {
    const owner = await connectedOwner(firm.id);
    route(/\/calendar\/v3\/calendars$/, { status: 200, json: { id: 'new-dedicated', summary: 'Paralegix' } }, { method: 'POST' });

    const res = await owner.api.post(`${BASE}/init-paralegix-calendar`).set('x-timezone', '').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Timezone is required/);
    expect(googleCalls()).toHaveLength(0);

    // The same caller WITH the header gets through to Google, so the refusal
    // above is the timezone gate and not a broken fixture.
    const withTimezone = await owner.api.post(`${BASE}/init-paralegix-calendar`).send({});
    expect(withTimezone.status).toBe(200);
    expect(googleCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  /**
   * The one route that answers 401 for a MISSING connection rather than 400,
   * and tags it so the browser raises the Google reconnect prompt instead of
   * refreshing the Firebase session in a loop. Goes red if `sendGoogleError`
   * stops attaching the discriminating code.
   */
  test('tags a missing Google connection as a re-auth prompt', async () => {
    const owner = await ownerOf(firm.id);

    const res = await owner.api.post(`${BASE}/init-paralegix-calendar`).send({});

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      code: 'GOOGLE_REAUTH_REQUIRED',
      requiresReAuth: true,
      error: 'No Google token available. Please reconnect Google.',
    });
    expect(googleCalls()).toHaveLength(0);
  });

  test('returns the existing Paralegix calendar for a connected caller', async () => {
    const owner = await connectedOwner(firm.id);
    await require('../../src/modules/calendar/shared/calendarTokens').saveSettings(owner.uid, { paralegixGoogleCalendarId: 'paralegix@group.calendar.google.com' });
    route('/calendars/paralegix%40group.calendar.google.com', { status: 200, json: {
      id: 'paralegix@group.calendar.google.com', summary: 'Renamed Paralegix', backgroundColor: '#ABCDEF',
    } });

    const res = await owner.api.post(`${BASE}/init-paralegix-calendar`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Paralegix calendar initialized successfully',
      calendar: { id: 'paralegix@group.calendar.google.com', name: 'Renamed Paralegix', color: '#ABCDEF' },
    });
  });
});

// ── sync-from-google (requireSyncPerm + requireCalendarSync) ────────────────

describe('POST /sync-from-google', () => {
  const inboundEvent = {
    status: 200,
    json: {
      items: [{
        id: 'g-inbound-1',
        summary: 'Client intake',
        status: 'confirmed',
        start: { dateTime: '2026-09-04T15:00:00Z' },
        end: { dateTime: '2026-09-04T16:00:00Z' },
      }],
    },
  };

  const firmEventRows = async (lawFirmId: string) => (await testPool.query(
    `select title, google_event_id from calendar_events where law_firm_id = $1`, [lawFirmId],
  )).rows;

  /** The permitted baseline every refusal below is measured against. */
  test('pulls the events in for an owner', async () => {
    const owner = await connectedOwner(firm.id);
    route(EVENTS_LIST, inboundEvent);

    const res = await owner.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1, createdCount: 1, updatedCount: 0 });
    expect(await firmEventRows(firm.id)).toEqual([{ title: 'Client intake', google_event_id: 'g-inbound-1' }]);
  });

  test('an ordinary Google event appears in the syncing member calendar feed only', async () => {
    const owner = await connectedOwner(firm.id);
    const colleague = await memberWith(firm.id, []);
    route(EVENTS_LIST, inboundEvent);

    const sync = await owner.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: firm.id });
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ createdCount: 1 });

    const feedUrl = `/api/lawfirms/${firm.id}/calendar-feed?from=2026-09-01&to=2026-09-30&tz=America/New_York`;
    const mine = await owner.api.get(feedUrl);
    const theirs = await colleague.api.get(feedUrl);

    expect(mine.status).toBe(200);
    expect(mine.body.calendarEvents.events).toEqual([expect.objectContaining({
      title: 'Client intake', provider: 'google', googleEventId: 'g-inbound-1', source: 'external',
      start: '2026-09-04T15:00:00.000Z', end: '2026-09-04T16:00:00.000Z',
    })]);
    expect(theirs.status).toBe(200);
    expect(theirs.body.calendarEvents.events).toEqual([]);
  });

  /**
   * `requireSyncPerm` checks `calendar.sync` specifically, not merely
   * membership. Both callers below are full members of the firm and both have
   * Google connected; the only difference is the permission code on their role.
   * Goes red if `requireSyncPerm` is removed or if it stops naming
   * `calendar.sync`.
   */
  test('admits a member holding calendar.sync and refuses one without it', async () => {
    const refused = await connectedMember(firm.id, ['calendar.view']);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    route(EVENTS_LIST, inboundEvent);

    const denied = await refused.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: firm.id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect(googleCalls()).toHaveLength(0);
    expect(await firmEventRows(firm.id)).toHaveLength(0);

    const allowed = await permitted.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: firm.id });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ syncedCount: 1 });
    expect(await firmEventRows(firm.id)).toHaveLength(1);
  });

  /**
   * The ethical wall. A full owner of ANOTHER firm names this firm in the body;
   * without `requireSyncPerm` the body would be taken at its word and that
   * firm's Google calendar would be read into this firm's records.
   *
   * Goes red if `requireSyncPerm` is removed: the handler's own
   * `assertLawFirmMembership` would still refuse, so the case also pins that the
   * refusal arrives as a 403 rather than as a scrubbed 500.
   */
  test('refuses an owner of a different firm and writes nothing into this one', async () => {
    const neighbour = await createFirm();
    const outsider = await connectedOwner(neighbour.id);
    route(EVENTS_LIST, inboundEvent);

    const res = await outsider.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', error: 'Not a member of this firm' });
    expect(googleCalls()).toHaveLength(0);
    expect(await firmEventRows(firm.id)).toHaveLength(0);

    // The same caller against their OWN firm succeeds, so the refusal above is
    // the firm scoping and not a broken fixture.
    const own = await outsider.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: neighbour.id });
    expect(own.status).toBe(200);
    expect(await firmEventRows(neighbour.id)).toHaveLength(1);
  });

  /**
   * This router mounts OUTSIDE `/api/lawfirms/:lawFirmId`, so
   * `requireCalendarSync` is the only thing standing between a plan without
   * calendar sync and the feature. Goes red if that gate is removed.
   */
  test('refuses a firm whose plan does not include calendar sync', async () => {
    const starter = await createFirm({ planId: 'starter' });
    const owner = await connectedOwner(starter.id);
    route(EVENTS_LIST, inboundEvent);

    const res = await owner.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: starter.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not included in your current plan/);
    expect(googleCalls()).toHaveLength(0);
  });

  /**
   * Same gate, the other half of its job: a firm whose billing has lapsed keeps
   * no paid feature. Nothing else on this router checks payment state. Goes red
   * if `requireCalendarSync` is removed or stops calling
   * `assertFirmBillingActive`.
   */
  test('refuses a firm whose billing has lapsed', async () => {
    const lapsed = await createFirm();
    await testPool.query(`update law_firms set billing_status = 'past_due' where id = $1`, [lapsed.id]);
    const owner = await connectedOwner(lapsed.id);
    route(EVENTS_LIST, inboundEvent);

    const res = await owner.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: lapsed.id });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('BILLING_INACTIVE');
    expect(googleCalls()).toHaveLength(0);
  });

  /**
   * With no firm id the gates are deliberate no-ops (they only ever deny a
   * KNOWN firm), and the handler treats the absence as a client bug rather than
   * user-actionable input. Goes red if the handler starts trusting a bodyless
   * request, which would reach Google with an undefined firm.
   */
  test('refuses a request with no lawFirmId without contacting Google or naming the internal reason', async () => {
    const owner = await connectedOwner(firm.id);
    route(EVENTS_LIST, inboundEvent);

    const res = await owner.api.post(`${BASE}/sync-from-google`).send({});

    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/lawFirmId/);
    expect(googleCalls()).toHaveLength(0);
  });

  /**
   * A permitted caller whose Google grant is gone has to be told to RECONNECT
   * GOOGLE, which the browser recognizes by the 401 plus the discriminating
   * code. Answering anything else means the reconnect prompt never fires and
   * background sync fails silently forever.
   *
   * Goes red if `resolveGoogleErrorStatus` stops reading the status off an
   * `AppError` (which carries `statusCode`, not `status`).
   */
  test('asks a connected-then-disconnected caller to reconnect Google', async () => {
    const owner = await ownerOf(firm.id);
    route(EVENTS_LIST, inboundEvent);

    const res = await owner.api.post(`${BASE}/sync-from-google`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED', requiresReAuth: true });
    expect(googleCalls()).toHaveLength(0);
  });
});

// ── the removed direct-push routes ──────────────────────────────────────────

describe('the direct-push routes', () => {
  /**
   * create-event, update-event and delete-event pushed a bare event straight
   * to Google, outside the adapters every real push goes through, and
   * nothing called them. Goes red if any of the three is mounted again.
   */
  test.each([
    ['post', '/create-event'],
    ['put', '/update-event/ext-1'],
    ['delete', '/delete-event/ext-1'],
  ] as const)('%s %s is not mounted', async (method, path) => {
    const owner = await connectedOwner(firm.id);

    const res = await owner.api[method](`${BASE}${path}?lawFirmId=${firm.id}`)
      .send({ lawFirmId: firm.id, title: 'Deposition of Ward', startTime: '2030-09-10T14:00:00Z' });

    expect(res.status).toBe(404);
    expect(googleCalls()).toHaveLength(0);
  });
});

// ── sync-tasks-to-google (requireSyncPermFromItems + …FromItems) ────────────

describe('POST /sync-tasks-to-google', () => {
  function routeTaskPush(ids: string[]) {
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(EVENTS_CREATE, (_call, hit) => ({ status: 200, json: { id: ids[Math.min(hit, ids.length - 1)] } }), { method: 'POST' });
  }

  const taskItem = (lawFirmId: string, taskId: string, title: string) => ({
    taskId, lawFirmId, title, dueDate: '2026-09-10T16:00:00Z',
  });

  test('refuses a body with no tasks array', async () => {
    const owner = await connectedOwner(firm.id);

    const res = await owner.api.post(`${BASE}/sync-tasks-to-google`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', error: 'Tasks array is required' });
    expect(googleCalls()).toHaveLength(0);
  });

  /**
   * THE batch hole, and the reason the service re-checks. The route gate reads
   * ONE firm id (here, the first item's) and authorizes the whole array against
   * it, so a caller who belongs to firm A can smuggle firm B's task into the
   * same request. Only `resolveSyncableFirmIds` inside the service stops firm
   * B's work from being copied into the caller's personal Google calendar.
   *
   * Goes red if that per-firm re-check is dropped: the second push would go out
   * and firm B's task would come back carrying a google event id.
   */
  test('pushes only the items belonging to firms the caller is a member of', async () => {
    const neighbour = await createFirm();
    const owner = await connectedOwner(firm.id);
    const mine = await seedTask(firm.id, 'File the motion', owner.uid);
    const theirs = await seedTask(neighbour.id, 'Their confidential filing');
    routeTaskPush(['g-task-mine', 'g-task-theirs']);

    const res = await owner.api.post(`${BASE}/sync-tasks-to-google`).send({
      tasks: [
        taskItem(firm.id, mine, 'File the motion'),
        taskItem(neighbour.id, theirs, 'Their confidential filing'),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1 });
    expect(res.body.results).toEqual([
      { taskId: mine, success: true, eventId: 'g-task-mine' },
      { taskId: theirs, success: false, error: 'Not a member of this firm' },
    ]);

    // Exactly one push, carrying the caller's own task and not the neighbour's.
    const pushes = callsMatching(EVENTS_CREATE);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body.summary).toBe('File the motion');

    // Recorded under the pushing user, where every later real-time update looks.
    expect((await testPool.query(`select calendar_sync from tasks where id = $1`, [mine])).rows[0].calendar_sync)
      .toEqual({ google: { [owner.uid]: { dueDate: { eventId: 'g-task-mine' } } } });
    expect(await taskRow(theirs)).toMatchObject({ google_event_id: null });
  });

  /**
   * Goes red if `requireSyncPermFromItems` is removed: the member without
   * `calendar.sync` would reach the service, whose own per-firm re-check would
   * also refuse them, so this case additionally pins that the answer is a 403
   * rather than a 200 carrying a per-item failure.
   */
  test('refuses a member without calendar.sync at the route, not per item', async () => {
    const refused = await connectedMember(firm.id, ['calendar.view']);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    const taskId = await seedTask(firm.id, undefined, permitted.uid);
    routeTaskPush(['g-task-1']);

    const denied = await refused.api.post(`${BASE}/sync-tasks-to-google`)
      .send({ tasks: [taskItem(firm.id, taskId, 'File the motion')] });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect(googleCalls()).toHaveLength(0);

    const allowed = await permitted.api.post(`${BASE}/sync-tasks-to-google`)
      .send({ tasks: [taskItem(firm.id, taskId, 'File the motion')] });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ syncedCount: 1 });
  });

  /**
   * `firmIdFromItems` prefers a top-level `lawFirmId` over the first item's.
   * Goes red if that precedence is dropped: the gate would authorize against
   * the item's firm (which the caller does belong to) while the caller was
   * explicitly asking to act as a firm they do not.
   */
  test('gates on the top-level lawFirmId ahead of the first item', async () => {
    const neighbour = await createFirm();
    const owner = await connectedOwner(firm.id);
    const taskId = await seedTask(firm.id);
    routeTaskPush(['g-task-1']);

    const res = await owner.api.post(`${BASE}/sync-tasks-to-google`).send({
      lawFirmId: neighbour.id,
      tasks: [taskItem(firm.id, taskId, 'File the motion')],
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', error: 'Not a member of this firm' });
    expect(googleCalls()).toHaveLength(0);
  });
});

// ── sync-events-to-google ───────────────────────────────────────────────────

describe('POST /sync-events-to-google', () => {
  function routeEventPush(id = 'g-matter-event') {
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(EVENTS_CREATE, { status: 200, json: { id } }, { method: 'POST' });
  }

  test('pushes a matter event for an owner and records the reverse mapping', async () => {
    const owner = await connectedOwner(firm.id);
    const matterId = await seedMatter(firm.id);
    const eventId = await seedMatterEvent(firm.id, matterId, undefined, undefined, owner.uid);
    routeEventPush();

    const res = await owner.api.post(`${BASE}/sync-events-to-google`).send({
      events: [{
        eventId, matterId, lawFirmId: firm.id, title: 'Preliminary hearing', date: '2026-09-10T14:00:00Z',
      }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1 });
    expect(res.body.results).toEqual([{ eventId, success: true, googleEventId: 'g-matter-event' }]);

    const { rows } = await testPool.query(
      `select external_event_id, law_firm_id, entity_type, entity_id, scope_id, user_id
         from calendar_mappings`,
    );
    expect(rows).toEqual([{
      external_event_id: 'g-matter-event',
      law_firm_id: firm.id,
      entity_type: 'matterEvent',
      entity_id: eventId,
      scope_id: matterId,
      user_id: owner.uid,
    }]);
  });

  /**
   * Goes red if `requireSyncPermFromItems` is removed from this route. Matter
   * events are the hearing dates: a member off the sync role must not be able
   * to copy them out.
   */
  test('refuses a member without calendar.sync before the push', async () => {
    const refused = await connectedMember(firm.id, ['calendar.view']);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    const matterId = await seedMatter(firm.id);
    // The permitted caller is staffed on the matter, so the only thing separating
    // the two halves is `calendar.sync` rather than the matter wall as well.
    await addMatterMember(firm.id, matterId, permitted.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, undefined, undefined, permitted.uid);
    routeEventPush();
    const body = {
      events: [{
        eventId, matterId, lawFirmId: firm.id, title: 'Preliminary hearing', date: '2026-09-10T14:00:00Z',
      }],
    };

    const denied = await refused.api.post(`${BASE}/sync-events-to-google`).send(body);
    expect(denied.status).toBe(403);
    expect(googleCalls()).toHaveLength(0);
    expect((await testPool.query(`select 1 from calendar_mappings`)).rowCount).toBe(0);

    const allowed = await permitted.api.post(`${BASE}/sync-events-to-google`).send(body);
    expect(allowed.status).toBe(200);
    expect((await testPool.query(`select 1 from calendar_mappings`)).rowCount).toBe(1);
  });

  /**
   * The plan ceiling on the batch variant. Goes red if
   * `requireCalendarSyncFromItems` is removed: a starter firm would push matter
   * events to Google without the feature.
   */
  test('refuses a firm whose plan does not include calendar sync', async () => {
    const starter = await createFirm({ planId: 'starter' });
    const owner = await connectedOwner(starter.id);
    const matterId = await seedMatter(starter.id);
    const eventId = await seedMatterEvent(starter.id, matterId);
    routeEventPush();

    const res = await owner.api.post(`${BASE}/sync-events-to-google`).send({
      events: [{
        eventId, matterId, lawFirmId: starter.id, title: 'Preliminary hearing', date: '2026-09-10T14:00:00Z',
      }],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not included in your current plan/);
    expect(googleCalls()).toHaveLength(0);
  });

  /**
   * Goes red if the batch stops loading a client event (an item naming a
   * `clientId` and no matter): it is skipped, and the client events that
   * existed before the member connected never reach their calendar.
   */
  test('pushes a client event and records the reverse mapping against the client', async () => {
    const owner = await connectedOwner(firm.id);
    const { clientId, eventId } = await seedClientEvent(firm.id, undefined, owner.uid);
    routeEventPush('g-client-event');

    const res = await owner.api.post(`${BASE}/sync-events-to-google`).send({
      events: [{ eventId, clientId, lawFirmId: firm.id, title: 'Client check-in', date: '2026-09-02T17:00:00Z' }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1 });
    expect(res.body.results).toEqual([{ eventId, success: true, googleEventId: 'g-client-event' }]);
    expect(callsMatching(EVENTS_CREATE)[0].body.summary).toBe('Client check-in');

    const { rows } = await testPool.query(
      `select external_event_id, law_firm_id, entity_type, entity_id, scope_id, user_id from calendar_mappings`,
    );
    expect(rows).toEqual([{
      external_event_id: 'g-client-event',
      law_firm_id: firm.id,
      entity_type: 'clientEvent',
      entity_id: eventId,
      scope_id: clientId,
      user_id: owner.uid,
    }]);
  });

  /**
   * The row is read under the item's firm. Goes red if the client event is
   * loaded without that scope: another firm's client event, named under the
   * caller's own firm id, would be copied onto the caller's calendar.
   */
  test('does not push another firm\'s client event named under the caller\'s firm', async () => {
    const owner = await connectedOwner(firm.id);
    const neighbour = await createFirm();
    const theirs = await seedClientEvent(neighbour.id, 'Their client meeting');
    routeEventPush();

    const res = await owner.api.post(`${BASE}/sync-events-to-google`).send({
      events: [{ ...theirs, lawFirmId: firm.id, title: 'Their client meeting', date: '2026-09-02T17:00:00Z' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.syncedCount).toBe(0);
    expect(callsMatching(EVENTS_CREATE)).toHaveLength(0);
    expect((await testPool.query(`select 1 from calendar_mappings`)).rowCount).toBe(0);
  });

  test('refuses a body with no events array', async () => {
    const owner = await connectedOwner(firm.id);

    const res = await owner.api.post(`${BASE}/sync-events-to-google`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', error: 'Events array is required' });
  });
});

// ── enable-silent-sync (requireSyncPerm + requireCalendarSync) ──────────────

describe('POST /enable-silent-sync', () => {
  const expiration = String(Date.parse('2026-12-01T00:00:00Z'));

  function routeWatch() {
    route(WATCH, { status: 200, json: { resourceId: 'res-from-google', expiration } }, { method: 'POST' });
    route(EVENTS_LIST, { status: 200, json: { items: [], nextSyncToken: 'sync-token-1' } });
  }

  test('opens a watch channel for an owner and records it against the firm', async () => {
    const owner = await connectedOwner(firm.id);
    routeWatch();

    const res = await owner.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Silent sync enabled', expiration });

    const rows = await watchChannelRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: owner.uid, law_firm_id: firm.id, calendar_id: 'primary' });
    expect(callsMatching(WATCH)).toHaveLength(1);
  });

  /**
   * Goes red if `requireSyncPerm` is removed from this route: a member without
   * `calendar.sync` would register a webhook that streams the firm's calendar
   * changes to their own connection for seven days.
   */
  test('refuses a member without calendar.sync and leaves no channel behind', async () => {
    const refused = await connectedMember(firm.id, ['calendar.view']);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    routeWatch();

    const denied = await refused.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });
    expect(denied.status).toBe(403);
    expect(googleCalls()).toHaveLength(0);
    expect(await watchChannelRows()).toHaveLength(0);

    const allowed = await permitted.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });
    expect(allowed.status).toBe(200);
    expect(await watchChannelRows()).toHaveLength(1);
  });

  test('refuses an owner of a different firm', async () => {
    const neighbour = await createFirm();
    const outsider = await connectedOwner(neighbour.id);
    routeWatch();

    const res = await outsider.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', error: 'Not a member of this firm' });
    expect(await watchChannelRows()).toHaveLength(0);
  });
});

// ── disable-silent-sync ─────────────────────────────────────────────────────

describe('POST /disable-silent-sync', () => {
  /**
   * The route takes no firm and no channel id: it acts on whatever channels the
   * CALLER owns. Goes red if `stopAllWatchChannels` stops filtering by user id,
   * which would silently tear down every other user's silent sync.
   */
  test('stops the caller channels and leaves another user channel alone', async () => {
    const owner = await connectedOwner(firm.id);
    const colleague = await connectedMember(firm.id, ['calendar.sync']);
    const mine = await seedWatchChannel(owner.uid, firm.id);
    const theirs = await seedWatchChannel(colleague.uid, firm.id);
    route(CHANNELS_STOP, { status: 204 }, { method: 'POST' });

    const res = await owner.api.post(`${BASE}/disable-silent-sync`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Silent sync disabled' });

    const rows = await watchChannelRows();
    expect(rows.map((r) => r.id)).toEqual([theirs.channelId]);

    // Google was asked to stop exactly the caller's channel.
    const stops = callsMatching(CHANNELS_STOP);
    expect(stops).toHaveLength(1);
    expect(stops[0].body).toEqual({ id: mine.channelId, resourceId: mine.resourceId });
  });
});

// ── silent-sync-status ──────────────────────────────────────────────────────

describe('GET /silent-sync-status', () => {
  /**
   * A per-user lookup. Goes red if `findWatchChannelForUser` stops scoping by
   * user id: the caller with no channel would report another user's silent sync
   * as their own, including its expiry.
   */
  test('reports only the caller own channel', async () => {
    const owner = await connectedOwner(firm.id);
    const colleague = await connectedMember(firm.id, ['calendar.sync']);
    await seedWatchChannel(colleague.uid, firm.id, { expiration: '2026-11-01T00:00:00Z' });

    const before = await owner.api.get(`${BASE}/silent-sync-status`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ enabled: false });

    await seedWatchChannel(owner.uid, firm.id, { expiration: '2026-12-01T00:00:00Z' });

    const after = await owner.api.get(`${BASE}/silent-sync-status`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ enabled: true, expiration: '2026-12-01T00:00:00.000Z' });
    expect(googleCalls()).toHaveLength(0);
  });
});

export {};
