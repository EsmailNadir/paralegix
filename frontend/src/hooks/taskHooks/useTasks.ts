"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import TasksService from "@/services/tasks.service";
import type { Task, TaskStatus, TaskStatusFilter, TaskRecurrence, Order, OrderBy, BulkResult } from "@/types";
import { validateRequiredFields, ValidationField } from "@/utils/formValidation";
import { serializeListSort } from "@/lib/utils/listQuery";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { serverBulkFailureMessage } from "@/lib/utils/bulkRequests";
import { useTaskForm, buildRecurrencePayload, taskToFormState, type TaskFormState } from "./useTaskForm";
import { track } from "@/lib/analytics/analytics";
import { endsAtPayloadFor, scheduleEdits, type ScheduleFields } from "@/components/calendarComp/calendarTiming";

export type LawfirmTasksOptions = {
  page?: number;          // 1-based
  limit?: number;         // page size
  sortBy?: OrderBy;       // 'title' | 'status' | 'priority' | 'dueDate' | 'assignedTo' | 'matterId'
  order?: Order;          // 'asc' | 'desc'
  assignedTo?: string;
  // Accepts the `active` sentinel as well as a real status: a list request can
  // ask for "not completed", which is not a state a task is ever in.
  status?: TaskStatusFilter;
  matterId?: string;
  priority?: string;
  search?: string;
  // Inclusive day window (`YYYY-MM-DD`) bounding which due dates match. Either
  // bound may stand alone: an open-ended `dueTo` is how "everything already
  // overdue" is expressed, since such work has no lower bound.
  dueFrom?: string;
  dueTo?: string;
  sort?: Array<{ field: OrderBy; sort: Order }>;  // multi-column sort model
  // Gates the query, so a caller loads tasks only while the view that shows
  // them is actually on screen.
  enabled?: boolean;
};

export function useCreateTask(lawFirmId?: string, onDone?: () => void) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { state, setField, setAll, reset } = useTaskForm();

  /**
   * Opens the form for a new task: blank, apart from what the caller seeds (the
   * matter it was opened from, the calendar's selected day). Closing only hides
   * the modal, so a draft left there would otherwise come back on the next open.
   */
  const openNew = (seed: Partial<TaskFormState> = {}) => {
    reset();
    setAll(seed);
    setOpen(true);
  };

  const submit = async (setError: (e: string | null) => void) => {
    try {
      if (!lawFirmId) throw new Error("Missing lawFirmId");
      setSubmitting(true);
      setError(null);

      // Validate required fields
      const validationFields: ValidationField[] = [
        { name: 'title', value: state.title, required: true, label: 'Title' }
      ];

      const validationError = validateRequiredFields(validationFields);
      if (validationError) {
        setError(validationError);
        return;
      }

      await TasksService.createTask({
        lawFirmId,
        matterId: state.matterId || undefined,
        title: state.title,
        description: state.description,
        location: state.location || undefined,
        dueDate: state.dueDate || undefined,
        endsAt: endsAtPayloadFor(state.allDay, state.endsAt) ?? undefined,
        allDay: state.allDay,
        assignedTo: state.assignedTo.length > 0 ? state.assignedTo : undefined,
        courtId: state.courtId || undefined,
        status: state.status,
        priority: state.priority,
        clientIds: !state.matterId && state.clientIds.length > 0 ? state.clientIds : undefined,
        reminderRecipientIds: state.reminderRecipientIds.length > 0 ? state.reminderRecipientIds : undefined,
        sendReminderEarly: state.sendReminderEarly,
        dependencies: state.dependencies.length > 0 ? state.dependencies : undefined,
        recurrence: buildRecurrencePayload(state),
      });

      track("task_created", {
        status: state.status,
        priority: state.priority,
        has_matter: Boolean(state.matterId),
        has_due_date: Boolean(state.dueDate),
        recurring: state.recurrenceEnabled,
      });
      queryClient.invalidateQueries({ queryKey: ['tasks', lawFirmId] });
      setOpen(false);
      reset();
      onDone?.();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create task"));
    } finally {
      setSubmitting(false);
    }
  };

  return {
    open, setOpen,
    title: state.title, setTitle: (v: string) => setField("title", v),
    description: state.description, setDescription: (v: string) => setField("description", v),
    location: state.location, setLocation: (v: string) => setField("location", v),
    dueDate: state.dueDate, setDueDate: (v: string) => setField("dueDate", v),
    endsAt: state.endsAt, setEndsAt: (v: string) => setField("endsAt", v),
    allDay: state.allDay, setAllDay: (v: boolean) => setField("allDay", v),
    assignedTo: state.assignedTo, setAssignedTo: (v: string[]) => setField("assignedTo", v),
    matterId: state.matterId, setMatterId: (v: string) => setField("matterId", v),
    courtId: state.courtId, setCourtId: (v: string) => setField("courtId", v),
    clientIds: state.clientIds, setClientIds: (v: string[]) => setField("clientIds", v),
    reminderRecipientIds: state.reminderRecipientIds, setReminderRecipientIds: (v: string[]) => setField("reminderRecipientIds", v),
    sendReminderEarly: state.sendReminderEarly, setSendReminderEarly: (v: boolean) => setField("sendReminderEarly", v),
    status: state.status, setStatus: (v: TaskStatus) => setField("status", v),
    priority: state.priority, setPriority: (v: 'low' | 'medium' | 'high' | 'urgent') => setField("priority", v),
    recurrenceEnabled: state.recurrenceEnabled, setRecurrenceEnabled: (v: boolean) => setField("recurrenceEnabled", v),
    recurrencePattern: state.recurrencePattern, setRecurrencePattern: (v: TaskRecurrence['pattern']) => setField("recurrencePattern", v),
    recurrenceInterval: state.recurrenceInterval, setRecurrenceInterval: (v: number) => setField("recurrenceInterval", v),
    recurrenceDaysOfWeek: state.recurrenceDaysOfWeek, setRecurrenceDaysOfWeek: (v: number[] | null) => setField("recurrenceDaysOfWeek", v),
    recurrenceDayOfMonth: state.recurrenceDayOfMonth, setRecurrenceDayOfMonth: (v: number | null) => setField("recurrenceDayOfMonth", v),
    recurrenceEndDate: state.recurrenceEndDate, setRecurrenceEndDate: (v: string | null) => setField("recurrenceEndDate", v),
    recurrenceMaxOccurrences: state.recurrenceMaxOccurrences, setRecurrenceMaxOccurrences: (v: number | null) => setField("recurrenceMaxOccurrences", v),
    dependencies: state.dependencies, setDependencies: (v: string[]) => setField("dependencies", v),
    submitting,
    submit,
    openNew,
  };
}

export function useEditTask(lawFirmId?: string, onDone?: () => void) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  // The schedule the form opened with, so a save sends only what changed.
  const [opened, setOpened] = useState<ScheduleFields>({ date: "", endsAt: "", allDay: false });
  const [submitting, setSubmitting] = useState(false);
  const { state, setField, setAll } = useTaskForm();

  const openWith = (t: Task) => {
    setTask(t);
    // taskToFormState normalizes the date-only dueDate via UTC components (no
    // local-time day-shift) and maps recurrence + every other field at once.
    const form = taskToFormState(t);
    setAll(form);
    setOpened({ date: form.dueDate, endsAt: form.endsAt, allDay: form.allDay });
    setOpen(true);
  };

  const save = async (setError: (e: string | null) => void) => {
    try {
      if (!lawFirmId) throw new Error("Missing lawFirmId");
      if (!task?.taskId) throw new Error("Missing taskId");
      setSubmitting(true);
      setError(null);

      // Validate required fields
      const validationFields: ValidationField[] = [
        { name: 'title', value: state.title, required: true, label: 'Title' }
      ];

      const validationError = validateRequiredFields(validationFields);
      if (validationError) {
        setError(validationError);
        return;
      }

      // The server only touches a schedule field whose key is present, so one
      // the user left alone is omitted and keeps its stored value.
      const schedule = scheduleEdits(opened, { date: state.dueDate, endsAt: state.endsAt, allDay: state.allDay });
      await TasksService.updateTask({
        lawFirmId,
        taskId: task.taskId || task.id,
        title: state.title,
        description: state.description,
        location: state.location || null,
        // null, not undefined, for a cleared date or end, so it is removed
        // rather than kept.
        ...(schedule.date !== undefined ? { dueDate: schedule.date || null } : {}),
        ...(schedule.endsAt !== undefined ? { endsAt: endsAtPayloadFor(state.allDay, schedule.endsAt) } : {}),
        // The flag goes with any due date: without it the server reads the
        // form's all-day 'YYYY-MM-DDT00:00' as a timed midnight.
        ...(schedule.allDay !== undefined || schedule.date !== undefined ? { allDay: state.allDay } : {}),
        assignedTo: state.assignedTo.length > 0 ? state.assignedTo : [],
        status: state.status,
        priority: state.priority,
        matterId: state.matterId ?? undefined,
        courtId: state.courtId || null,
        clientIds: !state.matterId ? state.clientIds : undefined,
        reminderRecipientIds: state.reminderRecipientIds,
        sendReminderEarly: state.sendReminderEarly,
        dependencies: state.dependencies,
        recurrence: buildRecurrencePayload(state),
      });

      queryClient.invalidateQueries({ queryKey: ['tasks', lawFirmId] });
      setOpen(false);
      onDone?.();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update task"));
    } finally {
      setSubmitting(false);
    }
  };

  return {
    open, setOpen,
    task, openWith,
    title: state.title, setTitle: (v: string) => setField("title", v),
    description: state.description, setDescription: (v: string) => setField("description", v),
    location: state.location, setLocation: (v: string) => setField("location", v),
    dueDate: state.dueDate, setDueDate: (v: string) => setField("dueDate", v),
    endsAt: state.endsAt, setEndsAt: (v: string) => setField("endsAt", v),
    allDay: state.allDay, setAllDay: (v: boolean) => setField("allDay", v),
    assignedTo: state.assignedTo, setAssignedTo: (v: string[]) => setField("assignedTo", v),
    matterId: state.matterId, setMatterId: (v: string) => setField("matterId", v),
    courtId: state.courtId, setCourtId: (v: string) => setField("courtId", v),
    clientIds: state.clientIds, setClientIds: (v: string[]) => setField("clientIds", v),
    reminderRecipientIds: state.reminderRecipientIds, setReminderRecipientIds: (v: string[]) => setField("reminderRecipientIds", v),
    sendReminderEarly: state.sendReminderEarly, setSendReminderEarly: (v: boolean) => setField("sendReminderEarly", v),
    status: state.status, setStatus: (v: TaskStatus) => setField("status", v),
    priority: state.priority, setPriority: (v: 'low' | 'medium' | 'high' | 'urgent') => setField("priority", v),
    recurrenceEnabled: state.recurrenceEnabled, setRecurrenceEnabled: (v: boolean) => setField("recurrenceEnabled", v),
    recurrencePattern: state.recurrencePattern, setRecurrencePattern: (v: TaskRecurrence['pattern']) => setField("recurrencePattern", v),
    recurrenceInterval: state.recurrenceInterval, setRecurrenceInterval: (v: number) => setField("recurrenceInterval", v),
    recurrenceDaysOfWeek: state.recurrenceDaysOfWeek, setRecurrenceDaysOfWeek: (v: number[] | null) => setField("recurrenceDaysOfWeek", v),
    recurrenceDayOfMonth: state.recurrenceDayOfMonth, setRecurrenceDayOfMonth: (v: number | null) => setField("recurrenceDayOfMonth", v),
    recurrenceEndDate: state.recurrenceEndDate, setRecurrenceEndDate: (v: string | null) => setField("recurrenceEndDate", v),
    recurrenceMaxOccurrences: state.recurrenceMaxOccurrences, setRecurrenceMaxOccurrences: (v: number | null) => setField("recurrenceMaxOccurrences", v),
    dependencies: state.dependencies, setDependencies: (v: string[]) => setField("dependencies", v),
    submitting,
    save,
  };
}

/**
 * One task by id, resolved independently of any list query.
 *
 * A server-paged grid only holds the current page, so a view that opens a task
 * from a URL (a deep link, a browser Back) cannot rely on finding it in the rows
 * it happens to have. This resolves the record on its own, so the task's title,
 * matter and clients are available whichever page the grid is on.
 *
 * Keyed under `['tasks', lawFirmId]` so the invalidations task mutations already
 * issue reach it by prefix match.
 */
export function useTaskById(lawFirmId?: string, taskId?: string | null) {
  const { data, isLoading, error } = useQuery<Task>({
    queryKey: ['tasks', lawFirmId, 'detail', taskId ?? null],
    queryFn: () => TasksService.getTask(lawFirmId!, taskId!),
    enabled: !!lawFirmId && !!taskId,
    staleTime: 60_000,
  });

  return {
    task: data ?? null,
    loading: isLoading,
    error: error ? getErrorMessage(error, "Failed to load task") : null,
  };
}

export function useLawfirmTasks(lawFirmId?: string, options?: LawfirmTasksOptions) {
  // When server-side options are supplied, request the paginated/filtered/sorted
  // window and key the query on those params so each filter/sort/page combination
  // is cached independently. With no options the hook behaves exactly as before
  // (the full firm task list under the ['tasks', lawFirmId] key), which the
  // calendar feed and client portal still rely on.
  const paged = !!options && (
    options.page != null || options.limit != null || options.status != null ||
    options.assignedTo != null || options.matterId != null || options.priority != null ||
    options.dueFrom != null || options.dueTo != null ||
    (typeof options.search === 'string' && options.search.trim() !== '') || options.sortBy != null ||
    (Array.isArray(options.sort) && options.sort.length > 0)
  );

  // Stable serialization of the multi-column sort model for the query key. Uses
  // the same encoder the request does, so the key can't drift from the URL.
  const sortKey = serializeListSort(options?.sort);

  const { data, isLoading, isFetching, error, refetch } = useQuery<{ tasks: Task[]; total: number }>({
    queryKey: paged
      ? ['tasks', lawFirmId, {
          page: options!.page ?? null,
          limit: options!.limit ?? null,
          status: options!.status ?? null,
          assignedTo: options!.assignedTo ?? null,
          matterId: options!.matterId ?? null,
          priority: options!.priority ?? null,
          dueFrom: options!.dueFrom ?? null,
          dueTo: options!.dueTo ?? null,
          search: (options!.search ?? '').trim() || null,
          sortBy: options!.sortBy ?? null,
          order: options!.order ?? null,
          sort: sortKey,
        }]
      : ['tasks', lawFirmId],
    queryFn: async () => {
      if (paged) {
        const { tasks, totalTasks } = await TasksService.listLawFirmTasksPaged(lawFirmId!, {
          page: options!.page,
          limit: options!.limit,
          status: options!.status,
          assignee: options!.assignedTo,
          matterId: options!.matterId,
          priority: options!.priority,
          dueFrom: options!.dueFrom,
          dueTo: options!.dueTo,
          search: options!.search,
          sortBy: options!.sortBy,
          order: options!.order,
          sort: options!.sort,
        });
        return { tasks, total: totalTasks };
      }
      const tasks = await TasksService.listLawFirmTasks(lawFirmId!);
      return { tasks, total: tasks.length };
    },
    enabled: !!lawFirmId && (options?.enabled ?? true),
    // Keep the previous page's rows and total on screen while the next page
    // loads. Without this, each page change drops to undefined data (total → 0),
    // which collapses the pagination footer back to page 1 mid-transition.
    //
    // Guarded on the previous query's OWN law firm (index 1 of its key, in
    // both the paged and unpaged key shapes above): bare `keepPreviousData`
    // hands over the last successful result on ANY key change, not just a
    // page/filter change within the same firm. Without the guard, switching
    // law firms rendered the old firm's tasks as though they were the new
    // firm's, for as long as the new firm's request took to resolve - a
    // cross-tenant leak in the UI.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });

  return {
    tasks: data?.tasks ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    // Kept separate because this hook also serves non-paged views. The table
    // adapter uses it for pagination feedback without turning every background
    // refresh elsewhere into a full-page loading state.
    fetching: isFetching,
    // No `setError`: this is React Query state, owned by the query and cleared
    // when it next succeeds, so a setter here could not honour the call. A
    // caller that wants a dismissible banner records the dismissal on its own
    // side (see `TasksGrid`/`MattersGrid`).
    error: error ? getErrorMessage(error, "Failed to load tasks") : null,
    refresh: refetch,
  };
}

export function useBulkTasks(lawFirmId?: string, onDone?: () => void) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureFirm = () => {
    if (!lawFirmId) throw new Error("Missing lawFirmId");
  };

  /**
   * Runs one bulk request and reports how it went.
   *
   * The routes answer 200 even when some rows were refused, so a resolved
   * request is not a clean one: refused rows are written to `error` with their
   * reasons, and the list still refreshes because the other rows did change.
   * Resolves with the server's answer, or `null` when the whole request failed,
   * so a caller can tell "nothing happened" from "some of it happened".
   */
  const run = async (
    request: () => Promise<BulkResult>,
    verb: string,
    fallback: string,
  ): Promise<BulkResult | null> => {
    try {
      ensureFirm();
      setBusy(true);
      setError(null);
      const result = await request();
      queryClient.invalidateQueries({ queryKey: ['tasks', lawFirmId] });
      const partial = serverBulkFailureMessage(result, verb, "tasks");
      if (partial) setError(partial);
      onDone?.();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const bulkDelete = (taskIds: string[]) =>
    run(() => TasksService.bulkDelete(lawFirmId!, taskIds), "deleted", "Bulk delete failed");

  const bulkStatus = (taskIds: string[], status: TaskStatus) =>
    run(() => TasksService.bulkUpdateStatus(lawFirmId!, taskIds, status), "updated", "Bulk status update failed");

  const bulkMatter = (taskIds: string[], matterId: string | null) =>
    run(() => TasksService.bulkUpdateMatter(lawFirmId!, taskIds, matterId), "updated", "Bulk matter update failed");

  return { busy, error, setError, bulkDelete, bulkStatus, bulkMatter };
}
