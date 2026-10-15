import { isTransientError, retryOnTransient } from '../../src/shared/utils/retryTransient';

describe('transient retry utilities', () => {
  it.each([
    [{ code: 'ECONNRESET' }],
    [{ errno: 'ETIMEDOUT' }],
    [{ cause: { message: 'socket hang up' } }],
    [{ response: { data: { code: 'EAI_AGAIN' } } }],
  ])('recognizes %p as transient', (error) => {
    expect(isTransientError(error)).toBe(true);
  });

  it('does not classify ordinary application errors as transient', () => {
    expect(isTransientError(new Error('invalid invoice'))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });

  it('retries transient errors with linear backoff and returns the eventual value', async () => {
    jest.useFakeTimers();
    const operation = jest.fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockRejectedValueOnce({ message: 'socket hang up' })
      .mockResolvedValue('ok');

    const resultPromise = retryOnTransient(operation, { retries: 2, baseDelayMs: 10, label: 'calendar' });
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(20);

    await expect(resultPromise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('immediately rethrows permanent errors and stops after the retry budget', async () => {
    const permanent = new Error('bad request');
    const operation = jest.fn().mockRejectedValue(permanent);
    await expect(retryOnTransient(operation, { retries: 3, baseDelayMs: 0 })).rejects.toBe(permanent);
    expect(operation).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    const transient = jest.fn().mockRejectedValue({ code: 'EPIPE' });
    const pending = retryOnTransient(transient, { retries: 1, baseDelayMs: 1 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'EPIPE' });
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
    expect(transient).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
