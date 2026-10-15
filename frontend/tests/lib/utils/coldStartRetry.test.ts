/**
 * The cold-start retry, tested by what it REFUSES to retry.
 *
 * The backend runs with `min-instances=0`, so the first request after an idle
 * period waits for a container to boot. That produces two failures and only two:
 * the client's deadline expires mid-boot, or nothing is listening yet. Retrying
 * those is free, because the failed attempt is what started the container.
 *
 * Retrying anything ELSE is not free. A 403, a 404 and a 500 are answers from a
 * server that is already up; running them twice doubles the load and returns the
 * same verdict. So the cases below that assert a SINGLE call matter more than the
 * ones that assert two: the helper's value is in the line it draws, and a version
 * of it that retried every failure would pass the happy-path cases untouched.
 */
import { retryOnColdStart, isColdStartError } from '@/lib/utils/coldStartRetry';
import {
  ApiError,
  NETWORK_UNREACHABLE_CODE,
  REQUEST_TIMEOUT_CODE,
} from '@/lib/utils/apiErrors';

const coldStart = (code: string) => new ApiError('cold', { status: 0, code });

/** No pause, so the assertions read without timer plumbing. Timing has its own case. */
const NO_DELAY = 0;

describe('what counts as a cold start', () => {
  it('recognises the two failures a booting container produces', () => {
    expect(isColdStartError(coldStart(REQUEST_TIMEOUT_CODE))).toBe(true);
    expect(isColdStartError(coldStart(NETWORK_UNREACHABLE_CODE))).toBe(true);
  });

  it('does not count an answer from a server that is already up', () => {
    expect(isColdStartError(new ApiError('Forbidden', { status: 403 }))).toBe(false);
    expect(isColdStartError(new ApiError('Server error', { status: 500 }))).toBe(false);
    expect(isColdStartError(new ApiError('Rate limited', { status: 429 }))).toBe(false);
  });

  it('does not count a failure that is not an ApiError at all', () => {
    expect(isColdStartError(new Error('Failed to fetch'))).toBe(false);
    expect(isColdStartError('timeout')).toBe(false);
    expect(isColdStartError(null)).toBe(false);
  });
});

describe('retryOnColdStart', () => {
  it('runs the request once when it works', async () => {
    const run = jest.fn().mockResolvedValue({ id: 'firm-1' });

    await expect(retryOnColdStart(run, NO_DELAY)).resolves.toEqual({ id: 'firm-1' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a deadline that expired during boot', REQUEST_TIMEOUT_CODE],
    ['nothing listening yet', NETWORK_UNREACHABLE_CODE],
  ])('recovers from %s', async (_label, code) => {
    const run = jest.fn()
      .mockRejectedValueOnce(coldStart(code))
      .mockResolvedValueOnce({ id: 'firm-1' });

    await expect(retryOnColdStart(run, NO_DELAY)).resolves.toEqual({ id: 'firm-1' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a refusal the server already decided', async () => {
    const forbidden = new ApiError('Forbidden', { status: 403 });
    const run = jest.fn().mockRejectedValue(forbidden);

    await expect(retryOnColdStart(run, NO_DELAY)).rejects.toBe(forbidden);
    // The point of the whole helper. A second attempt cannot change a permission
    // answer, and asking again would show the user a longer wait for the same no.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a plain Error', async () => {
    const boom = new Error('kaboom');
    const run = jest.fn().mockRejectedValue(boom);

    await expect(retryOnColdStart(run, NO_DELAY)).rejects.toBe(boom);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry instead of looping on a server that stays down', async () => {
    const second = coldStart(REQUEST_TIMEOUT_CODE);
    const run = jest.fn()
      .mockRejectedValueOnce(coldStart(REQUEST_TIMEOUT_CODE))
      .mockRejectedValueOnce(second);

    // The caller sees the SECOND failure, so the page reports the state of the
    // last attempt rather than a stale one from before the retry.
    await expect(retryOnColdStart(run, NO_DELAY)).rejects.toBe(second);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('waits before retrying, rather than firing again immediately', async () => {
    jest.useFakeTimers();
    try {
      const run = jest.fn()
        .mockRejectedValueOnce(coldStart(NETWORK_UNREACHABLE_CODE))
        .mockResolvedValueOnce({ id: 'firm-1' });

      const settled = retryOnColdStart(run, 1000);

      // Let the rejection propagate without letting the delay elapse. An
      // immediate retry would hit a container that is still starting, and turn
      // one wasted request into two.
      await jest.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      await expect(settled).resolves.toEqual({ id: 'firm-1' });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
