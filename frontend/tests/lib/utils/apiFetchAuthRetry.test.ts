/**
 * The 401 path: refresh the token once, retry once, then reload as a last resort.
 *
 * Five outcomes live here and none had a test. They are not interchangeable:
 *
 *   - a 401 this layer cannot fix (an expired Google or Microsoft OAuth grant)
 *     must be handed straight back, so the caller can raise its own reconnect
 *     prompt. Refreshing the Firebase session would not help, and reloading the
 *     page over it would throw away the user's work for nothing.
 *   - a 401 about the session itself must trigger exactly one silent refresh and
 *     one retry, and the retry must carry the NEW credential.
 *   - no token back from the refresh, or a second session 401, escalates to a
 *     full page reload.
 *
 * Confusing any two of those is a user-visible bug: an infinite reload loop, a
 * lost draft, or a permanent 401 the user can only escape by signing out.
 */
jest.unmock('@/services/requestDeduplicator');

const reload = jest.fn();
jest.mock('@/lib/utils/tokenRefreshHandler', () => ({
  // Mocked because the real one calls `window.location.reload()`, which jsdom
  // does not implement, and because "did it decide to reload" is the assertion.
  handleExpiredToken: (...args: unknown[]) => reload(...args),
}));

const getIdToken = jest.fn();
jest.mock('@/lib/firebase/config', () => ({
  auth: {
    currentUser: {
      uid: 'test-uid',
      email: 'testuser@example.com',
      emailVerified: true,
      providerData: [],
      getIdToken: (force?: boolean) => getIdToken(force),
    },
  },
  db: {},
  storage: {},
}));

import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { clearTokenCache } from '@/lib/utils/auth';

import { setupApiMock, sequence } from '../../support/apiMock';

const URL_A = '/api/lawfirms/firm-a/clients';

const api = setupApiMock();

beforeEach(() => {
  reload.mockClear();
  getIdToken.mockReset();
  getIdToken.mockResolvedValue('token-1');
  clearTokenCache();
});

afterEach(() => {
  clearTokenCache();
});

describe('a 401 this layer cannot fix is handed back untouched', () => {
  it('does not refresh, retry, or reload for a provider credential', async () => {
    // A Google or Microsoft grant expiring answers 401 with its own code. The
    // Firebase session is fine, so refreshing it would waste a round trip and
    // reloading would destroy the page for a problem a reconnect button fixes.
    api.getExact(URL_A, { status: 401, body: { code: 'GOOGLE_TOKEN_EXPIRED' } });

    const response = await apiFetch(URL_A);

    expect(response.status).toBe(401);
    expect(api.calls()).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    expect(getIdToken).not.toHaveBeenCalledWith(true);
  });
});

describe('a session 401 is refreshed once and retried once', () => {
  it('retries with the NEW token and returns the retry response', async () => {
    getIdToken.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    api.getExact(URL_A, sequence(
      { status: 401, body: { code: 'TOKEN_EXPIRED' } },
      { status: 200, body: { clients: [{ id: 'after-refresh' }] } },
    ));

    const response = await apiFetch(URL_A);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: [{ id: 'after-refresh' }] });

    const [first, retry] = api.calls();
    expect(first.headers.authorization).toBe('Bearer token-1');
    // The point of the whole path. A retry that reused the stale credential
    // would 401 again and escalate to a reload the user did not need.
    expect(retry.headers.authorization).toBe('Bearer token-2');
    expect(api.calls()).toHaveLength(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('forces the refresh rather than reading the cached token', async () => {
    getIdToken.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    api.getExact(URL_A, sequence(
      { status: 401, body: { code: 'TOKEN_REVOKED' } },
      { status: 200, body: {} },
    ));

    await apiFetch(URL_A);

    // `getIdToken(true)` is what makes it a REFRESH. Called with false, the SDK
    // hands back the same expired token and the retry cannot succeed.
    expect(getIdToken).toHaveBeenCalledWith(true);
  });

  it('treats a 401 with no code at all as a session failure', async () => {
    // The conservative reading, and the one the code takes: an unlabelled 401
    // is assumed fixable, so the user gets a silent retry rather than an
    // immediate error.
    getIdToken.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    api.getExact(URL_A, sequence(
      { status: 401, body: { error: 'Unauthorized' } },
      { status: 200, body: { clients: [] } },
    ));

    const response = await apiFetch(URL_A);

    expect(response.status).toBe(200);
    expect(api.calls()).toHaveLength(2);
  });
});

describe('escalation to a reload, and the case that must NOT escalate', () => {
  it('reloads when the refresh yields no token', async () => {
    getIdToken.mockResolvedValueOnce('token-1').mockResolvedValueOnce(null);
    api.getExact(URL_A, { status: 401, body: { code: 'TOKEN_EXPIRED' } });

    const error = await apiFetch(URL_A).catch((e) => e);

    expect(error.code).toBe('AUTHENTICATION_FAILED');
    expect(error.status).toBe(401);
    expect(reload).toHaveBeenCalledTimes(1);
    // One attempt only. A retry with no credential would be a second pointless
    // round trip on a page that is about to reload.
    expect(api.calls()).toHaveLength(1);
  });

  it('reloads when a fresh token still gets a session 401', async () => {
    getIdToken.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    api.getExact(URL_A, { status: 401, body: { code: 'TOKEN_EXPIRED' } });

    const error = await apiFetch(URL_A).catch((e) => e);

    expect(error.code).toBe('AUTHENTICATION_EXPIRED');
    expect(reload).toHaveBeenCalledTimes(1);
    // Exactly two. A third attempt would be the start of a loop.
    expect(api.calls()).toHaveLength(2);
  });

  it('does NOT reload when the retry 401 is a provider credential', async () => {
    // The subtle one. The session refresh worked; the endpoint's own OAuth grant
    // is what is expired. Reloading cannot fix that, and doing it anyway would
    // put the user in a reload loop they cannot escape.
    getIdToken.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    api.getExact(URL_A, sequence(
      { status: 401, body: { code: 'TOKEN_EXPIRED' } },
      { status: 401, body: { code: 'MICROSOFT_TOKEN_EXPIRED' } },
    ));

    const response = await apiFetch(URL_A);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'MICROSOFT_TOKEN_EXPIRED' });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the sequence helper itself', () => {
  it('repeats its last response once the steps run out', async () => {
    api.getExact(URL_A, sequence({ status: 200, body: { step: 1 } }, { status: 200, body: { step: 2 } }));

    const bodies = [];
    for (let i = 0; i < 3; i += 1) {
      bodies.push(await (await apiFetch(URL_A)).json());
    }

    // Repeating rather than throwing lets a spec state only the steps it cares
    // about, instead of padding the list to match an unrelated retry count.
    expect(bodies).toEqual([{ step: 1 }, { step: 2 }, { step: 2 }]);
  });

  it('starts fresh for each sequence, so no count leaks between cases', async () => {
    // The counter lives in the closure, not on the route, which is what makes a
    // new sequence() per test self-resetting.
    api.getExact(URL_A, sequence({ status: 200, body: { step: 1 } }));
    expect(await (await apiFetch(URL_A)).json()).toEqual({ step: 1 });

    api.getExact(URL_A, sequence({ status: 200, body: { fresh: true } }));
    expect(await (await apiFetch(URL_A)).json()).toEqual({ fresh: true });
  });
});
