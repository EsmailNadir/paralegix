
export type TaskAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  objectPath?: string;
};

export type TaskStatus = 'open' | 'in_progress' | 'completed' | 'blocked';

/**
 * What a list request may filter status by: a real status, or the `active`
 * sentinel the tasks API accepts for "not completed" (open, in_progress and
 * blocked together).
 *
 * `active` is never a value a task can hold, which is why it is a separate type
 * from `TaskStatus`: it is only ever a query, so it belongs on list options and
 * filter state and must stay out of create/update payloads.
 */
export type TaskStatusFilter = TaskStatus | 'active';

export type TaskSubtask = {
  id: string;
  taskId?: string;
  title: string;
  isCompleted: boolean;
  assigneeUserId?: string | null;
  sortOrder?: number;
  createdBy?: string;
  completedAt?: string | null;
  completedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TaskRecurrence = {
  enabled: boolean;
  pattern: 'daily' | 'weekly' | 'monthly' | 'custom';
  interval: number;
  daysOfWeek: number[] | null;
  dayOfMonth: number | null;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrenceCount: number;
  sourceTaskId: string | null;
};

export type Task = {
  id: string;
  taskId?: string;
  lawFirmId: string;
  title: string;
  description?: string;
  location?: string | null;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueDate?: string;
  assignedToUserId?: string;
  assignedToUserName?: string;
  matterId?: string;
  matterName?: string;
  practiceAreaId?: string;
  practiceAreaName?: string;
  courtId?: string;
  courtName?: string;
  createdBy?: string;
  createdByName?: string;
  assignedTo?: string[];
  assignedToName?: string[];
  visibleToUserIds?: string[];
  clientIds?: string[];
  clientNames?: string[];
  reminderRecipientIds?: string[];
  sendReminderEarly?: boolean;
  recurrence?: TaskRecurrence | null;
  source?: 'app' | 'import' | 'recurrence';
  createdAt: string;
  updatedAt: string;
  createdAtLocalDisplay?: string;
  dueDateLocalDisplay?: string;
  dueDateLocalInput?: string;
  /**
   * Optional end, after the due date/time. A timed end is an instant; an
   * all-day end is the exclusive day after the last day, at noon UTC.
   */
  endsAt?: string | null;
  endsAtLocalDisplay?: string | null;
  /** The end as a form value in the caller's zone, like `dueDateLocalInput`. */
  endsAtLocalInput?: string | null;
  dueDateTimeZone?: string | null;
  allDay?: boolean;
  createdAtLocalInput?: string;
  updatedAtLocalDisplay?: string;
  updatedAtLocalInput?: string;
  /**
   * How many notes the task has. The notes themselves do NOT travel with the
   * task - the notes panel reads its own page, so a long note history doesn't
   * weigh down every other tab.
   */
  totalNotes?: number;
  googleEventId?: string;
  googleCalendarId?: string;
  outlookId?: string;
  attachments?: TaskAttachment[];
  dependencies?: string[];
  dependents?: string[];
  // Server-computed: true when any of this task's dependencies is not completed.
  // Lets the grid show the "incomplete dependencies" indicator without loading
  // the whole task list to look up each dependency's status.
  hasIncompleteDependencies?: boolean;
  // Server-computed subtask counts, present on both list and single-task reads.
  subtaskCount?: number;
  incompleteSubtaskCount?: number;
  // Server-computed rollup of the time entries pointing back at this task. Only
  // the single-task read returns these; list responses omit them.
  loggedHours?: number;
  billableLoggedHours?: number;
  timeEntryCount?: number;
};
