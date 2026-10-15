/**
 * The server-side product analytics wrapper, `src/shared/analytics/serverAnalytics.ts`.
 *
 * It is the only code that talks to PostHog, and three promises it makes are
 * what let every caller fire and forget:
 *
 *   NO TOKEN, NO CLIENT. Local dev, the test suite and any environment without
 *   POSTHOG_PROJECT_TOKEN must never construct a PostHog client, so nothing can
 *   leave the process.
 *
 *   ONLY PRIMITIVES LEAVE. Property values are restricted to string, number,
 *   boolean and null. Most callers hand it `any`-typed webhook payloads, so the
 *   type alone is not enough: an object or array slipped past the compiler is
 *   dropped at runtime rather than serialised into a third-party system.
 *
 *   IT NEVER THROWS. A capture runs inside Stripe webhook handlers that move
 *   money. An analytics failure answering 500 would release the idempotency
 *   claim and make Stripe redeliver a payment.
 *
 * `posthog-node` itself is replaced with a recording fake. The wrapper resolves
 * its client lazily and caches it per module instance, so every case loads a
 * fresh copy through `jest.isolateModules` with the environment it needs.
 */

const mockCapture = jest.fn();
const mockShutdown = jest.fn();
const mockOn = jest.fn();
const mockConstructor = jest.fn();

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation((token: string, options: unknown) => {
    mockConstructor(token, options);
    return { capture: mockCapture, shutdown: mockShutdown, on: mockOn };
  }),
}));

type AnalyticsModule = typeof import('../../src/shared/analytics/serverAnalytics');
type ShutdownModule = typeof import('../../src/shared/utils/shutdownHooks');

const TOKEN_VAR = 'POSTHOG_PROJECT_TOKEN';
const HOST_VAR = 'POSTHOG_HOST';
const savedToken = process.env[TOKEN_VAR];
const savedHost = process.env[HOST_VAR];

/** A fresh copy of the wrapper and of the shutdown registry it registers with. */
function load(): { analytics: AnalyticsModule; shutdown: ShutdownModule } {
  let analytics!: AnalyticsModule;
  let shutdown!: ShutdownModule;
  jest.isolateModules(() => {
    shutdown = require('../../src/shared/utils/shutdownHooks');
    analytics = require('../../src/shared/analytics/serverAnalytics');
  });
  return { analytics, shutdown };
}

const FIRM = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  mockCapture.mockReset();
  mockShutdown.mockReset();
  mockOn.mockReset();
  mockConstructor.mockReset();
  delete process.env[TOKEN_VAR];
  delete process.env[HOST_VAR];
});

afterAll(() => {
  if (savedToken === undefined) delete process.env[TOKEN_VAR];
  else process.env[TOKEN_VAR] = savedToken;
  if (savedHost === undefined) delete process.env[HOST_VAR];
  else process.env[HOST_VAR] = savedHost;
});

describe('without POSTHOG_PROJECT_TOKEN', () => {
  it('constructs no client and captures nothing', () => {
    const { analytics } = load();

    analytics.captureServerEvent({ event: 'law_firm_created', lawFirmId: FIRM, properties: { firm_size: '2-5' } });

    expect(mockConstructor).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('treats an empty token as unset', () => {
    // The test harness blanks the variable rather than deleting it, because a
    // deleted variable is restored by the app's own dotenv load.
    process.env[TOKEN_VAR] = '';
    const { analytics } = load();

    analytics.captureServerEvent({ event: 'law_firm_created', lawFirmId: FIRM });

    expect(mockConstructor).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('with POSTHOG_PROJECT_TOKEN', () => {
  beforeEach(() => {
    process.env[TOKEN_VAR] = 'phc_unit_suite_token';
  });

  it('builds one client from the token, on the US host by default', () => {
    const { analytics } = load();

    analytics.captureServerEvent({ event: 'law_firm_created', lawFirmId: FIRM });
    analytics.captureServerEvent({ event: 'subscription_started', lawFirmId: FIRM });

    expect(mockConstructor).toHaveBeenCalledTimes(1);
    expect(mockConstructor).toHaveBeenCalledWith(
      'phc_unit_suite_token',
      expect.objectContaining({ host: 'https://us.i.posthog.com' }),
    );
  });

  it('uses POSTHOG_HOST when set', () => {
    process.env[HOST_VAR] = 'https://eu.i.posthog.com';
    const { analytics } = load();

    analytics.captureServerEvent({ event: 'law_firm_created', lawFirmId: FIRM });

    expect(mockConstructor).toHaveBeenCalledWith(
      'phc_unit_suite_token',
      expect.objectContaining({ host: 'https://eu.i.posthog.com' }),
    );
  });

  it('passes the properties through with the firm as group and as a property', () => {
    const { analytics } = load();

    analytics.captureServerEvent({
      event: 'subscription_status_changed',
      lawFirmId: FIRM,
      distinctId: 'firebase-uid-1',
      properties: { from_status: 'trialing', to_status: 'active', seats: 3, is_annual: false, plan: null },
    });

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'firebase-uid-1',
      event: 'subscription_status_changed',
      groups: { law_firm: FIRM },
      properties: {
        from_status: 'trialing',
        to_status: 'active',
        seats: 3,
        is_annual: false,
        plan: null,
        law_firm_id: FIRM,
      },
    });
  });

  it('attributes an event with no user to the firm itself', () => {
    const { analytics } = load();

    analytics.captureServerEvent({ event: 'client_invoice_paid', lawFirmId: FIRM });

    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ distinctId: `law_firm:${FIRM}` }));
  });

  it('never lets a caller overwrite law_firm_id', () => {
    const { analytics } = load();

    analytics.captureServerEvent({
      event: 'law_firm_created',
      lawFirmId: FIRM,
      properties: { law_firm_id: 'some-other-firm' },
    });

    expect(mockCapture.mock.calls[0][0].properties.law_firm_id).toBe(FIRM);
  });

  it('drops a non-primitive value that slipped past the type', () => {
    const { analytics } = load();

    analytics.captureServerEvent({
      event: 'client_invoice_paid',
      lawFirmId: FIRM,
      // An `any`-typed webhook payload is exactly how an object reaches here.
      properties: {
        is_installment: true,
        client: { name: 'Jane Client', email: 'jane@example.test' },
        tags: ['estate'],
        missing: undefined,
      } as any,
    });

    expect(mockCapture.mock.calls[0][0].properties).toEqual({ is_installment: true, law_firm_id: FIRM });
  });

  it('captures nothing without a law firm id', () => {
    const { analytics } = load();

    analytics.captureServerEvent({ event: 'law_firm_created', lawFirmId: '' });

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('does not throw when the client throws', () => {
    mockCapture.mockImplementation(() => { throw new Error('posthog exploded'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { analytics } = load();

    expect(() => analytics.captureServerEvent({ event: 'law_firm_created', lawFirmId: FIRM })).not.toThrow();
    // The positive control: the throwing client really was reached.
    expect(mockCapture).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('flushes the client on graceful shutdown', async () => {
    mockShutdown.mockResolvedValue(undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { analytics, shutdown } = load();
    analytics.captureServerEvent({ event: 'law_firm_created', lawFirmId: FIRM });

    await shutdown.runShutdownHooks();

    expect(mockShutdown).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('has nothing to flush on shutdown when nothing was captured', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { shutdown } = load();

    await shutdown.runShutdownHooks();

    expect(mockConstructor).not.toHaveBeenCalled();
    expect(mockShutdown).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

// Account erasure removes the person from PostHog too. It must never be the
// reason an erasure fails, so it reports an outcome instead of throwing.
describe('deleteAnalyticsPerson', () => {
  const KEY_VAR = 'POSTHOG_PERSONAL_API_KEY';
  const PROJECT_VAR = 'POSTHOG_PROJECT_ID';
  const API_HOST_VAR = 'POSTHOG_API_HOST';
  const saved = { key: process.env[KEY_VAR], project: process.env[PROJECT_VAR], apiHost: process.env[API_HOST_VAR] };
  let fetchSpy: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env[KEY_VAR] = 'phx_secret';
    process.env[PROJECT_VAR] = '623394';
    delete process.env[API_HOST_VAR];
    fetchSpy = jest.spyOn(global, 'fetch');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warn.mockRestore();
    for (const [name, value] of [[KEY_VAR, saved.key], [PROJECT_VAR, saved.project], [API_HOST_VAR, saved.apiHost]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('asks PostHog to delete the person and their events', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const { analytics } = load();

    await expect(analytics.deleteAnalyticsPerson('uid-1')).resolves.toBe('deleted');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://us.posthog.com/api/projects/623394/persons/bulk_delete/');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer phx_secret' });
    expect(JSON.parse(init.body)).toEqual({ distinct_ids: ['uid-1'], delete_events: true, delete_recordings: true });
  });

  it('does nothing without a personal API key or project id', async () => {
    delete process.env[KEY_VAR];
    const { analytics } = load();

    await expect(analytics.deleteAnalyticsPerson('uid-1')).resolves.toBe('skipped');
    process.env[KEY_VAR] = 'phx_secret';
    delete process.env[PROJECT_VAR];
    await expect(analytics.deleteAnalyticsPerson('uid-1')).resolves.toBe('skipped');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a refused request without throwing', async () => {
    fetchSpy.mockResolvedValue(new Response('forbidden', { status: 403 }));
    const { analytics } = load();

    await expect(analytics.deleteAnalyticsPerson('uid-1')).resolves.toBe('failed');
    expect(warn).toHaveBeenCalled();
  });

  it('reports an unreachable PostHog without throwing', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    const { analytics } = load();

    await expect(analytics.deleteAnalyticsPerson('uid-1')).resolves.toBe('failed');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
