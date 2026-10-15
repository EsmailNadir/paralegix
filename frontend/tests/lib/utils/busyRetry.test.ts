/**
 * `retryWhileBusy`: send a document request again when the server said its
 * queue was full.
 *
 * A busy answer (`TEMPLATE_FILL_BUSY`, `CONVERSION_BUSY`, `SIGNING_BUSY`) is a
 * 503 from a server that refused the work BEFORE starting it, so the same
 * request is safe to repeat. Everything else is not, and the cases that assert a
 * SINGLE call matter most:
 *
 * - a 429 `TEMPLATE_RENDER_IN_PROGRESS` is this person's own render still
 *   running; sending another only adds to the pile it is waiting behind.
 * - a 504 or a dropped connection says nothing about whether the work ran. The
 *   conversion finalize deletes its source when it fails, so a blind retry of
 *   one turns a slow success into a "file not found".
 */
import { retryWhileBusy, isServerBusyError } from '@/lib/utils/busyRetry';
import { ApiError, NETWORK_UNREACHABLE_CODE, REQUEST_TIMEOUT_CODE } from '@/lib/utils/apiErrors';

const busy = (code = 'TEMPLATE_FILL_BUSY', retryAfterSeconds?: number) =>
  new ApiError('Too many documents are being prepared right now.', { status: 503, code, retryAfterSeconds });

/** Let every pending timer and the promise chain behind it run. */
async function drain() {
  await jest.runAllTimersAsync();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('what counts as busy', () => {
  it.each(['TEMPLATE_FILL_BUSY', 'CONVERSION_BUSY', 'SIGNING_BUSY'])('recognises %s', (code) => {
    expect(isServerBusyError(busy(code))).toBe(true);
  });

  it('does not count a per-person render cap, a maintenance window, a gateway timeout or a lost connection', () => {
    expect(isServerBusyError(new ApiError('x', { status: 429, code: 'TEMPLATE_RENDER_IN_PROGRESS' }))).toBe(false);
    expect(isServerBusyError(new ApiError('x', { status: 503, code: 'MAINTENANCE_MODE' }))).toBe(false);
    expect(isServerBusyError(new ApiError('x', { status: 503 }))).toBe(false);
    expect(isServerBusyError(new ApiError('x', { status: 504 }))).toBe(false);
    expect(isServerBusyError(new ApiError('x', { status: 0, code: REQUEST_TIMEOUT_CODE }))).toBe(false);
    expect(isServerBusyError(new ApiError('x', { status: 0, code: NETWORK_UNREACHABLE_CODE }))).toBe(false);
    expect(isServerBusyError(new Error('Failed to fetch'))).toBe(false);
  });
});

describe('retryWhileBusy', () => {
  it('runs the request once when it works', async () => {
    const run = jest.fn().mockResolvedValue('filled');

    await expect(retryWhileBusy(run)).resolves.toBe('filled');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries a busy answer and returns the result once the queue has room', async () => {
    const run = jest.fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy('CONVERSION_BUSY'))
      .mockResolvedValueOnce('filled');

    const result = retryWhileBusy(run);
    await drain();

    await expect(result).resolves.toBe('filled');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('gives up after three retries and throws the last busy answer', async () => {
    const last = busy('CONVERSION_BUSY');
    const run = jest.fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(last)
      .mockResolvedValue('never reached');

    const result = retryWhileBusy(run);
    const settled = expect(result).rejects.toBe(last);
    await drain();

    await settled;
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('waits the Retry-After the server asked for before trying again', async () => {
    const run = jest.fn()
      .mockRejectedValueOnce(busy('TEMPLATE_FILL_BUSY', 7))
      .mockResolvedValueOnce('filled');

    const result = retryWhileBusy(run);
    await jest.advanceTimersByTimeAsync(6999);
    expect(run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(result).resolves.toBe('filled');
  });

  it('backs off with jitter when the server named no wait', async () => {
    // Math.random pinned to its extremes: the first pause stays inside its
    // window either way, and the two runs pause for different lengths.
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const fast = jest.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce('a');
    const fastResult = retryWhileBusy(fast);
    await jest.advanceTimersByTimeAsync(499);
    expect(fast).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fast).toHaveBeenCalledTimes(2);
    await fastResult;

    (Math.random as jest.Mock).mockReturnValue(0.999);
    const slow = jest.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce('b');
    const slowResult = retryWhileBusy(slow);
    await jest.advanceTimersByTimeAsync(990);
    expect(slow).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10);
    expect(slow).toHaveBeenCalledTimes(2);
    await slowResult;
  });

  it('does not retry when the server asks for a longer wait than a person will sit through', async () => {
    const err = busy('TEMPLATE_FILL_BUSY', 600);
    const run = jest.fn().mockRejectedValueOnce(err).mockResolvedValue('never reached');

    await expect(retryWhileBusy(run)).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a per-person render cap (429 TEMPLATE_RENDER_IN_PROGRESS)', new ApiError('x', { status: 429, code: 'TEMPLATE_RENDER_IN_PROGRESS' })],
    ['a gateway timeout', new ApiError('x', { status: 504 })],
    ['a client deadline', new ApiError('x', { status: 0, code: REQUEST_TIMEOUT_CODE })],
    ['a lost connection', new ApiError('x', { status: 0, code: NETWORK_UNREACHABLE_CODE })],
    ['a 503 with no busy code', new ApiError('x', { status: 503 })],
  ])('does not retry %s', async (_label, err) => {
    const run = jest.fn().mockRejectedValueOnce(err).mockResolvedValue('never reached');

    await expect(retryWhileBusy(run)).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the caller cancels, without sending the request again', async () => {
    const controller = new AbortController();
    const run = jest.fn().mockRejectedValueOnce(busy()).mockResolvedValue('never reached');

    const result = retryWhileBusy(run, { signal: controller.signal });
    const settled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(100);
    controller.abort();
    await drain();

    await settled;
    expect(run).toHaveBeenCalledTimes(1);
  });
});
