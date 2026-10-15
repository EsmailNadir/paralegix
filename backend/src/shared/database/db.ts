/**
 * Postgres (Supabase) connection for the backend data layer. This is the sole
 * data store; Firebase Admin (`firebase.js`) is retained only for Auth + GCS.
 *
 * Exposes the one node-postgres pool used by Drizzle, instrumentation, and
 * session-affine advisory-lock work.
 */

require('dotenv').config();
const { Pool, types } = require('pg');
const { resolveDbUrl, needsSsl } = require('./resolveDbUrl');
const { instrumentPool } = require('./queryInstrumentation');
const { PG_POOL_MAX, BUDGET_DERIVED, MAX_INSTANCES, POOLER_CEILING_SAFE } = require('./connectionBudget');

// Return DATE columns (oid 1082) as raw 'YYYY-MM-DD' strings instead of JS Date
// objects, which node-pg would otherwise parse at local midnight and risk a
// timezone shift. Day-only fields (entry_date, due_date, txn_date, ...) stay exact.
types.setTypeParser(1082, (v: string) => v);

// node-postgres leaves timestamptz[] (oid 1185) as a PostgreSQL array literal
// even though it parses scalar timestamptz values. Reuse pg's array tokenizer
// so invoice reminder history has the same Date[] runtime shape Drizzle models.
const parseTimestamptz = types.getTypeParser(1184, 'text');
types.setTypeParser(1185, (value: string) =>
  types.arrayParser.create(value, parseTimestamptz).parse());

const connectionString = resolveDbUrl();
if (!connectionString) {
  // Don't throw at import time — a misconfigured DB should surface as a loud
  // query failure rather than a module that refuses to load.
  console.warn('[db] No database URL resolved (DB_TARGET / DATABASE_URL). Postgres queries will fail until configured.');
}

// Every timeout here exists to bound how long ONE bad query or connection can
// hold a slot in a pool of `max`. Without them a single hung statement pins its
// connection forever and, once `max` of them pile up, `pool.connect()` waits
// forever too — the whole API stops serving with no error to point at.
export const pool = new Pool({
  connectionString,
  // Pins every session's Postgres `TimeZone` GUC to UTC, so `current_date`/
  // `now()`/a `date` column's `default CURRENT_DATE` always agree with the
  // app's own UTC-anchored day math (shared/utils/time.ts, localTime.ts).
  // Before this it was inherited from whatever the connection target
  // (Supabase project, the local Podman container, a future pooler) happened to
  // default to - undeclared anywhere, and never actually wrong only because
  // every one of those has defaulted to UTC so far. `invoices.repository.ts`'s
  // overdue-invoice query and `digest.repository.ts`'s retention purge both
  // compare a day-only column against `current_date` directly; this is what
  // makes that comparison deterministic instead of environment-dependent.
  options: '-c TimeZone=UTC',
  ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  // Derived, not chosen here: the session pooler gives every connection a real
  // Postgres backend, so this number multiplied by the instance count must fit
  // inside the pooler's pool_size. See connectionBudget.ts.
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30000,
  // Fail a checkout that can't get a connection instead of queueing forever, so
  // a saturated pool surfaces as a 500 on the request that caused it.
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000),
  // Server-side ceiling on a single statement. Generous enough for the heaviest
  // reporting reads (billing analytics, the workbench) and far below any
  // human-noticeable hang.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30000),
  // A transaction left open by a code path that skipped its rollback holds row
  // locks indefinitely and blocks unrelated writers. Reap those.
  idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TX_TIMEOUT_MS || 60000),
});

pool.on('error', (err: any) => console.error('[db] idle client error:', err.message));

// State the budget once at boot. Without this the pool size is invisible until
// something saturates, and "which topology is this instance assuming" is the
// first question asked when it does.
console.log(BUDGET_DERIVED
  ? `[db] pool max ${PG_POOL_MAX} (derived: ceiling ${POOLER_CEILING_SAFE} / ${MAX_INSTANCES} instances)`
  : `[db] pool max ${PG_POOL_MAX} (MAX_INSTANCES unset, using the pre-budget default)`);

// Time every statement and every connection checkout. Drizzle is attached to
// this exact pool, so the instrumentation observes the complete query layer and
// checked-out session-affine clients. See `queryInstrumentation.ts` for details.
instrumentPool(pool);
