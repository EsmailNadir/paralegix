import { types } from 'pg';

const parseTimestamptz = types.getTypeParser(1184, 'text');
const arrayParser = types.arrayParser as unknown as {
  create(value: string, transform: (entry: string) => unknown): { parse(): unknown[] };
};

/**
 * Drizzle's raw SQL execution preserves PostgreSQL array literals because it
 * cannot infer a column decoder from an untyped result. Normalize the one
 * timestamptz-array value currently returned by a compatibility SQL query.
 */
export function timestamptzArray(value: unknown): Array<Date | string> {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '') return [];
  return arrayParser.create(value, parseTimestamptz).parse() as Array<Date | string>;
}
