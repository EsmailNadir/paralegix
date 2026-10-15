/**
 * B07's C02 names the requirement directly: "Persistent coordination/idempotency
 * prevents duplicates across workers; an in-memory-only guard is insufficient
 * evidence." `withLock`/`tryLock` (`shared/database/advisoryLock.ts`) are the
 * mechanism every cross-worker guard in this codebase is built on - the
 * calendar outbound sync path, cron passes, OAuth refresh, the Stripe
 * payment-intent reversal - and none of it had a single direct test. Every
 * consumer's own test suite can only prove "this feature calls the lock
 * helper," never "the lock helper actually serializes two callers." This file
 * is that missing layer.
 *
 * Two real pool connections are used per contention case (`withLock` opens its
 * own `pool.connect()` internally, so two concurrent calls are genuinely two
 * Postgres sessions racing `pg_advisory_xact_lock`, not one JS event loop
 * pretending to be two). No `gate.ts` barrier is needed here: `withLock`
 * already accepts a bare callback, so the test controls exactly when the
 * lock-holder's work finishes with its own deferred promise, and proves the
 * second caller was blocked (not merely slower) by asserting its `withLock`
 * promise is still pending while the first one holds the lock, then resolves
 * only after the first releases it.
 */
// Side-effect only: forces NODE_ENV=test, RBAC_ENFORCED, the TEST_DB_SLOT/
// JEST_WORKER_ID-scoped database target, and the provider-credential pinning
// BEFORE anything below transitively requires the app's real
// `shared/database/db.ts`. Without this, `advisoryLock.ts`'s own
// `require('./db')` resolves against whatever the raw, un-forced environment
// happens to be, not the sandboxed per-worker test database.
import '../support/setupInProcess';

const {
  withLock, tryLock, AdvisoryLockTimeoutError,
} = require('../../src/shared/database/advisoryLock');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Resolves `true` if `p` is still pending after `ms`, without ever rejecting the test on a slow machine. */
function isStillPendingAfter(p: Promise<any>, ms: number): Promise<boolean> {
  const marker = Symbol('pending');
  return Promise.race([
    p.then(() => false, () => false),
    new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
  ]).then((result) => result === marker);
}

describe('advisoryLock: real cross-connection mutual exclusion, not an in-process guard', () => {
  it('a second caller for the SAME key is genuinely blocked, not just slower, until the first releases', async () => {
    const key = `lock-test-${Math.random().toString(36).slice(2, 10)}`;
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = withLock('CALENDAR_SYNC', key, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'first';
    }, { lockTimeoutMs: 5000 });

    await firstEntered.promise;

    let secondEntered = false;
    const second = withLock('CALENDAR_SYNC', key, async () => {
      secondEntered = true;
      return 'second';
    }, { lockTimeoutMs: 5000 });

    try {
      // The direct evidence: the second call's OWN promise has not settled
      // while the first still holds the lock. A guard that only serialized
      // within one process (a Map, a mutex object) would let a second
      // `withLock` call reach its own callback immediately, since nothing
      // in-process is holding it.
      expect(await isStillPendingAfter(second, 200)).toBe(true);
      expect(secondEntered).toBe(false);
    } finally {
      // Unconditional: an assertion failure above must not leave `first`
      // holding a real Postgres transaction open until the server's own
      // idle-in-transaction timeout kills it minutes later, which turns one
      // clear assertion failure into a suite-wide unhandled-connection-error
      // cascade during teardown.
      releaseFirst.resolve();
    }

    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(secondEntered).toBe(true);
  });

  it('different keys in the same domain do not serialize each other', async () => {
    const keyA = `lock-test-a-${Math.random().toString(36).slice(2, 8)}`;
    const keyB = `lock-test-b-${Math.random().toString(36).slice(2, 8)}`;
    const bothEntered = deferred();
    let enteredCount = 0;
    const noteEntry = () => {
      enteredCount += 1;
      if (enteredCount === 2) bothEntered.resolve();
    };

    const holdA = deferred();
    const holdB = deferred();

    const a = withLock('CALENDAR_SYNC', keyA, async () => {
      noteEntry();
      await holdA.promise;
    }, { lockTimeoutMs: 2000 });
    const b = withLock('CALENDAR_SYNC', keyB, async () => {
      noteEntry();
      await holdB.promise;
    }, { lockTimeoutMs: 2000 });

    try {
      // If a shared key accidentally serialized these (e.g. `resolveKey`
      // collapsing both to the same hash, or a domain-wide rather than
      // per-key lock), only one callback would ever fire and this would hang
      // until the suite's own timeout.
      await bothEntered.promise;
    } finally {
      holdA.resolve();
      holdB.resolve();
    }
    await Promise.all([a, b]);
    expect(enteredCount).toBe(2);
  });

  it('a contended lock throws AdvisoryLockTimeoutError naming the domain and key, without ever running the callback', async () => {
    const key = `lock-test-timeout-${Math.random().toString(36).slice(2, 8)}`;
    const holdFirst = deferred();
    // Resolved from inside the holder's callback, so the contender below starts
    // only once the lock is genuinely held. Without it the two race for the
    // first acquisition and the contender can win it outright.
    const holderReady = deferred();

    const first = withLock('CALENDAR_SYNC', key, async () => {
      holderReady.resolve();
      await holdFirst.promise;
    }, { lockTimeoutMs: 5000 });
    await holderReady.promise;

    let secondRan = false;
    const secondAttempt = withLock('CALENDAR_SYNC', key, async () => {
      secondRan = true;
    }, { lockTimeoutMs: 150 });

    try {
      await expect(secondAttempt).rejects.toThrow(AdvisoryLockTimeoutError);
      await expect(secondAttempt).rejects.toMatchObject({
        code: 'ADVISORY_LOCK_TIMEOUT',
        domain: 'CALENDAR_SYNC',
        key,
      });
      expect(secondRan).toBe(false);
    } finally {
      holdFirst.resolve();
    }
    await first;
  });

  it('a caller whose work throws still releases the lock, so the next caller does not wait for it', async () => {
    const key = `lock-test-rollback-${Math.random().toString(36).slice(2, 8)}`;

    await expect(withLock('CALENDAR_SYNC', key, async () => {
      throw new Error('simulated failure inside the lock');
    })).rejects.toThrow('simulated failure inside the lock');

    // If the failed attempt's transaction were left open (a missing rollback,
    // or `client.release()` skipped), this would either hang or time out rather
    // than resolving immediately.
    const result = await withLock('CALENDAR_SYNC', key, async () => 'clean run', { lockTimeoutMs: 1000 });
    expect(result).toBe('clean run');
  });

  it('tryLock never waits: it reports acquired: false immediately rather than queueing', async () => {
    const key = `lock-test-trylock-${Math.random().toString(36).slice(2, 8)}`;
    const holdFirst = deferred();
    // Resolved from INSIDE the first holder's callback, so the try below runs
    // only once the lock is genuinely held. Without this the two raced: the try
    // could land before the holder had acquired anything, win the lock itself,
    // and report `acquired: true`, which is not what the case is about.
    const holderReady = deferred();

    const first = withLock('CALENDAR_SYNC', key, async () => {
      holderReady.resolve();
      await holdFirst.promise;
    }, { lockTimeoutMs: 5000 });
    await holderReady.promise;

    const startedAt = Date.now();
    const outcome = await tryLock('CALENDAR_SYNC', key, async () => 'should not run');
    const elapsedMs = Date.now() - startedAt;

    try {
      expect(outcome).toEqual({ acquired: false });
      // Generous ceiling: the point is "did not wait for the 5000ms holder,"
      // not a precise latency budget this machine can't promise.
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      holdFirst.resolve();
    }
    await first;
  });

  it('a distinct lock domain does not collide with CALENDAR_SYNC even with the identical key text', async () => {
    // Sanity check on the two-int addressing scheme
    // (`resolveClassId`/`hashtext(key)`) rather than an assumption: two
    // different classids with the same key hash must not be treated as the
    // same lock.
    const key = `lock-test-domain-${Math.random().toString(36).slice(2, 8)}`;
    const holdCalendar = deferred();

    const calendarHold = withLock('CALENDAR_SYNC', key, async () => {
      await holdCalendar.promise;
    }, { lockTimeoutMs: 2000 });

    try {
      const cronResult = await withLock('CRON_PASS', key, async () => 'cron ran', { lockTimeoutMs: 1000 });
      expect(cronResult).toBe('cron ran');
    } finally {
      holdCalendar.resolve();
    }
    await calendarHold;
  });
});

/**
 * The lock is a lease row, not an open transaction, so holding or waiting for
 * one costs no pool connection. Instances share a pool of 12 behind a
 * 15-connection session pooler, and cron passes, calendar syncs and the Stripe
 * reversal hold their locks for minutes across remote API calls: a lock that
 * pinned a connection for that long starved every live request on the instance.
 *
 * Connection use is read from the app pool's own `acquire`/`release` events,
 * the same measurement `tests/dashboard/dashboardConnections.test.ts` uses.
 */
describe('advisoryLock: holding or waiting for a lock pins no pool connection', () => {
  // Loaded after the harness, which points DATABASE_URL at this worker's test
  // database: `db.ts` reads the URL when it is first imported.
  const { pool } = require('../../src/shared/database/db');

  function trackCheckedOut() {
    const state = { active: 0, peak: 0 };
    const onAcquire = () => { state.active += 1; state.peak = Math.max(state.peak, state.active); };
    const onRelease = () => { state.active -= 1; };
    pool.on('acquire', onAcquire);
    pool.on('release', onRelease);
    return {
      state,
      stop: () => {
        pool.off('acquire', onAcquire);
        pool.off('release', onRelease);
      },
    };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Goes red when the callback runs while the lock's own connection is still
  // checked out (the transaction-scoped implementation holds it for all of `fn`).
  it('withLock holds no connection while its callback awaits slow non-database work', async () => {
    const key = `lease-hold-${Math.random().toString(36).slice(2, 10)}`;
    const tracker = trackCheckedOut();
    let checkedOutDuringWork = -1;
    try {
      const result = await withLock('CALENDAR_SYNC', key, async () => {
        await sleep(500);
        checkedOutDuringWork = tracker.state.active;
        return 'done';
      });
      expect(result).toBe('done');
    } finally {
      tracker.stop();
    }
    // Proves the listener saw the acquire statement, so the 0 below is a real
    // measurement and not a detached pool.
    expect(tracker.state.peak).toBeGreaterThanOrEqual(1);
    expect(checkedOutDuringWork).toBe(0);
  });

  it('tryLock holds no connection while its callback awaits slow non-database work', async () => {
    const key = `lease-try-hold-${Math.random().toString(36).slice(2, 10)}`;
    const tracker = trackCheckedOut();
    let checkedOutDuringWork = -1;
    try {
      const outcome = await tryLock('CRON_PASS', key, async () => {
        await sleep(500);
        checkedOutDuringWork = tracker.state.active;
        return 'swept';
      });
      expect(outcome).toEqual({ acquired: true, result: 'swept' });
    } finally {
      tracker.stop();
    }
    expect(tracker.state.peak).toBeGreaterThanOrEqual(1);
    expect(checkedOutDuringWork).toBe(0);
  });

  // Goes red when a waiter blocks on a connection of its own while the holder
  // keeps one (peak 2), which is how a handful of waiters starved the pool.
  it('a holder and a waiter together never have more than one connection checked out', async () => {
    const key = `lease-wait-${Math.random().toString(36).slice(2, 10)}`;
    const holderEntered = deferred();
    const releaseHolder = deferred();
    const tracker = trackCheckedOut();

    const holder = withLock('CALENDAR_SYNC', key, async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
      return 'holder';
    }, { lockTimeoutMs: 5000 });

    let waiter: Promise<unknown> | undefined;
    let peakWhileContended = -1;
    try {
      await holderEntered.promise;
      const pendingWaiter = withLock('CALENDAR_SYNC', key, async () => 'waiter', { lockTimeoutMs: 5000 });
      waiter = pendingWaiter;
      // Long enough for the waiter to poll several times.
      expect(await isStillPendingAfter(pendingWaiter, 400)).toBe(true);
      peakWhileContended = tracker.state.peak;
    } finally {
      tracker.stop();
      releaseHolder.resolve();
    }

    expect(await holder).toBe('holder');
    expect(await waiter).toBe('waiter');
    // At least 1 proves the listener saw the polls; more than 1 means a
    // connection was pinned while contended.
    expect(peakWhileContended).toBe(1);
  });

  // Goes red if an expired lease cannot be taken over (the second caller would
  // time out), or if the first owner's release deletes the lease it no longer
  // owns (the tryLock below would acquire while the second owner still works).
  it('an expired lease is taken by a new caller, and the old owner finishing does not release it', async () => {
    const key = `lease-expiry-${Math.random().toString(36).slice(2, 10)}`;
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();

    // The old owner's late release is reported, not thrown.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const first = withLock('CALENDAR_SYNC', key, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'first';
    }, { maxHoldMs: 300 });
    await firstEntered.promise;

    const second = withLock('CALENDAR_SYNC', key, async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
      return 'second';
    }, { lockTimeoutMs: 5000, maxHoldMs: 60_000 });

    try {
      // The first owner is still inside its callback; its lease has expired.
      await secondEntered.promise;
      releaseFirst.resolve();
      // The old owner's work completed, so its caller gets its result.
      expect(await first).toBe('first');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`lease CALENDAR_SYNC:${key} expired before release`),
      );

      const whileSecondHolds = await tryLock('CALENDAR_SYNC', key, async () => 'stolen');
      expect(whileSecondHolds).toEqual({ acquired: false });
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      warn.mockRestore();
    }
    expect(await second).toBe('second');

    const afterRelease = await tryLock('CALENDAR_SYNC', key, async () => 'free again');
    expect(afterRelease).toEqual({ acquired: true, result: 'free again' });
  });
});
