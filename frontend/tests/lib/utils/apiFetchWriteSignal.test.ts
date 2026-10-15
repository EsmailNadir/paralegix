/**
 * `apiFetch` announces every successful write.
 *
 * The firm QueryClient keeps data fresh for two minutes and no longer refetches
 * on window focus, and many screens change data with an imperative service call
 * that invalidates nothing. The write announcement is what lets the firm layout
 * mark its cache stale, so a screen remounted after the user's own edit re-reads
 * instead of showing the value from before the edit.
 *
 * What has to break for these to go red: drop the emit from `apiFetch`, emit for
 * a read (which would throw away the cache on every page load), or emit for a
 * write the server refused (nothing changed, so nothing should go stale).
 */
jest.mock('@/lib/utils/auth', () => ({
  __esModule: true,
  getFirebaseToken: jest.fn().mockResolvedValue('test-token'),
  clearTokenCache: jest.fn(),
}));

import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { onApiWrite } from '@/lib/utils/apiWriteSignal';

function responseWith(status: number, body: unknown = {}) {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    clone: () => ({ json: async () => body, text: async () => JSON.stringify(body) }),
    json: async () => body,
  };
  return response as unknown as Response;
}

const URL = 'https://api.example.com/api/lawfirms/firm-1/matters/m-1';

let unsubscribe: (() => void) | null = null;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  jest.restoreAllMocks();
});

describe('apiFetch write signal', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('announces a successful %s with its method and url', async (method) => {
    global.fetch = jest.fn().mockResolvedValue(responseWith(200)) as any;
    const listener = jest.fn();
    unsubscribe = onApiWrite(listener);

    await apiFetch(URL, { method });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ method, url: URL });
  });

  it('treats a lower-case method as the same write', async () => {
    global.fetch = jest.fn().mockResolvedValue(responseWith(204)) as any;
    const listener = jest.fn();
    unsubscribe = onApiWrite(listener);

    await apiFetch(URL, { method: 'delete' });

    expect(listener).toHaveBeenCalledWith({ method: 'DELETE', url: URL });
  });

  it('does not announce a read', async () => {
    global.fetch = jest.fn().mockResolvedValue(responseWith(200)) as any;
    const listener = jest.fn();
    unsubscribe = onApiWrite(listener);

    await apiFetch(URL);
    await apiFetch(URL, { method: 'GET' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 409, 500])('does not announce a write the server answered %i', async (status) => {
    global.fetch = jest.fn().mockResolvedValue(responseWith(status, { error: 'no' })) as any;
    const listener = jest.fn();
    unsubscribe = onApiWrite(listener);

    await apiFetch(URL, { method: 'POST' }).catch(() => undefined);

    expect(global.fetch).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
