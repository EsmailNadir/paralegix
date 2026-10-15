"use client";

import type { Contact } from "@/types";
import useServerTable, {
  recoverOutOfRangePage,
  type ServerSortModel,
  type ServerTableFilters,
} from "@/hooks/useServerTable";
import { usePagedContacts } from "./useContacts";

/** Contact columns the backend list endpoint can order by. */
export type ContactSortField = 'name' | 'category' | 'organization' | 'email' | 'createdAt';

/** Ordering the directory opens on. */
const DEFAULT_SORT: ServerSortModel<ContactSortField> = [{ field: 'name', sort: 'asc' }];

/**
 * Drives the contact directory with SERVER-SIDE pagination, search and sort:
 * `useServerTable` owns the table state, `usePagedContacts` turns it into a
 * request. The `rows` returned are already the server page, so the list does no
 * in-memory filtering or sorting.
 */
export default function useContactsTable(
  lawFirmId?: string,
  initialFilters?: ServerTableFilters,
  enabled: boolean = true,
) {
  const table = useServerTable<ContactSortField>({
    defaultSort: DEFAULT_SORT,
    initialFilters,
  });

  const { contacts, total, loading, fetching, error, refresh } = usePagedContacts(
    lawFirmId,
    table.queryParams,
    enabled,
  );

  const rows: Contact[] = contacts;

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
