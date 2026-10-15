/**
 * Pin the clock for a spec.
 *
 * 42 modules under src/modules read `new Date()`. Reminders, daily digests,
 * billing windows, trust fee sweeps and calendar ranges all branch on it, and
 * none of them can be tested against a moving clock.
 *
 * Jest's modern fake timers replace the global Date, so the app reads the pinned
 * instant with no injection point and no production change. Timers are not
 * advanced automatically: every background interval in the app is unref'd and
 * irrelevant to a request, and auto-advancing would start running them.
 */

/**
 * Freeze time at an instant.
 *
 * Pass an ISO string with an EXPLICIT offset, for example
 * '2026-03-15T09:00:00-04:00'. A bare 'YYYY-MM-DD' is parsed as UTC midnight,
 * which is the previous calendar day in every US timezone, so a day-boundary
 * test written that way passes or fails for a reason that has nothing to do with
 * the code.
 */
export function freezeClockAt(iso: string): void {
  if (!/[+-]\d{2}:\d{2}$|Z$/.test(iso)) {
    throw new Error(
      `freezeClockAt needs an explicit offset or Z, got "${iso}". A bare date is `
      + 'parsed as UTC midnight, which is the day before in every US timezone.',
    );
  }
  jest.useFakeTimers({
    // nextTick and setImmediate must keep working: the pg driver and Express
    // both schedule on them, so faking these deadlocks any request made while
    // the clock is frozen.
    doNotFake: ['nextTick', 'setImmediate'],
    now: new Date(iso),
  });
}

export function unfreezeClock(): void {
  jest.useRealTimers();
}

/** Run one function at a fixed instant, restoring the real clock afterwards. */
export async function atInstant<T>(iso: string, fn: () => Promise<T> | T): Promise<T> {
  freezeClockAt(iso);
  try {
    return await fn();
  } finally {
    unfreezeClock();
  }
}
