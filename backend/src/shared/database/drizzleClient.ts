import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import * as schema from './drizzle/schema';

// `require` rather than `import`: db.js is CommonJS and exports a live pool
// instance, and this file compiles to CommonJS anyway.
const { pool } = require('./db');

/**
 * Drizzle over the SAME pool the rest of the app uses.
 *
 * Not a second connection, deliberately. Two reasons:
 *
 *  - The connection budget in `connectionBudget.js` sizes ONE pool against the
 *    Supabase session pooler's ceiling. A second pool would silently double the
 *    per-instance connection count and break arithmetic that is asserted at boot.
 *  - `db.ts` installs a type parser for oid 1082 so day-only `date` columns come
 *    back as raw 'YYYY-MM-DD' strings instead of being parsed at local midnight.
 *    That parser is registered on the `pg` module, so sharing the pool keeps one
 *    set of type semantics rather than two that have to be kept in sync.
 *
 * Sharing the pool is not by itself enough to guarantee that last point. Drizzle
 * sends its own `getTypeParser` with every statement and stubs the date/time and
 * numeric-array oids out to the identity function; a typed query undoes that in
 * its column mappers, but a raw `execute()` has none and would hand back raw
 * Postgres text. `pgTypeRestore.ts` re-applies the module's parsers on the raw
 * path so both paths agree.
 *
 * Query builder only. Migration ownership remains in db/schema.sql and the
 * numbered SQL migrations; application queries migrate through this client.
 */
export const db = drizzle(pool, { schema });
export { schema };

/** Root and transaction executors share the query-builder surface used by the
 * scoped access layer. Deriving the transaction type keeps it pinned to the
 * installed node-postgres driver rather than restating Drizzle internals. */
export type DrizzleDatabase = typeof db;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase['transaction']>[0]>[0];

/** Attach Drizzle to an already-checked-out client when session affinity is required. */
export function drizzleExecutorForClient(client: PoolClient) {
  return drizzle(client, { schema });
}

export type DrizzleClientExecutor = ReturnType<typeof drizzleExecutorForClient>;
export type DrizzleExecutor = DrizzleDatabase | DrizzleTransaction | DrizzleClientExecutor;
