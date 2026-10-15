/**
 * Blanket timing for every statement the app sends to Postgres, plus telemetry
 * on how long requests wait for a pool connection.
 *
 * Two questions this answers that nothing else in the app can:
 *
 *   1. Which statements are slow, and on which feature. Individual reads can be
 *      wrapped in `timedRead()` by hand, but that only covers the reads someone
 *      already suspected. This covers all of them, and tags each one with the
 *      route in flight (see `requestContext`) so a log line names a feature
 *      rather than a bare SQL string.
 *   2. Whether the pool is saturated. A saturated pool surfaces downstream as
 *      request timeouts and 500s that look like unrelated bugs, and
 *      `/api/health` cannot see it because it never touches the pool. Timing
 *      the checkout itself is the only direct signal.
 *
 * ## Where it hooks in, and what that misses
 *
 * Instrumentation is installed on `pool.connect`, not on `pool.query`, because
 * `Pool.prototype.query` is itself implemented as connect-then-`client.query`.
 * Hooking the client covers both ways this codebase reaches the database —
 * Drizzle over the shared pool and Drizzle attached to a checked-out client for
 * transactions or advisory locks — with one wrapper and no double-counting.
 *
 * Known blind spots, deliberately accepted:
 *
 *   - Statements issued through a pg `Submittable` (a cursor, `COPY`) pass
 *     through untimed. The codebase has none today.
 *   - Statement duration is the client-side round trip, so it includes network
 *     latency to Supabase but not the connection checkout, which is measured
 *     separately and reported on its own.
 *   - Migrations applied by `db/run-sql.ts` run in their own process and are
 *     not covered.
 *
 * Logging is best-effort by construction: every emit is wrapped so a logging
 * fault can never turn into a failed query.
 */

const { logger } = require('../utils/logger');
const { getRequestContext } = require('../utils/requestContext');

/**
 * Statement duration past which a log line is emitted. 200ms is well above a
 * healthy indexed read against the pooler and well below anything a user would
 * describe as slow, so a line appearing means "worth a look", not "broken".
 * Set to 0 or below to disable statement logging entirely.
 */
export const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_LOG_MS ?? 200);

/**
 * Checkout wait past which pool saturation is reported. Any nonzero wait means
 * every connection was busy; 500ms means it stayed that way long enough to be
 * eating into the request's own budget.
 *
 * One expected non-saturation hit: on a cold instance the first checkout has to
 * establish a TCP+TLS connection to the pooler, which costs a few hundred ms and
 * is reported here with `total: 1, waiting: 0`. That is worth seeing rather than
 * suppressing — nothing warms the pool at boot, so it is the real first-request
 * latency a freshly scaled-out instance serves.
 */
export const POOL_WAIT_MS = Number(process.env.POOL_WAIT_LOG_MS ?? 500);

/** Longest SQL prefix kept in a log line. Enough to identify the statement. */
const SQL_LOG_MAX_CHARS = 300;

/** Marks a client whose `query` has already been wrapped, so re-checkout is a no-op. */
const INSTRUMENTED = Symbol('paralegix.queryInstrumented');

/**
 * Collapse a statement to a single line and cap its length.
 *
 * Only the SQL text is ever logged, never the parameters: parameters are where
 * client names, note bodies, and email addresses live.
 */
function summarizeSql(text: unknown) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > SQL_LOG_MAX_CHARS ? `${flat.slice(0, SQL_LOG_MAX_CHARS)}...` : flat;
}

function elapsedMs(startedAt: bigint) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/**
 * The request context to blame for a database call, captured at call time.
 *
 * Capturing eagerly is not an optimization, it is required for correctness.
 * `pg` delivers query results by invoking a stored callback from the
 * connection's event handlers, and those handlers were bound in whatever async
 * context happened to create the client — usually a long-finished request, or
 * boot. Reading the context at completion time therefore reports the wrong
 * route rather than no route, which is worse than useless in a log meant to
 * point at a feature. Reading it synchronously, before any await, is the only
 * point at which the caller's context is reliably the caller's.
 */
function captureContext() {
  const ctx = getRequestContext();
  return ctx ? { route: `${ctx.method} ${ctx.route}`, requestId: ctx.requestId } : null;
}

function logSlowStatement(ctx: any, text: unknown, durationMs: number, rowCount: number | null) {
  try {
    if (!(SLOW_QUERY_MS > 0) || durationMs < SLOW_QUERY_MS) return;
    logger.warn({
      event: 'slow-query',
      sql: summarizeSql(text),
      durationMs: Math.round(durationMs),
      rowCount: typeof rowCount === 'number' ? rowCount : null,
      route: ctx ? ctx.route : null,
      requestId: ctx ? ctx.requestId : null,
    }, `[slow-query] ${Math.round(durationMs)}ms ${summarizeSql(text)}`);
  } catch {
    // A logging fault must never fail the query that triggered it.
  }
}

function logPoolWait(ctx: any, pool: any, durationMs: number) {
  try {
    if (!(POOL_WAIT_MS > 0) || durationMs < POOL_WAIT_MS) return;
    logger.warn({
      event: 'pool-wait',
      waitMs: Math.round(durationMs),
      // pg's own counters: `total` connections open, of which `idle` are free,
      // and `waiting` checkouts already queued behind them. `waiting > 0` on a
      // quiet environment means the pool is sized wrong, not that traffic spiked.
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: pool.options && pool.options.max,
      route: ctx ? ctx.route : null,
      requestId: ctx ? ctx.requestId : null,
    }, `[pool-wait] waited ${Math.round(durationMs)}ms for a connection`);
  } catch {
    // As above: telemetry never breaks the caller.
  }
}

/**
 * Wrap `client.query` so every statement it runs is timed. Idempotent, because
 * the same client object is handed out again on every checkout.
 */
function instrumentClient(client: any) {
  if (!client || client[INSTRUMENTED]) return client;
  client[INSTRUMENTED] = true;

  const rawQuery = client.query.bind(client);

  client.query = function instrumentedQuery(this: any, config: any, values?: any, callback?: any) {
    // Submittables (cursors, COPY streams) drive their own protocol exchange
    // and have no single completion this wrapper could time. Pass them through.
    if (config && typeof config.submit === 'function') {
      return rawQuery(config, values, callback);
    }

    const text = typeof config === 'string' ? config : (config && config.text) || '<unknown>';
    const ctx = captureContext();
    const startedAt = process.hrtime.bigint();

    // pg accepts (text, callback) as well as (text, values, callback).
    let params = values;
    let done = callback;
    if (typeof params === 'function') {
      done = params;
      params = undefined;
    }

    if (typeof done === 'function') {
      return rawQuery(config, params, (err: any, res: any) => {
        logSlowStatement(ctx, text, elapsedMs(startedAt), res && res.rowCount);
        done(err, res);
      });
    }

    return rawQuery(config, params).then(
      (res: any) => {
        logSlowStatement(ctx, text, elapsedMs(startedAt), res && res.rowCount);
        return res;
      },
      (err: any) => {
        // Timed in the failure path too: a statement that hits the 30s
        // `statement_timeout` is exactly the one worth a log line.
        logSlowStatement(ctx, text, elapsedMs(startedAt), null);
        throw err;
      },
    );
  };

  return client;
}

/**
 * Install timing on a `pg.Pool`, in place. Returns the same pool.
 *
 * Wrapping `connect` rather than `query` is load-bearing; see the module
 * comment. It also means a pool-backed Drizzle query reports its checkout wait and its
 * statement duration as two separate numbers, which is what makes "the query is
 * fine, the pool is full" distinguishable from "the query is slow".
 */
export function instrumentPool(pool: any) {
  const rawConnect = pool.connect.bind(pool);

  pool.connect = function instrumentedConnect(this: any, callback?: any) {
    const ctx = captureContext();
    const startedAt = process.hrtime.bigint();

    if (typeof callback === 'function') {
      return rawConnect((err: any, client: any, release: any) => {
        logPoolWait(ctx, pool, elapsedMs(startedAt));
        callback(err, instrumentClient(client), release);
      });
    }

    return rawConnect().then(
      (client: any) => {
        logPoolWait(ctx, pool, elapsedMs(startedAt));
        return instrumentClient(client);
      },
      (err: any) => {
        // A checkout that times out at `connectionTimeoutMillis` is the loudest
        // possible saturation signal, so report its wait before rethrowing.
        logPoolWait(ctx, pool, elapsedMs(startedAt));
        throw err;
      },
    );
  };

  return pool;
}
