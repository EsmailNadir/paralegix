/**
 * Run a list of async thunks with at most `limit` in flight at once.
 *
 * Exists because `Promise.all` / `Promise.allSettled` over a caller-sized array
 * is how one request comes to own a fixed shared resource entirely: a firm with
 * thirty matter members, a folder page holding a thousand GCS objects, or a
 * dashboard starting every section at once all put more work in flight than the
 * pool, the container, or the remote API can absorb, and the cost lands on
 * unrelated requests rather than on the one that caused it.
 *
 * The return shape is deliberately `Promise.allSettled`'s, in input order, so
 * an existing `await Promise.allSettled(work)` becomes
 * `await runWithConcurrency(work, limit)` with the merge loop underneath it
 * untouched — and so callers that zip results back against their input array
 * stay correct.
 *
 *   const settled = await runWithConcurrency(
 *     items.map((item) => () => handle(item)),
 *     8,
 *   );
 *
 * Note the shape: an array of **thunks**, not of promises. A promise has already
 * started; only an unstarted function can be held back.
 *
 * No dependency for this on purpose. It is twenty lines, and `p-limit` is ESM.
 */

/**
 * Thrown in place of running a thunk whose turn never came inside
 * `queueTimeoutMs`. Surfaces as a rejected settled entry rather than as a
 * thrown error, so one starved item cannot take down the whole batch — but it
 * does mean a backlog shows up as a failure instead of as an unbounded wait,
 * which is the point.
 */
export class ConcurrencyQueueTimeoutError extends Error {
  readonly code = 'CONCURRENCY_QUEUE_TIMEOUT';

  readonly index: number;

  constructor(index: number, queueTimeoutMs: number) {
    super(`Queued work at index ${index} did not start within ${queueTimeoutMs}ms`);
    this.name = 'ConcurrencyQueueTimeoutError';
    this.index = index;
  }
}

export interface ConcurrencyOptions {
  /**
   * Give up on any thunk that has not started this many ms after the batch
   * began. Omit to let every thunk wait for its turn indefinitely.
   */
  queueTimeoutMs?: number;
}

/**
 * `thunks` is unstarted work, run in order as slots free up; `limit` is the
 * maximum concurrent thunks, clamped to at least 1. Resolves to settled results
 * in input order and never rejects.
 */
export async function runWithConcurrency<T>(
  thunks: Array<() => Promise<T>>,
  limit: number,
  options: ConcurrencyOptions = {},
): Promise<Array<PromiseSettledResult<T>>> {
  const list = Array.from(thunks || []);
  const results: Array<PromiseSettledResult<T>> = new Array(list.length);
  if (list.length === 0) return results;

  const queueTimeoutMs = Number(options.queueTimeoutMs) > 0 ? Number(options.queueTimeoutMs) : 0;
  // More workers than items would just idle, and a limit below 1 would stall.
  const workers = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, list.length));
  const startedAt = Date.now();

  // Shared cursor: each worker claims the next index and runs it, so a slow
  // thunk holds up only its own slot rather than a whole partition.
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;

      if (queueTimeoutMs && Date.now() - startedAt > queueTimeoutMs) {
        results[index] = {
          status: 'rejected',
          reason: new ConcurrencyQueueTimeoutError(index, queueTimeoutMs),
        };
        continue;
      }

      try {
        results[index] = { status: 'fulfilled', value: await list[index]() };
      } catch (reason) {
        // Matches allSettled: a thrown thunk is a rejected entry, never a
        // rejection of the batch. Callers merge failures themselves.
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  // Every worker resolves — the loop above catches — so this cannot reject.
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * A standing gate that admits at most `limit` callers at once.
 *
 * `runWithConcurrency` bounds one batch; this bounds a *resource* across
 * unrelated callers and requests — the case where the thing being protected is
 * not a list of work but a fixed capacity, like the single-digit number of
 * LibreOffice processes a 512Mi container can host.
 *
 *   const limit = createLimiter(1, { queueTimeoutMs: 30_000 });
 *   const pdf = await limit(() => convertDocument(buf));
 *
 * `queueTimeoutMs` is what keeps a backlog honest: without it, a slow resource
 * turns every waiting request into an open socket held until its own timeout,
 * which is how a saturated converter becomes a saturated server. With it the
 * caller gets a fast, explicit failure instead.
 *
 * The returned function rejects on failure, unlike `runWithConcurrency` — a
 * single call has no settled array to hide in.
 */
/**
 * One work item for `runWithWeightedConcurrency`: `weight` is how many units of
 * the bounded resource (e.g. Postgres pool connections) `run` holds AT ONCE at
 * its peak, not a query count, a simultaneity count. A thunk that awaits three
 * queries one after another is weight 1; a thunk that fires three queries via
 * `Promise.all` is weight 3.
 */
export interface WeightedWorkItem<T> {
  weight: number;
  run: () => Promise<T>;
}

/**
 * Like `runWithConcurrency`, but admits by summed weight instead of by count.
 *
 * `runWithConcurrency(items, limit)` assumes every item costs the resource the
 * same amount, which is false the moment an item internally runs more than one
 * query at once (`Promise.all` inside the thunk). A count-based limiter sized
 * for the AVERAGE item then admits `limit` of the EXPENSIVE ones simultaneously
 * on a bad day, and the resource is oversubscribed even though the limiter
 * reports itself well within bounds. This is that gap, closed: each item
 * declares its own peak cost, and the scheduler only starts the next item when
 * it fits in the remaining `capacity`.
 *
 * An item whose weight exceeds `capacity` on its own is still admitted alone
 * (once nothing else is in flight) rather than deadlocking the batch -- the
 * budget was undersized for it, which is a sizing bug to fix at the call site,
 * not a reason to hang forever.
 */
export async function runWithWeightedConcurrency<T>(
  items: Array<WeightedWorkItem<T>>,
  capacity: number,
): Promise<Array<PromiseSettledResult<T>>> {
  const list = Array.from(items || []);
  const results: Array<PromiseSettledResult<T>> = new Array(list.length);
  if (list.length === 0) return results;

  const cap = Math.max(1, Math.floor(Number(capacity)) || 1);
  let active = 0;
  let nextIndex = 0;
  let completed = 0;
  let settleBatch: () => void;
  const batchDone = new Promise<void>((resolve) => { settleBatch = resolve; });

  const admitMore = () => {
    while (nextIndex < list.length) {
      const weight = Math.max(1, Math.floor(list[nextIndex].weight) || 1);
      // Always admit when idle, even over-budget, so one oversized item can't
      // starve forever; otherwise only admit what still fits.
      if (active > 0 && active + weight > cap) break;
      const index = nextIndex;
      nextIndex += 1;
      active += weight;
      run(index, weight);
    }
  };

  async function run(index: number, weight: number) {
    try {
      results[index] = { status: 'fulfilled', value: await list[index].run() };
    } catch (reason) {
      results[index] = { status: 'rejected', reason };
    } finally {
      active -= weight;
      completed += 1;
      if (completed === list.length) settleBatch();
      else admitMore();
    }
  }

  admitMore();
  await batchDone;
  return results;
}

export function createLimiter(limit: number, options: ConcurrencyOptions = {}) {
  const max = Math.max(1, Math.floor(Number(limit)) || 1);
  const queueTimeoutMs = Number(options.queueTimeoutMs) > 0 ? Number(options.queueTimeoutMs) : 0;
  let active = 0;

  interface Waiter {
    admit: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }

  const queue: Waiter[] = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      active += 1;
      next.admit();
    }
  };

  /**
   * `callOptions.queueTimeoutMs` replaces the limiter's own deadline for this
   * one call. A caller with a deadline of its own (a request that must answer
   * before its response timeout) passes what it has left, so it is told it is
   * busy while it can still say so. A non-positive value means "use the
   * limiter's default", the same meaning 0 has when the limiter is built.
   */
  return async function limited<T>(
    thunk: () => Promise<T>,
    callOptions: ConcurrencyOptions = {},
  ): Promise<T> {
    const waitMs = Number(callOptions.queueTimeoutMs) > 0
      ? Number(callOptions.queueTimeoutMs)
      : queueTimeoutMs;
    if (active < max) {
      active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { admit: resolve, reject, timer: null };
        if (waitMs) {
          waiter.timer = setTimeout(() => {
            const idx = queue.indexOf(waiter);
            if (idx >= 0) queue.splice(idx, 1);
            reject(new ConcurrencyQueueTimeoutError(-1, waitMs));
          }, waitMs);
          waiter.timer.unref?.();
        }
        queue.push(waiter);
      });
    }
    try {
      return await thunk();
    } finally {
      release();
    }
  };
}
