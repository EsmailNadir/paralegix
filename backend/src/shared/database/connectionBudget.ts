/**
 * One connection budget, from which every concurrency constant is derived.
 *
 * The problem this solves is that the pool size and the dashboard's fan-out
 * limit were being chosen independently, in different documents, against
 * different assumptions. That is how you end up with a fan-out limit larger
 * than the pool it draws from while every guard still reports green.
 *
 * Two inputs, everything else derived:
 *
 *   PG_POOL_MAX                = floor(POOLER_CEILING_SAFE / MAX_INSTANCES)
 *   DASHBOARD_CONNECTION_CAPACITY = PG_POOL_MAX - RESERVE
 *
 * `DASHBOARD_CONNECTION_CAPACITY` used to be a section-COUNT limit
 * (`DASHBOARD_CONCURRENCY = max(2, floor(capacity / AVG_QUERIES_PER_SECTION))`),
 * admitting `N` sections at a time on the assumption that every section costs
 * the pool the same "average" number of connections. That assumption was
 * false: several dashboard sections run their own internal `Promise.all` of
 * 2-4 simultaneous queries (the financial snapshot alone peaks at 4), so a
 * handful of "average" sections could mask a burst of "heavy" ones running
 * together and put more connections in flight than the pool actually has --
 * which surfaced as `pool.connect()` timeouts on an arbitrary section, not
 * necessarily the expensive one, once the pool ran dry. The caller now owns a
 * real per-section connection WEIGHT (see `dashboard.service.ts`) and admits
 * work against this raw capacity number via `runWithWeightedConcurrency`,
 * instead of the count-based approximation.
 *
 * ## Why the ceiling is what it is
 *
 * `DATABASE_URL` is the Supabase **session** pooler (Supavisor) on port 5432.
 * Session mode hands every client connection a real Postgres backend with no
 * multiplexing, so the per-instance pool multiplied by the instance count must
 * fit inside the pooler's `pool_size`, which is 20 on the current tier (raised
 * from the Nano default of 15 on 2026-09-16). That is
 * the limit that binds, not the server's `max_connections` (60 on staging). A
 * connection past it is not queued: Supavisor refuses it at once with
 * `(EMAXCONNSESSION) max clients reached in session mode`, and the query that
 * wanted it fails.
 *
 * This ceiling was once sized against `max_connections` at 40. One instance then
 * derived a pool of 40, and the first page load after an idle period (an empty
 * pool, every request opening connections together) went past the pool size, so whole
 * dashboard sections failed. `POOLER_CEILING_SAFE` defaults to 17: the pool size
 * less 3 for the things that connect outside the app, a migration run, a `psql`
 * session, the Supabase dashboard. It tracks `pool_size`, so raising one without
 * the other either wastes the headroom or reintroduces the refusal. Past the local pool's `max`, a checkout waits
 * for `connectionTimeoutMillis` instead of being refused.
 *
 * Read `pool_size` per environment in the Supabase dashboard (Database,
 * Connection pooling), and raise it there before raising this.
 *
 * ## Why this file does nothing until MAX_INSTANCES is set
 *
 * The instance count is a deployment decision. `cloudbuild.yaml` pins it for
 * current API deployments and passes the same value into the container. Keeping
 * the unset fallback still matters for local runs and older revisions: with
 * `MAX_INSTANCES` unset the module reproduces the pre-budget pool and says so at
 * startup; set it deliberately, and the derivation takes over.
 */

/** Connections the app may consume across all instances. See above. */
export const POOLER_CEILING_SAFE = Number(process.env.POOLER_CEILING_SAFE) || 17;

/**
 * Connections held back inside each instance's pool for work that is not the
 * fan-out being sized: an unrelated request arriving mid-dashboard, the rate
 * limiter's per-request write, a cron pass holding an advisory lock.
 */
export const RESERVE = Number(process.env.PG_POOL_RESERVE) || 3;

/** Pool size before this budget existed. The fallback when nothing is configured. */
const DEFAULT_POOL_MAX = 10;

/**
 * Cloud Run `--max-instances`. Unset means "not yet decided", not "one" -- see
 * the module comment for why that distinction changes the behaviour here.
 */
export const MAX_INSTANCES = Number(process.env.MAX_INSTANCES) > 0 ? Number(process.env.MAX_INSTANCES) : null;

function computeBudget() {
  if (MAX_INSTANCES === null) {
    const poolMax = Number(process.env.PG_POOL_MAX) || DEFAULT_POOL_MAX;
    return { derived: false, maxInstances: null, poolMax };
  }
  const poolMax = Number(process.env.PG_POOL_MAX) || Math.floor(POOLER_CEILING_SAFE / MAX_INSTANCES);
  return { derived: true, maxInstances: MAX_INSTANCES, poolMax };
}

const budget = computeBudget();

/**
 * The invariant that actually matters, asserted at import time.
 *
 * Throwing at import is intentional: a misconfigured budget should stop a
 * deployment at boot, where Cloud Run will refuse the revision and keep serving
 * the old one, rather than surfacing later as connection timeouts under load.
 */
function assertBudget(b: { poolMax: number; derived: boolean; maxInstances: number | null }): void {
  if (b.poolMax - RESERVE < 1) {
    throw new Error(
      `[connection-budget] Invalid configuration: PG_POOL_MAX is ${b.poolMax} but RESERVE is `
      + `${RESERVE}, leaving no connections for the dashboard fan-out (or anything else). `
      + `Raise PG_POOL_MAX, lower PG_POOL_RESERVE, or lower MAX_INSTANCES.`
    );
  }
  if (b.derived && b.maxInstances && b.poolMax * b.maxInstances > POOLER_CEILING_SAFE) {
    throw new Error(
      `[connection-budget] Invalid configuration: ${b.maxInstances} instances x PG_POOL_MAX `
      + `${b.poolMax} = ${b.poolMax * b.maxInstances} connections, above the safe pooler ceiling `
      + `of ${POOLER_CEILING_SAFE}. The session pooler holds a real backend per connection, so `
      + `this overruns the database rather than merely queueing.`
    );
  }
}

assertBudget(budget);

export const PG_POOL_MAX = budget.poolMax;
/**
 * The most connections ONE dashboard request may hold at once: the heaviest
 * section (`financial`, weight 4) plus the owner/admin probe that runs beside the
 * batch.
 *
 * The pool is shared by every request on the instance. Sized only against the
 * pool, one dashboard load would take nearly all of it and every other user's
 * request would queue behind that one page. Capping the request instead means
 * the dashboard runs its sections in a few small batches, which costs it tens of
 * milliseconds, and the rest of the pool stays free for everyone else.
 */
export const DASHBOARD_REQUEST_CONNECTIONS = 5;

/**
 * Connections available for the dashboard's weighted section fan-out (see
 * `dashboard.service.ts`): the per-request cap above, or less when the pool
 * after `RESERVE` is smaller still. Not a section count -- callers admit work by
 * summed connection WEIGHT against this number via `runWithWeightedConcurrency`.
 */
export const DASHBOARD_CONNECTION_CAPACITY = Math.max(
  1,
  Math.min(DASHBOARD_REQUEST_CONNECTIONS, budget.poolMax - RESERVE),
);
export const BUDGET_DERIVED = budget.derived;
