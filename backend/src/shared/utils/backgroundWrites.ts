/**
 * A handle on the writes that outlive the request that started them.
 *
 * Several paths deliberately do not await their own database write, because a
 * failure there must never affect the response: the signature audit trail and
 * the timezone capture are both like this, and `audit.service` was the first.
 * In production that is correct and invisible.
 *
 * In tests it is a hazard with no other handle on it. `drainEvents()` settles
 * the event bus, but none of these writes go through the bus, so a spec can
 * finish, the next one can `truncate` all the schema, and the straggling insert
 * deadlocks against that ACCESS EXCLUSIVE lock (Postgres 40P01). Postgres kills
 * one side. If it kills the insert, the request in flight dies with a bare
 * `socket hang up`; if it kills the truncate, the NEXT spec starts against a
 * database that was never cleaned. Both read as a bug in whichever spec drew the
 * short straw, and both move between files as the suite grows.
 *
 * That is not hypothetical. Three of these deadlocks were recorded against
 * `signature_audit_events` in one evening, each naming `truncateAll`'s own
 * statement as the other side.
 *
 * `audit.service` solved this for itself with a private Set and its own
 * `drainAuditWrites()`. This module is that same solution, shared, so a third
 * writer registers instead of reinventing it. Registering costs one Set entry
 * and changes nothing a caller can observe: `track` returns the promise it was
 * given.
 */

const inFlight = new Set<Promise<unknown>>();

/**
 * Register a fire-and-forget write and return it unchanged, so a caller that
 * does want to await it still can.
 *
 * The promise removes itself on settle, success or failure alike. A rejection
 * handler is attached here only to keep the Set from leaking; it deliberately
 * does NOT swallow the rejection for the caller, which still sees the original
 * promise and whatever handler it attached itself.
 */
export function trackBackgroundWrite<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise);
  const forget = () => { inFlight.delete(promise); };
  promise.then(forget, forget);
  return promise;
}

/**
 * Await every registered write that has started but not settled.
 *
 * Test-support only. Loops rather than awaiting once, because settling one write
 * can start another; the guard bounds that at 50 rounds so a pathological chain
 * fails the run rather than hanging it.
 */
export async function drainBackgroundWrites(): Promise<void> {
  let guard = 0;
  while (inFlight.size && guard < 50) {
    guard += 1;
    await Promise.allSettled([...inFlight]);
  }
}

/** How many writes are still outstanding. Test-support only. */
export function pendingBackgroundWrites(): number {
  return inFlight.size;
}
