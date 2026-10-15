"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { REFRESH_ON_FOCUS } from "@/lib/query/lawFirmQueryClient";
import trustService from "@/services/trust.service";
import type { TrustTransaction, TransactionFilters } from "@/types/trust";
import useServerTable, { recoverOutOfRangePage } from "@/hooks/useServerTable";
import type { ServerTableFilters } from "@/hooks/useServerTable";

/**
 * Filter keys the transactions endpoint accepts, excluding the paging window
 * (`limit`/`offset`), which the table owns. Anything outside this list is dropped
 * so a stray key can never reach the query string or the React Query key.
 */
const FILTER_KEYS = [
  "trustAccountId",
  "clientId",
  "type",
  "status",
  "startDate",
  "endDate",
] as const;

/** Page size the transaction ledger opens on. */
const DEFAULT_ROWS_PER_PAGE = 10;

/** Narrows a caller-supplied filter object to the string bag `useServerTable` holds. */
function toFilterBag(filters?: TransactionFilters): ServerTableFilters {
  const bag: ServerTableFilters = {};
  if (!filters) return bag;
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) bag[key] = String(value);
  }
  return bag;
}

/**
 * Trust transactions for the firm, paged, filtered and counted by the SERVER.
 *
 * `useServerTable` owns the page (1-based), page size and filter bag, and resets
 * to page 1 whenever a filter or the page size changes so a narrowing change can
 * never strand the view past the end of the new result set. The endpoint has no
 * free-text search and its ordering is fixed server-side (transaction date
 * descending), so neither the search term nor a sort model is wired up here.
 */
export default function useTrustTransactions(
  lawFirmId?: string,
  initialFilters?: TransactionFilters,
) {
  const table = useServerTable({
    defaultSort: [],
    defaultRowsPerPage: DEFAULT_ROWS_PER_PAGE,
    initialFilters: toFilterBag(initialFilters),
  });
  const { page, rowsPerPage, setPage, clearFilters } = table;

  // The resolved filters WITHOUT the paging window, in the shape the service
  // takes. Doubles as the React Query key and as what the CSV export re-requests
  // to cover the whole filtered set rather than just the page on screen.
  const listParams = useMemo<TransactionFilters>(() => {
    const resolved: Record<string, string> = {};
    for (const key of FILTER_KEYS) {
      const value = table.filters[key];
      if (value) resolved[key] = value;
    }
    return resolved as TransactionFilters;
  }, [table.filters]);

  const { data, isLoading, isFetching, error, refetch } = useQuery<{
    transactions: TrustTransaction[];
    totalItems: number;
  }>({
    queryKey: ["trustTransactions", lawFirmId, listParams, page, rowsPerPage],
    queryFn: () =>
      trustService.listTransactionsPaged(lawFirmId!, {
        ...listParams,
        limit: rowsPerPage,
        offset: (page - 1) * rowsPerPage,
      }),
    enabled: !!lawFirmId,
    // Other members post and void trust transactions with nothing pushing that
    // here, and a stale balance is a money error, so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
    // Guarded on the previous query's OWN firm (index 1 of its key above): bare
    // `keepPreviousData` hands over the last successful result on ANY key
    // change, not just a page/filter change within the same firm. Without the
    // guard, switching firms rendered the first firm's trust transactions and
    // total as though they belonged to the second, for as long as the new
    // firm's request took to resolve - a cross-tenant leak of trust money in
    // the UI.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined
    ),
  });

  const transactions = data?.transactions ?? [];
  const totalItems = data?.totalItems ?? 0;

  recoverOutOfRangePage({
    loading: isLoading || isFetching,
    rowCount: transactions.length,
    total: totalItems,
    page,
    setPage,
  });

  // Replaces the whole filter bag, which is what the transaction list's controls
  // hand over (`{ ...filters, type: next }`). Routing through `clearFilters` is
  // what resets the view to page 1 on every filter change.
  const setFilters = useCallback(
    (next: TransactionFilters) => clearFilters(toFilterBag(next)),
    [clearFilters],
  );

  return {
    transactions,
    totalItems,
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load transactions.") : null,
    refresh: refetch,
    /** 1-based. */
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage: table.setRowsPerPage,
    filters: listParams,
    setFilters,
    /** The active filters without the paging window, for a full-set re-request. */
    listParams,
  };
}
