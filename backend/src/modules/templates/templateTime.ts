/**
 * Shared timestamp formatter for the templates / template-folders modules.
 *
 * Postgres (via Drizzle, or `sqlRowToEntity` for a raw read) already returns timestamptz columns as
 * ISO strings, so the common real inputs here are an ISO string or null. This
 * helper passes those through unchanged while also defensively coercing any
 * stray native `Date` to ISO. It is a strict superset of the previously
 * duplicated `ts()` helpers:
 *   - templates / templateFolders: `v instanceof Date ? v.toISOString() : v ?? null`
 * For the real (ISO string | null) inputs, both and this one agree.
 */
export function ts(value: any) {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}
