const subtasksRepo = require('./taskSubtasks.repository');
const { NotFoundError, ValidationError } = require('../../../shared/errors/AppError');
const { assertLawFirmMembership, assertLawFirmMemberships, assertMatterMembership, assertMatterMemberships, assertMatterReadAccess } = require('../../../shared/utils/membership');

/**
 * Verify the acting user can access the parent task before any subtask
 * read/write. Firm membership is required; if the task belongs to a matter, the
 * matter ethical wall is enforced too, so a member walled off from a confidential
 * matter cannot read or mutate its subtasks. Mirrors the record-level gate that
 * tasks.service applies on get/update/delete: a read follows the matter read
 * rule, a write demands matter membership.
 */
async function assertTaskInFirm(lawFirmId: string, taskId: string, userId: string, mode = 'write') {
  await assertLawFirmMembership(lawFirmId, userId);
  const scope = await subtasksRepo.getParentScope(lawFirmId, taskId);
  if (!scope) throw new NotFoundError('Task');
  if (!scope.matterId) return scope;
  await (mode === 'read' ? assertMatterReadAccess : assertMatterMembership)(lawFirmId, scope.matterId, userId);
  return scope;
}

/**
 * If an assignee is provided (non-empty), assert they are a firm member and,
 * for a matter-scoped parent task, a member of that same matter. An empty
 * string means "no assignee" and is stored as null.
 */
async function resolveAssignee(lawFirmId: string, assigneeUserId: any, matterId: string | null = null) {
  if (assigneeUserId === undefined) return undefined;
  const trimmed = (assigneeUserId || '').trim();
  if (!trimmed) return null;
  await assertLawFirmMemberships(lawFirmId, [trimmed]);
  if (matterId) await assertMatterMemberships(lawFirmId, matterId, [trimmed]);
  return trimmed;
}

export async function listSubtasks({ lawFirmId, taskId, userId }: any) {
  await assertTaskInFirm(lawFirmId, taskId, userId, 'read');
  const subtasks = await subtasksRepo.list(lawFirmId, taskId);
  return { subtasks };
}

export async function createSubtask({ lawFirmId, taskId, userId, title, assigneeUserId, sortOrder }: any) {
  const scope = await assertTaskInFirm(lawFirmId, taskId, userId);

  const cleanTitle = (title || '').trim();
  if (!cleanTitle) throw new ValidationError('Title is required');

  const assignee = await resolveAssignee(lawFirmId, assigneeUserId, scope.matterId);

  const subtask = await subtasksRepo.create(lawFirmId, taskId, {
    title: cleanTitle,
    assigneeUserId: assignee || null,
    sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
    createdBy: userId,
  });

  return { message: 'Subtask created successfully', subtask };
}

export async function updateSubtask({ lawFirmId, taskId, subtaskId, userId, title, isCompleted, assigneeUserId, sortOrder }: any) {
  const scope = await assertTaskInFirm(lawFirmId, taskId, userId);

  const existing = await subtasksRepo.getById(lawFirmId, taskId, subtaskId);
  if (!existing) throw new NotFoundError('Subtask');

  const fields: Record<string, any> = {};
  if (title !== undefined) {
    const cleanTitle = (title || '').trim();
    if (!cleanTitle) throw new ValidationError('Title cannot be empty');
    fields.title = cleanTitle;
  }
  if (isCompleted !== undefined) fields.isCompleted = isCompleted;
  if (sortOrder !== undefined) fields.sortOrder = sortOrder;
  if (assigneeUserId !== undefined) {
    fields.assigneeUserId = await resolveAssignee(lawFirmId, assigneeUserId, scope.matterId);
  }

  const subtask = await subtasksRepo.update(lawFirmId, taskId, subtaskId, fields, userId);
  if (!subtask) throw new NotFoundError('Subtask');

  return { message: 'Subtask updated successfully', subtask };
}

export async function deleteSubtask({ lawFirmId, taskId, subtaskId, userId }: any) {
  await assertTaskInFirm(lawFirmId, taskId, userId);

  const existing = await subtasksRepo.getById(lawFirmId, taskId, subtaskId);
  if (!existing) throw new NotFoundError('Subtask');

  await subtasksRepo.remove(lawFirmId, taskId, subtaskId);
  return { message: 'Subtask deleted successfully', subtaskId };
}

export async function reorderSubtasks({ lawFirmId, taskId, userId, subtaskIds }: any) {
  await assertTaskInFirm(lawFirmId, taskId, userId);
  const subtasks = await subtasksRepo.reorder(lawFirmId, taskId, subtaskIds);
  return { message: 'Subtasks reordered successfully', subtasks };
}
