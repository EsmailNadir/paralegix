"use client";

import type { Client } from "@/types";
import useServerTable, {
  recoverOutOfRangePage,
  type ServerSortModel,
  type ServerTableFilters,
} from "@/hooks/useServerTable";
import { usePagedClients } from "./useClients";

/** Client columns the backend list endpoint can order by. */
export type ClientSortField = 'name' | 'email' | 'organization' | 'createdAt';

/** Ordering the list opens on. */
const DEFAULT_SORT: ServerSortModel<ClientSortField> = [{ field: 'name', sort: 'asc' }];

/**
 * Drives the clients list with SERVER-SIDE pagination, search and sort:
 * `useServerTable` owns the table state, `usePagedClients` turns it into a
 * request. The `rows` returned are already the server page, so the list does no
 * in-memory filtering or sorting.
 */
export default function useClientsTable(
  lawFirmId?: string,
  // Filter values the list opens on (e.g. a portal-only view).
  initialFilters?: ServerTableFilters,
  enabled: boolean = true,
) {
  const table = useServerTable<ClientSortField>({
    defaultSort: DEFAULT_SORT,
    initialFilters,
  });

  const { clients, total, loading, fetching, error, refresh } = usePagedClients(
    lawFirmId,
    table.queryParams,
    enabled,
  );

  const rows: Client[] = clients;

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
