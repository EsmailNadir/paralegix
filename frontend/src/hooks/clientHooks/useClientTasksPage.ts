"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import tasksService from "@/services/tasks.service";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";
import type { Task, TaskStatus } from "@/types";

/** The status filter values the tab offers; `all` sends no status. */
export type ClientTaskStatusFilter = "all" | TaskStatus;

const DEFAULT_PAGE_SIZE = 10;

// Stable reference for the empty state so consumers feeding rows into a
// dependency array don't re-run every render while data is undefined.
const EMPTY_TASKS: Task[] = [];

/**
 * The React Query key root for a client's tasks. Rooted at `tasks` (not a
 * separate `clientTasks` entity) so the invalidations task mutations already
 * issue (`invalidateQueries({ queryKey: ['tasks', lawFirmId] })`) reach it by
 * prefix match too.
 */
export function clientTasksKey(lawFirmId?: string, clientId?: string) {
  return ["tasks", lawFirmId, "client", clientId] as const;
}

/**
 * One server page of the tasks across every matter a client is on.
 *
 * Tasks roll up across all of a client's matters, so this is the one list on the
 * client page that grows without bound - an institutional client's task history
 * is the firm's whole relationship with them. The page and the search both run on
 * the server, so searching reaches every task rather than only the ones already
 * downloaded.
 */
export default function useClientTasksPage(
  lawFirmId: string | undefined,
  clientId: string | undefined,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPageState] = useState(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatusState] = useState<ClientTaskStatusFilter>("all");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Both re-cut the list, so the current page number no longer points at the same
  // tasks. Rewind to the top.
  const setRowsPerPage = useCallback((next: number) => {
    setRowsPerPageState(next);
    setPage(1);
  }, []);
  const setSearch = useCallback((value: string) => {
    setSearchInput(value);
    setPage(1);
  }, []);
  const setStatus = useCallback((value: string) => {
    setStatusState(value as ClientTaskStatusFilter);
    setPage(1);
  }, []);
  const statusParam = status === "all" ? undefined : status;

  const query = useQuery<{ tasks: Task[]; totalTasks: number }>({
    queryKey: [...clientTasksKey(lawFirmId, clientId), page, rowsPerPage, debouncedSearch, status],
    queryFn: () =>
      tasksService.listLawFirmTasksPaged(lawFirmId!, {
        clientId,
        page,
        limit: rowsPerPage,
        search: debouncedSearch || undefined,
        status: statusParam,
      }),
    enabled: enabled && !!lawFirmId && !!clientId,
    // Only within the SAME client. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, not just a same-client page change,
    // so switching from one client's tasks to another's would render the
    // first client's tasks as though they belonged to the second for as long
    // as the new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId && prevQuery?.queryKey?.[3] === clientId ? prev : undefined
    ),
  });

  const total = query.data?.totalTasks ?? 0;

  // The "All" option counts every task the search matches whatever status is
  // chosen. With no status the page read already carries that total; with one,
  // a single-row read of the unfiltered set supplies it.
  const allCountQuery = useQuery<{ tasks: Task[]; totalTasks: number }>({
    queryKey: [...clientTasksKey(lawFirmId, clientId), "allCount", debouncedSearch],
    queryFn: () =>
      tasksService.listLawFirmTasksPaged(lawFirmId!, {
        clientId,
        page: 1,
        limit: 1,
        search: debouncedSearch || undefined,
      }),
    enabled: enabled && !!lawFirmId && !!clientId && status !== "all",
  });
  const allTotal = status === "all" ? total : allCountQuery.data?.totalTasks;
  const refresh = useCallback(() => queryClient.invalidateQueries({
    queryKey: clientTasksKey(lawFirmId, clientId),
  }), [queryClient, lawFirmId, clientId]);

  return {
    tasks: query.data?.tasks ?? EMPTY_TASKS,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, rowsPerPage))),
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    search: searchInput,
    setSearch,
    status,
    setStatus,
    /** Every task matching the search, regardless of status; undefined until known. */
    allTotal,
    error: query.error,
    loading: query.isLoading,
    fetching: query.isFetching,
    refresh,
  };
}
