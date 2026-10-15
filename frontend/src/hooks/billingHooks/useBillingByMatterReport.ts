"use client";

import { useQuery } from "@tanstack/react-query";
import billingService, {
  type BillingByMatterReport,
  type BillingByMatterRow,
} from "@/services/billing.service";
import useServerTable from "@/hooks/useServerTable";

// Stable references for the empty state so consumers feeding these into a
// dependency array don't re-run every render while data is undefined.
const EMPTY_ROWS: BillingByMatterRow[] = [];
const EMPTY_PRACTICE_AREAS: string[] = [];
const EMPTY_UNLINKED = { count: 0, totalAmount: 0 };

/**
 * The "Billing by matter" report: one server page of matter roll-ups, with the
 * search and filters applied by the server.
 *
 * The rows are aggregates, not records - the browser never sees the firm's time
 * entries or invoices. That matters because the money on each card is a lifetime
 * total, so the report cannot be built from a page of raw entries; it has to be
 * a GROUP BY, and it is one.
 *
 * `unlinkedInvoices` and `practiceAreas` come back firm-wide rather than narrowed
 * by the active filters, which is why they are read off the response rather than
 * derived from `rows`.
 */
export default function useBillingByMatterReport(lawFirmId: string | undefined, enabled = true) {
  const table = useServerTable({ defaultSort: [], defaultRowsPerPage: 10 });
  const { page, limit, search, filters } = table.queryParams;

  const query = useQuery<BillingByMatterReport>({
    queryKey: ["billing", "byMatterReport", lawFirmId, { page, limit, search, filters }],
    queryFn: () =>
      billingService.getByMatterReport(lawFirmId!, {
        page,
        limit,
        search,
        status: filters.status,
        practiceArea: filters.practiceArea,
      }),
    enabled: enabled && !!lawFirmId,
    staleTime: 30_000,
    // Hold the current page while the next one loads, so paging and typing don't
    // blank the report between frames - but ONLY within the same firm (index 2
    // of the previous query's key above). Bare `keepPreviousData` hands over
    // the last successful result on ANY key change, not just a page/search
    // change within the same firm, so switching firms rendered the first
    // firm's matter roll-ups as though they belonged to the second, for as
    // long as the new firm's request took to resolve - a cross-tenant leak in
    // the UI.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[2] === lawFirmId ? prev : undefined
    ),
  });

  const total = query.data?.totalItems ?? 0;

  return {
    ...table,
    rows: query.data?.rows ?? EMPTY_ROWS,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, table.rowsPerPage))),
    unlinkedInvoices: query.data?.unlinkedInvoices ?? EMPTY_UNLINKED,
    practiceAreas: query.data?.practiceAreas ?? EMPTY_PRACTICE_AREAS,
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}
