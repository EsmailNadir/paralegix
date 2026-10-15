/**
 * Hold ONE named function open, so two requests can be PROVED to overlap there.
 *
 * WHY `Promise.all` IS NOT A RACE TEST
 * Every concurrency test in this suite today is shaped like
 * `await Promise.all([withdraw(), withdraw()])`. That starts two requests, and
 * then hopes. Node runs one callback at a time, so the second request may not
 * reach the contested read until the first has already committed its write, in
 * which case the test exercises two SEQUENTIAL operations and passes for the
 * wrong reason. It passes just as happily against code with no locking at all.
 * Nothing in the assertion can tell the two situations apart.
 *
 * A gate replaces the hope with evidence. It pauses every call at the entry of
 * one named function and lets the test wait until N calls are paused there AT
 * THE SAME TIME. `waiting() === 2` is not an inference: both requests are inside
 * the contested function, neither has returned, and the test chose that moment.
 *
 * WHY IT IS ALSO THE FAULT INJECTOR
 * The same seam answers the other half of B01.4. `failNext` makes exactly one
 * call to that boundary fail. Everything else, the route, the service, the other
 * repository calls, the transaction, the event listeners, keeps running for
 * real. That is the difference between "this service handles a failed balance
 * write" and "this service was replaced by a mock that returns a rejection".
 *
 * USAGE
 *   const repo = require('../../src/modules/trust/trust.repository');
 *   const gate = gateMethod(repo, 'insertLedgerRow');
 *   const a = api.post(url).send(body);      // both requests are in flight
 *   const b = api.post(url).send(body);
 *   await gate.arrived(2);                   // PROOF they overlap at the row write
 *   gate.open();
 *   const [resA, resB] = await Promise.all([a, b]);
 *   gate.restore();                          // always, even on failure
 */

// Captured at module load, before any spec installs fake timers. `clock.ts`
// fakes `setTimeout`, so a gate that used the global one would wait forever
// inside a frozen-clock spec and fail as a jest timeout naming the wrong thing.
const realSetTimeout = global.setTimeout;

/** Default patience for `arrived`. Long enough for a real request, short enough to name itself. */
const ARRIVAL_TIMEOUT_MS = 5_000;

interface Waiter {
  release: () => void;
  reject: (error: Error) => void;
}

export interface Gate {
  /**
   * Resolve once `count` calls are paused at the gate SIMULTANEOUSLY.
   *
   * Rejects with a message naming the gate if that never happens, rather than
   * hanging until the suite timeout, which would report a slow test instead of
   * a test whose two requests never overlapped.
   */
  arrived(count: number, timeoutMs?: number): Promise<void>;
  /** How many calls are paused at the gate right now. The overlap evidence. */
  waiting(): number;
  /** How many calls have reached the gate since it was installed. */
  entered(): number;
  /** Let every paused call through, and stop pausing later ones. */
  open(): void;
  /** Let exactly one paused call through. Later ones still pause. */
  openOne(): void;
  /**
   * Make the NEXT call to reach the gate reject with this error, without running
   * the real implementation. One boundary fails; everything around it is real.
   */
  failNext(error: Error): void;
  /** Restore the original function. Releases anything still paused first. */
  restore(): void;
}

/**
 * Gate one method on a module or object.
 *
 * `target` is whatever the caller reaches: a required CommonJS module object, or
 * an exported singleton. The gate REPLACES the property, so it only intercepts
 * callers that read it off this object at call time.
 *
 * THE WAY THIS SILENTLY FAILS, which is worth knowing before you debug it:
 *
 *  - An INTRA-MODULE call is invisible. `trust.service.ts` exports
 *    `createTransaction`, but that function calls the module-local
 *    `_createTransactionInternal` by its binding, not through `exports`. Gating
 *    the export intercepts the route, and gating anything the module calls
 *    internally intercepts nothing. Same shape in `stripe.service.ts`
 *    (`applyStripeCandidateTransaction`) and `eventOutbox.ts`, where the timer
 *    worker calls the local `processBatch` rather than the `_processBatch`
 *    export.
 *  - A DESTRUCTURED import holds the value, not the property. `trust.service.ts`
 *    does `const { trustTxnRepo } = require('./trust.repository')`. Gating a
 *    METHOD on that singleton works, because both modules hold the same object.
 *    Replacing the `trustTxnRepo` export itself would not.
 *
 * In both cases `arrived` times out and names the gate, rather than the suite
 * passing on a barrier that was never installed. Check how the caller reaches
 * the function before concluding the code has no race.
 */
export function gateMethod<T extends Record<string, any>>(target: T, key: keyof T & string): Gate {
  const original = target[key];
  if (typeof original !== 'function') {
    throw new Error(`gateMethod: ${String(key)} is not a function on the given target`);
  }

  const waiters = new Set<Waiter>();
  const arrivalWatchers = new Set<() => void>();
  let opened = false;
  let enteredCount = 0;
  let pendingFailure: Error | null = null;

  const announceArrival = () => {
    for (const watcher of Array.from(arrivalWatchers)) watcher();
  };

  const gated = function gatedFn(this: unknown, ...args: unknown[]) {
    enteredCount += 1;

    const failure = pendingFailure;
    if (failure) {
      pendingFailure = null;
      return Promise.reject(failure);
    }

    if (opened) {
      return original.apply(this, args);
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        release: () => {
          waiters.delete(waiter);
          // Resolved with the REAL call, so everything downstream of this
          // boundary still runs: the SQL, the transaction, the events.
          try {
            resolve(original.apply(this, args));
          } catch (error) {
            reject(error as Error);
          }
        },
        reject: (error: Error) => {
          waiters.delete(waiter);
          reject(error);
        },
      };
      waiters.add(waiter);
      announceArrival();
    });
  };

  (target as Record<string, unknown>)[key] = gated;

  const gate: Gate = {
    waiting: () => waiters.size,
    entered: () => enteredCount,

    arrived(count: number, timeoutMs = ARRIVAL_TIMEOUT_MS) {
      if (waiters.size >= count) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const timer = realSetTimeout(() => {
          arrivalWatchers.delete(watcher);
          reject(new Error(
            `gate(${String(key)}): waited ${timeoutMs}ms for ${count} concurrent calls, `
            + `saw ${waiters.size} paused and ${enteredCount} total.\n`
            + 'The requests did not overlap here. Either this is not the contested '
            + 'function, or one request finished before the other reached it.',
          ));
        }, timeoutMs);

        const watcher = () => {
          if (waiters.size < count) return;
          clearTimeout(timer as unknown as NodeJS.Timeout);
          arrivalWatchers.delete(watcher);
          resolve();
        };
        arrivalWatchers.add(watcher);
      });
    },

    open() {
      opened = true;
      for (const waiter of Array.from(waiters)) waiter.release();
    },

    openOne() {
      const [first] = Array.from(waiters);
      if (first) first.release();
    },

    failNext(error: Error) {
      pendingFailure = error;
    },

    restore() {
      // Released before restoring, so a spec that failed an assertion before
      // opening the gate does not leave a request hanging and turn a clear
      // failure into a suite timeout.
      opened = true;
      for (const waiter of Array.from(waiters)) waiter.release();
      arrivalWatchers.clear();
      (target as Record<string, unknown>)[key] = original;
    },
  };

  return gate;
}
