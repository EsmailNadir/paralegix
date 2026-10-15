"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import billingService, { type FirmTimeEntryListParams } from "@/services/billing.service";
import useServerTable, {
  recoverOutOfRangePage,
  type ServerSortModel,
  type ServerTableFilters,
} from "@/hooks/useServerTable";
import { serializeListSort } from "@/lib/utils/listQuery";
import type { EnrichedTimeEntry } from "./useFirmTimeEntries";

/** The only ordering the firm time-entry endpoint offers: entry date, newest first. */
/** Sortable fields, each backed by a server comparator over the whole match set. */
export type FirmTimeEntrySortField = "date" | "member" | "hours" | "amount";

const DEFAULT_SORT: ServerSortModel<FirmTimeEntrySortField> = [{ field: "date", sort: "desc" }];

export interface FirmTimeEntriesTableOptions {
  initialFilters?: ServerTableFilters;
  defaultRowsPerPage?: number;
  /**
   * Billing statuses to list when the user has not picked one, as a
   * comma-separated set. Lets a caller scope the list to, say, work that still
   * needs invoicing without pre-selecting a value in the status control (which
   * the user could then clear, widening the list past what the surface is for).
   */
  defaultBillingStatus?: string;
  /** Gates the query, so a hidden tab makes no request. */
  enabled?: boolean;
}

/**
 * Page / filter / sort state for the firm time-entry list, paired with the paged
 * server read.
 *
 * The rows this returns are already the server's page: nothing is filtered or
 * sliced in the browser, so a filter applies to every entry in the firm rather
 * than the ones a first request happened to load. Filter keys are the server's
 * own param names (`context`, `matterId`, `clientId`, `userId`, `chargeCodeId`,
 * `billingStatus`, `dateFrom`, `dateTo`).
 */
export default function useFirmTimeEntriesTable(
  lawFirmId: string,
  {
    initialFilters,
    defaultRowsPerPage = 10,
    defaultBillingStatus,
    enabled = true,
  }: FirmTimeEntriesTableOptions = {}
) {
  const table = useServerTable<FirmTimeEntrySortField>({
    defaultSort: DEFAULT_SORT,
    defaultRowsPerPage,
    initialFilters,
  });
  const { queryParams, setPage } = table;

  const params = useMemo<FirmTimeEntryListParams>(
    () => ({
      page: queryParams.page,
      limit: queryParams.limit,
      sort: queryParams.sort.map((s) => ({ field: s.field, sort: s.sort })),
      search: queryParams.search,
      context: queryParams.filters.context,
      matterId: queryParams.filters.matterId,
      clientId: queryParams.filters.clientId,
      clientScope: queryParams.filters.clientScope,
      userId: queryParams.filters.userId,
      chargeCodeId: queryParams.filters.chargeCodeId,
      billingStatus: queryParams.filters.billingStatus ?? defaultBillingStatus,
      dateFrom: queryParams.filters.dateFrom,
      dateTo: queryParams.filters.dateTo,
    }),
    [queryParams, defaultBillingStatus]
  );

  const queryEnabled = enabled && !!lawFirmId;

  const query = useQuery({
    queryKey: [
      "billing",
      "firmTimeEntriesPage",
      lawFirmId,
      { ...params, sort: serializeListSort(params.sort) },
    ],
    queryFn: () => billingService.listFirmTimeEntriesPage(lawFirmId, params),
    enabled: queryEnabled,
    staleTime: 30_000,
    // Keep the current page on screen while the next one loads. Without it every
    // keystroke in the search box would swap the list for a skeleton and take the
    // focused input with it. Guarded on the previous query's OWN firm (index 2
    // of its key above): bare `keepPreviousData` hands over the last successful
    // result on ANY key change, not just a page/search change within the same
    // firm. Without the guard, switching firms rendered the first firm's time
    // entries as though they belonged to the second, for as long as the new
    // firm's request took to resolve - a cross-tenant leak in the UI.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[2] === lawFirmId ? prev : undefined
    ),
  });

  // "There are no rows yet and there are going to be", which is what a caller
  // draws its skeleton on. Wider than `isLoading`: a query that has just been
  // enabled is pending before its fetch is under way, and reporting that gap as
  // loaded flashes the empty state over a list that is about to fill. A disabled
  // query is pending forever and is deliberately NOT loading - its caller is
  // showing something else.
  const loading = queryEnabled && query.isPending;

  const rows = useMemo<EnrichedTimeEntry[]>(
    () =>
      (query.data?.timeEntries || []).map((entry) => ({
        ...entry,
        matterId: entry.matterId || "",
        matterName: entry.matterName || "",
        clientId: entry.clientId || "",
        // The client this entry is billed to, empty when none is. It deliberately
        // does NOT fall back to the first name in `clientNames`: that array is
        // every client ON the matter, so the fallback billed one client for
        // another's work. Use getTimeEntryClientAttribution to render it.
        clientName: entry.clientName || "",
        clientNames: entry.clientNames || [],
        memberName: entry.userName || "Unknown",
        hourlyRate: typeof entry.hourlyRate === "number" ? entry.hourlyRate : null,
        context: entry.contextType,
        sourceLabel: entry.sourceTaskTitle || entry.sourceEventTitle || "",
      })),
    [query.data]
  );

  const total = query.data?.totalItems ?? 0;

  // Hours and value of every entry the filters matched, computed by the server
  // over the whole set rather than the page. A caller showing totals above a
  // paged list reads these, never a reduce over `rows` - that would report the
  // page and label it the total.
  const summary = query.data?.summary ?? { totalHours: 0, totalAmount: 0 };

  recoverOutOfRangePage({
    enabled,
    loading,
    rowCount: rows.length,
    total,
    page: table.page,
    setPage,
  });

  return {
    rows,
    total,
    summary,
    loading,
    fetching: query.isFetching,
    error: query.error,
    page: table.page,
    setPage,
    rowsPerPage: table.rowsPerPage,
    setRowsPerPage: table.setRowsPerPage,
    sortModel: table.sortModel,
    handleRequestSort: table.handleRequestSort,
    filters: table.filters,
    setFilter: table.setFilter,
    clearFilters: table.clearFilters,
    search: table.search,
    setSearch: table.setSearch,
    refetch: query.refetch,
  };
}
