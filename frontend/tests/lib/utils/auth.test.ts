/**
 * The Firebase ID-token cache every API call reads its bearer token from.
 *
 * The case that matters most is the user switch: two people on one browser,
 * one signs out and the other signs in. A cache that kept the first person's
 * token would send every request of the second person under the first
 * person's identity, which the backend would honour. The cache is keyed on the
 * uid for exactly that reason, and the first spec below goes red if it is not.
 *
 * The rest pin the cache window, the forced refresh, the wait for Firebase to
 * restore a session on a cold page load, and the failure paths (a refresh that
 * throws must not leave a stale token cached).
 */
type FakeUser = { uid: string; getIdToken: jest.Mock };

const mockFirebase: { auth: { currentUser: FakeUser | null } | null } = {
  auth: { currentUser: null },
};
jest.mock('@/lib/firebase/config', () => ({
  get auth() {
    return mockFirebase.auth;
  },
}));

// Firebase delivers the first auth-state callback asynchronously, after
// `onAuthStateChanged` has returned its unsubscribe. The fake keeps the
// callbacks so a spec decides when (and with whom) the session is restored.
const mockAuthListeners: ((user: FakeUser | null) => void)[] = [];
const mockUnsubscribe = jest.fn();
jest.mock('firebase/auth', () => ({
  onAuthStateChanged: jest.fn((_auth: unknown, cb: (user: FakeUser | null) => void) => {
    mockAuthListeners.push(cb);
    return mockUnsubscribe;
  }),
}));

import {
  clearTokenCache,
  getFirebaseToken,
  getFirebaseUid,
  isAuthenticated,
  refreshToken,
  requireFirebaseToken,
} from '@/lib/utils/auth';

const FIVE_MINUTES = 5 * 60 * 1000;

function user(uid: string, ...tokens: string[]): FakeUser {
  const getIdToken = jest.fn();
  for (const t of tokens) getIdToken.mockResolvedValueOnce(t);
  return { uid, getIdToken };
}

/** Let the dynamic imports inside `waitForAuthReady` settle and subscribe. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

let now: number;

beforeEach(() => {
  clearTokenCache();
  mockAuthListeners.length = 0;
  mockUnsubscribe.mockClear();
  mockFirebase.auth = { currentUser: null };
  now = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getFirebaseToken cache', () => {
  it('never hands one user the token cached for another', async () => {
    const alice = user('alice', 'alice-token-1');
    const bob = user('bob', 'bob-token-1');

    mockFirebase.auth!.currentUser = alice;
    await expect(getFirebaseToken()).resolves.toBe('alice-token-1');

    // Bob signs in on the same browser well inside Alice's cache window.
    mockFirebase.auth!.currentUser = bob;
    now += 1000;
    await expect(getFirebaseToken()).resolves.toBe('bob-token-1');
    expect(bob.getIdToken).toHaveBeenCalledTimes(1);
  });

  it('serves the cached token for five minutes without asking Firebase again', async () => {
    const alice = user('alice', 'token-1', 'token-2');
    mockFirebase.auth!.currentUser = alice;

    await expect(getFirebaseToken()).resolves.toBe('token-1');
    now += FIVE_MINUTES - 1;
    await expect(getFirebaseToken()).resolves.toBe('token-1');
    expect(alice.getIdToken).toHaveBeenCalledTimes(1);
    expect(alice.getIdToken).toHaveBeenCalledWith(false);
  });

  it('asks Firebase again once the five-minute window has passed', async () => {
    const alice = user('alice', 'token-1', 'token-2');
    mockFirebase.auth!.currentUser = alice;

    await getFirebaseToken();
    now += FIVE_MINUTES;
    await expect(getFirebaseToken()).resolves.toBe('token-2');
    expect(alice.getIdToken).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache and forces Firebase to mint a new token on forceRefresh', async () => {
    const alice = user('alice', 'token-1', 'token-2');
    mockFirebase.auth!.currentUser = alice;

    await getFirebaseToken();
    await expect(getFirebaseToken(true)).resolves.toBe('token-2');
    expect(alice.getIdToken).toHaveBeenLastCalledWith(true);
    // And the forced token is what the cache now holds.
    await expect(getFirebaseToken()).resolves.toBe('token-2');
    expect(alice.getIdToken).toHaveBeenCalledTimes(2);
  });

  it('returns null when Firebase fails to produce a token, and does not cache the failure', async () => {
    const alice = user('alice', 'token-1');
    alice.getIdToken.mockReset();
    alice.getIdToken
      .mockRejectedValueOnce(new Error('auth/network-request-failed'))
      .mockResolvedValueOnce('token-after-recovery');
    mockFirebase.auth!.currentUser = alice;

    await expect(getFirebaseToken()).resolves.toBeNull();
    await expect(getFirebaseToken()).resolves.toBe('token-after-recovery');
  });

  it('drops a cached token after a refresh fails, rather than serving the old one', async () => {
    const alice = user('alice', 'token-1');
    alice.getIdToken.mockRejectedValueOnce(new Error('revoked'));
    alice.getIdToken.mockResolvedValueOnce('token-3');
    mockFirebase.auth!.currentUser = alice;

    await expect(getFirebaseToken()).resolves.toBe('token-1');
    await expect(getFirebaseToken(true)).resolves.toBeNull();
    // Inside the window, but the cache was cleared by the failure.
    await expect(getFirebaseToken()).resolves.toBe('token-3');
  });

  it('returns null when Firebase is not initialised at all', async () => {
    mockFirebase.auth = null;
    await expect(getFirebaseToken()).resolves.toBeNull();
  });
});

describe('getFirebaseToken on a cold page load', () => {
  it('waits for Firebase to restore the session instead of reporting signed out', async () => {
    const restored = user('alice', 'restored-token');

    const pending = getFirebaseToken();
    await flush();
    expect(mockAuthListeners).toHaveLength(1);
    mockAuthListeners[0](restored);

    await expect(pending).resolves.toBe('restored-token');
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('returns null when the restored session is nobody', async () => {
    const pending = getFirebaseToken();
    await flush();
    mockAuthListeners[0](null);

    await expect(pending).resolves.toBeNull();
  });

  it('subscribes once for concurrent callers and answers them all from the same restore', async () => {
    const restored = user('alice', 'shared-token', 'unused');
    restored.getIdToken.mockReset();
    restored.getIdToken.mockResolvedValue('shared-token');

    const a = getFirebaseToken();
    const b = getFirebaseUid();
    await flush();
    expect(mockAuthListeners).toHaveLength(1);
    mockAuthListeners[0](restored);

    await expect(a).resolves.toBe('shared-token');
    await expect(b).resolves.toBe('alice');
  });

  it('re-subscribes after clearTokenCache, so a later sign-in is not answered by an old restore', async () => {
    const first = getFirebaseToken();
    await flush();
    mockAuthListeners[0](null);
    await expect(first).resolves.toBeNull();

    clearTokenCache();
    const second = getFirebaseToken();
    await flush();
    expect(mockAuthListeners).toHaveLength(2);
    mockAuthListeners[1](user('bob', 'bob-token'));
    await expect(second).resolves.toBe('bob-token');
  });
});

describe('requireFirebaseToken', () => {
  it('returns the token when signed in', async () => {
    mockFirebase.auth!.currentUser = user('alice', 'token-1');
    await expect(requireFirebaseToken()).resolves.toBe('token-1');
  });

  it('throws "User is not authenticated" when there is no token', async () => {
    mockFirebase.auth = null;
    await expect(requireFirebaseToken()).rejects.toThrow('User is not authenticated');
  });
});

describe('refreshToken', () => {
  it('discards the cached token and forces a fresh one', async () => {
    const alice = user('alice', 'token-1', 'token-2');
    mockFirebase.auth!.currentUser = alice;

    await getFirebaseToken();
    await expect(refreshToken()).resolves.toBe('token-2');
    expect(alice.getIdToken).toHaveBeenLastCalledWith(true);
  });
});

describe('getFirebaseUid', () => {
  it('returns the signed-in uid', async () => {
    mockFirebase.auth!.currentUser = user('alice');
    await expect(getFirebaseUid()).resolves.toBe('alice');
  });

  it('returns null when Firebase is not initialised', async () => {
    mockFirebase.auth = null;
    await expect(getFirebaseUid()).resolves.toBeNull();
  });
});

describe('isAuthenticated', () => {
  it('is true with a current user and false with none', async () => {
    mockFirebase.auth!.currentUser = user('alice');
    await expect(isAuthenticated()).resolves.toBe(true);

    mockFirebase.auth!.currentUser = null;
    await expect(isAuthenticated()).resolves.toBe(false);
  });

  it('answers false when Firebase is not initialised', async () => {
    // With `auth: null` (server side, or a failed init) there is no session to
    // speak of. A bare `?.currentUser !== null` read that as `undefined !== null`.
    mockFirebase.auth = null;
    await expect(isAuthenticated()).resolves.toBe(false);
  });
});
