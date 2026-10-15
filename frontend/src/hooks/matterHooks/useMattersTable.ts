"use client";

import type { Matter } from "@/types";
import useServerTable, {
  recoverOutOfRangePage,
  type ServerSortModel,
  type ServerTableFilters,
} from "@/hooks/useServerTable";
import { usePagedMatters } from "./useMatters";

/** Matter columns the backend list endpoint can order by. */
export type MatterSortField =
  | 'name'
  | 'status'
  | 'matterNumber'
  | 'createdAt'
  | 'updatedAt'
  | 'practiceArea'
  | 'leadUser'
  | 'category';

/** Ordering the grid opens on, matching its initial Name column sort. */
const DEFAULT_SORT: ServerSortModel<MatterSortField> = [{ field: 'name', sort: 'asc' }];

/**
 * Drives the matters grid with SERVER-SIDE pagination, filtering, search and
 * sort: `useServerTable` owns the table state, `usePagedMatters` turns it into a
 * request. The `rows` returned are already the server page, so the grid does no
 * in-memory filtering or sorting.
 */
export default function useMattersTable(
  lawFirmId?: string,
  // Filter values the grid opens on, read once from the URL / localStorage.
  initialFilters?: ServerTableFilters,
  // Gates the paged query so the board view (which reads the full matter list)
  // doesn't fire a second request.
  enabled: boolean = true,
) {
  const table = useServerTable<MatterSortField>({
    defaultSort: DEFAULT_SORT,
    initialFilters,
  });

  const { matters, total, loading, fetching, error, refresh } = usePagedMatters(
    lawFirmId,
    table.queryParams,
    enabled,
  );

  const rows: Matter[] = matters;

  recoverOutOfRangePage({
    enabled, loading: loading || fetching, rowCount: rows.length, total, page: table.page, setPage: table.setPage,
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
