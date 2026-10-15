/**
 * A hard ceiling on a list read that has no page size of its own.
 *
 * A few repository reads select every row for a parent and hand the whole array
 * back: every event on a matter, every event in a firm, every expense on a
 * matter. Each one is bounded only by how long the customer has been using the
 * product, on a 512 MiB container shared with document signing. A firm with
 * years of history is the case that runs it out of memory, and it is also the
 * customer least able to lose the data.
 *
 * The ceiling is deliberately NOT a `limit` that returns a short array. These
 * reads feed totals, dependency graphs and calendars, so a silently truncated
 * answer reads as "there is nothing else", which is a wrong number rather than
 * a slow one. Instead the query asks for one row more than the ceiling. Getting
 * that extra row proves the answer would have been incomplete, and the read
 * fails with something the caller can act on.
 *
 * So the ceiling is a guard against a pathological row count, not a pagination
 * mechanism. Both event repositories already have a paged read beside these for
 * the screens that page.
 */
import { AppError } from '../errors/AppError';

/**
 * Rows one unpaged read may return.
 *
 * Sized to be far above any real parent (a heavily used matter holds hundreds of
 * events, not thousands) and far below what threatens the container. It exists
 * to convert an unbounded read into a bounded one, so the exact value matters
 * much less than that there is one.
 */
export const READ_CEILING = Number(process.env.UNPAGED_READ_CEILING) || 5000;

/** Ask for one row past the ceiling, so hitting it is detectable. */
export function ceilingLimit(ceiling: number = READ_CEILING): number {
  return ceiling + 1;
}

/**
 * A list read returned more rows than the ceiling allows.
 *
 * 400 rather than 500: nothing is broken, the request asked for more than this
 * endpoint returns in one answer, and the fix is to narrow it. The message names
 * the parent so the response says which one.
 */
export class ReadCeilingExceededError extends AppError {
  readonly what: string;
  readonly ceiling: number;

  constructor(what: string, ceiling: number) {
    super(
      `This request would return more than ${ceiling} ${what}. `
      + 'Narrow it to a date range or use the paged endpoint.',
      400,
      'READ_CEILING_EXCEEDED',
    );
    this.what = what;
    this.ceiling = ceiling;
  }
}

/**
 * Return `rows` if the read stayed inside the ceiling, or throw.
 *
 * Pass the rows from a query that asked for `ceilingLimit()`. The extra row is
 * dropped on the way out, so a caller never sees it.
 */
export function withinCeiling<T>(rows: T[], what: string, ceiling: number = READ_CEILING): T[] {
  if (rows.length > ceiling) throw new ReadCeilingExceededError(what, ceiling);
  return rows;
}
