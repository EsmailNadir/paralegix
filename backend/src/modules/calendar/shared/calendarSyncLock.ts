/**
 * The cross-instance lock every outbound push for one (entity, user) runs under.
 *
 * Both providers decide create-versus-PATCH by looking for an event this user
 * already has, and record a new one only after the provider answers. Two pushes
 * for the same entity and user that overlap would both find nothing and both
 * create. The real-time listeners in `calendar.events.ts` and the bulk "sync
 * existing" routes take this same key, so neither can race the other into a
 * duplicate.
 */
const advisoryLock = require('../../../shared/database/advisoryLock');

/** How long a push waits for another worker to finish the same entity. */
const CALENDAR_LOCK_TIMEOUT_MS = Number(process.env.CALENDAR_LOCK_TIMEOUT_MS) || 10_000;
/** Ceiling on holding the lock, so a hung provider API cannot pin a connection. */
const CALENDAR_LOCK_MAX_HOLD_MS = Number(process.env.CALENDAR_LOCK_MAX_HOLD_MS) || 120_000;

/**
 * Run `fn` holding the sync lock for one entity and user. Rejects with
 * `AdvisoryLockTimeoutError` when another push for the same key is still running.
 */
export function withCalendarSyncLock<T>(entityType: string, entityId: string, userId: string, fn: () => Promise<T>): Promise<T> {
  return advisoryLock.withLock(
    'CALENDAR_SYNC',
    `${entityType}:${entityId}:${userId}`,
    fn,
    // Generous on both counts: the work inside is up to two sequential provider
    // API calls, so a waiter needs longer than the 2s default to be worth
    // waiting, and a hung provider must not hold a pool connection indefinitely.
    { lockTimeoutMs: CALENDAR_LOCK_TIMEOUT_MS, maxHoldMs: CALENDAR_LOCK_MAX_HOLD_MS },
  );
}
