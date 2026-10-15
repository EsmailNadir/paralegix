/**
 * @jest-environment node
 */
/**
 * The last resort for a session 401: reload the page, ONCE.
 *
 * The property that matters is the "once". `apiFetch` calls this when a
 * refreshed token still gets a 401; if it reloaded every time, a backend that
 * keeps refusing the session would put the tab in an infinite reload loop. So
 * the second call must hand the caller its error back instead of reloading.
 *
 * Runs under the node environment because jsdom's `location.reload` is a
 * non-configurable property that cannot be replaced, and "did it reload" is the
 * assertion. A plain `window` with a fake `location` keeps the module's own
 * code path intact. `tests/setup.ts` mocks this module globally, hence the
 * unmock.
 */
jest.unmock('@/lib/utils/tokenRefreshHandler');

import { handleExpiredToken, resetRefreshState } from '@/lib/utils/tokenRefreshHandler';

const reload = jest.fn();

beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = { location: { reload } };
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

beforeEach(() => {
  resetRefreshState();
  reload.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('handleExpiredToken', () => {
  it('reloads the page on the first expired-token error and resolves', async () => {
    await expect(handleExpiredToken(new Error('401'))).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rethrows the caller\'s own error on a second call instead of reloading again', async () => {
    const second = new Error('still 401');

    await handleExpiredToken(new Error('401'));
    await expect(handleExpiredToken(second)).rejects.toBe(second);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses a concurrent second call the same way, so two failing requests reload once', async () => {
    const a = handleExpiredToken(new Error('a'));
    const errB = new Error('b');
    const b = handleExpiredToken(errB);

    await expect(a).resolves.toBeUndefined();
    await expect(b).rejects.toBe(errB);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rejects with the reload failure and still never reloads twice', async () => {
    const boom = new Error('reload blocked');
    reload.mockImplementationOnce(() => {
      throw boom;
    });

    await expect(handleExpiredToken(new Error('401'))).rejects.toBe(boom);
    const later = new Error('later');
    await expect(handleExpiredToken(later)).rejects.toBe(later);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('resetRefreshState', () => {
  it('re-arms the one reload', async () => {
    await handleExpiredToken(new Error('401'));
    resetRefreshState();
    await handleExpiredToken(new Error('401 again'));

    expect(reload).toHaveBeenCalledTimes(2);
  });
});
