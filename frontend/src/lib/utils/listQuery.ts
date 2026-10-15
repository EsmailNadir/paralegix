/**
 * Query-string builders for the server-side list endpoints (matters, clients,
 * tasks). Those endpoints share a sort/search contract, so the serialization
 * lives here rather than being re-derived per service - a mismatch in how the
 * sort model is encoded is invisible on the client and only shows up as a 400
 * from the backend's regex validation.
 */

/** One column of an ordered multi-column sort model. */
export interface ListSortItem {
  field: string;
  sort: 'asc' | 'desc';
}

export interface ListSortSearchParams {
  search?: string;
  sortBy?: string;
  order?: 'asc' | 'desc';
  sort?: ListSortItem[];
}

/**
 * Encode a multi-column sort model as `field:dir,field:dir`.
 *
 * Returns null for an empty model so it can be dropped from a request or a React
 * Query key rather than sent blank. Query keys use this too: keying on the same
 * string the request carries means the cache entry changes exactly when the
 * request does, and never drifts from it.
 */
export function serializeListSort(sort?: ListSortItem[]): string | null {
  return sort && sort.length ? sort.map((s) => `${s.field}:${s.sort}`).join(',') : null;
}

/**
 * Apply the shared `search` / `sortBy` / `order` / `sort` params.
 *
 * The multi-column `sort` is serialized as `field:dir,field:dir`, the exact shape
 * the backend list schemas validate with. It takes precedence over the single
 * `sortBy`/`order` pair server-side; both are sent when both are supplied, which
 * is what lets a caller pass a default ordering alongside a user's grid sort.
 *
 * A blank or whitespace-only `search` is omitted rather than sent empty, so it
 * never reaches the request or the React Query key.
 */
export function applyListSortSearch(url: URL, params: ListSortSearchParams): void {
  if (params.search && params.search.trim()) url.searchParams.set('search', params.search.trim());
  if (params.sortBy) url.searchParams.set('sortBy', params.sortBy);
  if (params.order) url.searchParams.set('order', params.order);
  const sort = serializeListSort(params.sort);
  if (sort) url.searchParams.set('sort', sort);
}

/**
 * Apply the notes list query.
 *
 * Shared by the matter and task note reads so the one notes panel sends the same
 * query string whichever entity it is mounted on. Unset filters are omitted
 * rather than sent as their "all" sentinel, which keeps them out of the request
 * and out of the React Query key - so clearing a filter returns to the cached
 * unfiltered page instead of fetching a differently-spelled version of it.
 */
export function applyNotesPageParams(
  url: URL,
  params: {
    page?: number; limit?: number; search?: string; noteType?: string; timeFilter?: string; tag?: string;
    authorId?: string; dateFrom?: string; dateTo?: string; jumpToNoteId?: string;
  },
): void {
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.limit) url.searchParams.set('limit', String(params.limit));
  if (params.search && params.search.trim()) url.searchParams.set('search', params.search.trim());
  if (params.noteType && params.noteType !== 'all') url.searchParams.set('noteType', params.noteType);
  if (params.timeFilter && params.timeFilter !== 'all') url.searchParams.set('timeFilter', params.timeFilter);
  if (params.tag) url.searchParams.set('tag', params.tag);
  if (params.authorId) url.searchParams.set('authorId', params.authorId);
  if (params.dateFrom) url.searchParams.set('dateFrom', params.dateFrom);
  if (params.dateTo) url.searchParams.set('dateTo', params.dateTo);
  if (params.jumpToNoteId) url.searchParams.set('jumpToNoteId', params.jumpToNoteId);
}

export interface ListWindowParams {
  page?: number;
  limit?: number;
  offset?: number;
}

/**
 * Apply a clamped `limit` plus either `offset` or a 1-based `page`.
 *
 * `maxLimit` mirrors the ceiling the endpoint's schema accepts, so an oversized
 * request is trimmed here into a value the server will serve rather than being
 * rejected outright. An explicit `offset` wins over `page`, matching the server,
 * which keeps the older `?limit=&offset=` callers working.
 */
export function applyListWindow(
  url: URL,
  params: ListWindowParams,
  { defaultLimit = 50, maxLimit }: { defaultLimit?: number; maxLimit: number },
): void {
  url.searchParams.set('limit', String(Math.max(1, Math.min(params.limit ?? defaultLimit, maxLimit))));
  if (params.offset != null) url.searchParams.set('offset', String(Math.max(0, params.offset)));
  else url.searchParams.set('page', String(Math.max(1, params.page ?? 1)));
}
