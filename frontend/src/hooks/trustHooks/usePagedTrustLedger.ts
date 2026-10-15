"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { REFRESH_ON_FOCUS } from "@/lib/query/lawFirmQueryClient";
import type { TrustTransaction } from "@/types/trust";

/** Ledger page size, matching the trust transaction list. */
const DEFAULT_PAGE_SIZE = 25;

export interface TrustLedgerPaging {
  limit: number;
  offset: number;
  order: "asc" | "desc";
}

/** What differs between one ledger and another: whose it is and which endpoint serves it. */
export interface TrustLedgerScope {
  /** First element of the query key, e.g. `"clientLedger"`. */
  queryKeyRoot: string;
  fetchPage: (
    lawFirmId: string,
    scopeId: string,
    paging: TrustLedgerPaging,
  ) => Promise<{ transactions: TrustTransaction[]; totalItems: number }>;
  /** Shown when the request fails with something that is not an `Error`. */
  errorFallback: string;
}

export interface UsePagedTrustLedgerOptions {
  /** Rows the ledger opens on. The endpoint caps a page at 200. */
  pageSize?: number;
}

/**
 * One party's trust ledger (a client's or a matter's), paged by the SERVER.
 *
 * The ledger endpoints apply a default page of 100 when asked for no limit, so a
 * caller that fetched "everything" received the most recent 100 entries and
 * nothing to say more existed. Paging here is what makes the rest of a
 * long-running ledger reachable, and `totalItems` is the full count rather than
 * the size of the page on screen, so the footer states the real total.
 *
 * A trust ledger is an append-only money record, so it grows for the life of the
 * relationship and the page is never the whole story.
 */
export default function usePagedTrustLedger(
  scope: TrustLedgerScope,
  lawFirmId?: string,
  scopeId?: string,
  options?: UsePagedTrustLedgerOptions,
) {
  const [page, setPage] = useState(1); // 1-based
  const [rowsPerPage, setRowsPerPageState] = useState(options?.pageSize ?? DEFAULT_PAGE_SIZE);
  const lastScope = useRef({ lawFirmId, scopeId });
  const scopeChanged = lastScope.current.lawFirmId !== lawFirmId
    || lastScope.current.scopeId !== scopeId;
  if (scopeChanged) {
    lastScope.current = { lawFirmId, scopeId };
    // The old page number belongs to a different ledger. Restart the render on
    // page one and keep the obsolete offset from starting a request for the new
    // party in between.
    if (page !== 1) setPage(1);
  }

  // A bigger page re-cuts the whole ledger, so the current page number no longer
  // points at the same entries. Rewind to the top rather than land somewhere
  // arbitrary in the history.
  const setRowsPerPage = useCallback((next: number) => {
    setRowsPerPageState(next);
    setPage(1);
  }, []);

  const { data, isLoading, isFetching, error, refetch } = useQuery<{
    transactions: TrustTransaction[];
    totalItems: number;
  }>({
    queryKey: [scope.queryKeyRoot, lawFirmId, scopeId, page, rowsPerPage],
    queryFn: () =>
      scope.fetchPage(lawFirmId!, scopeId!, {
        limit: rowsPerPage,
        offset: (page - 1) * rowsPerPage,
        // Newest first, ordered by the server: the first page of a long-running
        // ledger has to be the recent activity, and reversing a page here would
        // only reorder the oldest 25 entries.
        order: "desc",
      }),
    enabled: !!lawFirmId && !!scopeId && !(scopeChanged && page !== 1),
    // Other members post and void trust transactions with nothing pushing that
    // here, and a stale balance is a money error, so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
    // Keeps the current page rendered while the next one loads, so the pager can
    // show its own pending state instead of the list collapsing to a skeleton.
    //
    // Guarded on the previous query's OWN firm and party (indexes 1 and 2 of its
    // key above): bare `keepPreviousData` hands over the last successful result
    // on ANY key change, not just a page change within the same ledger. Without
    // the guard, switching from one client or matter to another rendered the
    // first one's trust transactions and total as though they belonged to the
    // second, for as long as the new request took to resolve: a cross-party leak
    // of trust money in the UI.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId && prevQuery?.queryKey?.[2] === scopeId ? prev : undefined
    ),
  });

  const transactions = data?.transactions ?? [];
  const totalItems = data?.totalItems ?? 0;

  return {
    transactions,
    totalItems,
    loading: isLoading,
    /** True while a page change is in flight, with the previous page still shown. */
    fetching: isFetching,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    totalPages: Math.max(1, Math.ceil(totalItems / rowsPerPage)),
    error: error ? (error instanceof Error ? error.message : scope.errorFallback) : null,
    refresh: refetch,
  };
}

export type PagedTrustLedger = ReturnType<typeof usePagedTrustLedger>;
