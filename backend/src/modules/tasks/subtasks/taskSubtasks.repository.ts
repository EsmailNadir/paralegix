import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { tasks, taskSubtasks, users } from '../../../shared/database/drizzle/schema';
import { tenantQuery } from '../../../shared/database/queryContext';
import { scopedDelete, scopedInsert, scopedUpdate } from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');

const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function subtaskEntity(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    taskId: r.taskId,
    title: r.title || '',
    isCompleted: !!r.isCompleted,
    assigneeUserId: r.assigneeUserId || null,
    assigneeName: r.assigneeName || '',
    sortOrder: typeof r.sortOrder === 'number' ? r.sortOrder : Number(r.sortOrder) || 0,
    createdBy: r.createdBy || null,
    completedAt: iso(r.completedAt),
    completedBy: r.completedBy || null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

const SUBTASK_SELECT = {
  id: taskSubtasks.id,
  taskId: taskSubtasks.taskId,
  title: taskSubtasks.title,
  isCompleted: taskSubtasks.isCompleted,
  assigneeUserId: taskSubtasks.assigneeUserId,
  assigneeName: users.name,
  sortOrder: taskSubtasks.sortOrder,
  createdBy: taskSubtasks.createdBy,
  completedAt: taskSubtasks.completedAt,
  completedBy: taskSubtasks.completedBy,
  createdAt: taskSubtasks.createdAt,
  updatedAt: taskSubtasks.updatedAt,
};

class TaskSubtasksRepository {
  /**
   * Look up the parent task's scope for access checks before any subtask
   * read/write. Returns `{ matterId }` when the task exists in the firm (matterId
   * is null for firm-level tasks), or null when it does not. The caller applies
   * the matter ethical wall when matterId is set.
   */
  async getParentScope(lawFirmId: string, taskId: string) {
    if (!isUuid(taskId)) return null;
    const rows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
      .select({ matterId: tasks.matterId }).from(tasks).where(and(scope, eq(tasks.id, taskId))).limit(1));
    return rows[0] ? { matterId: rows[0].matterId || null } : null;
  }

  async list(lawFirmId: string, taskId: string) {
    if (!isUuid(taskId)) return [];
    const rows = await tenantQuery(taskSubtasks, lawFirmId, ({ executor, scope }) => executor
      .select(SUBTASK_SELECT).from(taskSubtasks).leftJoin(users, eq(users.id, taskSubtasks.assigneeUserId))
      .where(and(scope, eq(taskSubtasks.taskId, taskId)))
      .orderBy(asc(taskSubtasks.sortOrder), asc(taskSubtasks.createdAt)));
    return rows.map(subtaskEntity);
  }

  async getById(lawFirmId: string, taskId: string, subtaskId: any) {
    if (!isUuid(subtaskId) || !isUuid(taskId)) return null;
    const rows = await tenantQuery(taskSubtasks, lawFirmId, ({ executor, scope }) => executor
      .select(SUBTASK_SELECT).from(taskSubtasks).leftJoin(users, eq(users.id, taskSubtasks.assigneeUserId))
      .where(and(scope, eq(taskSubtasks.taskId, taskId), eq(taskSubtasks.id, subtaskId))).limit(1));
    return rows[0] ? subtaskEntity(rows[0]) : null;
  }

  async create(lawFirmId: string, taskId: string, { title, assigneeUserId = null, sortOrder = 0, createdBy = null }: any) {
    const rows = await scopedInsert(taskSubtasks, lawFirmId, {
      taskId, title, assigneeUserId, sortOrder, createdBy,
    });
    return this.getById(lawFirmId, taskId, rows[0].id);
  }

  /**
   * Update a subtask. Only fields present in `fields` are changed. Toggling
   * isCompleted to true stamps completed_at/completed_by with the acting user;
   * toggling back to false clears both. Verifies the subtask belongs to
   * (lawFirmId, taskId) before writing (IDOR guard).
   */
  async update(lawFirmId: string, taskId: string, subtaskId: any, fields: any, actingUserId: string) {
    if (!isUuid(subtaskId) || !isUuid(taskId)) return null;

    const values: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(fields, 'title')) {
      values.title = fields.title;
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'assigneeUserId')) {
      values.assigneeUserId = fields.assigneeUserId || null;
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'sortOrder')) {
      values.sortOrder = fields.sortOrder;
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'isCompleted')) {
      values.isCompleted = !!fields.isCompleted;
      if (fields.isCompleted) {
        values.completedAt = sql`now()`;
        values.completedBy = actingUserId || null;
      } else {
        values.completedAt = null;
        values.completedBy = null;
      }
    }

    if (!Object.keys(values).length) return this.getById(lawFirmId, taskId, subtaskId);
    const rows = await scopedUpdate(taskSubtasks, lawFirmId, and(
      eq(taskSubtasks.taskId, taskId), eq(taskSubtasks.id, subtaskId),
    )!, values);
    return rows.length ? this.getById(lawFirmId, taskId, subtaskId) : null;
  }

  async remove(lawFirmId: string, taskId: string, subtaskId: any) {
    if (!isUuid(subtaskId) || !isUuid(taskId)) return false;
    const rows = await scopedDelete(taskSubtasks, lawFirmId, and(
      eq(taskSubtasks.taskId, taskId), eq(taskSubtasks.id, subtaskId),
    )!);
    return rows.length > 0;
  }

  /**
   * Reorder subtasks: sets each subtask's sort_order to its index in `subtaskIds`.
   * Only ids that belong to (lawFirmId, taskId) are updated. A single CASE
   * statement applies the whole ordering atomically in one round-trip.
   */
  async reorder(lawFirmId: string, taskId: string, subtaskIds: any) {
    const ids = (subtaskIds || []).filter(isUuid);
    if (ids.length) {
      const cases = sql.join(ids.map((id: string, index: number) => sql`when ${id} then ${index}`), sql` `);
      await scopedUpdate(taskSubtasks, lawFirmId, and(
        eq(taskSubtasks.taskId, taskId), inArray(taskSubtasks.id, ids),
      )!, { sortOrder: sql`case ${taskSubtasks.id}::text ${cases} else ${taskSubtasks.sortOrder} end` });
    }
    return this.list(lawFirmId, taskId);
  }
}

export = new TaskSubtasksRepository();
