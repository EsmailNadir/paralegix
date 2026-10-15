// Lenient date-conversion helpers. Accept a Date or an ISO/parsable string and
// normalize it; invalid input becomes null rather than an Invalid Date.

export type DateLike = Date | string | null | undefined;

export function toDate(value: DateLike): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toIso(value: DateLike): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

export function toDayKey(value: DateLike): string | null {
  const date = toDate(value);
  return date ? date.toISOString().split('T')[0] : null;
}

/**
 * Shape one column of a Postgres row for the API: a `Date` becomes an ISO
 * string, anything else passes through untouched, and falsy becomes null.
 *
 * NOT interchangeable with `toIso`, which parses whatever it is given. Day-only
 * `date` columns arrive as raw `'YYYY-MM-DD'` strings -- `db.ts` registers a
 * type parser for oid 1082 precisely so they are never turned into Dates -- and
 * `toIso('2026-01-05')` would return `'2026-01-05T00:00:00.000Z'`, reintroducing
 * the timezone shift that parser exists to prevent. There are 24 such columns.
 * The pass-through arm is what keeps them intact.
 */
export function rowIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : ((value as string | null) || null);
}
