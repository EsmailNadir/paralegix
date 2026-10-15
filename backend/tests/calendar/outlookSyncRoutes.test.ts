/**
 * The Outlook calendar-sync ROUTES, driven through the real Express app.
 *
 * `outlookSync.test.ts` covers the SERVICE by calling it directly, so it never
 * sees a middleware. This file covers the layer above it: the six per-route
 * gates in `calendar/shared/calendarSyncGates.ts`, the timezone requirement,
 * each route's own validation, the way `handleReAuthError` turns a thrown error
 * into a status, and the exact envelope each endpoint answers with.
 *
 * WHY THE GATES ARE WORTH A FILE. These endpoints push firm data OUT to
 * Microsoft Graph and pull events back IN, and the firm they act on is named in
 * the request BODY rather than in the url, so none of them can use the ordinary
 * `/api/lawfirms/:lawFirmId` wiring that guards every other firm-scoped router.
 * The whole tenancy boundary for this module is those six functions. A caller
 * who is not a member of the firm they name must not be able to copy that
 * firm's hearings into a personal Outlook calendar, and a firm whose plan does
 * not include calendar sync (or whose billing has lapsed) must not get the
 * feature for free, because this router mounts outside the workspace billing
 * gate and `requireCalendarSync*` is the only place that is checked.
 *
 * THE ROUTER IS NOT A COPY OF THE GOOGLE ONE, so nothing here is assumed from
 * the sibling. Outlook has no `silent-sync-status` route; its
 * `init-paralegix-calendar` answers 400 rather than 401 for a missing grant;
 * and its `handleReAuthError` carries a `NO_REFRESH_TOKEN` branch the Google
 * file resolves differently. Every expectation below was read off
 * `outlook.routes.ts` and `outlook.service.ts`.
 *
 * Every refusal case is paired with a permitted caller on the SAME route with
 * the SAME fixtures. A 403 alone proves nothing: it is also what a broken
 * fixture, a missing seed, or a typo'd path produces.
 *
 * NO LIVE MICROSOFT CALL IS POSSIBLE HERE. `support/googleFetch.ts` is named
 * for the spec that first needed it but is provider-agnostic: it replaces
 * `globalThis.fetch` at module load with a router that answers only registered
 * urls and THROWS on anything else. That is the single chokepoint for this
 * module too, because `makeMicrosoftGraphCall` and `refreshMicrosoftToken`
 * (`calendar/shared/calendarHelpers.ts`) both call the global `fetch` directly
 * and neither uses an HTTP client of its own. The first case proves the wall is
 * up; without it, every "and nothing was pushed to Outlook" assertion below
 * would be worthless. It also protects real credentials: `tests/support/db.ts`
 * loads `backend/.env`, so a genuine `MICROSOFT_CLIENT_SECRET` is in
 * `process.env` while these run.
 */
import {
  installGoogleFetchWall as installFetchWall,
  uninstallGoogleFetchWall as uninstallFetchWall,
  resetGoogleFetch as resetFetchWall,
  route,
  callsMatching,
  googleCalls as outboundCalls,
  wallIsUp,
} from './support/googleFetch';

// Before `setupInProcess` pulls in the app graph, so nothing can reach the
// network on the way in.
installFetchWall();

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

const BASE = '/api/outlook-calendar-sync';

// Graph urls the routes reach for. Anchored regexes rather than substrings,
// because `/me`, `/me/events` and `/me/events/{id}` are prefixes of each other
// and a loose match would let one registration answer a call the test did not
// mean to allow.
const ME = /graph\.microsoft\.com\/v1\.0\/me$/;
const MAILBOX_TZ = /\/me\/mailboxSettings\/timeZone$/;
const CALENDARS = /\/me\/calendars$/;
const CALENDAR_VIEW = /\/me\/calendar\/calendarView\?/;
const EVENTS = /\/v1\.0\/me\/events$/;
const EVENT_BY_ID = /\/v1\.0\/me\/events\/[^/?]+$/;
const SUBSCRIPTIONS = /\/v1\.0\/subscriptions$/;
const SUBSCRIPTION_BY_ID = /\/v1\.0\/subscriptions\/[^/?]+$/;
const MS_TOKEN = 'login.microsoftonline.com';

let firm: Firm;

// ── fixtures ────────────────────────────────────────────────────────────────
// Plain SQL through the test pool, never the code under test: a fixture built
// by a broken repository produces both the data and the expectation.

/**
 * Give an existing user a connected Microsoft account.
 *
 * The mailbox timezone is seeded into the token `meta` on purpose. Without it
 * the first outbound call of every case is a `/me/mailboxSettings/timeZone`
 * fetch followed by a PATCH, which would make each test carry two routes that
 * have nothing to do with what it checks.
 *
 * `getUserDataAndSettings` memoizes per user id for 5 seconds inside the
 * process and nothing resets it between cases, so every test connects its OWN
 * freshly created actor rather than a shared one.
 */
async function connectMicrosoft(
  uid: string,
  opts: {
    accessToken?: string | null;
    refreshToken?: string | null;
    outbound?: boolean;
    inbound?: boolean;
    scope?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const accessToken = opts.accessToken === undefined
    ? `ms-access-${randomUUID().slice(0, 8)}`
    : (opts.accessToken as string);

  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, meta, scope)
     values ($1, 'microsoft', $2, $3, $4::jsonb, $5)`,
    [
      uid,
      accessToken,
      opts.refreshToken === undefined ? 'ms-refresh-seed' : opts.refreshToken,
      JSON.stringify({ outlookTimezone: 'America/New_York', outlookMailboxTimezoneWritable: true, ...opts.meta }),
      opts.scope ?? null,
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
  return accessToken as string;
}

/** An owner of `lawFirmId` with Microsoft already connected. */
async function connectedOwner(lawFirmId: string): Promise<Actor & { accessToken: string }> {
  const actor = await ownerOf(lawFirmId);
  const accessToken = await connectMicrosoft(actor.uid);
  return { ...actor, accessToken };
}

/** A member holding exactly `permissions`, with Microsoft already connected. */
async function connectedMember(lawFirmId: string, permissions: string[]): Promise<Actor> {
  const actor = await memberWith(lawFirmId, permissions);
  await connectMicrosoft(actor.uid);
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

async function seedSubscription(userId: string, lawFirmId: string) {
  const id = `sub-${randomUUID().slice(0, 8)}`;
  const res = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, resource, secret, expiration)
     values ('outlook', $1, $2, $3, '/me/calendar/events', 'state-seed', '2026-12-01T00:00:00Z')`,
    [id, userId, lawFirmId],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

/** A Graph event payload in the shape Microsoft actually delivers. */
function graphEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'EVT-INBOUND-1',
    subject: 'Client intake',
    body: { contentType: 'text', content: 'Bring the retainer.' },
    start: { dateTime: '2026-09-04T15:00:00.0000000', timeZone: 'Eastern Standard Time' },
    end: { dateTime: '2026-09-04T16:00:00.0000000', timeZone: 'Eastern Standard Time' },
    isAllDay: false,
    parentFolderId: 'calendar-1',
    lastModifiedDateTime: '2026-08-30T10:00:00Z',
    ...overrides,
  };
}

const taskRow = async (taskId: string) => (await testPool.query(
  `select outlook_id from tasks where id = $1`, [taskId],
)).rows[0];

const subscriptionRows = async () => (await testPool.query(
  `select id, user_id, law_firm_id, resource from calendar_subscriptions where provider = 'outlook' order by id`,
)).rows;

const firmEventRows = async (lawFirmId: string) => (await testPool.query(
  `select title, outlook_id from calendar_events where law_firm_id = $1`, [lawFirmId],
)).rows;

let webhookBaseUrl: string | undefined;

beforeAll(() => {
  // `createSubscription` returns null without an https webhook base, so
  // enable-silent-sync would answer 500 for a reason unrelated to its gate.
  webhookBaseUrl = process.env.WEBHOOK_BASE_URL;
  process.env.WEBHOOK_BASE_URL = 'https://hooks.paralegix.test';
});

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-08-01T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
  resetFetchWall();
  firm = await createFirm();
});

afterEach(async () => {
  // Cross-sync to Google and the subscription push stamp are fire-and-forget;
  // let them land against a live pool before the next truncate.
  await drainEvents();
  unfreezeClock();
});

afterAll(() => {
  uninstallFetchWall();
  if (webhookBaseUrl === undefined) delete process.env.WEBHOOK_BASE_URL;
  else process.env.WEBHOOK_BASE_URL = webhookBaseUrl;
});

// ── the wall ────────────────────────────────────────────────────────────────

describe('the network wall', () => {
  /**
   * Goes red if `globalThis.fetch` is no longer replaced, or if the router stops
   * throwing on an unregistered url. Every "nothing was pushed to Outlook" case
   * below is only as good as this one.
   */
  test('an unrouted Graph request fails the request instead of reaching Microsoft', async () => {
    const owner = await connectedOwner(firm.id);
    expect(wallIsUp()).toBe(true);

    const res = await owner.api.get(`${BASE}/calendars`);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('BLOCKED_NETWORK_CALL');
    // The attempt is recorded, so this is not passing because nothing ran: the
    // route really did try to reach graph.microsoft.com, on the caller's token.
    const attempts = callsMatching(CALENDARS);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toBe('https://graph.microsoft.com/v1.0/me/calendars');
    expect(attempts[0].bearer).toBe(owner.accessToken);
  });
});

// ── authentication ──────────────────────────────────────────────────────────

describe('verifyToken', () => {
  /**
   * Every route on this router carries `verifyToken`. Goes red if it is dropped
   * from the read route or the mutating one, which would expose a user's
   * Microsoft connection state and their outbound push to anyone.
   */
  test('refuses an unauthenticated caller on both a read and a write route', async () => {
    const read = await request().get(`${BASE}/check-auth`);
    expect(read.status).toBe(401);
    expect(read.body.code).toBe('NO_TOKEN');

    const write = await request()
      .post(`${BASE}/sync-from-outlook`)
      .set('x-timezone', 'America/New_York')
      .send({ lawFirmId: firm.id });
    expect(write.status).toBe(401);
    expect(write.body.code).toBe('NO_TOKEN');

    expect(outboundCalls()).toHaveLength(0);
  });
});

// ── check-auth ──────────────────────────────────────────────────────────────

describe('GET /check-auth', () => {
  /**
   * Deliberately NOT firm-scoped: it reports the caller's own Microsoft grant,
   * so it carries no gate beyond `verifyToken`. Goes red if the route goes
   * back to an identity probe, or if the answer stops carrying the mailbox.
   */
  test('answers the caller their own Microsoft state', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid, { scope: 'Calendars.ReadWrite openid', meta: { accountEmail: 'lawyer@firm.test' } });
    route(ME, { status: 200, json: { mail: 'lawyer@firm.test', userPrincipalName: 'lawyer@firm.test' } });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true, state: 'connected', email: 'lawyer@firm.test' });
    expect(callsMatching(ME)).toHaveLength(0);
  });

  /** Goes red if a grant without Calendars.ReadWrite is read as connected. */
  test('reports permission_required, not connected, when the calendar scope is missing', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid, { scope: 'Calendars.Read User.Read openid' });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: false, state: 'permission_required', email: null });
    expect(outboundCalls()).toHaveLength(0);
  });

  /**
   * A row stored before scopes were recorded is resolved through one refresh,
   * whose response names the granted scope. Goes red if the legacy row is read
   * as connected without checking, or if the resolved scope is not stored.
   */
  test('resolves a legacy row through one refresh and records its scope', async () => {
    const owner = await connectedOwner(firm.id);
    route(MS_TOKEN, {
      status: 200,
      json: { access_token: 'rotated-access', refresh_token: 'ms-refresh-seed', scope: 'https://graph.microsoft.com/Calendars.Read openid' },
    });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: false, state: 'permission_required' });
    expect(callsMatching(MS_TOKEN)).toHaveLength(1);
    const { rows } = await testPool.query(
      `select scope, access_token from user_oauth_tokens where user_id = $1 and provider = 'microsoft'`, [owner.uid],
    );
    expect(rows[0]).toEqual({ scope: 'Calendars.Read openid', access_token: 'rotated-access' });
  });

  /**
   * A grant Microsoft rejects, where a refresh cannot help. `checkAuth` answers
   * 200 with `authenticated: false` rather than an error, because the whole
   * point of the route is to report that state. Goes red if the non-ok branch
   * starts throwing, which would turn the connect screen's status probe into a
   * server error.
   */
  test('reports an invalid grant as not authenticated rather than failing', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid, { refreshToken: null });
    route(ME, { status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } });

    const res = await owner.api.get(`${BASE}/check-auth`);

    // No refresh token, so the row cannot keep a connection alive: it reads as
    // disconnected without asking Microsoft anything.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ authenticated: false, state: 'disconnected', email: null });
    expect(callsMatching(MS_TOKEN)).toHaveLength(0);
  });

  /**
   * Goes red if the `microsoftAccessToken` guard is dropped: the route would
   * then call Graph with no bearer at all. Measured against the case above,
   * which proves this fixture shape does produce a call when a token exists.
   */
  test('answers 400 and contacts nobody when the caller has no Microsoft connection', async () => {
    const owner = await ownerOf(firm.id);
    route(ME, { status: 200, json: { mail: 'should-not-be-reached@firm.test' } });

    const res = await owner.api.get(`${BASE}/check-auth`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'No Microsoft token available' });
    expect(outboundCalls()).toHaveLength(0);
  });
});

// ── calendars ───────────────────────────────────────────────────────────────

describe('GET /calendars', () => {
  /**
   * The route reshapes Graph's calendar list rather than forwarding it. Goes
   * red if the mapping changes or if the raw provider payload starts leaking
   * through (owner addresses, permission sets, change keys).
   */
  test('returns the caller calendar list in the app shape', async () => {
    const owner = await connectedOwner(firm.id);
    route(CALENDARS, {
      status: 200,
      json: {
        value: [
          {
            id: 'AAMkA-default',
            name: 'Calendar',
            isDefaultCalendar: true,
            color: 'auto',
            canEdit: true,
            owner: { address: 'lawyer@firm.test' },
          },
          { id: 'AAMkA-shared', name: 'Court holidays', canEdit: false },
        ],
      },
    });

    const res = await owner.api.get(`${BASE}/calendars`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      calendars: [
        { id: 'AAMkA-default', name: 'Calendar', isDefault: true, color: 'auto', canEdit: true },
        { id: 'AAMkA-shared', name: 'Court holidays', isDefault: false, color: '#000000', canEdit: false },
      ],
    });
  });

  test('answers 400 and contacts nobody when the caller has no Microsoft connection', async () => {
    const owner = await ownerOf(firm.id);
    route(CALENDARS, { status: 200, json: { value: [{ id: 'AAMkA-default', name: 'Calendar' }] } });

    const res = await owner.api.get(`${BASE}/calendars`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'No Microsoft token available' });
    expect(outboundCalls()).toHaveLength(0);
  });
});

// ── init-paralegix-calendar ─────────────────────────────────────────────────

describe('POST /init-paralegix-calendar', () => {
  const PARALEGIX_CALENDAR = /\/me\/calendars\/AAMkA-paralegix$/;

  /** The calendar Paralegix created earlier, recorded by its stored id. */
  async function routeInit(uid: string) {
    const prefs = await testPool.query(
      `update users set preferences = '{"paralegixCalendarId":"AAMkA-paralegix"}'::jsonb where id = $1`, [uid],
    );
    expect(prefs.rowCount).toBe(1);
    route(MAILBOX_TZ, { status: 200, json: { value: 'Eastern Standard Time' } });
    route(PARALEGIX_CALENDAR, {
      status: 200,
      json: { id: 'AAMkA-paralegix', name: 'Paralegix', color: 'lightBlue' },
    });
  }

  /**
   * `requireTimezone` is live here and the mailbox timezone is reconciled
   * against the caller's zone, so a missing header must refuse rather than
   * silently default to UTC. Goes red if `requireTimezone` is removed from this
   * route.
   */
  test('refuses a request with no timezone before contacting Microsoft', async () => {
    const owner = await connectedOwner(firm.id);
    await routeInit(owner.uid);

    const res = await owner.api.post(`${BASE}/init-paralegix-calendar`).set('x-timezone', '').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Timezone is required/);
    expect(outboundCalls()).toHaveLength(0);

    // The same caller WITH the header gets through to Graph, so the refusal
    // above is the timezone gate and not a broken fixture.
    const withTimezone = await owner.api.post(`${BASE}/init-paralegix-calendar`).send({});
    expect(withTimezone.status).toBe(200);
    expect(callsMatching(PARALEGIX_CALENDAR)).toHaveLength(1);
  });

  /**
   * Unlike the Google sibling, which answers 401 for a missing grant, the
   * Outlook service reports this as the 400 it treats it as. Goes red if the
   * service's `{ error, status }` pair stops being honoured by
   * `sendOutlookError` and collapses to a generic status.
   */
  test('answers 400 for a caller with no Microsoft connection', async () => {
    const owner = await ownerOf(firm.id);
    await routeInit(owner.uid);

    const res = await owner.api.post(`${BASE}/init-paralegix-calendar`).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No Microsoft token available' });
    expect(outboundCalls()).toHaveLength(0);
  });

  /**
   * Goes red if the "already exists" branch of `getOrCreateParalegixCalendar`
   * stops recognising the calendar by its stored id: a second Paralegix
   * calendar would be created on every visit to the connect screen.
   */
  test('returns the existing Paralegix calendar for a connected caller', async () => {
    const owner = await connectedOwner(firm.id);
    await routeInit(owner.uid);

    const res = await owner.api.post(`${BASE}/init-paralegix-calendar`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Paralegix calendar initialized successfully',
      calendar: { id: 'AAMkA-paralegix', name: 'Paralegix', color: 'lightBlue' },
    });
    // Discovery only: no POST creating a duplicate calendar went out.
    expect(callsMatching(CALENDARS).filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

// ── sync-from-outlook (requireSyncPerm + requireCalendarSync) ───────────────

describe('POST /sync-from-outlook', () => {
  const inboundPage = { status: 200, json: { value: [graphEvent()] } };

  /** The permitted baseline every refusal below is measured against. */
  test('pulls the events in for an owner', async () => {
    const owner = await connectedOwner(firm.id);
    route(CALENDAR_VIEW, inboundPage);

    const res = await owner.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1, createdCount: 1, updatedCount: 0 });
    expect(await firmEventRows(firm.id)).toEqual([{ title: 'Client intake', outlook_id: 'EVT-INBOUND-1' }]);
  });

  test('an ordinary Outlook event appears in the syncing member calendar feed only', async () => {
    const owner = await connectedOwner(firm.id);
    const colleague = await memberWith(firm.id, []);
    route(CALENDAR_VIEW, inboundPage);

    const sync = await owner.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ createdCount: 1 });

    const feedUrl = `/api/lawfirms/${firm.id}/calendar-feed?from=2026-09-01&to=2026-09-30&tz=America/New_York`;
    const mine = await owner.api.get(feedUrl);
    const theirs = await colleague.api.get(feedUrl);

    expect(mine.status).toBe(200);
    expect(mine.body.calendarEvents.events).toEqual([expect.objectContaining({
      title: 'Client intake', provider: 'outlook', outlookId: 'EVT-INBOUND-1', source: 'external',
    })]);
    expect(theirs.status).toBe(200);
    expect(theirs.body.calendarEvents.events).toEqual([]);
  });

  /**
   * `requireSyncPerm` checks `calendar.sync` specifically, not merely
   * membership. `calendar.view` is in DEFAULT_PERMISSIONS, so both callers below
   * hold it no matter how narrow their role; the only difference that can
   * matter is `calendar.sync`. Goes red if `requireSyncPerm` is removed or if it
   * stops naming `calendar.sync`.
   */
  test('admits a member holding calendar.sync and refuses one without it', async () => {
    const refused = await connectedMember(firm.id, []);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    route(CALENDAR_VIEW, inboundPage);

    const denied = await refused.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect(outboundCalls()).toHaveLength(0);
    expect(await firmEventRows(firm.id)).toHaveLength(0);

    const allowed = await permitted.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ syncedCount: 1 });
    expect(await firmEventRows(firm.id)).toHaveLength(1);
  });

  /**
   * The ethical wall. A full owner of ANOTHER firm names this firm in the body;
   * without `requireSyncPerm` the body would be taken at its word and that
   * firm's Outlook calendar would be read into this firm's records.
   *
   * Goes red if `requireSyncPerm` is removed: the handler's own
   * `assertLawFirmMembership` would still refuse, so the case also pins that the
   * refusal arrives as a 403 rather than as a scrubbed 500.
   */
  test('refuses an owner of a different firm and writes nothing into this one', async () => {
    const neighbour = await createFirm();
    const outsider = await connectedOwner(neighbour.id);
    route(CALENDAR_VIEW, inboundPage);

    const res = await outsider.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', error: 'Not a member of this firm' });
    expect(outboundCalls()).toHaveLength(0);
    expect(await firmEventRows(firm.id)).toHaveLength(0);

    // The same caller against their OWN firm succeeds, so the refusal above is
    // the firm scoping and not a broken fixture.
    const own = await outsider.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: neighbour.id });
    expect(own.status).toBe(200);
    expect(await firmEventRows(neighbour.id)).toHaveLength(1);
  });

  /**
   * This router mounts OUTSIDE `/api/lawfirms/:lawFirmId`, so
   * `requireCalendarSync` is the only thing standing between a plan without
   * calendar sync and the feature. Goes red if that gate is removed. The gate is
   * the shared `requireCalendarSync`, so its lapsed-billing branch is pinned
   * once, in googleSyncRoutes.test.ts; this case proves Outlook is wired to it.
   */
  test('refuses a firm whose plan does not include calendar sync', async () => {
    const starter = await createFirm({ planId: 'starter' });
    const owner = await connectedOwner(starter.id);
    route(CALENDAR_VIEW, inboundPage);

    const res = await owner.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: starter.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not included in your current plan/);
    expect(outboundCalls()).toHaveLength(0);
  });

  /**
   * With no firm id the gates are deliberate no-ops (they only ever deny a
   * KNOWN firm), and the handler treats the absence as a client bug rather than
   * user-actionable input. Goes red if the handler starts trusting a bodyless
   * request, which would reach Graph with an undefined firm.
   */
  test('refuses a request with no lawFirmId without contacting Microsoft or naming the internal reason', async () => {
    const owner = await connectedOwner(firm.id);
    route(CALENDAR_VIEW, inboundPage);

    const res = await owner.api.post(`${BASE}/sync-from-outlook`).send({});

    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/lawFirmId/);
    expect(outboundCalls()).toHaveLength(0);
  });

  /**
   * THE STATUS-MAPPING BUG, shape one: a `ValidationError` (400).
   *
   * A permitted member of the firm who simply has not connected Outlook must be
   * told their request was refused for a reason THEY can fix. `syncFromOutlook`
   * raises `ValidationError('No Microsoft token available')`, which carries
   * `statusCode` and no `status`, so a handler reading only `error.status`
   * reports it as a scrubbed 500 and the client shows a server outage instead
   * of "connect your calendar".
   *
   * Goes red if `handleReAuthError` stops reading `statusCode` off an AppError.
   */
  test('reports a missing Outlook connection as the 400 it is, not a server error', async () => {
    const owner = await ownerOf(firm.id);
    route(CALENDAR_VIEW, inboundPage);

    const res = await owner.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No Microsoft token available');
    expect(outboundCalls()).toHaveLength(0);
  });

  /**
   * Same bug, and the same gap on the inbound direction switch: a caller who
   * turned Outlook-to-Paralegix sync off gets a 400 naming the setting, not a
   * 500.
   *
   * Goes red if `handleReAuthError` stops reading `statusCode`.
   */
  test('reports a disabled inbound sync as a 400 rather than a server error', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid, { inbound: false });
    route(CALENDAR_VIEW, inboundPage);

    const res = await owner.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Outlook to Paralegix sync not enabled');
    expect(callsMatching(CALENDAR_VIEW)).toHaveLength(0);
  });

  /**
   * THE STATUS-MAPPING BUG, shape two: an `AppError` carrying 401.
   *
   * The grant is stale but a refresh token exists, so the refresh is attempted,
   * succeeds, and the retry is STILL rejected: the user revoked consent or an
   * admin removed the app. `syncFromOutlook` raises
   * `AppError('Microsoft token expired and refresh failed', 401, 'UNAUTHORIZED')`,
   * which the `NO_REFRESH_TOKEN` branch above it does not match, so it falls to
   * the status line. Read as `error.status` it becomes a 500 with no code, the
   * browser's generic 401 recovery never fires, and background sync retries a
   * dead grant forever without ever prompting a reconnect.
   *
   * Goes red if `handleReAuthError` stops reading `statusCode`, or if
   * `sendOutlookError` stops tagging a 401 with `MICROSOFT_REAUTH_REQUIRED`.
   */
  test('asks a caller whose refreshed grant is still rejected to reconnect Microsoft', async () => {
    const owner = await connectedOwner(firm.id);
    route(CALENDAR_VIEW, { status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } });
    route(MS_TOKEN, { status: 200, json: { access_token: 'rotated-access', refresh_token: 'ms-refresh-seed' } });

    const res = await owner.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Microsoft token expired and refresh failed',
      code: 'MICROSOFT_REAUTH_REQUIRED',
      requiresReAuth: true,
    });
    // The refresh really was attempted and the retry really was rejected, so
    // this is the post-refresh failure and not the NO_REFRESH_TOKEN branch.
    expect(callsMatching(MS_TOKEN)).toHaveLength(1);
    expect(callsMatching(CALENDAR_VIEW)).toHaveLength(2);
  });

  /**
   * The other end of the same family, and the one path that already worked: a
   * revoked grant with no refresh token at all gets the distinct
   * `NO_REFRESH_TOKEN` code, which tells the client the grant is gone rather
   * than that a refresh might still succeed.
   *
   * Goes red if the dedicated branch at the top of `handleReAuthError` is
   * removed, folding this into the generic re-auth code.
   */
  test('distinguishes a grant with no refresh token from one that may still refresh', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid, { refreshToken: null });
    route(CALENDAR_VIEW, { status: 401, json: { error: { code: 'InvalidAuthenticationToken' } } });

    const res = await owner.api.post(`${BASE}/sync-from-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Microsoft token expired. Please reconnect your Microsoft account.',
      code: 'NO_REFRESH_TOKEN',
      requiresReAuth: true,
    });
    expect(callsMatching(MS_TOKEN)).toHaveLength(0);
  });
});

// ── the removed direct-push routes ──────────────────────────────────────────

describe('the direct-push routes', () => {
  /**
   * create-event, update-event and delete-event pushed a bare event straight
   * to Outlook, outside the adapters every real push goes through, and
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
    expect(outboundCalls()).toHaveLength(0);
  });
});

// ── sync-tasks-to-outlook (requireSyncPermFromItems + …FromItems) ───────────

describe('POST /sync-tasks-to-outlook', () => {
  function routeTaskPush(ids: string[]) {
    route(EVENTS, (_call, hit) => ({ status: 200, json: { id: ids[Math.min(hit, ids.length - 1)] } }), { method: 'POST' });
  }

  const taskItem = (lawFirmId: string, taskId: string, title: string) => ({
    taskId, lawFirmId, title, dueDate: '2026-09-10T16:00:00Z',
  });

  test('refuses a body with no tasks array', async () => {
    const owner = await connectedOwner(firm.id);

    const res = await owner.api.post(`${BASE}/sync-tasks-to-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', error: 'Tasks array is required' });
    expect(outboundCalls()).toHaveLength(0);
  });

  /**
   * THE batch hole, and the reason the service re-checks. The route gate reads
   * ONE firm id (here, the first item's) and authorizes the whole array against
   * it, so a caller who belongs to firm A can smuggle firm B's task into the
   * same request. Only `resolveSyncableFirmIds` inside the service stops firm
   * B's work from being copied into the caller's personal Outlook calendar.
   *
   * Goes red if that per-firm re-check is dropped: the second push would go out
   * and firm B's task would come back carrying an Outlook event id.
   */
  test('pushes only the items belonging to firms the caller is a member of', async () => {
    const neighbour = await createFirm();
    const owner = await connectedOwner(firm.id);
    const mine = await seedTask(firm.id, 'File the motion', owner.uid);
    const theirs = await seedTask(neighbour.id, 'Their confidential filing');
    routeTaskPush(['AAMkA-task-mine', 'AAMkA-task-theirs']);

    const res = await owner.api.post(`${BASE}/sync-tasks-to-outlook`).send({
      tasks: [
        taskItem(firm.id, mine, 'File the motion'),
        taskItem(neighbour.id, theirs, 'Their confidential filing'),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1 });
    expect(res.body.results).toEqual([
      { taskId: mine, success: true, eventId: 'AAMkA-task-mine' },
      { taskId: theirs, success: false, error: 'Not a member of this firm' },
    ]);

    // Exactly one push, carrying the caller's own task and not the neighbour's.
    const pushes = callsMatching(EVENTS);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body.subject).toContain('File the motion');

    // Recorded under the pushing user, where every later real-time update looks.
    expect((await testPool.query(`select calendar_sync from tasks where id = $1`, [mine])).rows[0].calendar_sync)
      .toEqual({ outlook: { [owner.uid]: { dueDate: { eventId: 'AAMkA-task-mine', changeKey: null } } } });
    expect(await taskRow(theirs)).toMatchObject({ outlook_id: null });
  });

  /**
   * Goes red if `requireSyncPermFromItems` is removed: the member without
   * `calendar.sync` would reach the service, whose own per-firm re-check would
   * admit them (they ARE a member), so this route gate is the only thing
   * separating a read-only role from an outbound push.
   */
  test('refuses a member without calendar.sync at the route, not per item', async () => {
    const refused = await connectedMember(firm.id, []);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    const taskId = await seedTask(firm.id, undefined, permitted.uid);
    routeTaskPush(['AAMkA-task-1']);

    const denied = await refused.api.post(`${BASE}/sync-tasks-to-outlook`)
      .send({ tasks: [taskItem(firm.id, taskId, 'File the motion')] });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect(outboundCalls()).toHaveLength(0);
    expect(await taskRow(taskId)).toMatchObject({ outlook_id: null });

    const allowed = await permitted.api.post(`${BASE}/sync-tasks-to-outlook`)
      .send({ tasks: [taskItem(firm.id, taskId, 'File the motion')] });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ syncedCount: 1 });
    expect((await testPool.query(`select calendar_sync from tasks where id = $1`, [taskId])).rows[0].calendar_sync)
      .toEqual({ outlook: { [permitted.uid]: { dueDate: { eventId: 'AAMkA-task-1', changeKey: null } } } });
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
    routeTaskPush(['AAMkA-task-1']);

    const res = await owner.api.post(`${BASE}/sync-tasks-to-outlook`).send({
      lawFirmId: neighbour.id,
      tasks: [taskItem(firm.id, taskId, 'File the motion')],
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', error: 'Not a member of this firm' });
    expect(outboundCalls()).toHaveLength(0);
  });
});

// ── sync-events-to-outlook ──────────────────────────────────────────────────

describe('POST /sync-events-to-outlook', () => {
  function routeEventPush(id = 'AAMkA-matter-event') {
    route(EVENTS, { status: 200, json: { id, changeKey: 'CK-1' } }, { method: 'POST' });
  }

  const eventItem = (lawFirmId: string, matterId: string, eventId: string, title = 'Preliminary hearing') => ({
    eventId, matterId, lawFirmId, title, date: '2026-09-10T14:00:00Z', type: 'hearing',
  });

  test('pushes a matter event for an owner and records the reverse mapping', async () => {
    const owner = await connectedOwner(firm.id);
    const matterId = await seedMatter(firm.id);
    const eventId = await seedMatterEvent(firm.id, matterId, undefined, undefined, owner.uid);
    routeEventPush();

    const res = await owner.api.post(`${BASE}/sync-events-to-outlook`)
      .send({ events: [eventItem(firm.id, matterId, eventId)] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1 });
    expect(res.body.results).toEqual([{ eventId, success: true, outlookId: 'AAMkA-matter-event' }]);

    const { rows } = await testPool.query(
      `select provider, external_event_id, law_firm_id, entity_type, entity_id, scope_id, user_id
         from calendar_mappings`,
    );
    expect(rows).toEqual([{
      provider: 'outlook',
      external_event_id: 'AAMkA-matter-event',
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
    const refused = await connectedMember(firm.id, []);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    const matterId = await seedMatter(firm.id);
    // The permitted caller is staffed on the matter, so the only thing separating
    // the two halves is `calendar.sync` rather than the matter wall as well.
    await addMatterMember(firm.id, matterId, permitted.uid);
    const eventId = await seedMatterEvent(firm.id, matterId, undefined, undefined, permitted.uid);
    routeEventPush();
    const body = { events: [eventItem(firm.id, matterId, eventId)] };

    const denied = await refused.api.post(`${BASE}/sync-events-to-outlook`).send(body);
    expect(denied.status).toBe(403);
    expect(outboundCalls()).toHaveLength(0);
    expect((await testPool.query(`select 1 from calendar_mappings`)).rowCount).toBe(0);

    const allowed = await permitted.api.post(`${BASE}/sync-events-to-outlook`).send(body);
    expect(allowed.status).toBe(200);
    expect((await testPool.query(`select 1 from calendar_mappings`)).rowCount).toBe(1);
  });

  /**
   * The plan ceiling on the batch variant. Goes red if
   * `requireCalendarSyncFromItems` is removed: a starter firm would push matter
   * events to Outlook without the feature.
   */
  test('refuses a firm whose plan does not include calendar sync', async () => {
    const starter = await createFirm({ planId: 'starter' });
    const owner = await connectedOwner(starter.id);
    const matterId = await seedMatter(starter.id);
    const eventId = await seedMatterEvent(starter.id, matterId);
    routeEventPush();

    const res = await owner.api.post(`${BASE}/sync-events-to-outlook`)
      .send({ events: [eventItem(starter.id, matterId, eventId)] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not included in your current plan/);
    expect(outboundCalls()).toHaveLength(0);
  });

  /**
   * Goes red if the batch stops loading a client event (an item naming a
   * `clientId` and no matter): it is skipped, and the client events that
   * existed before the member connected never reach their calendar.
   */
  test('pushes a client event and records the reverse mapping against the client', async () => {
    const owner = await connectedOwner(firm.id);
    const { clientId, eventId } = await seedClientEvent(firm.id, undefined, owner.uid);
    routeEventPush('AAMkA-client-event');

    const res = await owner.api.post(`${BASE}/sync-events-to-outlook`).send({
      events: [{ eventId, clientId, lawFirmId: firm.id, title: 'Client check-in', date: '2026-09-02T17:00:00Z' }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedCount: 1 });
    expect(res.body.results).toEqual([{ eventId, success: true, outlookId: 'AAMkA-client-event' }]);
    expect(callsMatching(EVENTS)[0].body.subject).toBe('Client check-in');

    const { rows } = await testPool.query(
      `select provider, external_event_id, law_firm_id, entity_type, entity_id, scope_id, user_id from calendar_mappings`,
    );
    expect(rows).toEqual([{
      provider: 'outlook',
      external_event_id: 'AAMkA-client-event',
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

    const res = await owner.api.post(`${BASE}/sync-events-to-outlook`).send({
      events: [{ ...theirs, lawFirmId: firm.id, title: 'Their client meeting', date: '2026-09-02T17:00:00Z' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.syncedCount).toBe(0);
    expect(callsMatching(EVENTS)).toHaveLength(0);
    expect((await testPool.query(`select 1 from calendar_mappings`)).rowCount).toBe(0);
  });

  test('refuses a body with no events array', async () => {
    const owner = await connectedOwner(firm.id);

    const res = await owner.api.post(`${BASE}/sync-events-to-outlook`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', error: 'Events array is required' });
  });
});

// ── enable-silent-sync (requireSyncPerm + requireCalendarSync) ──────────────

describe('POST /enable-silent-sync', () => {
  function routeSubscribe(id = 'SUB-NEW') {
    route(SUBSCRIPTION_BY_ID, { status: 204 }, { method: 'DELETE' });
    route(SUBSCRIPTIONS, {
      status: 200,
      json: { id, expirationDateTime: '2026-12-01T00:00:00Z' },
    }, { method: 'POST' });
  }

  test('opens a subscription for an owner and records it against the firm', async () => {
    const owner = await connectedOwner(firm.id);
    routeSubscribe();

    const res = await owner.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Silent sync enabled',
      expirationDateTime: '2026-12-01T00:00:00Z',
    });

    const rows = await subscriptionRows();
    expect(rows).toEqual([{
      id: 'SUB-NEW',
      user_id: owner.uid,
      law_firm_id: firm.id,
      resource: '/me/calendar/events',
    }]);

    const created = callsMatching(SUBSCRIPTIONS);
    expect(created).toHaveLength(1);
    expect(created[0].body.notificationUrl).toBe('https://hooks.paralegix.test/api/webhooks/outlook-calendar');
  });

  /**
   * The route tears down the caller's existing subscriptions BEFORE creating a
   * new one, because Graph subscriptions are per-user and a second one doubles
   * webhook delivery and defeats the single-row bounce stamp. The colleague's
   * subscription is the control: `stopAllSubscriptions` is scoped by user id,
   * so a reconnect by one lawyer must not silence the rest of the firm.
   *
   * Goes red if the `stopAllSubscriptions` call is removed (two rows survive)
   * or if it stops filtering by user id (the colleague's row disappears).
   */
  test('replaces the caller own subscription and leaves a colleague one alone', async () => {
    const owner = await connectedOwner(firm.id);
    const colleague = await connectedMember(firm.id, ['calendar.sync']);
    const mine = await seedSubscription(owner.uid, firm.id);
    const theirs = await seedSubscription(colleague.uid, firm.id);
    routeSubscribe();

    const res = await owner.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(200);
    const rows = await subscriptionRows();
    expect(rows.map((r) => r.id).sort()).toEqual(['SUB-NEW', theirs].sort());

    // Graph was asked to stop exactly the caller's old subscription.
    const stops = callsMatching(SUBSCRIPTION_BY_ID).filter((c) => c.method === 'DELETE');
    expect(stops).toHaveLength(1);
    expect(stops[0].url).toBe(`https://graph.microsoft.com/v1.0/subscriptions/${mine}`);
  });

  /**
   * Goes red if `requireSyncPerm` is removed from this route: a member without
   * `calendar.sync` would register a webhook that streams the firm's calendar
   * changes to their own connection for three days.
   */
  test('refuses a member without calendar.sync and leaves no subscription behind', async () => {
    const refused = await connectedMember(firm.id, []);
    const permitted = await connectedMember(firm.id, ['calendar.sync']);
    routeSubscribe();

    const denied = await refused.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });
    expect(denied.status).toBe(403);
    expect(outboundCalls()).toHaveLength(0);
    expect(await subscriptionRows()).toHaveLength(0);

    const allowed = await permitted.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });
    expect(allowed.status).toBe(200);
    expect(await subscriptionRows()).toHaveLength(1);
  });

  test('refuses an owner of a different firm', async () => {
    const neighbour = await createFirm();
    const outsider = await connectedOwner(neighbour.id);
    routeSubscribe();

    const res = await outsider.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', error: 'Not a member of this firm' });
    expect(await subscriptionRows()).toHaveLength(0);
  });

  /**
   * `createSubscription` answers `null` rather than throwing when the caller has
   * no Microsoft grant, so the route's own null branch is the only thing that
   * turns that into a message. Goes red if that branch is dropped and the route
   * answers 200 with an undefined expiry, which would leave the UI showing
   * silent sync as enabled when no subscription exists.
   */
  test('reports a caller with no Microsoft connection instead of claiming success', async () => {
    const owner = await ownerOf(firm.id);
    routeSubscribe();

    const res = await owner.api.post(`${BASE}/enable-silent-sync`).send({ lawFirmId: firm.id });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to enable silent sync. Check Microsoft connection.' });
    expect(await subscriptionRows()).toHaveLength(0);
  });
});

// ── disable-silent-sync ─────────────────────────────────────────────────────

describe('POST /disable-silent-sync', () => {
  /**
   * The route takes no firm and no subscription id: it acts on whatever
   * subscriptions the CALLER owns. Goes red if `stopAllSubscriptions` stops
   * filtering by user id, which would silently tear down every other user's
   * silent sync.
   */
  test('stops the caller subscriptions and leaves another user alone', async () => {
    const owner = await connectedOwner(firm.id);
    const colleague = await connectedMember(firm.id, ['calendar.sync']);
    const mine = await seedSubscription(owner.uid, firm.id);
    const theirs = await seedSubscription(colleague.uid, firm.id);
    route(SUBSCRIPTION_BY_ID, { status: 204 }, { method: 'DELETE' });

    const res = await owner.api.post(`${BASE}/disable-silent-sync`).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Silent sync disabled' });

    const rows = await subscriptionRows();
    expect(rows.map((r) => r.id)).toEqual([theirs]);

    const stops = callsMatching(SUBSCRIPTION_BY_ID);
    expect(stops).toHaveLength(1);
    expect(stops[0].url).toBe(`https://graph.microsoft.com/v1.0/subscriptions/${mine}`);
  });

  /**
   * The one route on this router with no gate past `verifyToken`, and the only
   * one that may be called by a member of no firm at all: it is what the
   * disconnect button calls. Goes red if a firm-scoped gate is added here,
   * which would strand a user who left their firm with a live subscription
   * feeding their mailbox into a firm they no longer belong to.
   */
  test('admits a caller with no calendar.sync permission anywhere', async () => {
    const refused = await connectedMember(firm.id, []);
    const mine = await seedSubscription(refused.uid, firm.id);
    route(SUBSCRIPTION_BY_ID, { status: 204 }, { method: 'DELETE' });

    const res = await refused.api.post(`${BASE}/disable-silent-sync`).send({});

    expect(res.status).toBe(200);
    expect(await subscriptionRows()).toHaveLength(0);
    expect(callsMatching(SUBSCRIPTION_BY_ID)[0].url)
      .toBe(`https://graph.microsoft.com/v1.0/subscriptions/${mine}`);
  });
});

export {};
