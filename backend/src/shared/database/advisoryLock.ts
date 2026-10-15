/**
 * Cross-process mutual exclusion through lease rows in `lock_leases`.
 *
 * Every coordination mechanism that lives in a JavaScript `Map` (a debounce
 * table, an in-flight-refresh map, a "someone else is already sweeping" flag)
 * only coordinates the instance it lives on. These helpers move that
 * coordination into the database, which every instance shares.
 *
 * ## A lease, not an open transaction
 *
 * Acquiring is ONE short statement: an upsert on `(domain, lock_key)` that takes
 * the row only when it is absent or its `locked_until` has already passed, and
 * returns the owner token that ended up on the row. The caller holds the lock
 * when that token is its own. Releasing is a delete that matches the owner
 * token, so an owner whose lease expired and was taken over never deletes the
 * new owner's row.
 *
 * No pool connection is held between the two statements. That is the point:
 * each API instance's pool is small (12 against a 15-connection session
 * pooler), and callers hold these locks across minutes of remote work (cron
 * passes, Google/Outlook API calls, Stripe API calls). The previous
 * implementation held a `pg_advisory_xact_lock` inside an open transaction on a
 * dedicated connection for the whole callback, so every holder AND every waiter
 * pinned a pool slot doing nothing.
 *
 * The consequence for callers: the callback receives no executor, and there is
 * no transaction around it. Work that needs atomicity opens its own transaction
 * inside the lock. Every current caller already does.
 *
 * ## The two bounds
 *
 *   - `lockTimeoutMs` (2s) bounds how long `withLock` polls for the lease.
 *     Polling backs off from 25ms to 250ms, and each poll borrows a connection
 *     for one statement only.
 *   - `maxHoldMs` (60s) is the lease length. A holder that crashes, or hangs on
 *     a remote API past it, stops excluding anyone once it passes. Size it above
 *     the longest legitimate run of the work, because an expired lease can be
 *     taken while the first holder is still working.
 *
 * Both are measured on the database clock (`now()`), never the instance clock,
 * so clock skew between instances cannot shorten or stretch a lease.
 *
 * Prefer `tryLock` wherever "someone else is already doing this" is an
 * acceptable answer: it makes one attempt and never polls.
 */

import { randomUUID } from 'crypto';

const { infrastructureRootSql } = require('./infrastructureQuery');

/**
 * Lock namespaces. A lease row is keyed by the domain NAME, so two unrelated
 * features using the same key text never exclude each other. Register a domain
 * here before using it: an unregistered name throws, so a typo fails loudly
 * instead of silently locking against nothing.
 *
 * The numeric values are the classids of the advisory locks these domains used
 * before leases replaced them. Nothing passes them to Postgres anymore; they
 * stay so the exported shape is unchanged.
 */
export const LOCK_DOMAINS = Object.freeze({
  /** Serializes the outbound calendar write path per (user, entity). */
  CALENDAR_SYNC: 1920234801,
  /** Serializes inbound provider push notifications per user. */
  CALENDAR_WEBHOOK: 1920234802,
  /** Serializes OAuth token refresh per user; Microsoft refresh tokens rotate. */
  OAUTH_REFRESH: 1920234803,
  /** Serializes calendar connect/disconnect, including provider exchange and revoke. */
  CALENDAR_CONNECTION: 1920234807,
  /**
   * Serializes replacing one user's provider watch (a Google watch channel or a
   * Graph subscription), keyed `provider:userId`. Every replacement creates the
   * new watch before stopping the old one, so two that overlap each leave one
   * live and the user's changes notify twice.
   */
  CALENDAR_WATCH: 1920234808,
  /** One run of a given `/api/cron/*` sweep at a time, platform-wide. */
  CRON_PASS: 1920234804,
  /** Boot-time and scheduled housekeeping sweeps. */
  HOUSEKEEPING: 1920234805,
  /**
   * Serializes the shared provider sync engine's mapped-entity (matterEvent /
   * clientEvent) inbound read-decide-write per entity, ACROSS users and
   * providers. CALENDAR_WEBHOOK above is keyed by the calling user, which
   * does nothing for two different users' independent Google/Outlook
   * connections both syncing their own copy of the SAME shared matter/client
   * event: both would read the row before either writes it, and whichever
   * write lands second in Postgres wins regardless of which provider's edit
   * is actually newer. This key is `entityType:entityId` alone, with no user
   * or provider in it, specifically so it serializes across all of them.
   */
  CALENDAR_ENTITY: 1920234806,
  /** Serializes the money-moving Stripe deposit-reversal path per payment intent. */
  STRIPE_PAYMENT_INTENT: 1920234868,
  /** Serializes checkout creation for one invoice across portal and public links. */
  STRIPE_INVOICE_CHECKOUT: 1920234869,
});

export const DEFAULT_LOCK_TIMEOUT_MS = 2000;
export const DEFAULT_MAX_HOLD_MS = 60000;

/** First wait between acquisition attempts in `withLock`. Doubles each retry. */
const POLL_INITIAL_MS = 25;
/** Longest wait between acquisition attempts. */
const POLL_MAX_MS = 250;

/**
 * Thrown by `withLock` when the lock was still held after `lockTimeoutMs`.
 * Distinct from a failure inside `fn`, so callers can retry or degrade rather
 * than treating contention as a bug.
 */
export class AdvisoryLockTimeoutError extends Error {
  readonly code = 'ADVISORY_LOCK_TIMEOUT';

  readonly domain: string;

  readonly key: string;

  constructor(domain: string, key: string, lockTimeoutMs: number) {
    super(`Timed out after ${lockTimeoutMs}ms waiting for lock ${domain}:${key}`);
    this.name = 'AdvisoryLockTimeoutError';
    this.domain = domain;
    this.key = key;
  }
}

/** How long to wait for the lock, and how long a holder may keep it. */
export interface LockOptions {
  lockTimeoutMs?: number;
  maxHoldMs?: number;
}

function assertRegisteredDomain(domain: string) {
  if (typeof (LOCK_DOMAINS as Record<string, number | undefined>)[domain] !== 'number') {
    throw new Error(`Unknown advisory lock domain: ${String(domain)}. Register it in LOCK_DOMAINS.`);
  }
}

function resolveKey(domain: any, key: any) {
  // A missing key means the caller does not know what it is serializing, and
  // the failure mode of guessing is a race that only shows up under load.
  // Callers must resolve the key (or skip locking entirely) before calling in.
  if (typeof key !== 'string' && typeof key !== 'number') {
    throw new Error(`Advisory lock ${domain} requires a string or number key, got ${typeof key}`);
  }
  const asText = String(key);
  if (!asText.trim()) {
    throw new Error(`Advisory lock ${domain} requires a non-empty key`);
  }
  return asText;
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * One acquisition attempt. The `where` on the conflict branch is what makes it
 * exclusive: a live lease leaves the row untouched and `returning` yields
 * nothing, so only the caller that inserted or took over an expired row gets
 * its own token back.
 */
async function attemptLease(domain: string, lockKey: string, ownerToken: string, maxHoldMs: number) {
  const { rows } = await infrastructureRootSql(
    `insert into lock_leases (domain, lock_key, owner_token, locked_until)
     values ($1, $2, $3::uuid, now() + ($4::double precision * interval '1 millisecond'))
     on conflict (domain, lock_key) do update
       set owner_token = excluded.owner_token,
           locked_until = excluded.locked_until
       where lock_leases.locked_until < now()
     returning owner_token`,
    [domain, lockKey, ownerToken, maxHoldMs],
  );
  return rows.length === 1 && rows[0].owner_token === ownerToken;
}

/**
 * Delete the lease only if this caller still owns it. Never throws: the work
 * has already finished (or failed with its own error, which must win), and a
 * lease that could not be deleted simply expires at `maxHoldMs`.
 */
async function releaseLease(domain: string, lockKey: string, ownerToken: string, maxHoldMs: number) {
  try {
    const { rows } = await infrastructureRootSql(
      `delete from lock_leases
        where domain = $1 and lock_key = $2 and owner_token = $3::uuid
       returning owner_token`,
      [domain, lockKey, ownerToken],
    );
    if (rows.length === 0) {
      // Not thrown: the work is done and cannot be undone, and a thrown error
      // here would send callers such as calendar.events.ts down a fallback
      // that runs the same work again without any lock.
      console.warn(
        `[advisoryLock] lease ${domain}:${lockKey} expired before release (held past maxHoldMs ${maxHoldMs}ms); `
        + 'another caller may have run concurrently',
      );
    }
  } catch (err: any) {
    console.error(`[advisoryLock] failed to release lease ${domain}:${lockKey}; it expires on its own:`, err?.message || err);
  }
}

/** Shared body of both helpers: acquire (once or by polling), run, release. */
async function runLocked<T>(
  domain: string,
  key: string,
  fn: () => T | Promise<T>,
  { wait, lockTimeoutMs, maxHoldMs }: { wait: boolean; lockTimeoutMs: number; maxHoldMs: number },
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  assertRegisteredDomain(domain);
  const lockKey = resolveKey(domain, key);
  const ownerToken = randomUUID();

  let acquired = await attemptLease(domain, lockKey, ownerToken, maxHoldMs);
  if (!acquired && wait) {
    const deadline = Date.now() + lockTimeoutMs;
    let delay = POLL_INITIAL_MS;
    while (!acquired) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AdvisoryLockTimeoutError(domain, lockKey, lockTimeoutMs);
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, POLL_MAX_MS);
      acquired = await attemptLease(domain, lockKey, ownerToken, maxHoldMs);
    }
  }
  if (!acquired) return { acquired: false };

  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    await releaseLease(domain, lockKey, ownerToken, maxHoldMs);
  }
}

/**
 * Run `fn` with the named lock held, waiting up to `lockTimeoutMs` for it.
 *
 * Use when the work must happen and merely needs to not happen twice at once:
 * the calendar create-versus-PATCH decision, an OAuth token refresh.
 *
 *   await withLock('CALENDAR_SYNC', `${userId}:${entityId}`, async () => {
 *     // re-read the writeback ids here, inside the lock
 *   });
 *
 * @throws {AdvisoryLockTimeoutError} if the lock was not free in time.
 */
export async function withLock<T>(
  domain: string,
  key: string,
  fn: () => T | Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const outcome = await runLocked(domain, key, fn, {
    wait: true,
    lockTimeoutMs: Number(options.lockTimeoutMs) > 0 ? Number(options.lockTimeoutMs) : DEFAULT_LOCK_TIMEOUT_MS,
    maxHoldMs: Number(options.maxHoldMs) > 0 ? Number(options.maxHoldMs) : DEFAULT_MAX_HOLD_MS,
  });
  return (outcome as { acquired: true; result: T }).result;
}

/**
 * Run `fn` only if the lock is free right now. Never waits.
 *
 * Use when "someone else is already doing this" is a fine answer: cron sweeps,
 * housekeeping passes, boot-time recovery. The caller gets a discriminable
 * result rather than an exception, because skipping is a normal outcome and
 * not an error.
 *
 *   const outcome = await tryLock('CRON_PASS', 'reminders', run);
 *   if (!outcome.acquired) return res.status(200).json({ status: 'skipped' });
 */
export async function tryLock<T>(
  domain: string,
  key: string,
  fn: () => T | Promise<T>,
  options: LockOptions = {},
) {
  return runLocked(domain, key, fn, {
    wait: false,
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    maxHoldMs: Number(options.maxHoldMs) > 0 ? Number(options.maxHoldMs) : DEFAULT_MAX_HOLD_MS,
  });
}
