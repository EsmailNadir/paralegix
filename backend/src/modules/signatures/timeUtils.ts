/**
 * Shared timestamp coercion for the signatures module.
 *
 * Postgres returns timestamps as ISO strings (or JS Date for some driver paths);
 * the routes/repo/services historically each carried their own near-identical
 * coercion helper. These three primitives replace all of them:
 *
 *   toIso(value)  -> ISO string, or null when absent/unparseable
 *   toMs(value)   -> epoch milliseconds, or 0 when absent/unparseable
 *   toDbTs(value) -> a JS Date for binding to a timestamptz column, or null
 */

export function toIso(value: any) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toMs(value: any) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isNaN(value) ? 0 : value;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export function toDbTs(value: any) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
