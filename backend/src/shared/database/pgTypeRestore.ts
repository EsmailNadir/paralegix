/**
 * Restore node-postgres type parsing on rows returned by a raw Drizzle
 * `execute()`.
 *
 * Drizzle's node-postgres driver attaches its own `getTypeParser` to every
 * statement it sends and makes it the identity function for the date/time and
 * numeric-array oids listed below (see `drizzle-orm/node-postgres/session.js`).
 * On a *typed* query that is invisible: the column mappers built from the
 * Drizzle schema convert each value afterwards, so a `timestamptz` still
 * arrives as a `Date`. A raw `execute()` has no column mappers, so those
 * columns leak out as raw Postgres text — `'2026-07-07 06:24:19.343276+00'`
 * instead of a `Date`.
 *
 * That breaks the contract the rest of the backend is written against, where a
 * `timestamptz` is a `Date` and is shaped for the API with `rowIso()`. Callers
 * that indexed straight into `.toISOString()` threw `TypeError`; callers that
 * guarded with `instanceof Date` silently emitted non-ISO strings on the wire.
 *
 * Re-applying `pg`'s parsers puts the two paths back on one set of type
 * semantics — including this app's own overrides, because `getTypeParser`
 * resolves against the same `pg` module `db.ts` registers them on. Day-only
 * `date` (1082) therefore stays a raw `'YYYY-MM-DD'` string and `timestamptz[]`
 * (1185) still goes through the array tokenizer, exactly as before.
 */

const { types } = require('pg');

/** The oids Drizzle stubs out with an identity parser on the raw path. */
const STUBBED_OIDS = new Set([
  1082, // date
  1114, // timestamp
  1115, // timestamp[]
  1182, // time[]
  1184, // timestamptz
  1185, // timestamptz[]
  1186, // interval
  1187, // date[]
  1231, // numeric[]
]);

interface PgField {
  name: string;
  dataTypeID: number;
}

interface PgResultLike {
  rows?: Record<string, unknown>[];
  fields?: PgField[];
}

/**
 * Re-parse the affected columns in place and return the same result object.
 *
 * Only columns whose oid Drizzle stubbed are touched, and only while the value
 * is still the raw `string` the identity parser left behind, so running this
 * over an already-correct result is a no-op.
 */
export function restorePgTypes<TResult>(result: TResult): TResult {
  const pgResult = result as PgResultLike | null;
  const rows = pgResult?.rows;
  const fields = pgResult?.fields;
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(fields)) return result;

  const affected: { name: string; parse: (value: string) => unknown }[] = [];
  for (const field of fields) {
    if (!STUBBED_OIDS.has(field.dataTypeID)) continue;
    affected.push({ name: field.name, parse: types.getTypeParser(field.dataTypeID, 'text') });
  }
  if (!affected.length) return result;

  for (const row of rows) {
    for (const { name, parse } of affected) {
      const value = row[name];
      if (typeof value === 'string') row[name] = parse(value);
    }
  }
  return result;
}
