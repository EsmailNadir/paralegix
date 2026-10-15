"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";

export type ServerSortDir = "asc" | "desc";

/** Ordered multi-column sort model, highest priority first. */
export type ServerSortModel<Field extends string = string> = Array<{
  field: Field;
  sort: ServerSortDir;
}>;

/**
 * Filter bag. Values are the raw strings the server expects; a key is absent
 * (rather than empty) when it isn't filtering, so it never reaches the query
 * string or the React Query key.
 */
export type ServerTableFilters = Record<string, string | undefined>;

export interface ServerTableOptions<Field extends string = string> {
  /** Ordering applied on first render and restored when the sort model empties. */
  defaultSort: ServerSortModel<Field>;
  /** Page size the table opens on. */
  defaultRowsPerPage?: number;
  /** Filter values to open with (a bookmarked URL, a persisted selection). */
  initialFilters?: ServerTableFilters;
}

/** The request shape a data hook forwards to its service and its query key. */
export interface ServerTableQueryParams<Field extends string = string> {
  /** 1-based. */
  page: number;
  limit: number;
  sort: ServerSortModel<Field>;
  /** Debounced search term (never the raw keystroke value). */
  search: string;
  filters: ServerTableFilters;
}

/**
 * Snap a table back to page 1 when the current page is past the end of the
 * result set (e.g. the last page's rows were all deleted, or a filter narrowed
 * the set). The server returns no rows and a zero total in that case, stranding
 * the view on an empty "0-0 of 0" page.
 *
 * Guarded on `page > 1` so it can't loop on a genuinely empty first page, and on
 * `!loading` so it doesn't fire against an in-flight page. Adjusting state during
 * render (rather than in an effect) lets React restart the render with the
 * corrected page before committing, avoiding a wasted pass - which is why this is
 * a plain function called during render, not a hook with an effect.
 */
export function recoverOutOfRangePage({
  enabled = true,
  loading,
  rowCount,
  total,
  page,
  setPage,
}: {
  enabled?: boolean;
  loading: boolean;
  rowCount: number;
  total: number;
  page: number;
  setPage: (n: number) => void;
}) {
  if (enabled && !loading && rowCount === 0 && total === 0 && page > 1) {
    setPage(1);
  }
}

/** Drops keys with an empty value so they never reach the request. */
function compactFilters(filters: ServerTableFilters): ServerTableFilters {
  const out: ServerTableFilters = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Page / page-size / sort / filter / search state for a table whose data is
 * paged, filtered and sorted by the SERVER.
 *
 * Every input that changes the result set (a filter, the sort, the page size, the
 * search term) resets to page 1, so a change can never strand the view on a page
 * past the end of the new result set. `search` is split in two: the raw input
 * value updates on every keystroke so the controlled field stays snappy, while
 * only the debounced value reaches `queryParams` (and therefore the network).
 *
 * The hook deliberately owns no data. A composing hook pairs it with a paged
 * query, feeding `queryParams` to both the service call and the React Query key.
 */
export default function useServerTable<Field extends string = string>({
  defaultSort,
  defaultRowsPerPage = 10,
  initialFilters,
}: ServerTableOptions<Field>) {
  const [page, setPage] = useState(1); // 1-based
  const [rowsPerPage, setRowsPerPageState] = useState(defaultRowsPerPage);
  // `defaultSort` is read once, as a seed. Later changes to the prop don't
  // reorder a table the user has already sorted.
  const [sortModel, setSortModel] = useState<ServerSortModel<Field>>(() => defaultSort);
  const [filters, setFilters] = useState<ServerTableFilters>(() =>
    compactFilters(initialFilters ?? {})
  );

  // Free-text search: a raw input value (updated on every keystroke for a snappy
  // field) plus a debounced value that is what actually drives the server query.
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(searchInput);
      // A new search term changes the result set; reset to page 1 so we don't
      // land on an out-of-range page.
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Accepts the full ordered multi-column sort model. An empty model falls back
  // to the default ordering. Resets to page 1 so a sort change never lands on an
  // out-of-range page.
  const handleRequestSort = useCallback(
    (model: ServerSortModel<Field>) => {
      setSortModel(model.length ? model : defaultSort);
      setPage(1);
    },
    // `defaultSort` is a literal at every call site, so depending on its identity
    // would rebuild this callback every render. The seed is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Setting a filter to an empty value removes it. Resets to page 1 so a filter
  // change never lands on an out-of-range page.
  //
  // A no-op set returns the previous object identity rather than a fresh copy so
  // React can bail out of the re-render. Callers that push a filter from an
  // effect would otherwise re-render on every pass, and any unstable dependency
  // in that effect turns into an unbounded update loop.
  const setFilter = useCallback((key: string, value: string | undefined) => {
    setFilters((prev) => {
      const current = prev[key];
      if (value ? current === value : current === undefined) return prev;
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    setPage(1);
  }, []);

  const clearFilters = useCallback((next: ServerTableFilters = {}) => {
    setFilters(compactFilters(next));
    setPage(1);
  }, []);

  const setRowsPerPage = useCallback((n: number) => {
    setRowsPerPageState(n);
    setPage(1);
  }, []);

  // Only updates the raw input; the debounce effect above handles the page reset
  // and the actual server query, so typing stays smooth.
  const setSearch = useCallback((value: string) => setSearchInput(value), []);

  const queryParams = useMemo<ServerTableQueryParams<Field>>(
    () => ({
      page,
      limit: rowsPerPage,
      sort: sortModel,
      search: debouncedSearch,
      filters,
    }),
    [page, rowsPerPage, sortModel, debouncedSearch, filters]
  );

  return {
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    sortModel,
    handleRequestSort,
    filters,
    setFilter,
    clearFilters,
    /** Raw input value, for the controlled search field. */
    search: searchInput,
    setSearch,
    queryParams,
  };
}
