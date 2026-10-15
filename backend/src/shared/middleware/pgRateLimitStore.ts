const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');

/**
 * express-rate-limit (v8) Store backed by Postgres (the `rate_limits` table), so
 * per-IP / per-token limits are coordinated across ALL backend instances instead
 * of being counted per-process in memory (the default MemoryStore is per-instance,
 * which on multi-instance Cloud Run lets the effective cap scale with instances).
 *
 * Fail-open: on ANY DB error (including the table not existing yet) the limiter
 * ALLOWS the request and logs, rather than 500-ing legitimate traffic on a DB
 * hiccup. The critical brute-force control (the signing access-code/OTP hard cap)
 * is enforced separately and durably in the signature tables, so a degraded
 * limiter never removes the real protection. (This also makes the code safe to
 * deploy before the migration is applied: limiters simply no-op until the table
 * exists.)
 *
 * Create ONE store per limiter, each with a unique `prefix`, so different limiters
 * don't share a keyspace in the shared table.
 *
 * KEEP THIS STORE. A performance review once observed that this costs an
 * `insert ... on conflict do update` on the request path, and noted that under a
 * single-instance topology an in-process counter would be free and just as
 * correct. That is no longer the topology being designed for: the whole point of
 * the multi-instance work is that instance count is a knob, and a MemoryStore
 * makes the effective cap scale with it — a 100/min limit becomes 400/min at
 * four instances, silently. Cross-instance correctness is exactly what is being
 * paid for here.
 *
 * The per-request write IS budgeted: it means every rate-limited request costs a
 * connection checkout before it costs a handler, which is why the connection
 * budget holds connections in reserve. If slow-query data ever shows this is
 * material, the follow-up is in-process counting with periodic reconciliation
 * against this table — not removing it.
 */
// Expired windows are pruned by ONE timer for the whole process, not one per
// store. The DELETE is not prefix-scoped (an expired row is expired for every
// limiter), so a timer per store meant ~20 identical full-table deletes every
// interval. Unref'd so it can't keep the process alive; the DELETE is
// idempotent, so several server instances running it concurrently is harmless.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    infrastructureRootSql('delete from rate_limits where expires_at <= now()').catch(() => {});
  }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

export function createPgRateLimitStore(prefix: string) {
  if (!prefix) throw new Error('createPgRateLimitStore requires a unique prefix');
  let windowMs = 60 * 1000;
  const k = (key: string) => `${prefix}:${key}`;

  return {
    // Keys live in a shared DB, not local to this process.
    localKeys: false,
    prefix: `${prefix}:`,

    init(options: { windowMs?: number } & Record<string, unknown>) {
      windowMs = options.windowMs ?? windowMs;
      startSweep();
    },

    async increment(key: string) {
      try {
        // Atomic upsert: a fresh/expired window resets to 1 with a new expiry;
        // an active window increments. Single statement → no read-modify-write race.
        const { rows } = await infrastructureRootSql(
          `insert into rate_limits (key, hits, expires_at)
             values ($1, 1, now() + $2::bigint * interval '1 millisecond')
           on conflict (key) do update set
             hits = case when rate_limits.expires_at <= now() then 1 else rate_limits.hits + 1 end,
             expires_at = case when rate_limits.expires_at <= now()
                               then excluded.expires_at else rate_limits.expires_at end
           returning hits, expires_at`,
          [k(key), windowMs],
        );
        const r = rows[0];
        return {
          totalHits: Number(r.hits),
          resetTime: r.expires_at instanceof Date ? r.expires_at : new Date(r.expires_at),
        };
      } catch (err: any) {
        console.error('[pgRateLimitStore] increment failed (failing open):', err.message);
        return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
      }
    },

    async decrement(key: string) {
      try {
        await infrastructureRootSql(
          'update rate_limits set hits = greatest(0, hits - 1) where key = $1 and expires_at > now()',
          [k(key)],
        );
      } catch (err: any) {
        console.error('[pgRateLimitStore] decrement failed:', err.message);
      }
    },

    async resetKey(key: string) {
      try {
        await infrastructureRootSql('delete from rate_limits where key = $1', [k(key)]);
      } catch (err: any) {
        console.error('[pgRateLimitStore] resetKey failed:', err.message);
      }
    },

    async resetAll() {
      try {
        await infrastructureRootSql('delete from rate_limits where key like $1', [`${prefix}:%`]);
      } catch (err: any) {
        console.error('[pgRateLimitStore] resetAll failed:', err.message);
      }
    },

    // Deliberately does NOT stop the sweep: the timer is shared by every store
    // in the process, so tearing down one limiter must not leave the others
    // without a pruner. It is unref'd, so it never holds the process open.
    shutdown() {},
  };
}
