/**
 * Shape a raw Postgres row into the entity the API returns.
 *
 * Drizzle already does this for a query built from a table object: the row
 * comes back keyed by the schema's camelCase names. This is for the reads that
 * assemble their own SQL, where the row arrives keyed by the column names, and
 * it is the shaping the legacy `SqlRepository.toEntity` applied to everything.
 *
 * Three rules, all of which a caller has been caught assuming:
 *   - snake_case becomes camelCase;
 *   - a `Date` becomes an ISO string, because `timestamptz` comes back as a
 *     `Date` and every consumer of these entities expects the string. Express
 *     serializes a `Date` to the same thing on its way out, so dropping this
 *     looks harmless over HTTP and is not: an internal caller that formats or
 *     compares the value gets an object instead;
 *   - `search`, the generated tsvector, is dropped. It is an index, never a
 *     field, and returning it ships a large value nobody reads.
 */
export function sqlRowToEntity(row: Record<string, unknown> | undefined | null) {
  if (!row) return null;
  const entity: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (key === 'search') continue;
    const value = row[key];
    entity[toCamel(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return entity;
}

/** `law_firm_id` becomes `lawFirmId`. Digits count as the start of a word. */
export function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}
