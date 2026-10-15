/**
 * Zod fragments for the query strings the server-side list and typeahead reads
 * accept.
 *
 * Every paginated list grew the same three groups of query params independently:
 * `page`/`limit`/`offset`, `sortBy`/`order`/`sort`, and the typeahead's
 * `search`/`ids`/`limit`. The sort model in particular was a hand-built regex
 * repeated in five modules, where a stray edit to one copy would accept a
 * direction the repository does not honour. These builders return plain objects
 * meant to be spread into a module's own `z.object({ query: … })`, so a schema
 * still reads as one shape and can add its own domain filters alongside.
 *
 * The `limit` ceilings differ by domain (a list page vs. a typeahead vs. the
 * billing windows), so `max` is always explicit rather than defaulted.
 */

import { z } from 'zod';

const { MAX_PAGE_OFFSET } = require('../database/pagination');
const { isValidCalendarDateString } = require('./calendarDate');

/**
 * Largest `page` number any list accepts, paired with `MAX_PAGE_OFFSET`.
 *
 * Bounding `offset` alone would not bound the read, because `page` is multiplied
 * by the page size to derive one. Set from the smallest page size a caller can
 * ask for (1 row) so the page number can never describe a deeper window than a
 * raw `offset` may.
 */
export const MAX_PAGE_NUMBER = MAX_PAGE_OFFSET;

/** `offset`, bounded so a deep window can't turn one request into two full scans. */
export const offsetParam = z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).optional();

/** 1-based `page`. `offset` still wins downstream when both are supplied. */
export const pageParam = z.coerce.number().int().min(1).max(MAX_PAGE_NUMBER).optional();

/**
 * The compact multi-column sort model: `field:dir,field:dir` over `fields`.
 *
 * Validated as a whole-string regex so an unknown field is a 400 rather than a
 * value the repository silently drops from the ORDER BY. `fields` must mirror
 * the repository's SORT_COLUMNS whitelist for that entity.
 */
export function sortModel(fields: readonly string[]) {
  const alt = fields.join('|');
  return z.string()
    .regex(new RegExp(`^(${alt}):(asc|desc)(,(${alt}):(asc|desc))*$`), 'Unsupported sort model')
    .optional();
}

/**
 * `page` / `limit` / `offset`.
 *
 * All optional: omitting `limit` is what preserves each list's unpaginated
 * contract for the callers that still need the full set. `offset` wins over
 * `page` downstream when both are sent.
 */
export function paging({ max, withOffset = true }: { max: number; withOffset?: boolean }) {
  return {
    page: pageParam,
    limit: z.coerce.number().int().min(1).max(max).optional(),
    ...(withOffset ? { offset: offsetParam } : {}),
  };
}

/** `sortBy` / `order` (single column) plus the multi-column `sort` model. */
export function sorting<T extends string>(fields: readonly [T, ...T[]]) {
  return {
    sortBy: z.enum(fields).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    // Multi-column sort model: "field:dir,field:dir" over the whitelisted fields.
    sort: sortModel(fields),
  };
}

/**
 * The shape every `/lookup` typeahead shares: a search term, a comma-separated
 * `ids` list for resolving the label of an already-saved selection, and a page
 * size. Domain-specific scoping flags are added by the caller.
 */
export function lookup({ max }: { max: number }) {
  return {
    search: z.string().max(500).optional(),
    // Comma-separated ids, used to resolve labels for an existing selection.
    ids: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(max).optional(),
  };
}

/** A day-only 'YYYY-MM-DD' bound, for range filters over `date` columns. */
export const dayOnly = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')
  .refine(isValidCalendarDateString, { message: 'Must be a real calendar date' });

/**
 * The inclusive `from`/`to` day window the calendar reads use.
 *
 * Both are optional and only take effect together: a request with neither keeps
 * the endpoint's unwindowed full-set contract, which is what the non-calendar
 * callers still rely on. The service layer resolves the pair through
 * `shared/utils/calendarRange`, which rejects a half-supplied or inverted window.
 */
export function dateWindow() {
  return {
    from: dayOnly.optional(),
    to: dayOnly.optional(),
  };
}
