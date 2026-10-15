/**
 * `realtimeClient`: the one Supabase Realtime JWT shared by every subscriber.
 *
 * What is pinned here is request volume and recovery, neither of which shows on
 * screen:
 * - concurrent authorizations share ONE token request
 * - the refresh timer does not run while the tab is hidden, so a background tab
 *   stops minting a token every ten minutes
 * - on becoming visible the token is refreshed only when it is inside the
 *   refresh window or already expired
 * - when it expired while hidden, resume listeners are told once, because the
 *   server drops a channel whose token lapsed and its subscriber must reopen it
 */
import { resetPageVisibility, setPageVisibility } from '../../support/pageVisibility';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    realtime: { setAuth: jest.fn().mockResolvedValue(undefined) },
  })),
}));

jest.mock('@/lib/utils/auth', () => ({
  getFirebaseToken: jest.fn().mockResolvedValue('firebase-id-token'),
}));

type RealtimeModule = typeof import('@/lib/supabase/realtimeClient');

const TOKEN_TTL_SECONDS = 15 * 60;
const MINUTE = 60_000;

let realtime: RealtimeModule;
let fetchMock: jest.Mock;
let tokenCounter = 0;
// Subscribers a spec retained and has not released. Each spec loads a fresh copy
// of the module, but a retained copy keeps its `visibilitychange` listener on the
// shared `document`, so it would answer the next spec's visibility changes.
let retained = 0;

function tokenRequests(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messaging/realtime-token')).length;
}

/** Let pending promise continuations (the token fetch chain) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  tokenCounter = 0;
  fetchMock = jest.fn(async () => {
    tokenCounter += 1;
    return {
      ok: true,
      json: async () => ({ token: `realtime-token-${tokenCounter}`, expiresIn: TOKEN_TTL_SECONDS }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.isolateModules(() => {
    realtime = require('@/lib/supabase/realtimeClient');
  });
});

afterEach(() => {
  for (; retained > 0; retained -= 1) realtime.releaseRealtime();
  jest.useRealTimers();
  resetPageVisibility();
});

async function startSubscriber(): Promise<void> {
  realtime.retainRealtime();
  retained += 1;
  await realtime.authorizeRealtime();
}

describe('token request coalescing', () => {
  it('shares one request between concurrent callers', async () => {
    const results = await Promise.all([
      realtime.authorizeRealtime(),
      realtime.authorizeRealtime(),
      realtime.authorizeRealtime(),
    ]);

    expect(tokenRequests()).toBe(1);
    expect(results.every((client) => client === results[0] && client !== null)).toBe(true);
  });

  it('reuses the token for a subscriber that mounts after it resolved', async () => {
    await startSubscriber();
    await startSubscriber();

    expect(tokenRequests()).toBe(1);
  });
});

describe('refresh timer', () => {
  it('refreshes before expiry while the tab is visible', async () => {
    await startSubscriber();

    jest.advanceTimersByTime(10 * MINUTE);
    await flush();

    expect(tokenRequests()).toBe(2);
  });

  it('does not refresh while the tab is hidden', async () => {
    await startSubscriber();

    setPageVisibility('hidden');
    jest.advanceTimersByTime(60 * MINUTE);
    await flush();

    expect(tokenRequests()).toBe(1);
  });

  it('does not arm a refresh for a token fetched while hidden', async () => {
    setPageVisibility('hidden');
    await startSubscriber();

    jest.advanceTimersByTime(60 * MINUTE);
    await flush();

    expect(tokenRequests()).toBe(1);
  });
});

describe('becoming visible', () => {
  it('refreshes immediately and re-authorizes the socket when the token is inside the refresh window', async () => {
    await startSubscriber();
    const client = realtime.getRealtimeClient() as unknown as { realtime: { setAuth: jest.Mock } };

    setPageVisibility('hidden');
    jest.advanceTimersByTime(12 * MINUTE);
    await flush();
    // Nothing is refreshed until the tab is looked at again.
    expect(tokenRequests()).toBe(1);

    setPageVisibility('visible');
    await flush();

    expect(tokenRequests()).toBe(2);
    expect(client.realtime.setAuth).toHaveBeenLastCalledWith('realtime-token-2');
  });

  it('does not refresh when the token is still fresh, and re-arms the timer', async () => {
    await startSubscriber();

    setPageVisibility('hidden');
    jest.advanceTimersByTime(3 * MINUTE);
    setPageVisibility('visible');
    await flush();
    expect(tokenRequests()).toBe(1);

    // The timer was cleared while hidden; visible again it must still fire
    // before the refresh window closes.
    jest.advanceTimersByTime(7 * MINUTE);
    await flush();
    expect(tokenRequests()).toBe(2);
  });

  it('does nothing once every subscriber has released', async () => {
    await startSubscriber();
    realtime.releaseRealtime();
    retained -= 1;

    setPageVisibility('hidden');
    jest.advanceTimersByTime(30 * MINUTE);
    setPageVisibility('visible');
    await flush();

    expect(tokenRequests()).toBe(1);
  });
});

describe('resume listeners', () => {
  it('fire once, after the new token is installed, when the token expired while hidden', async () => {
    await startSubscriber();
    const client = realtime.getRealtimeClient() as unknown as { realtime: { setAuth: jest.Mock } };
    const tokenAtResume: string[] = [];
    realtime.onRealtimeResume(() => {
      tokenAtResume.push(client.realtime.setAuth.mock.calls.at(-1)?.[0]);
    });

    setPageVisibility('hidden');
    jest.advanceTimersByTime(20 * MINUTE);
    setPageVisibility('visible');
    await flush();

    expect(tokenRequests()).toBe(2);
    expect(tokenAtResume).toEqual(['realtime-token-2']);
  });

  it('do not fire when the token was refreshed before it expired', async () => {
    await startSubscriber();
    const listener = jest.fn();
    realtime.onRealtimeResume(listener);

    setPageVisibility('hidden');
    jest.advanceTimersByTime(12 * MINUTE);
    setPageVisibility('visible');
    await flush();

    expect(tokenRequests()).toBe(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stop firing once unsubscribed', async () => {
    await startSubscriber();
    const listener = jest.fn();
    const unsubscribe = realtime.onRealtimeResume(listener);
    unsubscribe();

    setPageVisibility('hidden');
    jest.advanceTimersByTime(20 * MINUTE);
    setPageVisibility('visible');
    await flush();

    expect(listener).not.toHaveBeenCalled();
  });
});
