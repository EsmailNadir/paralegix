/**
 * Shared SQL helpers for the server-side list reads (matters, clients, tasks and
 * anything else that pushes paging/sorting/counting into Postgres).
 *
 * Each of those reads independently grew the same three pieces: a whitelist-driven
 * ORDER BY, a clamped LIMIT/OFFSET appended to the caller's param array, and the
 * fallback count that covers an out-of-range page. They live here so the clamping
 * rules and the out-of-range behaviour stay identical across domains.
 */

// Required lazily inside `resolveWindowTotal` (the only function that touches
// it) so importing the pure paging helpers does not construct a Postgres pool.
// The route validation layer pulls in `MAX_PAGE_OFFSET` from here.

/**
 * Hard ceiling on the row offset any paged read will honour.
 *
 * A deep offset is not free: Postgres still produces and discards every row
 * before it, and an offset past the end returns an empty page, which sends
 * `resolveWindowTotal` to its fallback `count(*)` query. So `?page=100000000`
 * costs two full scans of the filtered set and returns nothing.
 *
 * Deliberately far above any reachable page: a million rows deep is 100,000
 * pages at the UI's default size of 10, and 5,000 pages at the largest page size
 * any route accepts. It exists to bound nonsense values, not to stop a firm with
 * a lot of data from paging through it.
 */
export const MAX_PAGE_OFFSET = 1_000_000;

/**
 * Clamp a caller-supplied page size into [1, max]. A missing, zero, or
 * unparseable value falls back to `fallback` rather than erroring, so a caller
 * that omits the parameter still gets a bounded query.
 */
export function clampLimit(value: any, { fallback = 50, max = 200 } = {}) {
  return Math.max(1, Math.min(Number(value) || fallback, max));
}

/**
 * Look `key` up in a whitelist object, treating only OWN keys as members.
 *
 * A plain `map[key]` also resolves inherited `Object.prototype` members, so a
 * caller asking to sort by `constructor` or `__proto__` gets a truthy non-column
 * back. In `buildOrderBy` that would be interpolated straight into the ORDER BY
 * and fail as a SQL syntax error rather than being skipped as an unknown field.
 * Route schemas whitelist the field names too, but this is the layer that
 * actually builds SQL, so it does not rely on that.
 */
export function whitelisted(map: any, key: any) {
  if (typeof key !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Resolve a caller's paging request into a concrete `{ limit, offset }`.
 *
 * `offset` wins over `page` when both are supplied, so an older `?limit=&offset=`
 * query string keeps working alongside the 1-based `page`. Shared by the SQL
 * reads (through `buildPageClause`) and the in-memory billing windows, so a page
 * number means the same row range whichever path serves it.
 *
 * The result is clamped to `MAX_PAGE_OFFSET`. The route schemas reject an
 * out-of-range `page`/`offset` outright, but this is the one place every paged
 * read resolves its window, so the bound holds even for a caller that builds its
 * params directly.
 */
export function resolvePage({ limit, offset, page, fallbackLimit = 50, max }: {
  limit?: unknown;
  offset?: unknown;
  page?: unknown;
  fallbackLimit?: number;
  max?: number;
} = {}) {
  const lim = clampLimit(limit, { fallback: fallbackLimit, max });
  const off = offset != null
    ? Math.max(0, Number(offset) || 0)
    : Math.max(0, (Math.max(1, Number(page) || 1) - 1) * lim);
  return { limit: lim, offset: Math.min(off, MAX_PAGE_OFFSET) };
}

/**
 * Parse the compact `field:dir,field:dir` sort model the list routes accept into
 * the ordered array `buildOrderBy` consumes.
 *
 * Returns undefined for anything empty, which is the "no sort model" signal that
 * makes `buildOrderBy` fall back to the single `sortBy`/`order` pair. Field names
 * are passed through unvalidated on purpose: the route schema rejects unknown
 * ones, and `buildOrderBy` skips whatever it does not recognize.
 */
export function parseSortModel(sort: any) {
  if (typeof sort !== 'string' || !sort.trim()) return undefined;
  const model = sort.split(',').map((part) => {
    const [field, dir] = part.split(':');
    return { field: (field || '').trim(), dir: (dir || '').trim() };
  }).filter((s) => s.field);
  return model.length ? model : undefined;
}

/**
 * Parse a comma-separated `?ids=` query param into a deduplicated id array.
 *
 * Returns undefined when nothing usable is present, which every caller treats as
 * "not an id-resolution request" rather than "resolve zero ids".
 */
export function parseIdList(value: any) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ids = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
  return ids.length ? ids : undefined;
}

/**
 * Build an ORDER BY clause from a caller-supplied sort model.
 *
 * `columns` is the whitelist mapping an entity field to a real SQL expression;
 * caller input is only ever a key into it, never interpolated. Unknown fields are
 * skipped, and if nothing survives, `fallback` applies. `tiebreaker` is appended
 * unconditionally so paging over equal sort keys is deterministic.
 *
 * `defaultDir` is the direction an unrecognized `dir` resolves to, which differs
 * by domain (the matters and clients grids default to `desc`, the tasks grid to
 * `asc`), so it is explicit rather than assumed.
 *
 * Every expression in `columns` must be resolvable in BOTH the page CTE (which
 * selects from the bare table) and the enriched outer select, since the same
 * clause is applied in both positions.
 *
 * @param {object} args
 * @param {Array<{field: string, dir: string}>} [args.sort] - ordered multi-column model.
 * @param {string} [args.sortBy] - single-column fallback when `sort` is absent.
 * @param {string} [args.order] - direction for `sortBy`.
 * @param {Object<string,string>} args.columns - field -> SQL expression whitelist.
 * @param {{field: string, dir: string}} args.fallback - used when no field matches.
 * @param {string} args.tiebreaker - always-appended stable ordering, e.g. `c.id asc`.
 * @param {'asc'|'desc'} [args.defaultDir]
 * @returns {string} the ORDER BY body (without the `order by` keyword).
 */
export function buildOrderBy({ sort, sortBy, order, columns, fallback, tiebreaker, defaultDir = 'desc' }: any) {
  const model = Array.isArray(sort) && sort.length ? sort : [{ field: sortBy, dir: order }];
  const parts = [];
  for (const s of model) {
    const col = whitelisted(columns, s && s.field);
    if (!col) continue;
    const requested = String(s && s.dir).toLowerCase();
    const dir = requested === 'asc' || requested === 'desc' ? requested : defaultDir;
    parts.push(`${col} ${dir} nulls last`);
  }
  if (!parts.length) parts.push(`${columns[fallback.field]} ${fallback.dir} nulls last`);
  return `${parts.join(', ')}, ${tiebreaker}`;
}

/**
 * Append the paging params to `params` (mutating it, the same way the filter
 * clauses do) and return the matching `limit $N offset $N` fragment.
 *
 * `offset` wins over `page` when both are supplied, so an older `?limit=&offset=`
 * query string keeps working alongside the 1-based `page`.
 *
 * With `optional` set, a null `limit` returns an empty clause and every matching
 * row comes back. That is the unpaginated list contract the matters and clients
 * reads still honour for their non-grid callers; the count stays exact either way.
 *
 * @returns {{ pageClause: string, pageOffset: number }}
 */
export function buildPageClause({ limit, offset, page, params, fallbackLimit = 50, max, optional = false }: any) {
  if (optional && limit == null) return { pageClause: '', pageOffset: 0 };

  const { limit: lim, offset: off } = resolvePage({ limit, offset, page, fallbackLimit, max });

  params.push(lim);
  let pageClause = ` limit $${params.length}`;
  params.push(off);
  pageClause += ` offset $${params.length}`;
  return { pageClause, pageOffset: off };
}

/**
 * Rows an unpaged list read will return before it stops.
 *
 * Some reads are deliberately unpaged: their caller wants the whole set, and the
 * set is small enough that paging it would only add round trips. "Small enough"
 * is an assumption about today's data, though, and every one of these tables
 * grows. Without a bound, the first tenant to outgrow the assumption turns a
 * cheap query into a request that materializes every row into JS objects and
 * then into a JSON string — the DB side stays fast while the process falls over.
 *
 * Set well above any set these reads plausibly return, so it never truncates
 * real data; it exists to stop an unbounded read, not to page one.
 */
export const LIST_CEILING = 5000;

/**
 * Append `limit ceiling + 1` to `params` (mutating it, as the other clause
 * builders do) and return the matching fragment.
 *
 * The extra row is the whole point: it is what tells a result that exactly fills
 * the ceiling apart from one that was cut short. Pair with `applyCeiling`, which
 * discards it and reports which case happened.
 */
export function buildCeilingClause({ params, ceiling = LIST_CEILING }: any) {
  params.push(ceiling + 1);
  return ` limit $${params.length}`;
}

/**
 * Split a `ceiling + 1` row set into the rows to return and whether more exist.
 *
 * `truncated` must reach the client. A list that quietly stops at N is
 * indistinguishable from a complete one, which is how rows appear to go missing;
 * every caller of this puts the flag in its response envelope so the UI can say
 * the list is partial.
 */
export function applyCeiling(rows: any, ceiling = LIST_CEILING) {
  const truncated = rows.length > ceiling;
  return { rows: truncated ? rows.slice(0, ceiling) : rows, truncated, ceiling };
}

/**
 * Resolve the total match count for a windowed read.
 *
 * The page query carries `count(*) over()` as `total_count` on every row, so the
 * common path is free. But that window rides on the RETURNED rows, so an empty
 * page carries no count at all: paging past the last match would report zero
 * matches instead of the real total, and a caller holding a page number from a
 * wider filter would render "no results" rather than clamping back into range.
 * Only that case pays for a second query. An empty page at offset 0 genuinely has
 * no matches, so it short-circuits and the common path stays one round trip.
 *
 * `countSql` must select the count as `total` and reuse the page query's WHERE
 * with identical $N numbering, which is why callers snapshot their params before
 * `buildPageClause` appends the paging ones.
 */
export async function resolveWindowTotal({ rows, pageOffset, countSql, filterParams, countQuery }: any) {
  if (rows.length) return Number(rows[0].total_count);
  if (pageOffset <= 0) return 0;
  if (countQuery) {
    const countRows = await countQuery();
    return Number(countRows[0]?.total) || 0;
  }
  const { infrastructureRootSql } = require('./infrastructureQuery');
  const { rows: countRows } = await infrastructureRootSql(countSql, filterParams);
  return Number(countRows[0].total) || 0;
}
