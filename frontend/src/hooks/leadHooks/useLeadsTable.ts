"use client";

import type { Lead } from "@/types";
import useServerTable, {
  recoverOutOfRangePage,
  type ServerSortModel,
  type ServerTableFilters,
} from "@/hooks/useServerTable";
import { usePagedLeads } from "./useLeads";

export type LeadSortField = "name" | "email" | "organization" | "createdAt" | "updatedAt";

const DEFAULT_SORT: ServerSortModel<LeadSortField> = [{ field: "createdAt", sort: "desc" }];

/**
 * Drives the leads list with server-side pagination, search and sort.
 */
export default function useLeadsTable(
  lawFirmId?: string,
  initialFilters?: ServerTableFilters,
  enabled: boolean = true,
) {
  const table = useServerTable<LeadSortField>({
    defaultSort: DEFAULT_SORT,
    initialFilters,
  });

  const { leads, total, loading, fetching, error, refresh } = usePagedLeads(
    lawFirmId,
    table.queryParams,
    enabled,
  );

  const rows: Lead[] = leads;

  recoverOutOfRangePage({
    enabled,
    loading: loading || fetching,
    rowCount: rows.length,
    total,
    page: table.page,
    setPage: table.setPage,
  });

  return {
    rows,
    total,
    loading,
    fetching,
    error,
    refetch: refresh,
    ...table,
  };
}
