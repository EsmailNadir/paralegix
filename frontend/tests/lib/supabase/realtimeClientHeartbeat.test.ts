/**
 * `realtimeClient` against the REAL supabase-js client: the token a heartbeat
 * sends to open channels.
 *
 * supabase-js always hands its realtime client an `accessToken` callback. With
 * no callback of ours, that callback asks Supabase Auth for a session, finds
 * none (Firebase is the identity provider), and answers with the anon key. The
 * realtime client re-runs the callback on every heartbeat and pushes whatever it
 * returns to every joined channel, so the messaging JWT injected by
 * `authorizeRealtime()` was replaced by the anon key about 25 seconds after it
 * was installed, and RLS-protected channels stopped delivering changes.
 *
 * The supabase-js module is deliberately NOT mocked here. The defect lives in
 * how that library resolves the token, so a mocked client cannot show it.
 */
jest.mock('@/lib/utils/auth', () => ({
  getFirebaseToken: jest.fn().mockResolvedValue('firebase-id-token'),
}));

type RealtimeModule = typeof import('@/lib/supabase/realtimeClient');

/** The parts of realtime-js's client these specs read or drive. */
interface RealtimeInternals {
  accessTokenValue: string | null;
  heartbeatCallback: (status: string, latency?: number) => void;
}

const TOKEN_TTL_SECONDS = 15 * 60;
const MINUTE = 60_000;

let realtime: RealtimeModule;
let fetchMock: jest.Mock;
let tokenCounter = 0;
let retained = 0;
// When set, the next token request waits until the spec resolves it.
let holdNextTokenRequest: Promise<void> | null = null;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function socket(): RealtimeInternals {
  const client = realtime.getRealtimeClient();
  if (!client) throw new Error('realtime client was not created');
  return client.realtime as unknown as RealtimeInternals;
}

/** Run the realtime client's own heartbeat hook, as its socket does every 25 s. */
async function heartbeat(): Promise<void> {
  socket().heartbeatCallback('sent');
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-17T12:00:00Z'));
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  tokenCounter = 0;
  holdNextTokenRequest = null;
  fetchMock = jest.fn(async () => {
    tokenCounter += 1;
    const token = `realtime-token-${tokenCounter}`;
    if (holdNextTokenRequest) {
      const hold = holdNextTokenRequest;
      holdNextTokenRequest = null;
      await hold;
    }
    return { ok: true, json: async () => ({ token, expiresIn: TOKEN_TTL_SECONDS }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.isolateModules(() => {
    realtime = require('@/lib/supabase/realtimeClient');
  });
});

afterEach(() => {
  for (; retained > 0; retained -= 1) realtime.releaseRealtime();
  jest.useRealTimers();
});

async function startSubscriber(): Promise<void> {
  realtime.retainRealtime();
  retained += 1;
  await realtime.authorizeRealtime();
  await flush();
}

describe('heartbeat token refresh', () => {
  it('keeps the messaging JWT on the socket instead of replacing it with the anon key', async () => {
    await startSubscriber();
    expect(socket().accessTokenValue).toBe('realtime-token-1');

    await heartbeat();
    await heartbeat();

    expect(socket().accessTokenValue).toBe('realtime-token-1');
  });

  it('sends the refreshed JWT once a new one is installed', async () => {
    await startSubscriber();

    jest.advanceTimersByTime(10 * MINUTE);
    await flush();
    await heartbeat();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(socket().accessTokenValue).toBe('realtime-token-2');
  });

  it('keeps the current JWT while a refresh is still in flight', async () => {
    await startSubscriber();
    let release: () => void = () => {};
    holdNextTokenRequest = new Promise<void>((resolve) => {
      release = resolve;
    });

    jest.advanceTimersByTime(10 * MINUTE);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await heartbeat();
    expect(socket().accessTokenValue).toBe('realtime-token-1');

    release();
    await flush();
    await heartbeat();
    expect(socket().accessTokenValue).toBe('realtime-token-2');
  });
});
