"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import billingService, {
  type FirmInvoiceListParams,
  type InvoiceDueGroupTotals,
} from "@/services/billing.service";
import useServerTable, {
  recoverOutOfRangePage,
  type ServerSortModel,
  type ServerTableFilters,
} from "@/hooks/useServerTable";
import { serializeListSort } from "@/lib/utils/listQuery";
import type { EnrichedInvoice } from "./useFirmInvoices";

/**
 * Orderings the firm invoice endpoint understands.
 *
 * `paymentPriority` puts anything still owed ahead of anything settled, then
 * soonest next payment first. `dueGroup` orders by due bucket (overdue first,
 * undated last) then due date. `createdAt` is newest first.
 */
export type FirmInvoiceSortField = "createdAt" | "paymentPriority" | "dueGroup";

export interface FirmInvoicesTableOptions {
  /** Ordering the list opens on. */
  defaultSort: ServerSortModel<FirmInvoiceSortField>;
  /** Filter values to open with (e.g. a KPI tile that pre-selects a status). */
  initialFilters?: ServerTableFilters;
  defaultRowsPerPage?: number;
  /** Restrict to invoices the firm is still owed money on. */
  awaitingOnly?: boolean;
  /**
   * Ask for the line items, payments and credit notes alongside each invoice.
   * A list that only renders summary rows should leave this off; a list whose
   * rows expand or export a PDF needs it, because those read the detail.
   */
  includeDetails?: boolean;
  /** Gates the query, so a hidden tab makes no request. */
  enabled?: boolean;
}

/**
 * Page / filter / sort state for a firm invoice list, paired with the paged
 * server read.
 *
 * The rows this returns are already the server's page: nothing is filtered,
 * sorted or sliced in the browser, so a filter applies to every invoice in the
 * firm and not just the ones a first request happened to load. Filter keys are
 * the server's own param names (`matterId`, `clientId`, `status`, `dateFrom`,
 * `dateTo`, `dueDateFrom`, `dueDateTo`, `dueGroup`).
 *
 * `dueGroupTotals` summarizes the WHOLE awaiting set (independent of the search /
 * matter / client / bucket filters), which is what the upcoming-payments tiles
 * need. It is only populated when `awaitingOnly` is set.
 */
export default function useFirmInvoicesTable(
  lawFirmId: string,
  {
    defaultSort,
    initialFilters,
    defaultRowsPerPage = 10,
    awaitingOnly = false,
    includeDetails = false,
    enabled = true,
  }: FirmInvoicesTableOptions
) {
  const table = useServerTable<FirmInvoiceSortField>({
    defaultSort,
    defaultRowsPerPage,
    initialFilters,
  });
  const { queryParams, setPage } = table;

  const params = useMemo<FirmInvoiceListParams>(
    () => ({
      page: queryParams.page,
      limit: queryParams.limit,
      sort: queryParams.sort.map((s) => ({ field: s.field, sort: s.sort })),
      search: queryParams.search,
      matterId: queryParams.filters.matterId,
      clientId: queryParams.filters.clientId,
      status: queryParams.filters.status,
      dateFrom: queryParams.filters.dateFrom,
      dateTo: queryParams.filters.dateTo,
      dueDateFrom: queryParams.filters.dueDateFrom,
      dueDateTo: queryParams.filters.dueDateTo,
      dueGroup: queryParams.filters.dueGroup,
      awaitingOnly,
      includeDetails,
    }),
    [queryParams, awaitingOnly, includeDetails]
  );

  const query = useQuery({
    // The serialized sort keeps the cache key changing exactly when the request
    // does, rather than on the sort array's identity.
    queryKey: [
      "billing",
      "firmInvoicesPage",
      lawFirmId,
      { ...params, sort: serializeListSort(params.sort) },
    ],
    queryFn: () => billingService.listFirmInvoicesPage(lawFirmId, params),
    enabled: enabled && !!lawFirmId,
    staleTime: 30_000,
    // Keep the current page on screen while the next one loads. Without it every
    // keystroke in the search box would swap the list for a skeleton and take the
    // focused input with it. Guarded on the previous query's OWN firm (index 2
    // of its key above): bare `keepPreviousData` hands over the last successful
    // result on ANY key change, not just a page/search change within the same
    // firm. Without the guard, switching firms rendered the first firm's
    // invoices as though they belonged to the second, for as long as the new
    // firm's request took to resolve - a cross-tenant leak in the UI.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[2] === lawFirmId ? prev : undefined
    ),
  });

  const rows = useMemo<EnrichedInvoice[]>(
    () =>
      (query.data?.invoices || []).map((invoice) => ({
        ...invoice,
        matterName: invoice.matterName || "",
        matterClientNames: invoice.matterClientNames || [],
      })),
    [query.data]
  );

  const total = query.data?.totalItems ?? 0;
  const dueGroupTotals: InvoiceDueGroupTotals = query.data?.dueGroupTotals ?? {};

  // Chip counts from the server, over the matter/client scope rather than the
  // status filter. Counting `rows` instead would only ever describe the page.
  const statusCounts = query.data?.statusCounts ?? {};

  // Money across the scoped client's owned invoices, computed by the server over
  // the whole relationship. A caller showing totals above a paged list reads this,
  // never a reduce over `rows` - that would report the page.
  const summary = query.data?.summary ?? { ownedCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 };

  recoverOutOfRangePage({
    enabled,
    loading: query.isLoading,
    rowCount: rows.length,
    total,
    page: table.page,
    setPage,
  });

  return {
    rows,
    total,
    statusCounts,
    summary,
    dueGroupTotals,
    loading: query.isLoading,
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
