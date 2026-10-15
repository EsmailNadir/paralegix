/**
 * `apiFetch` is where a 402 becomes a workspace-wide lock.
 *
 * The paywall used to depend entirely on the billing status the layout fetched
 * at mount. When that went stale mid-session - a trial ending, a webhook landing
 * late, a plan cancelled in another tab - nothing told the client, and each page
 * painted the same 402 as its own red banner over a workspace the backend had
 * already closed.
 *
 * What has to break for these to go red: drop the 402 branch from `apiFetch`,
 * emit for the wrong statuses, stop reading the status out of the body, or
 * consume the response body so the caller can no longer read it.
 */
jest.mock('@/lib/utils/auth', () => ({
  __esModule: true,
  getFirebaseToken: jest.fn().mockResolvedValue('test-token'),
  clearTokenCache: jest.fn(),
}));

import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { onBillingLock } from '@/lib/plans/billingLockSignal';

/**
 * A stand-in for `Response`. `apiFetch` reaches `.status`, and `readErrorBody`
 * reaches `.clone().json()`. Building a real Response would drag whatwg-fetch
 * into a jsdom environment that does not need it.
 */
function responseWith(status: number, body: unknown) {
  const response = {
    status,
    ok: status < 400,
    headers: { get: () => null },
    clone: () => ({ json: async () => body, text: async () => JSON.stringify(body) }),
    json: async () => body,
  };
  return response as unknown as Response;
}

const BILLING_402 = {
  error: "This firm's subscription is inactive.",
  code: 'BILLING_INACTIVE',
  details: { billingStatus: 'past_due' },
};

let unsubscribe: (() => void) | null = null;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  jest.restoreAllMocks();
});

describe('apiFetch billing lock signal', () => {
  it('announces a 402, naming the firm and the status', async () => {
    global.fetch = jest.fn().mockResolvedValue(responseWith(402, BILLING_402)) as any;
    const listener = jest.fn();
    unsubscribe = onBillingLock(listener);

    await apiFetch('https://api.example.com/api/lawfirms/firm-1/tasks');

    expect(listener).toHaveBeenCalledWith({ lawFirmId: 'firm-1', billingStatus: 'past_due' });
  });

  it('hands the 402 response back unread so the caller still throws its own error', async () => {
    global.fetch = jest.fn().mockResolvedValue(responseWith(402, BILLING_402)) as any;
    unsubscribe = onBillingLock(jest.fn());

    const response = await apiFetch('https://api.example.com/api/lawfirms/firm-1/tasks');

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual(BILLING_402);
  });

  it('announces a 402 whose body carries no status', async () => {
    global.fetch = jest.fn().mockResolvedValue(responseWith(402, { error: 'inactive' })) as any;
    const listener = jest.fn();
    unsubscribe = onBillingLock(listener);

    await apiFetch('https://api.example.com/api/lawfirms/firm-9/matters');

    expect(listener).toHaveBeenCalledWith({ lawFirmId: 'firm-9', billingStatus: null });
  });

  it('stays quiet for every other status', async () => {
    const listener = jest.fn();
    unsubscribe = onBillingLock(listener);

    for (const status of [200, 403, 404, 500]) {
      global.fetch = jest.fn().mockResolvedValue(responseWith(status, { error: 'x' })) as any;
      await apiFetch('https://api.example.com/api/lawfirms/firm-1/tasks');
    }

    expect(listener).not.toHaveBeenCalled();
  });
});
