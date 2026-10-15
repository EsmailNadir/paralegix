"use client";

import { useReducer, useCallback } from "react";
import type { Task, TaskStatus, TaskRecurrence } from "@/types";
import { endFormValueFor, timedFormValueFor } from "@/components/calendarComp/calendarTiming";

/**
 * Shared create/edit task form state.
 *
 * Both `useCreateTask` and `useEditTask` previously duplicated ~22 fields of
 * useState verbatim (and had diverged on recurrence-clear + due-date parsing).
 * This reducer is the single source of truth for that state so the two hooks
 * stay in lockstep.
 */
export type TaskFormState = {
  title: string;
  description: string;
  location: string;
  dueDate: string; // datetime-local string ('yyyy-mm-ddThh:mm') or ''
  /** Optional end: a timed wall clock, or the last day when all-day. '' for none. */
  endsAt: string;
  allDay: boolean;
  assignedTo: string[];
  matterId: string;
  courtId: string;
  clientIds: string[];
  reminderRecipientIds: string[];
  sendReminderEarly: boolean;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  recurrenceEnabled: boolean;
  recurrencePattern: TaskRecurrence['pattern'];
  recurrenceInterval: number;
  recurrenceDaysOfWeek: number[] | null;
  recurrenceDayOfMonth: number | null;
  recurrenceEndDate: string | null;
  recurrenceMaxOccurrences: number | null;
  dependencies: string[];
};

export const INITIAL_TASK_FORM: TaskFormState = {
  title: "",
  description: "",
  location: "",
  dueDate: "",
  endsAt: "",
  allDay: false,
  assignedTo: [],
  matterId: "",
  courtId: "",
  clientIds: [],
  reminderRecipientIds: [],
  sendReminderEarly: false,
  status: "open",
  priority: "medium",
  recurrenceEnabled: false,
  recurrencePattern: "weekly",
  recurrenceInterval: 1,
  recurrenceDaysOfWeek: null,
  recurrenceDayOfMonth: null,
  recurrenceEndDate: null,
  recurrenceMaxOccurrences: null,
  dependencies: [],
};

type Action =
  | { type: "set"; patch: Partial<TaskFormState> }
  | { type: "reset" };

function reducer(state: TaskFormState, action: Action): TaskFormState {
  switch (action.type) {
    case "set":
      return { ...state, ...action.patch };
    case "reset":
      return { ...INITIAL_TASK_FORM };
    default:
      return state;
  }
}

/**
 * Derive the datetime-local input value for a task's date-only `dueDate`.
 *
 * The task model is date-only ('yyyy-mm-dd'); the previous edit hook parsed it
 * with local-time `getFullYear()/getMonth()/getDate()` which could roll the day
 * back/forward at timezone edges. Anchor on the UTC components instead so the
 * displayed day always matches the stored date.
 */
export function deriveDueDateInput(task?: Task | null): string {
  if (!task) return "";
  if (task.dueDateLocalInput) return task.allDay ? task.dueDateLocalInput : timedFormValueFor(task.dueDate, task.dueDateLocalInput);
  if (!task.dueDate) return "";
  try {
    const date = new Date(task.dueDate);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  } catch {
    return "";
  }
}

/**
 * Build the recurrence payload sent to the API. Returns the explicit disabled
 * object (never `undefined`) when recurrence is off, so create and edit clear
 * recurrence the same way (the backend treats `{ enabled: false }` as "no
 * recurrence" identically for both paths).
 */
export function buildRecurrencePayload(state: TaskFormState): Omit<TaskRecurrence, 'occurrenceCount' | 'sourceTaskId'> {
  if (!state.recurrenceEnabled) {
    return { enabled: false, pattern: 'weekly', interval: 1, daysOfWeek: null, dayOfMonth: null, endDate: null, maxOccurrences: null };
  }
  return {
    enabled: true,
    pattern: state.recurrencePattern,
    interval: state.recurrenceInterval,
    daysOfWeek: state.recurrenceDaysOfWeek,
    dayOfMonth: state.recurrenceDayOfMonth,
    endDate: state.recurrenceEndDate,
    maxOccurrences: state.recurrenceMaxOccurrences,
  };
}

/** Map a hydrated Task onto form state (used by the edit hook's openWith). */
export function taskToFormState(t: Task): TaskFormState {
  const rec = t.recurrence;
  return {
    title: t.title || "",
    description: t.description || "",
    location: t.location || "",
    dueDate: deriveDueDateInput(t),
    endsAt: endFormValueFor({ allDay: t.allDay === true, endsAt: t.endsAt, endsAtLocalInput: t.endsAtLocalInput }),
    allDay: t.allDay === true,
    assignedTo: Array.isArray(t.assignedTo) ? t.assignedTo : (t.assignedTo ? [t.assignedTo] : []),
    matterId: t.matterId || "",
    courtId: t.courtId || "",
    clientIds: t.clientIds || [],
    reminderRecipientIds: t.reminderRecipientIds || [],
    sendReminderEarly: t.sendReminderEarly === true,
    status: (t.status as TaskStatus) || "open",
    priority: t.priority || "medium",
    recurrenceEnabled: rec?.enabled || false,
    recurrencePattern: rec?.pattern || 'weekly',
    recurrenceInterval: rec?.interval || 1,
    recurrenceDaysOfWeek: rec?.daysOfWeek || null,
    recurrenceDayOfMonth: rec?.dayOfMonth || null,
    recurrenceEndDate: rec?.endDate || null,
    recurrenceMaxOccurrences: rec?.maxOccurrences || null,
    dependencies: t.dependencies || [],
  };
}

/**
 * Shared form-state hook. Returns the flat state plus per-field setters with the
 * same names the create/edit hooks already expose, so the components consuming
 * those hooks need no changes.
 */
export function useTaskForm() {
  const [state, dispatch] = useReducer(reducer, INITIAL_TASK_FORM);

  const setField = useCallback(<K extends keyof TaskFormState>(key: K, value: TaskFormState[K]) => {
    dispatch({ type: "set", patch: { [key]: value } as Partial<TaskFormState> });
  }, []);

  const setAll = useCallback((patch: Partial<TaskFormState>) => {
    dispatch({ type: "set", patch });
  }, []);

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, setField, setAll, reset };
}
