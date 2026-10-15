/**
 * Who gets a provider copy of an assigned entity: a task, a matter event or a
 * client event.
 *
 * The per-change push (and its outbound retry) and the "sync existing" buttons
 * all answer this question, and they have to answer it the same way. When the
 * bulk button let through someone the per-change path did not, the button made
 * a copy and the next edit of the item deleted it again.
 *
 * - A task goes to its creator and to each assignee.
 * - An event goes to its assignees, or to its creator when nobody is assigned.
 *
 * A row with no recorded creator (an import, or one written before the column
 * was filled) has no stable creator. The per-change fan-out gives it to the
 * member who saved it, and its outbound retry replays that, so those callers
 * pass `actingUserId`. A bulk press or a backfill has no such member: a copy it
 * made for anyone would be deleted by the next save, so it passes none.
 *
 * Any other entity type (external events, billing items) is not assigned to
 * anyone, so this rule does not restrict it.
 */

const ASSIGNED_ENTITY_TYPES = new Set(['task', 'matterEvent', 'clientEvent']);

export function isAssignedEntityType(entityType: string): boolean {
  return ASSIGNED_ENTITY_TYPES.has(entityType);
}

export function isCalendarRecipient(
  entityType: string,
  entity: { assignedTo?: string[] | null; createdBy?: string | null },
  userId: string,
  actingUserId: string | null = null,
): boolean {
  if (!isAssignedEntityType(entityType)) return true;
  const assignees = Array.isArray(entity.assignedTo) ? entity.assignedTo : [];
  const creator = entity.createdBy || actingUserId;
  if (entityType === 'task') return creator === userId || assignees.includes(userId);
  return assignees.length ? assignees.includes(userId) : creator === userId;
}
