/**
 * The concurrency gate every bulk action runs through.
 *
 * WHY IT EXISTS. One API instance holds a twelve-connection Postgres pool and
 * serves roughly fifty users. A bulk action that handed every selected row to
 * `Promise.all` opened one request per row at once, so a select-all-then-delete
 * over the firm time-entry list (ceiling raised from 200 to 1,000) could fire a
 * thousand simultaneous DELETEs and starve every other user of a connection.
 *
 * WHAT BREAKS EACH TEST BELOW:
 *  - swap `runBulkRequests` back to `Promise.all(items.map(task))` and the
 *    concurrency case sees `items.length` in flight, the partial-failure case
 *    stops attempting items after the first rejection, and the progress case
 *    never reports an intermediate count.
 *  - drop the `finally` that frees a slot and the failure cases deadlock.
 *  - report `failed` as a count instead of the items and the retry case loses
 *    which rows to re-send.
 */
import {
  runBulkRequests,
  bulkFailureMessage,
  bulkProgressMessage,
  serverBulkFailureMessage,
  MAX_ACTIVE_BULK_REQUESTS,
} from '@/lib/utils/bulkRequests';

/** Resolve after the current macrotask so several tasks are genuinely in flight. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A task that records how many copies of itself are running at the same moment.
 * The peak is measured INSIDE the task, between its entry and its exit, which
 * is the only place an unbounded fan-out is visible.
 */
function concurrencyProbe() {
  let active = 0;
  let peak = 0;
  return {
    get peak() { return peak; },
    async run<T>(work: () => Promise<T>): Promise<T> {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await work();
      } finally {
        active -= 1;
      }
    },
  };
}

describe('runBulkRequests', () => {
  it('runs every item but never more than four at a time', async () => {
    const probe = concurrencyProbe();
    const items = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const attempted: string[] = [];

    const result = await runBulkRequests(items, (id) =>
      probe.run(async () => {
        attempted.push(id);
        await tick();
      }),
    );

    expect(MAX_ACTIVE_BULK_REQUESTS).toBe(4);
    expect(probe.peak).toBe(MAX_ACTIVE_BULK_REQUESTS);
    expect(attempted).toHaveLength(50);
    expect(new Set(attempted)).toEqual(new Set(items));
    expect(result.succeeded).toEqual(items);
    expect(result.failed).toEqual([]);
  });

  it('holds the bound while failures are settling, and keeps going past them', async () => {
    const probe = concurrencyProbe();
    const items = Array.from({ length: 20 }, (_, i) => i);
    const attempted: number[] = [];

    const result = await runBulkRequests(items, (n) =>
      probe.run(async () => {
        attempted.push(n);
        await tick();
        if (n % 2 === 0) throw new Error(`boom ${n}`);
        return n;
      }),
    );

    // Every item was attempted. `Promise.all` would have rejected on item 0 and
    // left the caller unable to say what did or did not happen to the rest.
    expect(attempted.sort((a, b) => a - b)).toEqual(items);
    expect(probe.peak).toBe(MAX_ACTIVE_BULK_REQUESTS);
    expect(result.succeeded).toEqual(items.filter((n) => n % 2 === 1));
    expect(result.failed.map((f) => f.item)).toEqual(items.filter((n) => n % 2 === 0));
    // The error itself survives, so a caller can surface the server's reason
    // rather than a generic "something went wrong".
    expect((result.failed[0].error as Error).message).toBe('boom 0');
  });

  it('frees a slot for a task that throws before it ever awaits', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    // Enough synchronous throws to fill every slot. Without the `finally` around
    // the release they would exhaust the gate and this would never settle.
    const doomed = items.filter((n) => n <= MAX_ACTIVE_BULK_REQUESTS);
    const result = await runBulkRequests(items, (n) => {
      if (doomed.includes(n)) throw new Error('sync failure');
      return Promise.resolve(n);
    });

    expect(result.failed.map((f) => f.item)).toEqual(doomed);
    expect(result.succeeded).toEqual(items.filter((n) => !doomed.includes(n)));
  });

  it('reports progress as items settle, not only at the end', async () => {
    const items = Array.from({ length: 9 }, (_, i) => i);
    const progress: Array<[number, number]> = [];

    await runBulkRequests(
      items,
      async () => { await tick(); },
      { onProgress: (done, total) => progress.push([done, total]) },
    );

    // One report per settled item, counting up, every one naming the same total
    // so the UI can render "N of M" without holding the total itself.
    expect(progress).toHaveLength(9);
    expect(progress.map(([done]) => done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(progress.every(([, total]) => total === 9)).toBe(true);
  });

  it('counts a failure toward progress, so the bar cannot stall on a bad row', async () => {
    const progress: number[] = [];

    const result = await runBulkRequests(
      [1, 2, 3],
      async (n) => { await tick(); if (n === 2) throw new Error('nope'); },
      { onProgress: (done) => progress.push(done) },
    );

    expect(progress).toEqual([1, 2, 3]);
    expect(result.failed).toHaveLength(1);
  });

  it('does nothing and reports nothing for an empty selection', async () => {
    const task = jest.fn();
    const onProgress = jest.fn();

    const result = await runBulkRequests([], task, { onProgress });

    expect(task).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(result).toEqual({ succeeded: [], failed: [] });
  });
});

/**
 * The wording is the honesty half of the fix, so it is asserted rather than
 * left to whichever surface happens to render it. What breaks these: collapsing
 * the partial case into the "none" case (or into a bare "Failed to delete"),
 * which is what every one of these handlers did before.
 */
describe('bulkFailureMessage', () => {
  const run = (succeeded: number, failed: number) => ({
    succeeded: Array.from({ length: succeeded }, (_, i) => `ok-${i}`),
    failed: Array.from({ length: failed }, (_, i) => ({ item: `bad-${i}`, error: new Error('x') })),
  });

  it('is empty when nothing failed, so a clean run says nothing', () => {
    expect(bulkFailureMessage(run(5, 0), 'deleted', 'time entries')).toBe('');
  });

  it('names both halves of a partial run', () => {
    expect(bulkFailureMessage(run(900, 100), 'deleted', 'time entries')).toBe(
      '900 of 1000 time entries deleted. 100 could not be deleted and stayed selected.',
    );
  });

  it('does not do arithmetic when the answer is none of them', () => {
    expect(bulkFailureMessage(run(0, 4), 'shared', 'files')).toBe(
      'None of the 4 files could be shared.',
    );
  });

  it('reads the same for one as for many', () => {
    expect(bulkFailureMessage(run(3, 1), 'shared', 'files', 'stayed unchanged')).toBe(
      '3 of 4 files shared. 1 could not be shared and stayed unchanged.',
    );
  });
});

describe('bulkProgressMessage', () => {
  it('counts up against the total so a long run is not a bare spinner', () => {
    expect(bulkProgressMessage('Deleting', 340, 1000)).toBe('Deleting… 340 of 1000 done.');
  });
});

describe('serverBulkFailureMessage', () => {
  it('says nothing when the server refused none of the rows', () => {
    expect(serverBulkFailureMessage({ requested: 3, updated: 3, failed: [], errors: {} }, 'updated', 'tasks')).toBe('');
  });

  it('counts what went through and names each distinct reason once', () => {
    expect(serverBulkFailureMessage({
      requested: 4,
      updated: 2,
      failed: ['t2', 't3'],
      errors: { t2: 'Task is under legal hold', t3: 'Task is under legal hold' },
    }, 'updated', 'tasks')).toBe('2 of 4 tasks updated. 2 could not be updated: Task is under legal hold');
  });

  it('reads the deleted count when the action is a delete', () => {
    expect(serverBulkFailureMessage({
      requested: 2, deleted: 1, failed: ['t2'], errors: { t2: 'Under legal hold' },
    }, 'deleted', 'tasks')).toBe('1 of 2 tasks deleted. 1 could not be deleted: Under legal hold');
  });

  it('still reports the refusal when the server gave no reason', () => {
    expect(serverBulkFailureMessage({ requested: 2, updated: 0, failed: ['a', 'b'], errors: {} }, 'updated', 'matters'))
      .toBe('0 of 2 matters updated. 2 could not be updated.');
  });
});
