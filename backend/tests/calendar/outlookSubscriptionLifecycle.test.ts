/**
 * The Graph subscription lifecycle in `calendar/outlook/outlook.service.ts` and
 * the lifecycle route on `outlook.webhook.routes.ts`.
 *
 * A subscription is what makes Outlook changes arrive at all, and it lasts at
 * most about three days. The renewal cron is one way it stays alive. Graph's
 * lifecycle notifications are the other: Graph says when a subscription needs
 * reauthorizing, when it has removed one, and when it dropped notifications.
 * Each of those, ignored, ends a user's live import with nothing on screen to
 * say so, which is why every case below asserts what reached Graph or what was
 * queued, not just the status code.
 *
 * NO LIVE MICROSOFT CALL IS POSSIBLE HERE. `globalThis.fetch` is replaced for
 * the life of the file by a router that answers only urls a case registered and
 * throws on anything else, and the Microsoft OAuth credentials are replaced with
 * invalid values. The first case proves the router is in force.
 */
import {
  testPool,
  createFirm,
  createFirmMember,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';

const outlookService = require('../../src/modules/calendar/outlook/outlook.service');
const calendarSyncRepo = require('../../src/modules/calendar/shared/calendarSync.repository');

// ── the outbound-request router ─────────────────────────────────────────────

const BLOCKED = 'BLOCKED OUTBOUND REQUEST';
const WEBHOOK_BASE = 'https://webhook.invalid';
const LIFECYCLE_PATH = '/api/webhooks/outlook-calendar/lifecycle';

interface RecordedCall {
  url: string;
  method: string;
  body: any;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

let routes: Array<{ method: string; fragment: string; handler: Handler }> = [];
let calls: RecordedCall[] = [];
let realFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function graph(method: string, fragment: string, handler: Handler) {
  routes.push({ method: method.toUpperCase(), fragment, handler });
}

function always(status: number, body?: unknown): Handler {
  return () => (body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

const callsTo = (method: string, fragment: string) => calls.filter(
  (c) => c.method === method && c.url.includes(fragment),
);

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    const method = (init.method || 'GET').toUpperCase();
    let body: any = init.body == null ? null : String(init.body);
    try { body = body ? JSON.parse(body) : body; } catch { /* not JSON; keep the string */ }
    const call: RecordedCall = { url, method, body };
    calls.push(call);
    const match = routes.find((r) => r.method === method && url.includes(r.fragment));
    if (!match) throw new Error(`${BLOCKED}: ${method} ${url}`);
    return match.handler(call);
  }) as typeof globalThis.fetch;

  for (const key of ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'WEBHOOK_BASE_URL']) {
    savedEnv[key] = process.env[key];
  }
  process.env.MICROSOFT_CLIENT_ID = 'invalid-client-id-for-tests';
  process.env.MICROSOFT_CLIENT_SECRET = 'invalid-client-secret-for-tests';
  // createSubscription refuses to run without an https webhook base.
  process.env.WEBHOOK_BASE_URL = WEBHOOK_BASE;
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

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

/**
 * A firm member with Microsoft connected. A fresh uid each time, because
 * `calendarHelpers` caches user data by uid for a few seconds.
 */
async function connectMicrosoft(firm: Firm, opts: { accessToken?: string | null } = {}) {
  const { uid } = await createFirmMember(firm.id);
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, meta)
     values ($1, 'microsoft', $2, $3, $4::jsonb)`,
    [
      uid,
      opts.accessToken === undefined ? 'access-token-seed' : opts.accessToken,
      opts.accessToken === null ? null : 'refresh-token-seed',
      JSON.stringify({ outlookTimezone: 'America/New_York', outlookMailboxTimezoneWritable: true }),
    ],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', true, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid],
  );
  expect(settings.rowCount).toBe(1);
  return uid;
}

/** A subscription row on the default calendar, the one a default target expects. */
async function seedSubscription(fields: {
  id: string; userId: string; firm: Firm; clientState?: string; expiresInMs?: number;
}) {
  const inserted = await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, resource, secret, expiration)
     values ('outlook', $1, $2, $3, '/me/calendar/events', $4, $5)`,
    [
      fields.id, fields.userId, fields.firm.id, fields.clientState ?? `cs-${fields.id}`,
      new Date(Date.now() + (fields.expiresInMs ?? 3 * 24 * 60 * 60 * 1000)),
    ],
  );
  expect(inserted.rowCount).toBe(1);
}

const subscriptionRows = async () => (await testPool.query(
  `select id, user_id, expiration from calendar_subscriptions where provider = 'outlook' order by id`,
)).rows;

const catchUpRows = async (userId: string) => (await testPool.query(
  `select dedupe_key from calendar_sync_failures
    where kind = 'webhook' and provider = 'outlook' and user_id = $1
      and payload->>'changeType' = 'catch_up'`,
  [userId],
)).rows;

/** Graph's answer to a subscription create. */
const createdSubscription = (id: string) => always(201, {
  id, expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
});

const deliverLifecycle = (value: unknown[]) => request().post(LIFECYCLE_PATH).send({ value });

/**
 * Graph's answer to a renewal PATCH: the whole subscription, which for one
 * created with lifecycle notifications names the lifecycle url.
 */
const patched = (id: string) => always(200, { id, lifecycleNotificationUrl: `${WEBHOOK_BASE}${LIFECYCLE_PATH}` });

// ── 1. containment ──────────────────────────────────────────────────────────

describe('outbound network containment', () => {
  /**
   * Goes red if the router is not installed. Every "Graph was not called"
   * assertion below is worthless without it.
   */
  test('an unrouted Graph request is blocked and recorded', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await expect(outlookService.createSubscription({ userId: uid, lawFirmId: firm.id }))
      .rejects.toThrow(BLOCKED);
    expect(callsTo('POST', '/v1.0/subscriptions')).toHaveLength(1);
  });
});

// ── 2. creating a subscription ──────────────────────────────────────────────

describe('createSubscription', () => {
  /**
   * Graph sends lifecycle notifications only to a subscription that names a
   * lifecycle url when it is created.
   *
   * Goes red if the create body stops carrying `lifecycleNotificationUrl`, or
   * carries one the lifecycle route is not mounted at.
   */
  test('asks Graph for lifecycle notifications at the lifecycle route', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    graph('POST', '/v1.0/subscriptions', createdSubscription('sub-created'));

    await outlookService.createSubscription({ userId: uid, lawFirmId: firm.id });

    const [create] = callsTo('POST', '/v1.0/subscriptions');
    expect(create.body.notificationUrl).toBe(`${WEBHOOK_BASE}/api/webhooks/outlook-calendar`);
    expect(create.body.lifecycleNotificationUrl).toBe(`${WEBHOOK_BASE}${LIFECYCLE_PATH}`);
    expect((await subscriptionRows()).map((r) => r.id)).toEqual(['sub-created']);
  });
});

// ── 3. renewal accounting ───────────────────────────────────────────────────

describe('renewExpiringSubscriptions', () => {
  /**
   * A subscription whose owner has no usable token is counted as failed and
   * the pass moves on. It must not read as a budget cut-off: `truncated` tells
   * the cron that due work was left unreached.
   *
   * Goes red if the no-token branch skips counting the subscription as
   * processed: the pass reports `truncated: true` having reached everything.
   */
  test('a subscription with no token counts as failed, not as unreached', async () => {
    const firm = await createFirm();
    const tokenless = await connectMicrosoft(firm, { accessToken: null });
    const connected = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-tokenless', userId: tokenless, firm, expiresInMs: 60 * 60 * 1000 });
    await seedSubscription({ id: 'sub-connected', userId: connected, firm, expiresInMs: 60 * 60 * 1000 });
    graph('PATCH', '/subscriptions/sub-connected', patched('sub-connected'));

    const result = await outlookService.renewExpiringSubscriptions();

    expect(result).toEqual({ renewed: 1, failed: 1, truncated: false });
    expect(callsTo('PATCH', '/subscriptions/sub-connected')).toHaveLength(1);
    expect(callsTo('PATCH', '/subscriptions/sub-tokenless')).toHaveLength(0);
  });

  /**
   * Graph cannot add a lifecycle url to a subscription with a PATCH, and the
   * PATCH reply shows whether one is set. A subscription created before the
   * lifecycle route existed would otherwise be extended forever and never get
   * one, so it never hears about reauthorization, removal or missed changes.
   *
   * Goes red if renewal stops reading the reply: the old subscription is kept
   * and no create is sent.
   */
  test('a subscription without a lifecycle url is recreated with one', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-legacy', userId: uid, firm, expiresInMs: 60 * 60 * 1000 });
    graph('PATCH', '/subscriptions/sub-legacy', always(200, { id: 'sub-legacy', lifecycleNotificationUrl: null }));
    graph('POST', '/v1.0/subscriptions', createdSubscription('sub-modern'));
    graph('DELETE', '/subscriptions/sub-legacy', always(204));

    const result = await outlookService.renewExpiringSubscriptions();

    expect(result).toEqual({ renewed: 1, failed: 0, truncated: false });
    const [create] = callsTo('POST', '/v1.0/subscriptions');
    expect(create.body.lifecycleNotificationUrl).toBe(`${WEBHOOK_BASE}${LIFECYCLE_PATH}`);
    expect(callsTo('DELETE', '/subscriptions/sub-legacy')).toHaveLength(1);
    expect((await subscriptionRows()).map((r) => r.id)).toEqual(['sub-modern']);
  });

  /**
   * The PATCH already extended the old subscription, so a refused recreate
   * leaves it live and renewed, and the next renewal tries the recreate again.
   *
   * Goes red if a refused recreate is reported as a failure, or if the old
   * row's new expiry is not stored before the recreate is tried.
   */
  test('a refused recreate keeps the extended subscription', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-legacy-kept', userId: uid, firm, expiresInMs: 60 * 60 * 1000 });
    graph('PATCH', '/subscriptions/sub-legacy-kept', always(200, { id: 'sub-legacy-kept' }));
    graph('POST', '/v1.0/subscriptions', always(400, { error: { code: 'InvalidRequest' } }));
    const [before] = await subscriptionRows();

    const result = await outlookService.renewExpiringSubscriptions();

    expect(result).toEqual({ renewed: 1, failed: 0, truncated: false });
    expect(callsTo('POST', '/v1.0/subscriptions')).toHaveLength(1);
    const [after] = await subscriptionRows();
    expect(after.id).toBe('sub-legacy-kept');
    expect(after.expiration.getTime()).toBeGreaterThan(before.expiration.getTime());
  });
});

// ── 3b. lifecycle items on the change route ─────────────────────────────────

describe('lifecycle items on POST /api/webhooks/outlook-calendar', () => {
  const deliverChange = (value: unknown[]) => request().post('/api/webhooks/outlook-calendar').send({ value });

  /**
   * Graph may deliver lifecycle events to the change url. Such an item has a
   * `lifecycleEvent` and no change, so treating it as a change fetched nothing
   * and dropped the event.
   *
   * Goes red if the change route stops handing lifecycle items over: no
   * catch-up is queued for the missed changes.
   */
  test('a missed event on the change route queues a catch-up', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-change-route', userId: uid, firm, clientState: 'cs-change-route' });

    const res = await deliverChange([
      { subscriptionId: 'sub-change-route', clientState: 'cs-change-route', lifecycleEvent: 'missed' },
    ]);

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
    expect(await catchUpRows(uid)).toHaveLength(1);
    const { rows } = await testPool.query(
      `select payload->>'changeType' as change_type from calendar_sync_failures where kind = 'webhook' and user_id = $1`,
      [uid],
    );
    expect(rows).toEqual([{ change_type: 'catch_up' }]);
  });

  /**
   * Goes red if lifecycle items skip the change route's clientState check.
   */
  test('a lifecycle item with the wrong clientState does nothing', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-change-forged', userId: uid, firm, clientState: 'the-real-secret' });

    const res = await deliverChange([
      { subscriptionId: 'sub-change-forged', clientState: 'a-guess', lifecycleEvent: 'missed' },
    ]);

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
    expect((await testPool.query(`select 1 from calendar_sync_failures where kind = 'webhook'`)).rows).toHaveLength(0);
  });
});

// ── 4. the lifecycle route ──────────────────────────────────────────────────

describe(`POST ${LIFECYCLE_PATH}`, () => {
  /**
   * Graph validates a lifecycle url when a subscription naming it is created,
   * and refuses the create when the token is not echoed back as plain text.
   *
   * Goes red if the route is not mounted, or stops echoing the token.
   */
  test('echoes the validation token as plain text', async () => {
    const res = await request().post(`${LIFECYCLE_PATH}?validationToken=lifecycle-check-123`).send();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('lifecycle-check-123');
  });

  /**
   * The route carries no auth middleware, because Graph cannot present a
   * bearer token. The stored clientState is the whole gate, so a delivery
   * naming another user's subscription with the wrong secret must do nothing.
   *
   * Goes red if the clientState check is skipped: the forged
   * `subscriptionRemoved` would recreate the subscription and queue a full
   * read of that user's calendar.
   */
  test('ignores a delivery whose clientState does not match', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-guarded', userId: uid, firm, clientState: 'the-real-secret' });
    graph('POST', '/v1.0/subscriptions', createdSubscription('sub-forged-replacement'));
    graph('DELETE', '/subscriptions/sub-guarded', always(204));

    const res = await deliverLifecycle([
      { subscriptionId: 'sub-guarded', clientState: 'a-guess', lifecycleEvent: 'subscriptionRemoved' },
    ]);

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
    expect((await subscriptionRows()).map((r) => r.id)).toEqual(['sub-guarded']);
    expect(await catchUpRows(uid)).toHaveLength(0);
  });

  /**
   * Goes red if an unknown subscription id is trusted. Nothing is known about
   * whose it would be, so there is nothing safe to do with it.
   */
  test('ignores a subscription nobody issued', async () => {
    const res = await deliverLifecycle([
      { subscriptionId: 'sub-nobody-issued', clientState: 'anything', lifecycleEvent: 'missed' },
    ]);
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
    expect((await testPool.query(`select 1 from calendar_sync_failures where kind = 'webhook'`)).rows).toHaveLength(0);
  });

  /**
   * `reauthorizationRequired` means Graph will stop delivering unless the
   * subscription is renewed, possibly well before its expiry. Renewing it in
   * place is a reauthorization.
   *
   * Goes red if the event is acknowledged without the PATCH, which is the old
   * behaviour: the subscription lapses at Graph while its row still says live.
   */
  test('renews the subscription on reauthorizationRequired', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-reauth', userId: uid, firm, clientState: 'cs-reauth', expiresInMs: 2 * 24 * 60 * 60 * 1000 });
    graph('PATCH', '/subscriptions/sub-reauth', patched('sub-reauth'));
    const [before] = await subscriptionRows();

    const res = await deliverLifecycle([
      { subscriptionId: 'sub-reauth', clientState: 'cs-reauth', lifecycleEvent: 'reauthorizationRequired' },
    ]);

    expect(res.status).toBe(202);
    const patches = callsTo('PATCH', '/subscriptions/sub-reauth');
    expect(patches).toHaveLength(1);
    expect(new Date(patches[0].body.expirationDateTime).getTime()).toBeGreaterThan(before.expiration.getTime());
    const [after] = await subscriptionRows();
    expect(after.id).toBe('sub-reauth');
    expect(after.expiration.getTime()).toBeGreaterThan(before.expiration.getTime());
  });

  /**
   * `subscriptionRemoved` means Graph has already deleted it. Nothing arrives
   * until a new one exists, and whatever changed in between was never
   * notified, so the calendar is read in full too.
   *
   * Goes red if the removed subscription is not recreated (its row survives
   * and no create is sent), or if no catch-up is queued.
   */
  test('recreates the subscription and queues a catch-up on subscriptionRemoved', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-removed', userId: uid, firm, clientState: 'cs-removed' });
    graph('POST', '/v1.0/subscriptions', createdSubscription('sub-recreated'));
    graph('DELETE', '/subscriptions/sub-removed', always(404));

    const res = await deliverLifecycle([
      { subscriptionId: 'sub-removed', clientState: 'cs-removed', lifecycleEvent: 'subscriptionRemoved' },
    ]);

    expect(res.status).toBe(202);
    expect(callsTo('POST', '/v1.0/subscriptions')).toHaveLength(1);
    expect(await subscriptionRows()).toEqual([expect.objectContaining({ id: 'sub-recreated', user_id: uid })]);
    expect(await catchUpRows(uid)).toHaveLength(1);
  });

  /**
   * `missed` means Graph dropped change notifications. The subscription itself
   * is fine, so only a full read can recover what was lost.
   *
   * Goes red if the event queues nothing, or if it touches the subscription.
   */
  test('queues a catch-up and leaves the subscription alone on missed', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-missed', userId: uid, firm, clientState: 'cs-missed' });

    const res = await deliverLifecycle([
      { subscriptionId: 'sub-missed', clientState: 'cs-missed', lifecycleEvent: 'missed' },
    ]);

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
    expect(await catchUpRows(uid)).toHaveLength(1);
    expect((await subscriptionRows()).map((r) => r.id)).toEqual(['sub-missed']);
  });

  /**
   * The queued catch-up is a real full read: the sweep that replays it lists
   * the calendar rather than re-fetching one event.
   *
   * Goes red if the queued row is not the `catch_up` shape the retry sweep
   * turns into `syncFromOutlook`.
   */
  test('the queued catch-up is replayed as a full calendar read', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-replayed', userId: uid, firm, clientState: 'cs-replayed' });
    await deliverLifecycle([
      { subscriptionId: 'sub-replayed', clientState: 'cs-replayed', lifecycleEvent: 'missed' },
    ]);
    graph('GET', '/calendarView', always(200, { value: [] }));

    const { retryFailedWebhooks } = require('../../src/modules/calendar/shared/calendarWebhookRetry');
    const summary = await retryFailedWebhooks({});

    expect(summary).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(callsTo('GET', '/calendarView').length).toBeGreaterThan(0);
    expect(await catchUpRows(uid)).toHaveLength(0);
  });
});

// ── 5. overlapping replacements ─────────────────────────────────────────────

describe('a lifecycle recreate overlapping the renewal cron', () => {
  /**
   * Holds the first subscription create open until `release` is called.
   * `inFlight` resolves once it has reached Graph.
   */
  function holdFirstCreate(id: string) {
    let release!: () => void;
    let markInFlight!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = new Promise<void>((resolve) => { markInFlight = resolve; });
    let hit = 0;
    graph('POST', '/v1.0/subscriptions', async (call) => {
      const mine = hit;
      hit += 1;
      if (mine === 0) {
        markInFlight();
        await released;
      }
      return createdSubscription(`${id}-${mine}`)(call);
    });
    return { inFlight, release };
  }

  /**
   * Graph removed a subscription that is also due for renewal. The renewal's
   * PATCH fails on the removed id and it recreates, so without one lock the
   * cron and the lifecycle handler each created a replacement and the user's
   * changes notified twice.
   *
   * Goes red if renewal and the lifecycle handler stop sharing the per-user
   * watch lock: the renewal creates its own subscription and two remain.
   */
  test('leaves the user with one subscription', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-both', userId: uid, firm, clientState: 'cs-both', expiresInMs: 60 * 60 * 1000 });
    const { inFlight, release } = holdFirstCreate('sub-next');
    graph('PATCH', '/subscriptions/sub-both', always(404));
    graph('DELETE', '/subscriptions/sub-both', always(404));

    const lifecycle = deliverLifecycle([
      { subscriptionId: 'sub-both', clientState: 'cs-both', lifecycleEvent: 'subscriptionRemoved' },
    ]).then((res) => res);
    await inFlight;
    const renewal = await outlookService.renewExpiringSubscriptions();
    release();
    expect((await lifecycle).status).toBe(202);

    expect(renewal).toEqual({ renewed: 0, failed: 0, truncated: false });
    expect(callsTo('POST', '/v1.0/subscriptions')).toHaveLength(1);
    expect((await subscriptionRows()).map((r) => r.id)).toEqual(['sub-next-0']);
  });

  /**
   * A renewal pass that listed the subscription before the lifecycle handler
   * replaced it takes the lock only afterwards. It must notice the row is gone
   * rather than PATCH a dead id and recreate a second time.
   *
   * Goes red if renewal stops re-reading the subscription once it holds the
   * lock.
   */
  test('a renewal holding a stale listing does not replace it again', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-stale', userId: uid, firm, clientState: 'cs-stale', expiresInMs: 60 * 60 * 1000 });
    const { inFlight, release } = holdFirstCreate('sub-fresh');
    graph('PATCH', '/subscriptions/sub-stale', always(404));
    graph('DELETE', '/subscriptions/sub-stale', always(404));

    const lifecycle = deliverLifecycle([
      { subscriptionId: 'sub-stale', clientState: 'cs-stale', lifecycleEvent: 'subscriptionRemoved' },
    ]).then((res) => res);
    await inFlight;

    // The renewal reads its due set while the old row still exists, then waits
    // for the lifecycle handler to finish before going on.
    const realList = calendarSyncRepo.listExpiringSubscriptions;
    let markListed!: () => void;
    let openGate!: () => void;
    const listed = new Promise<void>((resolve) => { markListed = resolve; });
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const spy = jest.spyOn(calendarSyncRepo, 'listExpiringSubscriptions').mockImplementationOnce(async (cutoff: any) => {
      const due = await realList(cutoff);
      markListed();
      await gate;
      return due;
    });
    try {
      const renewal = outlookService.renewExpiringSubscriptions();
      await listed;
      release();
      expect((await lifecycle).status).toBe(202);
      openGate();
      expect(await renewal).toEqual({ renewed: 0, failed: 0, truncated: false });
    } finally {
      spy.mockRestore();
    }

    expect(callsTo('PATCH', '/subscriptions/sub-stale')).toHaveLength(0);
    expect((await subscriptionRows()).map((r) => r.id)).toEqual(['sub-fresh-0']);
  });

  /**
   * Re-pointing live import after a calendar-target change also replaces the
   * subscription. It listed the old one, created its own and stopped what it
   * listed, so overlapping a renewal's recreate left the renewal's new
   * subscription live beside its own.
   *
   * Goes red if `rearmSubscription` stops taking the per-user watch lock: it
   * runs straight through while the renewal is held, and two subscriptions
   * remain.
   */
  test('a re-point overlapping a renewal leaves one subscription', async () => {
    const firm = await createFirm();
    const uid = await connectMicrosoft(firm);
    await seedSubscription({ id: 'sub-rearm', userId: uid, firm, clientState: 'cs-rearm', expiresInMs: 60 * 60 * 1000 });
    const { inFlight, release } = holdFirstCreate('sub-after');
    graph('PATCH', '/subscriptions/sub-rearm', always(404));
    graph('DELETE', '/subscriptions/', always(204));

    const renewal = outlookService.renewExpiringSubscriptions();
    await inFlight;
    let rearmSettled = false;
    const rearm = outlookService.rearmSubscription(uid).finally(() => { rearmSettled = true; });
    // Unlocked, the re-point finishes on its own while the renewal is held.
    // Locked, it is still waiting when this second is up.
    for (let waited = 0; waited < 1000 && !rearmSettled; waited += 25) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    release();
    expect(await renewal).toEqual({ renewed: 1, failed: 0, truncated: false });
    await rearm;

    expect(callsTo('POST', '/v1.0/subscriptions')).toHaveLength(2);
    expect((await subscriptionRows()).map((r) => r.id)).toEqual(['sub-after-1']);
  });
});
