import { getUserTimeZone } from '@/lib/utils/timezone';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { ApiError } from '@/lib/utils/apiErrors';
import type { Task, TaskStatus, TaskStatusFilter, TaskAttachment, TaskRecurrence, TaskSubtask, BulkResult } from '@/types';
import type { NotesPageParams } from '@/types/note';
import requestDeduplicator from './requestDeduplicator';
import { createNotesApi, type TimeEntryInput } from './notesApi';

import type { LookupResult } from './matters.service';
import { applyListSortSearch } from '@/lib/utils/listQuery';
import { authenticatedHeaders } from './base.service';

const taskNotesApi = createNotesApi('tasks', 'taskId');

// The lookup envelope is declared once, alongside the matters service, because
// every /lookup endpoint answers in the same shape.
export type { LookupItem, FullLookupItem, LookupResult } from './matters.service';

/** ===== Types (align with backend) ===== */

export interface CreateTaskResponse {
  message: string;
  taskId: string;
  task?: Task;
}

export interface UpdateTaskResponse {
  message: string;
  task: Task;
}

export interface DeleteTaskResponse {
  message: string;
}

export type GetTaskResponse = Task;

// Shared with the other bulk endpoints (see @/types).
export type { BulkResult };

export interface CreateTaskData {
  lawFirmId: string;
  matterId?: string;
  title: string;
  description?: string;
  location?: string;
  dueDate?: string | null;
  /** An all-day end is the exclusive day after the last day. */
  endsAt?: string;
  allDay?: boolean;
  assignedTo?: string[];
  practiceAreaId?: string;
  courtId?: string;
  courtName?: string;
  status?: TaskStatus;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  clientIds?: string[];
  reminderRecipientIds?: string[];
  sendReminderEarly?: boolean;
  recurrence?: Omit<TaskRecurrence, 'occurrenceCount' | 'sourceTaskId'> | null;
  dependencies?: string[];
}

export interface UpdateTaskData {
  lawFirmId: string;
  taskId: string;
  title?: string;
  description?: string;
  location?: string | null;
  dueDate?: string | null;
  /** Null removes the end. An all-day end is the exclusive day after the last day. */
  endsAt?: string | null;
  allDay?: boolean;
  assignedTo?: string[] | null;
  status?: TaskStatus;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  matterId?: string | null;
  practiceAreaId?: string | null;
  courtId?: string | null;
  attachments?: TaskAttachment[];
  clientIds?: string[];
  reminderRecipientIds?: string[];
  sendReminderEarly?: boolean;
  recurrence?: Omit<TaskRecurrence, 'occurrenceCount' | 'sourceTaskId'> | null;
  dependencies?: string[];
}

export interface DependencyGraphResponse {
  dependencies: Task[];
  dependents: Task[];
}

/** ===== Utilities ===== */


/** ===== Service ===== */

class TasksService {
  private apiRoot: string;

  constructor() {
    const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiRoot = API_ROOT;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    return authenticatedHeaders({ 'Content-Type': 'application/json', ...extra });
  }

  private baseTasksUrl(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/tasks`;
  }

  private taskUrl(lawFirmId: string, taskId: string): string {
    return `${this.baseTasksUrl(lawFirmId)}/${encodeURIComponent(taskId)}`;
  }

  // -------------------------
  // Subtasks (checklist items under a task)
  // -------------------------

  private subtasksUrl(lawFirmId: string, taskId: string): string {
    return `${this.taskUrl(lawFirmId, taskId)}/subtasks`;
  }

  async listSubtasks(lawFirmId: string, taskId: string): Promise<TaskSubtask[]> {
    const response = await requestDeduplicator.execute<{ subtasks?: TaskSubtask[] }>(this.subtasksUrl(lawFirmId, taskId), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
    return response?.subtasks || [];
  }

  async createSubtask(lawFirmId: string, taskId: string, data: { title: string; assigneeUserId?: string | null }): Promise<TaskSubtask> {
    const res = await apiFetch(this.subtasksUrl(lawFirmId, taskId), {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to create subtask');
    return body.subtask as TaskSubtask;
  }

  async updateSubtask(lawFirmId: string, taskId: string, subtaskId: string, data: Partial<Pick<TaskSubtask, 'title' | 'isCompleted' | 'assigneeUserId' | 'sortOrder'>>): Promise<TaskSubtask> {
    const res = await apiFetch(`${this.subtasksUrl(lawFirmId, taskId)}/${encodeURIComponent(subtaskId)}`, {
      method: 'PUT',
      headers: await this.authHeaders(),
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to update subtask');
    return body.subtask as TaskSubtask;
  }

  async deleteSubtask(lawFirmId: string, taskId: string, subtaskId: string): Promise<{ message: string }> {
    const res = await apiFetch(`${this.subtasksUrl(lawFirmId, taskId)}/${encodeURIComponent(subtaskId)}`, {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to delete subtask');
    return body as { message: string };
  }

  async reorderSubtasks(lawFirmId: string, taskId: string, subtaskIds: string[]): Promise<TaskSubtask[]> {
    const res = await apiFetch(`${this.subtasksUrl(lawFirmId, taskId)}/reorder`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ subtaskIds }),
    });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Failed to reorder subtasks');
    return (body.subtasks || []) as TaskSubtask[];
  }

  /** Create a task - NO DEDUPLICATION (mutations always execute) */
  async createTask(data: CreateTaskData): Promise<CreateTaskResponse> {
    const { lawFirmId, ...payload } = data;

    const res = await apiFetch(this.baseTasksUrl(lawFirmId), {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong. Please try again.');
    return body as CreateTaskResponse;
  }

  /** Get one task - DEDUPLICATED */
  async getTask(lawFirmId: string, taskId: string): Promise<GetTaskResponse> {
    const url = new URL(this.taskUrl(lawFirmId, taskId));
    url.searchParams.set('tz', getUserTimeZone());

    return requestDeduplicator.execute<GetTaskResponse>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
  }

  /** list ALL tasks for a law firm - DEDUPLICATED */
  async listLawFirmTasks(lawFirmId: string): Promise<Task[]> {
    const url = new URL(this.baseTasksUrl(lawFirmId));
    url.searchParams.set('tz', getUserTimeZone());

    const response = await requestDeduplicator.execute<{ tasks?: Task[] }>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    return response?.tasks ?? [];
  }

  /**
   * Typeahead lookup for task pickers - DEDUPLICATED.
   *
   * `search` and `ids` are mutually exclusive server-side: pass `ids` to resolve
   * labels for values a form already holds, `search` to find new ones. An `ids`
   * request that matches nothing comes back empty rather than falling back to an
   * arbitrary page, so a stale id never renders as some unrelated task.
   */
  async lookupTasks(
    lawFirmId: string,
    { search, exactName, ids, clientId, matterId, limit }: { search?: string; exactName?: string; ids?: string[]; clientId?: string; matterId?: string; limit?: number } = {},
  ): Promise<LookupResult> {
    const url = new URL(`${this.baseTasksUrl(lawFirmId)}/lookup`);
    if (search) url.searchParams.set('search', search);
    if (exactName) url.searchParams.set('exactName', exactName);
    if (ids?.length) url.searchParams.set('ids', ids.join(','));
    // Restricts the results to tasks linked to this client. A value the server
    // cannot resolve yields an empty result rather than the unscoped list.
    if (clientId) url.searchParams.set('clientId', clientId);
    // Restricts to one matter - used by the duplicate-title check so a common
    // task title elsewhere in the firm doesn't read as a false-positive match.
    if (matterId) url.searchParams.set('matterId', matterId);
    if (limit != null) url.searchParams.set('limit', String(limit));

    const response = await requestDeduplicator.execute<Partial<LookupResult>>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    return { items: response?.items ?? [], hasMore: response?.hasMore ?? false };
  }

  /**
   * Server-side paginated/filtered/sorted firm task list - DEDUPLICATED.
   * Sends page/limit/status/assignee/matterId/priority/search/sortBy/order as query
   * params and returns the page window plus the full filtered total.
   *
   * `dueFrom`/`dueTo` bound the read to a range of due dates. They are pure
   * filters: sent on their own they do not switch the endpoint onto its paged
   * branch, so a caller that needs every task in a date range gets all of them.
   */
  async listLawFirmTasksPaged(
    lawFirmId: string,
    opts: {
      page?: number;
      limit?: number;
      // A real status, or the `active` sentinel the API reads as "not completed".
      status?: TaskStatusFilter;
      assignee?: string;
      matterId?: string;
      clientId?: string;
      priority?: string;
      search?: string;
      sortBy?: string;
      order?: 'asc' | 'desc';
      sort?: Array<{ field: string; sort: 'asc' | 'desc' }>;
      dueFrom?: string;
      dueTo?: string;
      includeSpanning?: boolean;
    } = {}
  ): Promise<{ tasks: Task[]; totalTasks: number }> {
    const url = new URL(this.baseTasksUrl(lawFirmId));
    url.searchParams.set('tz', getUserTimeZone());
    if (opts.page != null) url.searchParams.set('page', String(opts.page));
    if (opts.limit != null) url.searchParams.set('limit', String(opts.limit));
    if (opts.status) url.searchParams.set('status', opts.status);
    if (opts.assignee) url.searchParams.set('assignee', opts.assignee);
    if (opts.matterId) url.searchParams.set('matterId', opts.matterId);
    if (opts.clientId) url.searchParams.set('clientId', opts.clientId);
    if (opts.priority) url.searchParams.set('priority', opts.priority);
    if (opts.dueFrom) url.searchParams.set('dueFrom', opts.dueFrom);
    if (opts.dueTo) url.searchParams.set('dueTo', opts.dueTo);
    if (opts.includeSpanning) url.searchParams.set('includeSpanning', 'true');
    applyListSortSearch(url, opts);

    const response = await requestDeduplicator.execute<{ tasks?: Task[]; totalTasks?: number }>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    return { tasks: response?.tasks ?? [], totalTasks: response?.totalTasks ?? (response?.tasks?.length ?? 0) };
  }

  /**
   * The ids of EVERY task matching these filters, unpaginated.
   *
   * Backs "select all" in the tasks grid: the user means every task behind the
   * current filters, not the page on screen, and the bulk endpoints act on ids. The
   * server applies the same visibility and filters as `listLawFirmTasksPaged`, so
   * the selection can never reach a task the list wouldn't show.
   *
   * `truncated` means the match set was larger than `limit` and the answer was
   * capped, so the caller should say the selection is partial rather than imply it
   * covers everything.
   */
  async listTaskIds(
    lawFirmId: string,
    opts: {
      // A real status, or the `active` sentinel the API reads as "not completed".
      status?: TaskStatusFilter;
      assignee?: string;
      matterId?: string;
      clientId?: string;
      priority?: string;
      search?: string;
      dueFrom?: string;
      dueTo?: string;
    } = {}
  ): Promise<{ ids: string[]; truncated: boolean; limit: number }> {
    const url = new URL(`${this.baseTasksUrl(lawFirmId)}/ids`);
    if (opts.status) url.searchParams.set('status', opts.status);
    if (opts.assignee) url.searchParams.set('assignee', opts.assignee);
    if (opts.matterId) url.searchParams.set('matterId', opts.matterId);
    if (opts.clientId) url.searchParams.set('clientId', opts.clientId);
    if (opts.priority) url.searchParams.set('priority', opts.priority);
    if (opts.dueFrom) url.searchParams.set('dueFrom', opts.dueFrom);
    if (opts.dueTo) url.searchParams.set('dueTo', opts.dueTo);
    if (opts.search?.trim()) url.searchParams.set('search', opts.search.trim());

    const response = await requestDeduplicator.execute<{ ids?: string[]; truncated?: boolean; limit?: number }>(
      url.toString(),
      { method: 'GET', headers: await this.authHeaders() },
    );

    return { ids: response?.ids ?? [], truncated: !!response?.truncated, limit: response?.limit ?? 0 };
  }

  /** list ALL tasks for a single matter - DEDUPLICATED */
  async listMatterTasks(lawFirmId: string, matterId: string): Promise<Task[]> {
    const url = new URL(`${this.baseTasksUrl(lawFirmId)}/matter/${encodeURIComponent(matterId)}`);
    url.searchParams.set('tz', getUserTimeZone());

    const response = await requestDeduplicator.execute<{ tasks?: Task[] }>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });

    return response?.tasks ?? [];
  }

  /** Update a task - NO DEDUPLICATION (mutations always execute) */
  async updateTask(data: UpdateTaskData): Promise<UpdateTaskResponse> {
    const { lawFirmId, taskId, ...payload } = data;

    const res = await apiFetch(this.taskUrl(lawFirmId, taskId), {
      method: 'PUT',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong. Please try again.');
    return body as UpdateTaskResponse;
  }

  /** Delete a task - NO DEDUPLICATION (mutations always execute) */
  async deleteTask(lawFirmId: string, taskId: string): Promise<DeleteTaskResponse> {
    const res = await apiFetch(this.taskUrl(lawFirmId, taskId), {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });

    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong. Please try again.');
    return body as DeleteTaskResponse;
  }

  /** ===== Bulk operations - NO DEDUPLICATION (mutations always execute) ===== */

  async bulkDelete(lawFirmId: string, taskIds: string[]): Promise<BulkResult> {
    const res = await apiFetch(`${this.baseTasksUrl(lawFirmId)}/bulk-delete`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ taskIds }),
    });

    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong. Please try again.');
    return body as BulkResult;
  }

  async bulkUpdateStatus(
    lawFirmId: string,
    taskIds: string[],
    status: TaskStatus
  ): Promise<BulkResult> {
    const res = await apiFetch(`${this.baseTasksUrl(lawFirmId)}/bulk-status`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ taskIds, status }),
    });

    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong. Please try again.');
    return body as BulkResult;
  }

  async bulkUpdateMatter(
    lawFirmId: string,
    taskIds: string[],
    matterId: string | null
  ): Promise<BulkResult> {
    const res = await apiFetch(`${this.baseTasksUrl(lawFirmId)}/bulk-matter`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({ taskIds, matterId }),
    });

    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) throw ApiError.fromResponse(res, body, 'Something went wrong. Please try again.');
    return body as BulkResult;
  }

  /**
   * Task notes are the same feature as matter/client notes (rich content,
   * pinning, retraction, replies, time entries), sharing one implementation
   * with them - see `notesApi.ts`.
   */
  async listTaskNotes(lawFirmId: string, taskId: string, params: NotesPageParams = {}) {
    return taskNotesApi.listNotes(lawFirmId, taskId, params);
  }
  async getTaskNote(lawFirmId: string, taskId: string, noteId: string) {
    return taskNotesApi.getNoteDetail(lawFirmId, taskId, noteId);
  }
  async addNoteToTask(lawFirmId: string, taskId: string, noteData: Parameters<typeof taskNotesApi.addNote>[2]) {
    return taskNotesApi.addNote(lawFirmId, taskId, noteData);
  }
  async updateNoteInTask(lawFirmId: string, taskId: string, noteId: string, noteData: Parameters<typeof taskNotesApi.updateNote>[3]) {
    return taskNotesApi.updateNote(lawFirmId, taskId, noteId, noteData);
  }
  async retractNoteFromTask(lawFirmId: string, taskId: string, noteId: string, reason?: string) {
    return taskNotesApi.retractNote(lawFirmId, taskId, noteId, reason);
  }
  async addTaskNoteTimeEntry(lawFirmId: string, taskId: string, noteId: string, entry: TimeEntryInput) {
    return taskNotesApi.addNoteTimeEntry(lawFirmId, taskId, noteId, entry);
  }
  async updateTaskNoteTimeEntry(lawFirmId: string, taskId: string, noteId: string, timeEntryId: string, entry: TimeEntryInput) {
    return taskNotesApi.updateNoteTimeEntry(lawFirmId, taskId, noteId, timeEntryId, entry);
  }
  async removeTaskNoteTimeEntry(lawFirmId: string, taskId: string, noteId: string, timeEntryId: string) {
    return taskNotesApi.removeNoteTimeEntry(lawFirmId, taskId, noteId, timeEntryId);
  }
  async setTaskNotePinned(lawFirmId: string, taskId: string, noteId: string, pinned: boolean) {
    return taskNotesApi.setNotePinned(lawFirmId, taskId, noteId, pinned);
  }
  async listTaskNoteVersions(lawFirmId: string, taskId: string, noteId: string) {
    return taskNotesApi.listNoteVersions(lawFirmId, taskId, noteId);
  }
  async listTaskNoteReplies(lawFirmId: string, taskId: string, noteId: string) {
    return taskNotesApi.listNoteReplies(lawFirmId, taskId, noteId);
  }
  async addTaskNoteReply(lawFirmId: string, taskId: string, noteId: string, reply: Parameters<typeof taskNotesApi.addNoteReply>[3]) {
    return taskNotesApi.addNoteReply(lawFirmId, taskId, noteId, reply);
  }
  async updateTaskNoteReply(lawFirmId: string, taskId: string, noteId: string, replyId: string, reply: Parameters<typeof taskNotesApi.updateNoteReply>[4]) {
    return taskNotesApi.updateNoteReply(lawFirmId, taskId, noteId, replyId, reply);
  }
  async retractTaskNoteReply(lawFirmId: string, taskId: string, noteId: string, replyId: string, reason?: string) {
    return taskNotesApi.retractNoteReply(lawFirmId, taskId, noteId, replyId, reason);
  }

  /** Get task dependency graph - DEDUPLICATED */
  async getTaskDependencies(lawFirmId: string, taskId: string): Promise<DependencyGraphResponse> {
    const url = new URL(`${this.taskUrl(lawFirmId, taskId)}/dependencies`);
    url.searchParams.set('tz', getUserTimeZone());

    return requestDeduplicator.execute<DependencyGraphResponse>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
  }

  // Get my assigned tasks - DEDUPLICATED
  async getMyAssignments(lawFirmId: string): Promise<MyAssignmentsResponse> {
    const url = new URL(`${this.baseTasksUrl(lawFirmId)}/my-assignments`);
    url.searchParams.set('tz', getUserTimeZone());

    return requestDeduplicator.execute<MyAssignmentsResponse>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
  }

  /** Get task analytics */
  async getTaskAnalytics(lawFirmId: string, dateRange: string = 'all'): Promise<TaskAnalyticsResponse> {
    const url = new URL(`${this.baseTasksUrl(lawFirmId)}/analytics`);
    url.searchParams.set('dateRange', dateRange);

    return requestDeduplicator.execute<TaskAnalyticsResponse>(url.toString(), {
      method: 'GET',
      headers: await this.authHeaders(),
    });
  }
}

export interface MyAssignmentsResponse {
  tasks: Task[];
  totalTasks: number;
}

export interface TaskAnalyticsSummary {
  total: number;
  completed: number;
  overdue: number;
  open: number;
  inProgress: number;
  blocked: number;
}

export interface AssigneeAnalytics {
  userId: string;
  name: string;
  total: number;
  completed: number;
  overdue: number;
}

export interface TrendDataPoint {
  date: string;
  completed: number;
  created: number;
}

export interface TaskAnalyticsResponse {
  summary: TaskAnalyticsSummary;
  byAssignee: AssigneeAnalytics[];
  byPriority: Record<string, number>;
  completionTrend: TrendDataPoint[];
  avgCompletionDays: number | null;
}

const tasksService = new TasksService();
export default tasksService;
