"use client";

import { useQuery } from "@tanstack/react-query";
import billingService, {
  type BillingByClientReport,
  type BillingByClientRow,
  type BillingClientMatterRow,
} from "@/services/billing.service";
import useServerTable from "@/hooks/useServerTable";

// Stable references for the empty state so consumers feeding these into a
// dependency array don't re-run every render while data is undefined.
const EMPTY_ROWS: BillingByClientRow[] = [];
const EMPTY_UNATTRIBUTED = { count: 0, totalAmount: 0 };
const EMPTY_BREAKDOWN: BillingClientMatterRow[] = [];

/**
 * The "Billing by client" report: one server page of client roll-ups.
 *
 * Like the by-matter report, the rows are aggregates rather than records - the
 * money on each card is a lifetime total, so it cannot be built from a page of
 * raw entries and has to be a GROUP BY.
 *
 * `unattributedInvoices` comes back firm-wide rather than narrowed by the search,
 * which is why it is read off the response rather than derived from `rows`.
 */
export default function useBillingByClientReport(lawFirmId: string | undefined, enabled = true) {
  const table = useServerTable({ defaultSort: [], defaultRowsPerPage: 10 });
  const { page, limit, search } = table.queryParams;

  const query = useQuery<BillingByClientReport>({
    queryKey: ["billing", "byClientReport", lawFirmId, { page, limit, search }],
    queryFn: () => billingService.getByClientReport(lawFirmId!, { page, limit, search }),
    enabled: enabled && !!lawFirmId,
    staleTime: 30_000,
    // Guarded on the previous query's OWN firm (index 2 of its key above): bare
    // `keepPreviousData` hands over the last successful result on ANY key
    // change, not just a page/search change within the same firm. Without the
    // guard, switching firms rendered the first firm's client roll-ups as
    // though they belonged to the second, for as long as the new firm's
    // request took to resolve - a cross-tenant leak in the UI.
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
    unattributedInvoices: query.data?.unattributedInvoices ?? EMPTY_UNATTRIBUTED,
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The per-matter breakdown behind one client's card.
 *
 * Read on demand when the card is opened rather than derived in the browser: it
 * applies the same attribution rules as the card itself, in the same query, so
 * the breakdown can never disagree with the totals it was opened from.
 */
export function useBillingClientMatterBreakdown(
  lawFirmId: string | undefined,
  clientId: string | null | undefined,
) {
  const query = useQuery<BillingClientMatterRow[]>({
    queryKey: ["billing", "clientMatterBreakdown", lawFirmId, clientId],
    queryFn: () => billingService.getClientMatterBreakdown(lawFirmId!, clientId!),
    enabled: !!lawFirmId && !!clientId,
    staleTime: 30_000,
  });

  return {
    matters: query.data ?? EMPTY_BREAKDOWN,
    loading: query.isLoading,
  };
}
