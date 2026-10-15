"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { REFRESH_ON_FOCUS } from "@/lib/query/lawFirmQueryClient";
import documentRequestsService, { type DocumentRequest } from "@/services/documentRequests.service";

const DEFAULT_PAGE_SIZE = 10;

// Stable reference for the empty state so a consumer feeding rows into a
// dependency array doesn't re-run every render while data is undefined.
const EMPTY_REQUESTS: DocumentRequest[] = [];

/**
 * The React Query key for a page of a matter's document requests.
 *
 * The page and size are part of the key, so invalidating the prefix
 * `["document-requests", lawFirmId, matterId]` after a mutation still clears
 * every page - which is what the panel's `invalidate()` relies on.
 */
export function documentRequestsKey(
  lawFirmId?: string,
  matterId?: string,
  page?: number,
  limit?: number,
) {
  // React Query's partial-match invalidation compares every index present in
  // the filter key, and an explicit `undefined` there does not match a real
  // value (different typeof) the way a shorter array does. So the page/limit
  // must be omitted entirely, not just left undefined, for the panel's
  // `invalidate()` call (which passes no page/limit) to match every page.
  const key: unknown[] = ["document-requests", lawFirmId, matterId];
  if (page !== undefined) key.push(page, limit);
  return key as readonly unknown[];
}

/**
 * One server page of a matter's document requests.
 *
 * Requests are never pruned, so a long-running matter accumulates them for its
 * whole life. The panel reads a window rather than the matter's full history.
 */
export default function useDocumentRequests(lawFirmId?: string, matterId?: string) {
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPageState] = useState(DEFAULT_PAGE_SIZE);

  // A different page size re-cuts the list, so the current page number no longer
  // points at the same requests. Rewind to the top.
  const setRowsPerPage = useCallback((next: number) => {
    setRowsPerPageState(next);
    setPage(1);
  }, []);

  const { data, isLoading, isFetching, error, refetch } = useQuery<{
    requests: DocumentRequest[];
    totalRequests: number;
  }>({
    queryKey: documentRequestsKey(lawFirmId, matterId, page, rowsPerPage),
    queryFn: () => documentRequestsService.list(lawFirmId!, matterId!, { page, limit: rowsPerPage }),
    enabled: !!lawFirmId && !!matterId,
    // Clients fulfil requests from the portal with nothing pushing that here,
    // so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
    // Hold the current page on screen while the next one loads, rather than
    // collapsing the panel between frames - but only within the SAME matter.
    // Bare `keepPreviousData` hands over the last successful result on ANY key
    // change, not just a same-matter page change, so switching from one
    // matter's document requests to another's would render the first matter's
    // requests as though they belonged to the second for as long as the new
    // request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId && prevQuery?.queryKey?.[2] === matterId ? prev : undefined
    ),
  });

  const total = data?.totalRequests ?? 0;

  return {
    requests: data?.requests ?? EMPTY_REQUESTS,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, rowsPerPage))),
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    loading: isLoading,
    fetching: isFetching,
    error,
    refresh: refetch,
  };
}
