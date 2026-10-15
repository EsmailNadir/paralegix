import ListSection from "@/components/ui/ListSection";
import { useMemo, useState, useEffect, useCallback, useRef, startTransition } from "react";
import { useSearchParams } from "next/navigation";
import dayjs from "dayjs";
import Tooltip from "@/components/ui/Tooltip";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Button from "@/components/ui/Button";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ClearFiltersButton from "@/components/ui/ClearFiltersButton";
import ListToolbar from "@/components/ui/ListToolbar";
import DateRangePicker from "@/components/ui/DateRangePicker";

import ErrorNotification from "@/components/ErrorNotification";
import ListView, { ListRow, ListSelectionModel, ListSortColumn, SortDir } from "@/components/ui/ListView";
import { highlightText } from "@/components/ui/HighlightText";
import TaskStatusBadge from "@/components/ui/TaskStatusBadge";
import TaskPriorityBadge from "@/components/ui/TaskPriorityBadge";
import type { ExportColumn } from "@/utils/csvExport";
import PageHeader from "@/components/ui/PageHeader";
import CreateTaskModal from "@/components/taskComp/CreateTaskModal";
import EditTaskModal from "@/components/taskComp/EditTaskModal";
import TimeEntryModal, { TimerPrefill } from "@/components/billingComp/TimeEntryModal";
import Modal from "@/components/ui/Modal";
import { usePruneStaleFilters } from "@/hooks/usePruneStaleFilters";
import { isTaskOverdue, toLocalDate } from "@/lib/utils/dateUtils";

import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useBillingTimer } from "@/contexts/BillingTimerContext";
import { useAuth } from "@/hooks/useAuth";
import { useLawFirmUsers } from "@/hooks/useUsers";
import { useCreateTask, useEditTask, useBulkTasks } from "@/hooks/taskHooks/useTasks";
import useTasksTable from "@/hooks/taskHooks/useTasksTable";
import useCourts from "@/hooks/courtHooks/useCourts";
import useChargeCodes from "@/hooks/chargeCodeHooks/useChargeCodes";
import TasksService from "@/services/tasks.service";
import type { Task, TaskStatus, TaskStatusFilter, OrderBy } from "@/types";
import { STATUS_VARIANTS, TASK_STATUS_OPTIONS } from "@/constants/statusMeta";
import { OVERDUE_FLOOR_DAYS, NO_TIMER_TARGET_HINT, canStartTimerForTask, taskTimerTarget } from "@/constants/taskConstants";
import { useBillNowRedirect } from "@/hooks/billingHooks/useBillNowRedirect";
import { Plus, Download, Clock3, Play, Link, CircleDot, Briefcase, Trash2, Pencil, ListChecks } from 'lucide-react';
import { exportToCSV } from "@/utils/csvExport";
import BulkActionsMenu from "@/components/filesComp/BulkActionsMenu";
import SearchInput from "@/components/ui/SearchInput";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { taskEndSuffix } from "@/components/calendarComp/calendarTiming";


type Props = {
  lawFirmId: string;
};

/**
 * The status paired with a `?due=` window, so completed work cannot dilute a
 * list opened to see what is still outstanding.
 *
 * Matches the digest exactly: `active` is the list API's not-completed filter,
 * spanning open, in_progress and blocked. Matching a single status instead would
 * omit in-progress and blocked tasks the email counted, so a recipient following
 * a "+N more" link would land on a page missing rows the email had promised.
 */
const DIGEST_BUCKET_STATUS: TaskStatusFilter = "active";

/** How far ahead the `week` bucket reaches, in days past today. */
const DUE_WEEK_DAYS = 7;

/**
 * Translates a `?due=` urgency bucket into the inclusive day window the tasks
 * API takes. Digest emails link each of their buckets here, so opening one has
 * to land on the same work the email described rather than on whatever filters
 * the viewer last used. The dashboard's "Tasks: Next 7 Days" widget links its
 * day-group headers here too, via the `date` bucket.
 *
 * Each window matches the bucket the digest built. `week` starts the day AFTER
 * tomorrow because the digest's week bucket is everything the today and tomorrow
 * sections did not already list; starting it at today would re-show every row
 * the reader has just scrolled past in the two sections above it.
 *
 * Days are formatted from LOCAL date parts (dayjs formats in local time), not
 * from `toISOString()`, which resolves to the UTC day and would hand a viewer
 * behind UTC yesterday's window for most of their evening.
 *
 * Returns `null` for an unrecognised bucket, leaving the list unfiltered.
 */
function dueWindowForBucket(bucket: string, explicitDate?: string | null): { dueFrom?: string; dueTo?: string } | null {
  const today = dayjs().startOf("day");
  const day = (d: dayjs.Dayjs) => d.format("YYYY-MM-DD");
  switch (bucket) {
    case "overdue":
      return {
        dueFrom: day(today.subtract(OVERDUE_FLOOR_DAYS, "day")),
        dueTo: day(today.subtract(1, "day")),
      };
    case "today":
      return { dueFrom: day(today), dueTo: day(today) };
    case "tomorrow":
      return { dueFrom: day(today.add(1, "day")), dueTo: day(today.add(1, "day")) };
    case "week":
      return { dueFrom: day(today.add(2, "day")), dueTo: day(today.add(DUE_WEEK_DAYS, "day")) };
    case "date":
      return explicitDate ? { dueFrom: explicitDate, dueTo: explicitDate } : null;
    default:
      return null;
  }
}

export default function TasksGrid({ lawFirmId }: Props) {
  const { navigate } = useNavigation();
  const searchParams = useSearchParams();
  const { hasPermission } = usePermissions();
  const billingTimer = useBillingTimer();
  const { user: currentUser } = useAuth();

  const canCreateTask = hasPermission("tasks.create");
  const canUpdateTask = hasPermission("tasks.update");
  const canDeleteTask = hasPermission("tasks.delete");
  const canManageTimeEntries = hasPermission("billing.manageTimeEntries");
  const canManageCourts = hasPermission("courts.manage");
  const canUseBulkActions = canUpdateTask || canDeleteTask;

  // Base data
  const { users, loading: usersLoading, error: usersError, refresh: refreshUsers } = useLawFirmUsers(lawFirmId);

  // Top filters drive the SERVER query (no client-side filtering). Seeded from the
  // URL (status takes priority) or localStorage so a deep-link / return visit
  // lands on the same filtered view.
  //
  // `dueFrom`/`dueTo` are an inclusive day window with no dropdown of its own: it
  // only ever arrives from `?due=`. It is deliberately absent from the
  // localStorage hydration below and from every write to it, because a window a
  // link asked for describes a moment, not a preference - restoring it on a later
  // visit would silently hide work whose deadline has since moved.
  const [filters, setFilters] = useState<{
    assignedTo?: string;
    status?: TaskStatusFilter | "";
    matterId?: string;
    priority?: string;
    dueFrom?: string;
    dueTo?: string;
  }>(() => {
    if (typeof window === 'undefined') return {};
    const f: Record<string, string> = {};
    // URL search params take priority over localStorage
    const urlStatus = searchParams.get('status');
    if (urlStatus) {
      f.status = urlStatus;
      return f as any;
    }
    for (const key of ['status', 'assignedTo', 'matterId', 'priority'] as const) {
      const v = localStorage.getItem(`tasksFilter_${key}`);
      if (v) f[key] = v;
    }
    return f as any;
  });

  // ===== Server-side paged/filtered/sorted table state =====
  // The grid view fetches ONE page at a time from the server, keyed on the
  // current filters/sort/page. The top filter dropdowns feed `externalFilters`;
  // the search box and sort/pagination controls drive the hook directly.
  const externalFilters = useMemo(
    () => ({
      assignedTo: filters.assignedTo || undefined,
      status: filters.status || undefined,
      matterId: filters.matterId || undefined,
      priority: filters.priority || undefined,
      dueFrom: filters.dueFrom || undefined,
      dueTo: filters.dueTo || undefined,
    }),
    [filters.assignedTo, filters.status, filters.matterId, filters.priority, filters.dueFrom, filters.dueTo]
  );

  const table = useTasksTable(lawFirmId, externalFilters);
  const {
    rows,
    total: totalRows,
    loading: loadingRows,
    fetching: fetchingRows,
    error: tableError,
    page: tablePage,
    setPage: setTablePage,
    rowsPerPage,
    setRowsPerPage,
    handleRequestSort,
    search: searchTerm,
    setSearch: setSearchTerm,
    refetch: refetchTable,
    listParams,
  } = table;

  // Mutations invalidate the ['tasks', lawFirmId] cache (both the paged grid
  // query and the full-set query below), so refetching the grid page here is
  // enough; the full set refetches on its own the next time it's enabled.
  const refetch = useCallback(() => {
    refetchTable();
  }, [refetchTable]);

  // Set initial matterId filter from URL if present
  useEffect(() => {
    const matterIdFromUrl = searchParams.get('matterId');
    if (matterIdFromUrl && matterIdFromUrl !== filters.matterId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the independently-editable matterId filter from the URL query
      setFilters(prev => ({ ...prev, matterId: matterIdFromUrl }));
    }
  }, [searchParams, filters.matterId]);

  // Seed the due-date window from `?due=<bucket>` (plus `?date=<YYYY-MM-DD>`
  // for the `date` bucket), pairing it with the open status so completed work
  // can't dilute a list the recipient opened to see what is still outstanding,
  // and the assignee from `?assignedTo=<uid>`.
  //
  // These arrive together on a digest or dashboard link and are consumed
  // together: the list applies no assignee predicate of its own, so without
  // the second one an owner following a link built from their own deadlines
  // lands on every task in the firm. All parameters are stripped from the URL
  // once read - they describe a one-time destination, so leaving them in place
  // would keep re-applying themselves and make the Clear button unable to
  // escape them.
  const dueParam = searchParams.get('due');
  const dateParam = searchParams.get('date');
  const assignedToParam = searchParams.get('assignedTo');
  useEffect(() => {
    if (!dueParam && !assignedToParam) return;
    const dueWindow = dueParam ? dueWindowForBucket(dueParam, dateParam) : null;
    const url = new URL(window.location.href);
    url.searchParams.delete('due');
    url.searchParams.delete('date');
    url.searchParams.delete('assignedTo');
    window.history.replaceState({}, '', url.toString());
    if (!dueWindow && !assignedToParam) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the due-date window and assignee from the URL query on arrival
    setFilters(prev => {
      const next = { ...prev };
      if (assignedToParam) next.assignedTo = assignedToParam;
      if (dueWindow) {
        next.status = DIGEST_BUCKET_STATUS;
        next.dueFrom = dueWindow.dueFrom;
        next.dueTo = dueWindow.dueTo;
        if (!dueWindow.dueFrom) delete next.dueFrom;
        if (!dueWindow.dueTo) delete next.dueTo;
      }
      return next;
    });
  }, [dueParam, dateParam, assignedToParam]);

  const [rowsError, setRowsError] = useState<string | null>(null);

  // The users / grid errors are React Query state: they persist until
  // their query succeeds, so there is nothing to "clear". Dismissing one has to
  // be recorded here instead. Keying the record on the message rather than a
  // boolean means a DIFFERENT load failure still reaches the banner after the
  // user has closed the previous one.
  const [dismissedLoadError, setDismissedLoadError] = useState<string | null>(null);
  const loadError = usersError || tableError || null;
  const showingLoadError = !!loadError && loadError !== dismissedLoadError;
  const error = (showingLoadError ? loadError : null) || rowsError;

  // Re-run every read the banner could be reporting. Only offered while the
  // banner is showing a LOAD failure: an action failure (a delete that was
  // rejected) is not fixed by fetching the list again, and offering to would
  // suggest it might be.
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await Promise.allSettled([refetchTable(), refreshUsers()]);
    } finally {
      setRetryingLoad(false);
    }
  }, [refetchTable, refreshUsers]);

  const setError = (e: string | null) => {
    if (e === null) {
      setRowsError(null);
      setDismissedLoadError(loadError);
      return;
    }
    // Only page-level failures belong in the banner; modals show their own
    // validation messages, which are recognised by the "missing …" wording.
    if (!e.includes('missing')) setRowsError(e);
  };

  // Single row delete confirmation
  const [deleteTaskDialogOpen, setDeleteTaskDialogOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState(false);
  const [addTimeEntryOpen, setAddTimeEntryOpen] = useState(false);
  const [timeEntryPrefill, setTimeEntryPrefill] = useState<TimerPrefill | null>(null);
  const handleTimeEntrySaved = useBillNowRedirect(lawFirmId, () => {
    setAddTimeEntryOpen(false);
    setTimeEntryPrefill(null);
  });

  // Modals
  const create = useCreateTask(lawFirmId, refetch);
  const edit = useEditTask(lawFirmId, refetch);

  // Courts feed only the create/edit task modals and charge codes only the
  // time-entry modal, so each loads when its modal first opens. The cache keys
  // are shared, so reopening does not refetch.
  const { courts, loading: courtsLoading, createCourt, updateCourt } = useCourts(lawFirmId, create.open || edit.open);
  const updateCourtAddress = (courtId: string, address: string) => updateCourt(courtId, { address });
  const { chargeCodes } = useChargeCodes(lawFirmId, false, addTimeEntryOpen);

  // Row actions
  const handleDeleteTask = useCallback((task: Task) => {
    if (!canDeleteTask) return;
    setTaskToDelete(task);
    setDeleteTaskDialogOpen(true);
  }, [canDeleteTask]);

  const confirmDeleteTask = async () => {
    if (!taskToDelete || !canDeleteTask) return;
    setDeletingTask(true);
    try {
      await TasksService.deleteTask(taskToDelete.lawFirmId || '', taskToDelete.id);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete task"));
    } finally {
      setDeletingTask(false);
      // Keep taskToDelete set so its title stays visible during the close
      // animation; it is overwritten the next time the dialog opens.
      setDeleteTaskDialogOpen(false);
      refetch();
    }
  };

  const handleEditTask = useCallback((task: Task) => {
    if (!canUpdateTask) return;
    edit.openWith(task);
  }, [canUpdateTask, edit]);
  const handleLogTime = useCallback((task: Task) => {
    if (!canManageTimeEntries) return;
    setTimeEntryPrefill({
      matterId: task.matterId || null,
      clientId: !task.matterId && task.clientIds?.length ? task.clientIds[0] : null,
      userId: currentUser?.uid || null,
      name: task.title,
      description: task.description || undefined,
      sourceTaskId: task.taskId || task.id,
      sourceTaskTitle: task.title,
      sourceMatterId: task.matterId || null,
      sourceClientIds: task.clientIds || [],
    });
    setAddTimeEntryOpen(true);
  }, [canManageTimeEntries, currentUser?.uid]);
  const handleStartTimer = useCallback((task: Task) => {
    // No matter and no single client means no billing target; the row action falls
    // back to Log Time, which can ask, rather than accruing time with nowhere to put it.
    const target = taskTimerTarget(task);
    if (!target) return;
    billingTimer.startTimer({
      matterId: target.matterId,
      clientId: target.clientId,
      targetLabel: target.label || task.title,
      name: task.title,
      description: task.description || "",
      sourceTaskId: task.taskId || task.id,
      sourceTaskTitle: task.title,
      sourceMatterId: task.matterId || null,
      sourceClientIds: task.clientIds || [],
    });
  }, [billingTimer]);
  const handleViewTask = (task: Task) => {
    navigate(`/lawfirm/${lawFirmId}/tasks/${task.taskId || task.id}`);
  };

  // Top filter change → updates filter state (which re-keys the server query) and
  // resets to page 1 + clears the page-scoped selection.
  const handleTopFieldChange = (key: string, value: string) => {
    localStorage.setItem(`tasksFilter_${key}`, value);
    startTransition(() => {
      const next = { ...filters, [key]: value as any };
      if (value === "" || value === undefined || value === null) delete (next as any)[key];
      setFilters(next);
      setTablePage(1);
      setSelectedIds([] as any);
    });
  };

  // The sort bar drives the server query: clicking a column toggles its
  // direction and re-queries. Seeded to the default due-date ascending order.
  const [sortValue, setSortValue] = useState<string>("dueDate");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sortColumns: ListSortColumn[] = useMemo(
    () => [
      { label: "Due Date", value: "dueDate", defaultDir: "asc" },
      { label: "Title", value: "title" },
      { label: "Status", value: "status" },
      { label: "Priority", value: "priority", defaultDir: "desc" },
      { label: "Assigned To", value: "assignedTo" },
      { label: "Matter", value: "matter" },
    ],
    []
  );

  // Maps a sort column to its server OrderBy field (the `matter` alias maps to
  // the backend's `matterId` ordering field).
  const handleSortChange = useCallback(
    (value: string, dir: SortDir) => {
      setSortValue(value);
      setSortDir(dir);
      const FIELD_MAP: Record<string, OrderBy> = {
        title: "title",
        status: "status",
        priority: "priority",
        dueDate: "dueDate",
        assignedTo: "assignedTo",
        matter: "matterId",
      };
      const field = FIELD_MAP[value];
      handleRequestSort(field ? [{ field, sort: dir }] : []);
      setSelectedIds([] as any);
    },
    [handleRequestSort]
  );

  // CSV export column set (field + header only). The on-screen list is rendered
  // by `renderRow` below; these columns are passed only to `exportToCSV`.
  const exportColumns: ExportColumn[] = useMemo(
    () => [
      { field: "title", headerName: "Title" },
      { field: "description", headerName: "Description" },
      { field: "dueDate", headerName: "Due Date" },
      { field: "assignedTo", headerName: "Assigned To" },
      { field: "matterId", headerName: "Matter" },
      { field: "clients", headerName: "Clients" },
      { field: "status", headerName: "Status" },
      { field: "priority", headerName: "Priority" },
    ],
    []
  );

  // CSV export covers the WHOLE filtered result set, not just the page on screen.
  // The grid view holds a single server page, so the export re-requests the same
  // filter/sort/search in backend-max windows and concatenates them.
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const handleExportCsv = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const EXPORT_PAGE_SIZE = 200;   // the backend's maximum tasks `limit`
      const MAX_EXPORT_PAGES = 40;    // hard stop, so a bad total can't loop forever
      const collected: Task[] = [];
      let truncated = false;
      for (let pageNumber = 1; pageNumber <= MAX_EXPORT_PAGES; pageNumber += 1) {
        const { tasks: batch, totalTasks } = await TasksService.listLawFirmTasksPaged(lawFirmId, {
          page: pageNumber,
          limit: EXPORT_PAGE_SIZE,
          sort: listParams.sort,
          search: listParams.search,
          assignee: listParams.assignedTo,
          status: listParams.status,
          matterId: listParams.matterId,
          priority: listParams.priority,
          dueFrom: listParams.dueFrom,
          dueTo: listParams.dueTo,
        });
        collected.push(...batch);
        if (batch.length < EXPORT_PAGE_SIZE || collected.length >= totalTasks) break;
        // Reaching the cap with rows still unfetched means the file is short of
        // what the filters actually match. Say so, rather than handing over a
        // partial export that looks complete.
        if (pageNumber === MAX_EXPORT_PAGES) truncated = true;
      }
      exportToCSV(collected, exportColumns, "tasks");
      if (truncated) {
        setExportNotice(
          `Export stopped at the first ${collected.length} tasks. Narrow the filters or search to export the rest.`
        );
      }
    } catch (e) {
      setExportNotice(e instanceof Error ? e.message : "Failed to export tasks");
    } finally {
      setExporting(false);
    }
  }, [exporting, exportColumns, lawFirmId, listParams]);

  // Maps a task to its card content for ListView.
  const renderRow = useCallback(
    (task: Task): ListRow => {
      // Server-computed flag (see tasks.repository TASK_SELECT): true when any
      // dependency isn't completed. Avoids loading the whole task list here.
      const hasIncompleteDeps = !!task.hasIncompleteDependencies;

      const overdue = isTaskOverdue(task);

      // Assigned-to summary (first + overflow count).
      const assignedIds = Array.isArray(task.assignedTo)
        ? task.assignedTo
        : task.assignedTo
        ? [task.assignedTo]
        : [];
      let assignedText: string | null = null;
      if (assignedIds.length > 0) {
        const names = assignedIds.map((id: string) => {
          const u = users.find((user) => user.uid === id);
          return u ? u.name || u.email || u.uid : "Unknown";
        });
        const extra = names.length > 1 ? names.length - 1 : 0;
        assignedText = extra > 0 ? `${names[0]}, +${extra}` : names[0];
      }

      // Clients summary (first + overflow count).
      const clientNames = task.clientNames as string[] | undefined;
      let clientsText: string | null = null;
      if (clientNames && clientNames.length > 0) {
        const extra = clientNames.length > 1 ? clientNames.length - 1 : 0;
        const first = clientNames[0] || "Client";
        clientsText = extra > 0 ? `${first}, +${extra}` : first;
      }

      const matterName = task.matterId ? task.matterName || "Unknown matter" : null;

      // Server-computed subtask counts (see tasks.repository TASK_SELECT). Only
      // surfaced once the task actually has subtasks.
      const subtaskCount = task.subtaskCount || 0;
      const incompleteSubtaskCount = task.incompleteSubtaskCount || 0;
      const subtaskText =
        subtaskCount > 0
          ? incompleteSubtaskCount > 0
            ? `${incompleteSubtaskCount} subtask${incompleteSubtaskCount === 1 ? "" : "s"} left`
            : `${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"} done`
          : null;

      const metaParts = [
        matterName,
        assignedText ? `Assigned: ${assignedText}` : "Unassigned",
        clientsText ? `Clients: ${clientsText}` : null,
        subtaskText,
        task.description || null,
      ].filter(Boolean);

      // `toLocalDate`, not a raw `new Date(...)`: it handles a day-only
      // 'YYYY-MM-DD' value by construction, not by relying on the backend's
      // noon-UTC anchoring trick for `dueDate` to happen to round-trip safely.
      const dueStart =
        task.dueDateLocalDisplay ||
        (task.dueDate ? (toLocalDate(task.dueDate)?.toLocaleString() ?? "-") : "-");
      const dueDisplay = `${dueStart}${taskEndSuffix(task)}`;

      return {
        title: (
          <span className="inline-flex items-center gap-1.5 min-w-0">
            {hasIncompleteDeps && (
              <Tooltip title="Has incomplete dependencies" enterDelay={300}>
                <span className={`shrink-0 ${STATUS_VARIANTS.warning.text}`}>
                  <Link size={13} />
                </span>
              </Tooltip>
            )}
            <span className="truncate">{highlightText(task.title, searchTerm)}</span>
          </span>
        ),
        badges: (
          <>
            <TaskStatusBadge status={task.status} overdue={overdue} />
            <TaskPriorityBadge priority={task.priority} />
          </>
        ),
        meta: highlightText(metaParts.length ? metaParts.join("  ·  ") : "No description", searchTerm),
        right: (
          <span
            className={`text-sm ${
              overdue ? `font-semibold ${STATUS_VARIANTS.danger.text}` : "text-on-surface-muted"
            }`}
          >
            {dueDisplay}
          </span>
        ),
      };
    },
    [users, searchTerm]
  );

  const rowActions = useCallback(
    (task: Task) => (
      <>
        {canManageTimeEntries && (
          <ActionIconButton
            label="Start timer"
            tooltip={
              canStartTimerForTask(task)
                ? "Start timer"
                : NO_TIMER_TARGET_HINT
            }
            onClick={() => handleStartTimer(task)}
            disabled={!canStartTimerForTask(task)}
            tone="info"
          >
            <Play size={15} />
          </ActionIconButton>
        )}
        {canManageTimeEntries && (
          <ActionIconButton label="Log time" onClick={() => handleLogTime(task)} tone="success">
            <Clock3 size={15} />
          </ActionIconButton>
        )}
        {canUpdateTask && (
          <ActionIconButton label="Edit" onClick={() => handleEditTask(task)}>
            <Pencil size={15} />
          </ActionIconButton>
        )}
        {canDeleteTask && (
          <ActionIconButton label="Delete" tone="danger" emphasis onClick={() => handleDeleteTask(task)}>
            <Trash2 size={15} />
          </ActionIconButton>
        )}
      </>
    ),
    [
      canManageTimeEntries,
      canUpdateTask,
      canDeleteTask,
      handleStartTimer,
      handleLogTime,
      handleEditTask,
      handleDeleteTask,
    ]
  );

  // Check URL params for auto-opening create modal
  useEffect(() => {
    const shouldCreate = searchParams.get('create');
    if (shouldCreate === 'true' && canCreateTask) {
      create.openNew();
      // Remove the query parameter from URL without triggering navigation
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('create');
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, [searchParams, create, canCreateTask]);

  // ===== selection & bulk actions =====
  // Selection spans the whole filtered set, not the page on screen: "select all"
  // asks the server for every matching task id (see `selectAllMatching` below), so
  // a bulk action covers what the filters describe. Individually ticked rows
  // survive paging for the same reason.
  const [selectedIds, setSelectedIds] = useState<ListSelectionModel>([] as any);
  const [selectAllPending, setSelectAllPending] = useState(false);
  // Set when a select-all was capped by the server's ceiling, so the count in the
  // bulk bar isn't read as "everything".
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  const selectedIdsArray = useMemo<readonly (string | number)[]>(() => {
    if (Array.isArray(selectedIds)) return selectedIds;
    try {
      return Array.from((selectedIds as unknown as Iterable<string | number>) ?? []);
    } catch {
      return [];
    }
  }, [selectedIds]);

  const selectedCount = canUseBulkActions ? selectedIdsArray.length : 0;

  const bulk = useBulkTasks(lawFirmId, () => {
    refetch();
  });

  // Bulk dialogs
  const [statusDlgOpen, setStatusDlgOpen] = useState(false);
  const [statusToSet, setStatusToSet] = useState<TaskStatus>("open");

  const [matterDlgOpen, setMatterDlgOpen] = useState(false);
  const [matterToSet, setMatterToSet] = useState<string | "">("");

  const [confirmDelOpen, setConfirmDelOpen] = useState(false);

  const closeStatusDlg = useCallback(() => setStatusDlgOpen(false), []);
  const closeMatterDlg = useCallback(() => setMatterDlgOpen(false), []);

  // Hold the count shown in the bulk-delete title steady while the dialog animates
  // closed. Confirming clears the selection, which would otherwise make the title
  // flash "0 tasks" during the exit transition.
  const bulkDeleteCountRef = useRef(selectedCount);
  useEffect(() => {
    if (confirmDelOpen) bulkDeleteCountRef.current = selectedCount;
  }, [confirmDelOpen, selectedCount]);
  const bulkDeleteCount = confirmDelOpen ? selectedCount : bulkDeleteCountRef.current;

  // Drop the selection whenever the set it was taken from changes. Paging and
  // re-sorting leave it alone: the same tasks still match, and the ids stay valid
  // whether or not their row is on screen.
  useEffect(() => {
    setSelectedIds([] as any);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter/search describes a different set, so its capped-selection notice no longer applies
    setSelectionNotice(null);
  }, [filters, canUseBulkActions, searchTerm]);

  // Selection handler
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memoization is intentional
  const handleSelection = useCallback((ids: ListSelectionModel) => {
    startTransition(() => {
      setSelectedIds(ids);
    });
  }, []);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memoization is intentional
  const handleClearSelection = useCallback(() => {
    startTransition(() => {
      setSelectedIds([] as any);
    });
    setSelectionNotice(null);
  }, []);

  // Select every task the current filters + search match, across all pages. The
  // server resolves the ids under the same visibility rules as the list, so this
  // can never select a task the user cannot see.
  const selectAllMatching = useCallback(async () => {
    setSelectAllPending(true);
    setSelectionNotice(null);
    try {
      const { ids, truncated, limit } = await TasksService.listTaskIds(lawFirmId, {
        status: listParams.status,
        assignee: listParams.assignedTo,
        matterId: listParams.matterId,
        priority: listParams.priority,
        dueFrom: listParams.dueFrom,
        dueTo: listParams.dueTo,
        search: listParams.search,
      });
      startTransition(() => setSelectedIds(ids as any));
      if (truncated) {
        setSelectionNotice(
          `Selection is capped at ${limit} tasks, so the first ${limit} of ${totalRows} are selected.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to select all tasks");
    } finally {
      setSelectAllPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setError is recreated every render; the selection depends only on the resolved filters
  }, [lawFirmId, listParams, totalRows]);

  // The ids a bulk action targets: whatever is selected, which may span every page
  // of the filtered set after a select-all.
  const getAllTaskIds = useCallback(async () => {
    return selectedIdsArray.map(String);
  }, [selectedIdsArray]);

  // dropdown options for bulk dialogs
  const statusOptions: DropdownOption[] = TASK_STATUS_OPTIONS;

  // Dropdown options for filters
  const assignedToOptions: DropdownOption[] = useMemo(
    () => [{ value: "", label: "All Users" }, ...users.map((u) => ({ value: u.uid, label: u.name || u.email || u.uid }))],
    [users]
  );
  // `active` is a filter-only value the list API understands as "not completed"
  // (open, in_progress and blocked). It has an entry here because a `?due=` link
  // selects it: without one the dropdown would find no match for the value it is
  // holding and fall back to its placeholder, so a filtered page would look
  // unfiltered while silently showing a subset.
  const statusFilterOptions: DropdownOption[] = useMemo(
    () => [
      { value: "", label: "All Statuses" },
      { value: "active", label: "Not completed" },
      { value: "open", label: "Open" },
      { value: "in_progress", label: "In Progress" },
      { value: "completed", label: "Completed" },
      { value: "blocked", label: "Blocked" },
    ],
    []
  );
  // Drop persisted filters whose target no longer exists (a removed assignee, a
  // deleted matter), so a stale value can't silently hide every task while its
  // dropdown shows no selection. `matterId` is skipped while it's supplied by the
  // URL (?matterId=…), which a separate effect keeps re-seeding - pruning it there
  // would fight that effect in a loop.
  const urlMatterId = searchParams.get("matterId");
  usePruneStaleFilters(
    [
      { key: "assignedTo", value: filters.assignedTo, options: assignedToOptions, storageKey: "tasksFilter_assignedTo" },
    ],
    (keys) => {
      startTransition(() => {
        setFilters((prev) => {
          const next = { ...prev };
          for (const k of keys) delete (next as any)[k];
          return next;
        });
        setTablePage(1);
        setSelectedIds([] as any);
      });
    }
  );

  const priorityFilterOptions: DropdownOption[] = useMemo(
    () => [
      { value: "", label: "All Priorities" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "urgent", label: "Urgent" },
    ],
    []
  );

  // Active filter count (drives the Clear button / indicator) and a one-click
  // reset that also wipes the persisted values from localStorage. A matterId
  // supplied via the URL (?matterId=…) is re-seeded by a separate effect, so it
  // isn't counted or cleared here.
  const TASK_FILTER_KEYS = ["status", "assignedTo", "matterId", "priority"] as const;
  const activeFilterCount =
    TASK_FILTER_KEYS.filter((k) => !(k === "matterId" && urlMatterId) && (filters as Record<string, string | undefined>)[k]).length +
    (filters.dueFrom || filters.dueTo ? 1 : 0);

  // Due-date range change, from the `DateRangePicker`. Deliberately separate
  // from `handleTopFieldChange`: the window is never written to localStorage
  // (see the `filters` state comment above) - it always starts blank on a
  // fresh visit, whether the viewer picked it directly or arrived via a
  // `?due=` link.
  const handleDueDateChange = (next: { from?: string; to?: string }) => {
    startTransition(() => {
      setFilters((prev) => {
        const nextFilters = { ...prev, dueFrom: next.from, dueTo: next.to };
        if (!next.from) delete nextFilters.dueFrom;
        if (!next.to) delete nextFilters.dueTo;
        return nextFilters;
      });
      setTablePage(1);
      setSelectedIds([] as any);
    });
  };

  const clearAllFilters = () => {
    for (const key of TASK_FILTER_KEYS) {
      if (key === "matterId" && urlMatterId) continue;
      try {
        localStorage.removeItem(`tasksFilter_${key}`);
      } catch {
        // localStorage may be unavailable (private mode); ignore.
      }
    }
    startTransition(() => {
      setFilters((prev) => (urlMatterId && prev.matterId ? { matterId: prev.matterId } : {}));
      setTablePage(1);
      setSelectedIds([] as any);
    });
  };

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">
        <ErrorNotification
          error={error}
          onClose={() => setError(null)}
          onRetry={showingLoadError ? retryLoad : undefined}
          retrying={retryingLoad}
        />

        {/* Export outcome (a failure, or a file cut short by the page cap) gets its
            own dismissible banner, separate from the grid's load errors. */}
        <ErrorNotification
          error={exportNotice}
          onClose={() => setExportNotice(null)}
        />

        {/* A select-all the server had to cap, so the bulk bar's count is never
            mistaken for "every matching task". */}
        <ErrorNotification
          error={selectionNotice}
          onClose={() => setSelectionNotice(null)}
        />

        {/* A bulk change the server only partly applied, or refused outright. */}
        <ErrorNotification
          error={bulk.error}
          onClose={() => bulk.setError(null)}
        />

        <PageHeader
          eyebrow="Task Management"
          title="Tasks"
          description="Manage your law firm's tasks."
          actions={
            canCreateTask && (
              <Button
                size="compact"
                onClick={() => create.openNew()}
                icon={<Plus size={14} strokeWidth={2.2} />}
              >
                New Task
              </Button>
            )
          }
        />

      <ListToolbar className="mb-4">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center">
          <SearchInput
            className="w-full 2xl:min-w-64 2xl:max-w-sm 2xl:flex-1"
            placeholder="Search by task name, description, or client..."
            value={searchTerm}
            onChange={(next) => setSearchTerm(next)}
            onClear={() => setSearchTerm("")}
          />
          {/* Mobile: dropdowns use a 2x2(+1) grid. From sm up the filters wrap
              within their own row; only genuinely wide screens place that row
              beside the search box. */}
          <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap 2xl:ml-auto 2xl:justify-end">
            <Dropdown
              placeholder="All Users"
              value={filters.assignedTo ?? ""}
              onChange={(v) => handleTopFieldChange("assignedTo", v)}
              options={assignedToOptions}
              disabled={usersLoading}
              className="w-full sm:w-40 text-sm"
            />
            <EntityPicker
              entity="matters"
              lawFirmId={lawFirmId}
              placeholder="All Matters"
              value={filters.matterId ?? ""}
              onChange={(v) => handleTopFieldChange("matterId", v)}
              emptyOption={{ value: "", label: "All Matters" }}
              className="w-full sm:w-40 text-sm"
            />
            <Dropdown
              placeholder="All Statuses"
              value={filters.status ?? ""}
              onChange={(v) => handleTopFieldChange("status", v)}
              options={statusFilterOptions}
              className="w-full sm:w-40 text-sm"
            />
            <Dropdown
              placeholder="All Priorities"
              value={filters.priority ?? ""}
              onChange={(v) => handleTopFieldChange("priority", v)}
              options={priorityFilterOptions}
              className="w-full sm:w-40 text-sm"
            />
            <DateRangePicker
              from={filters.dueFrom}
              to={filters.dueTo}
              onChange={handleDueDateChange}
              placeholder="Due date"
              className="col-span-2 sm:col-span-1 sm:w-44"
            />
          </div>
        </div>
        {activeFilterCount > 0 && (
          <div className="mt-3 flex justify-end">
            <ClearFiltersButton count={activeFilterCount} onClear={clearAllFilters} />
          </div>
        )}
      </ListToolbar>

      {/* Title row with inline bulk actions */}
      <ListSection>
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
          <h2 className="text-lg font-semibold text-on-surface shrink-0">Tasks ({totalRows})</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="secondary"
              size="compact"
              onClick={handleExportCsv}
              disabled={exporting}
              icon={<Download size={14} strokeWidth={2.2} />}
            >
              {exporting ? "Exporting..." : "Export CSV"}
            </Button>

          </div>
        </div>

        <ListView<Task>
            loadFailed={!!tableError}
          rows={rows}
          loading={loadingRows}
          fetching={fetchingRows}
          getRowId={(row) => row.taskId || row.id}
          renderRow={renderRow}
          rowActions={canManageTimeEntries || canUpdateTask || canDeleteTask ? rowActions : undefined}
          onRowClick={handleViewTask}
          // Server-driven sort + pagination: the list renders just the current
          // server page and calls back to re-query on sort/page changes.
          sortingMode="server"
          sortColumns={sortColumns}
          sortValue={sortValue}
          sortDir={sortDir}
          onSortChange={handleSortChange}
          paginationMode="server"
          page={tablePage - 1}
          pageSize={rowsPerPage}
          rowCount={totalRows}
          onPageChange={(p) => setTablePage(p + 1)}
          onPageSizeChange={setRowsPerPage}
          pageSizeOptions={[10, 25, 50]}
          defaultPageSize={rowsPerPage}
          // selection (controlled)
          showSelection={canUseBulkActions}
          selectionModel={[...selectedIds]}
          onSelectionChange={canUseBulkActions ? handleSelection : undefined}
          showSelectAll={canUseBulkActions}
          onSelectAll={canUseBulkActions ? selectAllMatching : undefined}
          onClearSelection={canUseBulkActions ? handleClearSelection : undefined}
          selectAllPending={selectAllPending}
          // The toggle covers every task the current filters match, across pages,
          // so it names that count rather than the page in front of the user.
          selectAllLabel={
            selectedCount > 0
              ? `${selectedCount} selected${selectedCount < totalRows ? ` of ${totalRows}` : ""}`
              : `Select all ${totalRows}`
          }
          emptyIcon={<ListChecks size={40} />}
          emptyTitle="No tasks found"
          emptyMessage="Try adjusting your search or filters."
          trailing={
            selectedCount > 0 ? (
              <BulkActionsMenu
                count={selectedCount}
                actions={[
                  canUpdateTask && {
                    key: "status",
                    label: "Change Status",
                    icon: <CircleDot size={15} />,
                    onClick: () => setStatusDlgOpen(true),
                  },
                  canUpdateTask && {
                    key: "matter",
                    label: "Change Matter",
                    icon: <Briefcase size={15} />,
                    onClick: () => setMatterDlgOpen(true),
                  },
                  canDeleteTask && {
                    key: "delete",
                    label: "Delete",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    onClick: () => setConfirmDelOpen(true),
                  },
                ]}
              />
            ) : undefined
          }
        />
      </ListSection>

      {/* Create Modal */}
      <CreateTaskModal
        open={create.open}
        onClose={() => create.setOpen(false)}
        lawFirmId={lawFirmId}
        users={users.map(u => ({ id: u.uid, name: u.name, email: u.email }))}
        courts={courts.map(c => ({ id: c.id, name: c.name, abbreviation: c.abbreviation, city: c.city, address: c.address, state: c.state }))}
        courtsLoading={courtsLoading}
        createCourt={createCourt}
        updateCourtAddress={updateCourtAddress}
        canLinkCourtAddress={canManageCourts}
        create={create}
      />

      {/* Edit Modal */}
      <EditTaskModal
        open={edit.open}
        onClose={() => edit.setOpen(false)}
        lawFirmId={lawFirmId}
        users={users.map(u => ({ id: u.uid, name: u.name, email: u.email }))}
        courts={courts.map(c => ({ id: c.id, name: c.name, abbreviation: c.abbreviation, city: c.city, address: c.address, state: c.state }))}
        courtsLoading={courtsLoading}
        createCourt={createCourt}
        updateCourtAddress={updateCourtAddress}
        canLinkCourtAddress={canManageCourts}
        edit={edit}
      />

      <TimeEntryModal
        open={addTimeEntryOpen}
        onClose={() => {
          setAddTimeEntryOpen(false);
          setTimeEntryPrefill(null);
        }}
        lawFirmId={lawFirmId}
        users={users}
        chargeCodes={chargeCodes}
        defaultUserId={currentUser?.uid}
        prefill={timeEntryPrefill}
        onSuccess={handleTimeEntrySaved}
      />

      {/* ===== Bulk Dialogs (Dropdown version) ===== */}

      {/* Change Status */}
      {canUpdateTask && (
        <Modal
          isOpen={statusDlgOpen}
          onClose={closeStatusDlg}
          title="Change Status"
          size="md"
          footer={
            <>
              <Button type="secondary" onClick={closeStatusDlg}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={async () => {
                  try {
                    const taskIds = await getAllTaskIds();
                    const result = await bulk.bulkStatus(taskIds, statusToSet);
                    // A refused request leaves the selection for a retry; the
                    // dialog closes either way so the banner above is visible.
                    if (result) setSelectedIds([] as any);
                  } catch {}
                  setStatusDlgOpen(false);
                }}
                loading={bulk.busy}
                disabled={bulk.busy}
              >
                {bulk.busy ? "Applying..." : "Apply"}
              </Button>
            </>
          }
        >
          <Dropdown
            label="Status"
            value={statusToSet}
            onChange={(v) => setStatusToSet(v as TaskStatus)}
            options={statusOptions}
            portal
          />
        </Modal>
      )}

      {/* Change Matter */}
      {canUpdateTask && (
        <Modal
          isOpen={matterDlgOpen}
          onClose={closeMatterDlg}
          title="Change Matter"
          size="md"
          footer={
            <>
              <Button type="secondary" onClick={closeMatterDlg}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={async () => {
                  try {
                    const taskIds = await getAllTaskIds();
                    const result = await bulk.bulkMatter(taskIds, matterToSet ? matterToSet : null);
                    if (result) setSelectedIds([] as any);
                  } catch {}
                  setMatterDlgOpen(false);
                }}
                loading={bulk.busy}
                disabled={bulk.busy}
              >
                {bulk.busy ? "Applying..." : "Apply"}
              </Button>
            </>
          }
        >
          <EntityPicker
            entity="matters"
            lawFirmId={lawFirmId}
            label="Matter"
            value={matterToSet}
            onChange={setMatterToSet}
            emptyOption={{ value: "", label: "No matter" }}
            portal
          />
        </Modal>
      )}

      {/* Confirm Delete (bulk) */}
      {canDeleteTask && (
        <ConfirmModal
          isOpen={confirmDelOpen}
          onClose={() => setConfirmDelOpen(false)}
          onConfirm={async () => {
            try {
              const taskIds = await getAllTaskIds();
              const result = await bulk.bulkDelete(taskIds);
              if (result) setSelectedIds([] as any);
            } catch {}
            setConfirmDelOpen(false);
          }}
          title={`Delete ${bulkDeleteCount} task${bulkDeleteCount === 1 ? "" : "s"}?`}
          message="This action cannot be undone."
          confirmText="Delete"
          confirmType="danger"
          loading={bulk.busy}
        />
      )}

      {/* Single Task Delete Confirmation */}
      {canDeleteTask && (
        <ConfirmModal
          isOpen={deleteTaskDialogOpen}
          onClose={() => setDeleteTaskDialogOpen(false)}
          onConfirm={confirmDeleteTask}
          title="Delete Task?"
          message={`Are you sure you want to delete "${taskToDelete?.title ?? ""}"? This action cannot be undone.`}
          confirmText="Delete"
          confirmType="danger"
          loading={deletingTask}
        />
      )}
      </div>
    </div>
  );
}
