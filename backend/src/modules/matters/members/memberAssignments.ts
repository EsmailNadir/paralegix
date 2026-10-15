import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  eventAssignees,
  events,
  taskAssignees,
  tasks,
} from '../../../shared/database/drizzle/schema';
import { tenantQuery, type DrizzleExecutor } from '../../../shared/database/queryContext';
import {
  scopedDelete,
  scopedInsertManyOnConflictDoNothing,
  scopedUpdate,
} from '../../../shared/database/scopedWrite';

/**
 * What hangs off a person's membership: the tasks they are assigned to, the
 * tasks that name them as a reminder recipient, and the events they are
 * assigned to. All three are required to be members of the matter the work sits
 * on, and the reminder paths resolve people without re-checking membership, so
 * a membership that ends has to take these with it.
 *
 * One implementation serves both removal paths. A firm-level removal passes no
 * `matterId` and clears the person everywhere in the firm; removing a member
 * from one matter passes its id and touches that matter's work only.
 */
export interface MemberWorkScope {
  lawFirmId: string;
  userId: string;
  /** Narrow to one matter's tasks and events. Omit for the whole firm. */
  matterId?: string | null;
  /**
   * Hand the person's task and event assignments to this user instead of
   * dropping them. A task or event the target already holds is left as is, so
   * the target never ends up with two rows. Reminder slots are never moved.
   */
  reassignTo?: string | null;
  executor?: DrizzleExecutor;
}

const taskIdsInScope = (lawFirmId: string, matterId?: string | null) => (matterId
  ? sql`(select ${tasks.id} from ${tasks} where ${tasks.lawFirmId} = ${lawFirmId} and ${tasks.matterId} = ${matterId})`
  : sql`(select ${tasks.id} from ${tasks} where ${tasks.lawFirmId} = ${lawFirmId})`);

// With no matter, every event the person is on is in scope, matter and client
// events alike: both carry reminder emails through the same assignee rows.
const eventIdsInScope = (lawFirmId: string, matterId?: string | null) => (matterId
  ? sql`(select ${events.id} from ${events} where ${events.lawFirmId} = ${lawFirmId} and ${events.matterId} = ${matterId})`
  : sql`(select ${events.id} from ${events} where ${events.lawFirmId} = ${lawFirmId})`);

/** Drop (or move) the person's rows in `task_assignees`. */
export async function clearTaskAssignees({ lawFirmId, userId, matterId, reassignTo, executor }: MemberWorkScope) {
  const inScope = sql`${taskAssignees.taskId} in ${taskIdsInScope(lawFirmId, matterId)}`;
  if (reassignTo) {
    const held = await tenantQuery(taskAssignees, lawFirmId, ({ executor: q, scope }) => q
      .select({ taskId: taskAssignees.taskId }).from(taskAssignees)
      .where(and(scope, eq(taskAssignees.userId, userId), inScope)), executor);
    await scopedInsertManyOnConflictDoNothing(
      taskAssignees, lawFirmId,
      held.map((row: { taskId: string }) => ({ taskId: row.taskId, userId: reassignTo })),
      [taskAssignees.taskId, taskAssignees.userId], undefined, executor,
    );
  }
  await scopedDelete(taskAssignees, lawFirmId, and(eq(taskAssignees.userId, userId), inScope)!, executor);
}

/** Remove the person from every task's explicit reminder recipients. */
export async function clearReminderRecipients({ lawFirmId, userId, matterId, executor }: MemberWorkScope) {
  const holdsUser = sql`${userId} = any(${tasks.reminderRecipientIds})`;
  await scopedUpdate(
    tasks,
    lawFirmId,
    matterId ? and(holdsUser, eq(tasks.matterId, matterId))! : holdsUser,
    { reminderRecipientIds: sql`array_remove(${tasks.reminderRecipientIds}, ${userId})` },
    executor,
  );
}

/** Drop (or move) the person's rows in `event_assignees`. */
export async function clearEventAssignees({ lawFirmId, userId, matterId, reassignTo, executor }: MemberWorkScope) {
  const inScope = sql`${eventAssignees.eventId} in ${eventIdsInScope(lawFirmId, matterId)}`;
  if (reassignTo) {
    const held = await tenantQuery(eventAssignees, lawFirmId, ({ executor: q, scope }) => q
      .select({ eventId: eventAssignees.eventId }).from(eventAssignees)
      .where(and(scope, eq(eventAssignees.userId, userId), inScope)), executor);
    await scopedInsertManyOnConflictDoNothing(
      eventAssignees, lawFirmId,
      held.map((row: { eventId: string }) => ({ eventId: row.eventId, userId: reassignTo })),
      [eventAssignees.eventId, eventAssignees.userId], undefined, executor,
    );
  }
  await scopedDelete(eventAssignees, lawFirmId, and(eq(eventAssignees.userId, userId), inScope)!, executor);
}

/** All three, for the per-matter removal where one transaction covers them. */
export async function pruneMemberAssignments(scope: MemberWorkScope) {
  await clearTaskAssignees(scope);
  await clearReminderRecipients(scope);
  await clearEventAssignees(scope);
}

export interface MemberWorkCounts {
  userId: string;
  openTasks: number;
  upcomingEvents: number;
  reminderSlots: number;
}

/**
 * What removing each of these users from one matter would touch: open (not
 * completed) tasks they are assigned to, upcoming events they are assigned to,
 * and open tasks that list them as a reminder recipient. Writes nothing.
 */
export async function countMemberWork(
  { lawFirmId, matterId, userIds }: { lawFirmId: string; matterId: string; userIds: string[] },
): Promise<MemberWorkCounts[]> {
  if (!userIds.length) return [];
  const counts = new Map<string, MemberWorkCounts>(
    userIds.map((userId) => [userId, { userId, openTasks: 0, upcomingEvents: 0, reminderSlots: 0 }]),
  );

  const taskRows = await tenantQuery(taskAssignees, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: taskAssignees.userId, n: sql<number>`count(*)` }).from(taskAssignees)
    .innerJoin(tasks, and(eq(tasks.id, taskAssignees.taskId), eq(tasks.lawFirmId, taskAssignees.lawFirmId)))
    .where(and(
      scope, eq(tasks.matterId, matterId), ne(tasks.status, 'completed'),
      inArray(taskAssignees.userId, userIds),
    ))
    .groupBy(taskAssignees.userId));
  for (const row of taskRows) counts.get(row.userId)!.openTasks = Number(row.n);

  const eventRows = await tenantQuery(eventAssignees, lawFirmId, ({ executor, scope }) => executor
    .select({ userId: eventAssignees.userId, n: sql<number>`count(*)` }).from(eventAssignees)
    .innerJoin(events, and(eq(events.id, eventAssignees.eventId), eq(events.lawFirmId, eventAssignees.lawFirmId)))
    .where(and(
      scope, eq(events.matterId, matterId), eq(events.status, 'upcoming'),
      gte(events.date, new Date()), inArray(eventAssignees.userId, userIds),
    ))
    .groupBy(eventAssignees.userId));
  for (const row of eventRows) counts.get(row.userId)!.upcomingEvents = Number(row.n);

  const reminderRows = await tenantQuery(tasks, lawFirmId, ({ executor, scope }) => executor
    .select({ recipients: tasks.reminderRecipientIds }).from(tasks)
    .where(and(
      scope, eq(tasks.matterId, matterId), ne(tasks.status, 'completed'),
      sql`${tasks.reminderRecipientIds} && ${sql.param(userIds)}::text[]`,
    )));
  for (const row of reminderRows) {
    for (const recipient of row.recipients || []) {
      if (counts.has(recipient)) counts.get(recipient)!.reminderSlots += 1;
    }
  }

  return [...counts.values()];
}
