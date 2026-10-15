"use client";

import { useMemo } from "react";
import type { Task, Order, OrderBy } from "@/types";
import { useLawfirmTasks, type LawfirmTasksOptions } from "./useTasks";
import useServerTable, { recoverOutOfRangePage } from "@/hooks/useServerTable";

/** Sentinel the backend understands for "firm-level (matter-less) tasks only". */
const FIRM_LEVEL_ONLY = "none";

/** Ordering the table opens on, matching the grid's initial dueDate column sort. */
const DEFAULT_SORT: Array<{ field: OrderBy; sort: Order }> = [{ field: "dueDate", sort: "asc" }];

/**
 * Sets up the task table and calls the data hook with SERVER-SIDE
 * pagination/filtering/sort.
 *
 * The page/rowsPerPage/sort/search machinery lives in `useServerTable`; this hook
 * adds the task-specific parts: the firm-level sentinel, the precedence between
 * its own filter controls and the caller's `externalFilters`, and the
 * `useLawfirmTasks` call. The `rows` returned here are already the server page,
 * no in-memory filter/sort/paginate happens.
 *
 * First-class filter controls: in addition to `externalFilters`, the hook owns an
 * internal `assigneeFilter` and a `firmLevelOnly` toggle and exposes setters for
 * them. `firmLevelOnly` maps to the backend `matterId='none'` sentinel (which the
 * repo already supports) so a consuming component can offer a "firm-level only"
 * checkbox without knowing the sentinel. Internal filters take precedence over
 * the equivalent `externalFilters` when set, so a caller can pre-seed a value and
 * still let the user override it in the table.
 */
export default function useTasksTable(
  lawFirmId?: string,
  externalFilters?: Partial<LawfirmTasksOptions>,
  // Gates the paged server query, so a caller can hold it back until the
  // table is actually on screen.
  enabled: boolean = true,
  // Ordering the table opens on. Defaults to due date ascending, matching the
  // tasks grid's initial column. A consumer whose sort bar offers a different
  // first column passes that column instead, so the highlighted control and the
  // ordering actually requested agree on the first render.
  defaultSort: Array<{ field: OrderBy; sort: Order }> = DEFAULT_SORT
) {
  const table = useServerTable<OrderBy>({ defaultSort });
  const { queryParams, filters, setFilter, setPage } = table;

  // Resolve the effective filters: an internal, table-owned value wins, otherwise
  // fall back to the externally supplied one. `firmLevelOnly` is stored in the
  // filter bag as the backend's matter sentinel, so it needs no separate slot.
  const effectiveMatterId = filters.matterId ?? externalFilters?.matterId;
  const effectiveAssignee = filters.assignedTo ?? externalFilters?.assignedTo;
  const effectivePriority = externalFilters?.priority;
  const effectiveStatus = externalFilters?.status;
  // The due-date window has no table-owned control, so it comes only from the
  // caller. Each bound is forwarded independently: an "overdue" window supplies
  // `dueTo` alone, and defaulting the missing `dueFrom` would clip it.
  const effectiveDueFrom = externalFilters?.dueFrom;
  const effectiveDueTo = externalFilters?.dueTo;

  const options: LawfirmTasksOptions = useMemo(
    () => ({
      page: queryParams.page,
      limit: queryParams.limit,
      sort: queryParams.sort,
      assignedTo: effectiveAssignee,
      status: effectiveStatus,
      matterId: effectiveMatterId,
      priority: effectivePriority,
      dueFrom: effectiveDueFrom,
      dueTo: effectiveDueTo,
      search: queryParams.search,
      enabled,
    }),
    [queryParams, effectiveAssignee, effectiveStatus, effectiveMatterId, effectivePriority, effectiveDueFrom, effectiveDueTo, enabled]
  );

  const { tasks, total, loading, fetching, error, refresh } = useLawfirmTasks(lawFirmId, options);
  const tableBusy = loading || fetching;

  // The resolved server query WITHOUT pagination, so a consumer can re-request
  // the same filtered/sorted result set in windows of its own choosing. The CSV
  // export needs this: `rows` is one page, and exporting it would silently write
  // a page where the user asked for the whole filtered set.
  const listParams = useMemo(
    () => ({
      sort: queryParams.sort,
      search: queryParams.search,
      assignedTo: effectiveAssignee,
      status: effectiveStatus,
      matterId: effectiveMatterId,
      priority: effectivePriority,
      dueFrom: effectiveDueFrom,
      dueTo: effectiveDueTo,
    }),
    [queryParams.sort, queryParams.search, effectiveAssignee, effectiveStatus, effectiveMatterId, effectivePriority, effectiveDueFrom, effectiveDueTo]
  );

  const rows: Task[] = tasks;

  recoverOutOfRangePage({
    enabled, loading: tableBusy, rowCount: rows.length, total, page: table.page, setPage,
  });

  const firmLevelOnly = filters.matterId === FIRM_LEVEL_ONLY;

  return {
    rows,
    total,
    loading,
    fetching,
    error,
    page: table.page,
    setPage,
    rowsPerPage: table.rowsPerPage,
    setRowsPerPage: table.setRowsPerPage,
    sortModel: table.sortModel,
    handleRequestSort: table.handleRequestSort,
    listParams,
    // First-class filter controls (reachable from any consuming component).
    assigneeFilter: effectiveAssignee,
    setAssigneeFilter: (userId: string | undefined) => setFilter("assignedTo", userId || undefined),
    firmLevelOnly,
    setFirmLevelOnly: (on: boolean) => setFilter("matterId", on ? FIRM_LEVEL_ONLY : undefined),
    // Free-text search: raw value for the controlled input + debounced setter.
    search: table.search,
    setSearch: table.setSearch,
    refetch: refresh,
  };
}
