/**
 * The standing gate's per-call queue deadline.
 *
 * A limiter is built once with one queue deadline, but its callers do not all
 * have the same patience. A signer's completion request has a response deadline
 * of its own, and a slot that frees up after that deadline answers nobody: the
 * request already got a 504 for work it would then go on to do. So one call can
 * ask for a SHORTER wait than the limiter's default, and be told it is busy in
 * time to say so.
 *
 * What has to break for these to go red: ignore the per-call option (the first
 * case waits the full default instead of its own deadline), or leave a timed-out
 * waiter in the queue (the third case's later caller never gets the freed slot,
 * because release hands it to a waiter that already gave up).
 */
const { createLimiter } = require('../../src/shared/utils/runWithConcurrency');

/** Resolve when `promise` settles, or report that it had not within `ms`. */
async function settledWithin(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); });
  try {
    return await Promise.race([
      promise.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Occupy every slot of `limit` until the returned release is called. */
function occupy(limit: any, count: number) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = Array.from({ length: count }, () => limit(() => held));
  return { release: async () => { release(); await Promise.all(running); } };
}

describe('createLimiter per-call queue deadline', () => {
  it('gives up on a call after ITS OWN deadline, not the limiter default', async () => {
    const limit = createLimiter(1, { queueTimeoutMs: 60_000 });
    const hold = occupy(limit, 1);
    const ran = jest.fn(async () => 'ran');

    try {
      const outcome: any = await settledWithin(limit(ran, { queueTimeoutMs: 30 }), 1_000);

      expect(outcome).not.toBe('pending');
      expect(outcome.status).toBe('rejected');
      expect(outcome.reason.code).toBe('CONCURRENCY_QUEUE_TIMEOUT');
      // A call told it is busy must not also run later: its caller has already
      // taken the busy path and moved on.
      expect(ran).not.toHaveBeenCalled();
    } finally {
      await hold.release();
    }
    expect(ran).not.toHaveBeenCalled();
  });

  it('applies a per-call deadline on a limiter that has none of its own', async () => {
    const limit = createLimiter(1);
    const hold = occupy(limit, 1);

    try {
      const outcome: any = await settledWithin(limit(async () => 'ran', { queueTimeoutMs: 30 }), 1_000);

      expect(outcome).not.toBe('pending');
      expect(outcome.reason.code).toBe('CONCURRENCY_QUEUE_TIMEOUT');
    } finally {
      await hold.release();
    }
  });

  it('runs the call when a slot frees up inside its deadline', async () => {
    const limit = createLimiter(1, { queueTimeoutMs: 60_000 });
    const hold = occupy(limit, 1);
    const waiting = limit(async () => 'ran', { queueTimeoutMs: 5_000 });

    await hold.release();

    expect(await waiting).toBe('ran');
  });

  it('hands a freed slot to the next live waiter, not to one that already timed out', async () => {
    const limit = createLimiter(1);
    const hold = occupy(limit, 1);
    const gaveUp = limit(async () => 'should not run', { queueTimeoutMs: 20 });
    await expect(gaveUp).rejects.toMatchObject({ code: 'CONCURRENCY_QUEUE_TIMEOUT' });
    const patient = limit(async () => 'patient ran');

    await hold.release();

    expect(await settledWithin(patient, 1_000)).toEqual({ status: 'fulfilled', value: 'patient ran' });
  });
});
