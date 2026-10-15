/**
 * Email-verification whitelist (test accounts that bypass email verification).
 *
 * TWO SOURCES, UNIONED:
 *  - EMAIL_VERIFICATION_WHITELIST env var (deploy-time, parsed once at load).
 *  - the `email_verification_whitelist` table (managed live from the admin panel).
 *
 * The DB set is cached in memory and refreshed on a timer so the auth middleware
 * check (`isWhitelisted`) stays synchronous and fast. Admin mutations call
 * `refresh()` directly so a newly-added address takes effect on the next request
 * instead of waiting for the timer.
 *
 * This is a security relaxation: any address here skips email verification. A
 * transient DB error must never widen the set or crash the auth path, so refresh
 * failures keep the last known-good set (env entries always remain).
 */

const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../database/infrastructureQuery');

// Env-var whitelist: the historically-configured, deploy-time source. Parsed once.
export const ENV_WHITELIST = (process.env.EMAIL_VERIFICATION_WHITELIST || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// The DB-managed portion, plus the union that `isWhitelisted` actually reads.
let dbWhitelist = new Set<string>();
let combined = new Set(ENV_WHITELIST);

function rebuild() {
  const next = new Set(ENV_WHITELIST);
  for (const e of dbWhitelist) next.add(e);
  combined = next;
}

/**
 * Reload the DB portion of the whitelist into memory. Never throws: on a DB
 * error we keep the previous set so an outage can't lock verified users out
 * (env entries are always present regardless).
 */
export async function refresh() {
  try {
    const { rows } = await infrastructureRootSql('select email from email_verification_whitelist');
    dbWhitelist = new Set(
      rows.map((r: any) => String(r.email || '').trim().toLowerCase()).filter(Boolean),
    );
    rebuild();
  } catch (err: any) {
    console.error('[emailWhitelist] refresh failed, keeping last known set:', err.message);
  }
}

/** Synchronous membership check against the cached env ∪ DB set. */
export function isWhitelisted(email: unknown) {
  const e = String(email || '').trim().toLowerCase();
  return e ? combined.has(e) : false;
}

// Initial load + periodic refresh so admin-panel changes propagate without a
// redeploy even if a mutation's direct refresh() is missed (e.g. multi-instance).
//
// REFRESH INTERVAL IS A SECURITY BOUND, NOT A CACHE TUNING KNOB. This set is a
// relaxation: an address in it SKIPS email verification. Additions being slow to
// propagate is a mild inconvenience — someone waits to sign in. Removals being
// slow is the real direction: after an admin deletes an entry, every instance
// that has not refreshed keeps honouring it, so the address keeps bypassing
// verification for up to one interval. A direct `refresh()` on mutation only
// clears the instance that served the request, which is exactly the gap this
// interval has to cover.
//
// 15s rather than 60s, because the query is a single scan of a table with a
// handful of rows and four times almost nothing is still almost nothing, while
// it cuts the window a revoked address stays usable to a quarter.
//
// `isWhitelisted` stays synchronous deliberately. It is called from
// `isEmailVerifiedToken` on the token-verification path, which is sync all the
// way up; making the whitelist authoritative per-call would mean a database
// round trip inside auth, which is a worse trade than a bounded 15s window on a
// set this small.
refresh();
// The periodic refresh is not scheduled under test. It queries the database
// every fifteen seconds for the life of the process, and the app is loaded once
// per Jest worker, so in a suite that runs longer than that it fires repeatedly
// inside unrelated spec files: against a pool one of them is closing, or after
// Jest has torn the environment down, which surfaces as "Cannot log after tests
// are done" and can hang up a request that was in flight.
//
// `unref()` stops the timer holding the event loop open; it does not stop it
// firing. The initial `refresh()` above still runs, so the loaded set is
// unchanged, and `refresh()` stays exported for a spec that wants to reload it
// deliberately.
if (process.env.NODE_ENV !== 'test') {
  const timer = setInterval(refresh, 15 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}
