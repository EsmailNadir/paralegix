/**
 * The Credence ID Cloud SDK client: token caching, headers and error mapping.
 *
 * `global.fetch` is replaced per test, so nothing leaves the process. Every
 * assertion names a request the client actually sent, which is what makes a
 * refactor that skips the cache or drops a header go red.
 */
import {
  __resetCredenceTokenCache,
  getDocRequest,
  isCredenceConfigured,
  pollW3c,
} from '../../src/modules/identityVerification/credence.client';

const LICENSE = 'CS-test-license-not-real';
const ORIGIN = 'https://staging.example.test';

type Sent = { url: string; headers: Record<string, string>; body: any };

let sent: Sent[] = [];
const realFetch = global.fetch;
const savedEnv = { ...process.env };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body == null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Install a fetch double that answers by path and records every request. */
function routeFetch(routes: Record<string, (body: any) => Response | Promise<Response>>) {
  global.fetch = jest.fn(async (input: any, init: any) => {
    const url = String(input);
    const path = url.replace('https://credence.example.test/sdk', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url, headers: { ...(init?.headers || {}) }, body });
    const route = routes[path];
    if (!route) throw new Error(`unexpected request to ${path}`);
    return route(body);
  }) as any;
}

const tokens = (accessToken: string, expiresIn = 3600) => ({
  accessToken,
  refreshToken: `refresh-${accessToken}`,
  expiresIn,
  tokenType: 'Bearer',
  customerName: 'Test',
  profileName: 'Test',
});

const docRequest = { sessionId: 'sess-1', dcRequest: { deviceRequest: 'dr', encryptionInfo: 'ei' } };

beforeEach(() => {
  sent = [];
  process.env.CREDENCE_BASE_URL = 'https://credence.example.test/sdk/';
  process.env.CREDENCE_LICENSE_KEY = LICENSE;
  process.env.CREDENCE_PROFILE_ID = '00000000-0000-4000-8000-000000000001';
  process.env.CREDENCE_ORIGIN = ORIGIN;
  __resetCredenceTokenCache();
});

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
  process.env = { ...savedEnv };
});

const paths = () => sent.map((s) => s.url.replace('https://credence.example.test/sdk', ''));

describe('credence client', () => {
  it('two concurrent calls share one /v1/setup', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    routeFetch({
      '/v1/setup': async () => { await gate; return jsonResponse(200, tokens('tok-a')); },
      '/v1/getDocRequest': () => jsonResponse(200, docRequest),
    });

    const both = Promise.all([getDocRequest(), getDocRequest()]);
    // Both callers are now waiting on the one setup request.
    await new Promise((r) => setImmediate(r));
    release();
    await both;

    expect(paths().filter((p) => p === '/v1/setup')).toHaveLength(1);
    expect(paths().filter((p) => p === '/v1/getDocRequest')).toHaveLength(2);
  });

  it('an access token within 60 s of expiry is refreshed, not set up again', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-13T12:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
    routeFetch({
      '/v1/setup': () => jsonResponse(200, tokens('tok-a', 120)),
      '/v1/refresh': () => jsonResponse(200, tokens('tok-b')),
      '/v1/getDocRequest': () => jsonResponse(200, docRequest),
    });

    await getDocRequest();
    // 120 s token, 70 s later: 50 s left, inside the 60 s skew.
    jest.setSystemTime(new Date('2026-10-13T12:01:10Z'));
    await getDocRequest();

    expect(paths()).toEqual(['/v1/setup', '/v1/getDocRequest', '/v1/refresh', '/v1/getDocRequest']);
    expect(sent[2].body).toEqual({ refreshToken: 'refresh-tok-a' });
    expect(sent[3].headers.Authorization).toBe('Bearer tok-b');
  });

  it('a failed refresh falls back to /v1/setup', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-13T12:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
    routeFetch({
      '/v1/setup': (() => {
        let n = 0;
        return () => { n += 1; return jsonResponse(200, tokens(`tok-${n}`, 120)); };
      })(),
      '/v1/refresh': () => jsonResponse(401, { error: 'expired' }),
      '/v1/getDocRequest': () => jsonResponse(200, docRequest),
    });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});

    await getDocRequest();
    jest.setSystemTime(new Date('2026-10-13T12:01:10Z'));
    await getDocRequest();
    quiet.mockRestore();

    expect(paths()).toEqual([
      '/v1/setup', '/v1/getDocRequest', '/v1/refresh', '/v1/setup', '/v1/getDocRequest',
    ]);
    expect(sent[4].headers.Authorization).toBe('Bearer tok-2');
  });

  it('sends Origin on every call and Authorization on authenticated ones', async () => {
    routeFetch({
      '/v1/setup': () => jsonResponse(200, tokens('tok-a')),
      '/v1/getDocRequest': () => jsonResponse(200, docRequest),
    });

    await getDocRequest();

    expect(sent.map((s) => s.headers.Origin)).toEqual([ORIGIN, ORIGIN]);
    expect(sent[0].headers.Authorization).toBeUndefined();
    expect(sent[0].body).toEqual({ licenseKey: LICENSE, profileId: process.env.CREDENCE_PROFILE_ID });
    expect(sent[1].headers.Authorization).toBe('Bearer tok-a');
  });

  it('maps 403 DOMAIN_MISMATCH to IDENTITY_PROVIDER_DOMAIN (503)', async () => {
    routeFetch({ '/v1/setup': () => jsonResponse(403, { code: 'DOMAIN_MISMATCH' }) });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});

    const err: any = await getDocRequest().catch((e) => e);
    quiet.mockRestore();

    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('IDENTITY_PROVIDER_DOMAIN');
  });

  it('never puts the license key in a thrown error, even when the provider echoes it', async () => {
    routeFetch({
      '/v1/setup': (body) => jsonResponse(400, { error: `bad license ${body.licenseKey}` }),
    });
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: any[]) => { logged.push(args.join(' ')); });

    const err: any = await getDocRequest().catch((e) => e);
    spy.mockRestore();

    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('IDENTITY_PROVIDER_ERROR');
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(LICENSE);
    // The provider body is logged for us, with the key redacted.
    expect(logged.join('\n')).not.toContain(LICENSE);
  });

  it('pollW3c answers null while the wallet has not responded (202)', async () => {
    routeFetch({
      '/v1/setup': () => jsonResponse(200, tokens('tok-a')),
      '/w3c/openid4vp/v1/validate': () => jsonResponse(202, null),
    });

    await expect(pollW3c('sess-w3c')).resolves.toBeNull();
    expect(sent[1].body).toEqual({ sessionId: 'sess-w3c' });
  });

  it('answers 503 IDENTITY_VERIFICATION_UNCONFIGURED without calling out when config is missing', async () => {
    delete process.env.CREDENCE_LICENSE_KEY;
    routeFetch({});

    const err: any = await getDocRequest().catch((e) => e);

    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('IDENTITY_VERIFICATION_UNCONFIGURED');
    expect(sent).toHaveLength(0);
    expect(isCredenceConfigured()).toBe(false);
  });
});
