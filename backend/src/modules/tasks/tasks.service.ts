const tasksRepo = require('./tasks.repository');
import type { DrizzleExecutor } from '../../shared/database/queryContext';
const filesRepo = require('../files/files.repository');
const { removeCascadeObjects } = require('../files/cascadeSweep');
const mattersRepo = require('../matters/matters.repository');
const { assertAttachmentsReadable } = require('../../shared/attachments/attachmentLinks');
const { ForbiddenError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const eventBus = require('../../shared/events/eventBus');
const { TASK_CREATED, TASK_UPDATED, TASK_DELETED } = require('../../shared/events/eventTypes');
const { formatForClient, localInputToUtcDate, normalizeTimeZone, resolveEventDate } = require('../../shared/utils/time');
const { assertEndAfterStart, endWithoutCallerEnd, endsAtLocal } = require('../../shared/validation/eventRange');
const { taskDueInstant } = require('./taskDue');
const { assertLawFirmMemberships, assertMatterMembership, assertMatterMemberships, assertMatterReadAccess, getAccessibleMatterIds, isFirmOwnerOrAdmin, resolveMatterMembers } = require('../../shared/utils/membership');
const { resignAttachmentsOn } = require('../../shared/utils/attachmentSigning');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const { isUuid } = require('../../shared/utils/isUuid');
const { resolveEffectiveClientIds } = require('../clients/clientCompanyLinks.util');
const { assertFirmPermission } = require('../lawfirms/roles/requirePermission');

const VALID_STATUSES = new Set(['open', 'in_progress', 'completed', 'blocked']);
const isNonEmptyStr = (v: any) => typeof v === 'string' && v.trim().length > 0;
const dateOnly = (v: any) => (typeof v === 'string' ? v.slice(0, 10) : (v instanceof Date ? v.toISOString().slice(0, 10) : null));

// ── shared coercion (single source of truth for status + assignedTo) ──────────
/** Trim + validate a status against VALID_STATUSES, throwing a 400 on a bad value. */
function normalizeStatus(status: any, { fallback = 'open' }: any = {}) {
  const normalized = isNonEmptyStr(status) ? status.trim() : fallback;
  if (!VALID_STATUSES.has(normalized)) {
    throw Object.assign(new Error(`Invalid status. Use one of: ${[...VALID_STATUSES].join(', ')}`), { statusCode: 400 });
  }
  return normalized;
}
/** Coerce an assignedTo value (array | scalar | undefined) into a clean string[]. */
function toAssigneeArray(assignedTo: any) {
  if (Array.isArray(assignedTo)) return assignedTo.filter(Boolean);
  return assignedTo ? [assignedTo] : [];
}

async function resolveTaskReference(lawFirmId: string, referenceId: any, kind: any) {
  if (referenceId === undefined) return undefined;
  if (referenceId === null || referenceId === '') return null;
  if (!isUuid(referenceId)) throw new ValidationError(`Invalid ${kind} for this law firm`);

  const exists = kind === 'practiceArea'
    ? await mattersRepo.validatePracticeArea(lawFirmId, referenceId)
    : await mattersRepo.validateCourt(lawFirmId, referenceId);
  if (!exists) throw new ValidationError(`Invalid ${kind} for this law firm`);
  return referenceId;
}

/**
 * Split an incoming due date into the day-only `dueDate` anchor and the optional
 * precise `dueAt` instant.
 *
 * `due_date` stays day-only because recurrence, reminders, overdue and the
 * dashboard all key on the calendar day. `due_at` carries the time-of-day the
 * user picked (converted from their timezone to UTC) so the calendar can place
 * the task at its real time instead of a midnight/noon fallback. A bare
 * "YYYY-MM-DD" carries no time, so `dueAt` is null and the task stays all-day.
 * An explicit `allDayFlag: true` forces the same day-only outcome even when
 * `dueDate` carries a time component (e.g. the all-day toggle sends the
 * picked day at local midnight, not a bare date string).
 */
function resolveDue(dueDate: any, timezone: any, allDayFlag?: boolean) {
  if (dueDate == null || dueDate === '') return { dueDate: null, dueAt: null, allDay: false };
  const dayOnly = allDayFlag === true || (typeof dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDate));
  return {
    dueDate: dateOnly(dueDate),
    dueAt: dayOnly ? null : localInputToUtcDate(dueDate, timezone),
    allDay: dayOnly,
  };
}

/**
 * A task's end from the request, resolved the way an event's is: a timed end
 * in the caller's zone, an all-day end at its day's noon-UTC anchor (the
 * exclusive day after the last day). Null for no end.
 */
function resolveTaskEnd(endsAt: any, timezone: any, allDay: boolean) {
  if (endsAt == null || endsAt === '') return null;
  return resolveEventDate(endsAt, timezone, allDay);
}

/**
 * An end needs a start to come after. `tasks_ends_after_start` refuses both
 * cases; this gives the caller a 400 that names the problem instead of a 500.
 */
function assertTaskEnd(due: { dueDate: any; dueAt: any }, endsAtTs: any) {
  if (!endsAtTs) return;
  const start = taskDueInstant(due);
  if (!start) throw new ValidationError('An end needs a due date to come after');
  assertEndAfterStart(start, endsAtTs);
}

/**
 * Reject an internally-inconsistent recurrence config with a clean 400, so a bad
 * config never silently produces a recurring task that can never spawn. Mirrors
 * the per-step checks the recurrence cron applies (taskRecurrence.service.js):
 *   - endDate, if present, must be on/after the task's start (dueDate)
 *   - maxOccurrences, if present, must be a positive integer
 *   - a recurrence with no dueDate has no anchor to advance from
 * Only runs for enabled recurrence; disabled/absent recurrence is a no-op.
 */
function assertRecurrenceConsistent(recurrence: any, dueDate: any) {
  if (!recurrence || !recurrence.enabled) return;

  if (!dueDate) {
    throw new ValidationError('Recurrence requires a due date to advance from');
  }

  if (recurrence.maxOccurrences != null) {
    const max = Number(recurrence.maxOccurrences);
    if (!Number.isInteger(max) || max < 1) {
      throw new ValidationError('Recurrence maxOccurrences must be a positive integer');
    }
  }

  if (recurrence.endDate) {
    const start = dateOnly(dueDate);
    const end = dateOnly(recurrence.endDate);
    if (end && start && end < start) {
      throw new ValidationError('Recurrence endDate must be on or after the task due date');
    }
  }
}

/**
 * Add localized due-date display fields to a hydrated task entity.
 */
function formatTaskForResponse(t: any, tz: any) {
  const due = taskDueInstant(t);
  const { display, input } = formatForClient(due, tz, { dateOnly: t.allDay === true || !t.dueAt });
  return {
    ...t,
    // Anchor the serialized dueDate at the same instant used for display above:
    // the precise dueAt when the task is timed, else the day-only NOON-UTC anchor.
    // The old all-day branch used midnight UTC, which dayjs/new Date on the frontend
    // rolled back a day for viewers behind UTC (e.g. urgency colouring and the
    // dueDateLocalDisplay fallbacks that read the raw dueDate).
    dueDate: due ? due.toISOString() : null,
    dueDateLocalDisplay: display,
    dueDateLocalInput: input,
    endsAt: t.endsAt ? new Date(t.endsAt).toISOString() : null,
    ...endsAtLocal(t, tz),
  };
}

// ── CRUD ──────────────────────────────────────────────────────

export async function createTask(
  { lawFirmId, userId, timezone, skipCalendarEvent, ...body }: any,
  writeRelated?: (taskId: string, transaction: DrizzleExecutor) => Promise<void>,
) {
  const {
    matterId, title, description, location, dueDate, endsAt, allDay,
    assignedTo, practiceAreaId, courtId,
    status, priority, clientIds: reqClientIds,
    reminderRecipientIds, sendReminderEarly,
    recurrence, dependencies: reqDependencies,
  } = body;

  // ValidationError, not NotFoundError. `NotFoundError` appends " not found" to
  // whatever it is given, so this used to answer 404 with the user-facing
  // message "Title is required not found". `taskSubtasks.service.ts` throws
  // ValidationError for the identical check.
  if (!isNonEmptyStr(title)) throw new ValidationError({ title: ['Title is required'] });

  if (matterId) await assertMatterMembership(lawFirmId, matterId, userId);

  if (!matterId && Array.isArray(reqClientIds) && reqClientIds.length) {
    await assertFirmPermission(lawFirmId, userId, 'clients.manage');
  }

  const normalizedStatus = normalizeStatus(status);

  const assignedToArr = toAssigneeArray(assignedTo);
  const reminderRecipientArr = toAssigneeArray(reminderRecipientIds);
  const [resolvedPracticeAreaId, resolvedCourtId] = await Promise.all([
    resolveTaskReference(lawFirmId, practiceAreaId, 'practiceArea'),
    resolveTaskReference(lawFirmId, courtId, 'court'),
  ]);
  // Assignees on a matter task must be on the matter: otherwise they hold work
  // behind the ethical wall, and no one can record their time against it.
  if (matterId) {
    await assertMatterMemberships(lawFirmId, matterId, assignedToArr);
    // Explicit reminder recipients receive the task title, deadline and matter
    // name. They are part of the matter's confidential delivery audience too.
    await assertMatterMemberships(lawFirmId, matterId, reminderRecipientArr);
  }
  // Standalone tasks are firm-wide, but assignment still triggers notification
  // and calendar delivery. Never accept a UID from another firm (or a client)
  // as a recipient merely because this task has no matter scope.
  else {
    await assertLawFirmMemberships(lawFirmId, assignedToArr);
    await assertLawFirmMemberships(lawFirmId, reminderRecipientArr);
  }
  const { dueDate: dueIso, dueAt, allDay: resolvedAllDay } = resolveDue(dueDate, timezone, allDay);
  const endsAtTs = resolveTaskEnd(endsAt, timezone, resolvedAllDay);
  assertTaskEnd({ dueDate: dueIso, dueAt }, endsAtTs);

  // Reject a contradictory recurrence config (bad endDate/maxOccurrences) up front.
  assertRecurrenceConsistent(recurrence, dueIso);

  const created = await tasksRepo.createTask(lawFirmId, {
    matterId: matterId || null,
    title: title.trim(),
    description: isNonEmptyStr(description) ? description.trim() : '',
    location: isNonEmptyStr(location) ? location.trim() : null,
    status: normalizedStatus,
    priority: priority || 'medium',
    dueDate: dueIso,
    dueAt,
    endsAt: endsAtTs,
    allDay: resolvedAllDay,
    dueDateTimeZone: dueIso ? timezone : null,
    source: 'app',
    practiceAreaId: resolvedPracticeAreaId || null,
    courtId: resolvedCourtId || null,
    createdBy: userId,
    assignedTo: assignedToArr,
    clientIds: matterId ? [] : (Array.isArray(reqClientIds) ? reqClientIds : []),
    dependencies: Array.isArray(reqDependencies) ? reqDependencies : [],
    reminderRecipientIds: reminderRecipientArr,
    sendReminderEarly: sendReminderEarly === true,
    recurrence: recurrence && recurrence.enabled ? {
      enabled: true,
      pattern: recurrence.pattern,
      interval: recurrence.interval || 1,
      daysOfWeek: recurrence.daysOfWeek || null,
      dayOfMonth: recurrence.dayOfMonth || null,
      endDate: recurrence.endDate ? dateOnly(recurrence.endDate) : null,
      maxOccurrences: recurrence.maxOccurrences || null,
      occurrenceCount: 0,
      sourceTaskId: null,
    } : null,
  }, writeRelated);

  // Emit TASK_CREATED whenever the task has assignees OR a due date, so the
  // notifications listener fires for assignee-bearing tasks even without a due
  // date. (`skipCalendarEvent` still suppresses the whole emit for bulk/import.)
  // The calendar TASK_CREATED listener safely no-ops for a task with no due
  // date. The task adapter's toCalendarItems returns [] when !dueDate, and the
  // provider create path short-circuits on an empty items array, so no calendar
  // event is created and nothing is left to update/delete.
  const hasAssignees = Array.isArray(created.assignedTo) && created.assignedTo.length > 0;
  if ((created.dueDate || hasAssignees) && !skipCalendarEvent) {
    // Detached fire-and-forget (consistent with other event producers): the
    // notification/calendar listeners are each try/catch-wrapped and the outbox
    // (when enabled) is the durability backstop, so we don't block the HTTP
    // response on listener completion.
    eventBus.emit(TASK_CREATED, { lawFirmId, taskId: created.id, entityData: created, userId, timeZone: timezone });
  }

  return { message: 'Task created successfully', taskId: created.id, task: formatTaskForResponse(created, timezone) };
}

/**
 * Deleting a task cascades its documents and sweeps their stored objects, so a
 * task on a matter under legal hold is refused the same way the files routes
 * refuse deleting that matter's documents. Without this, moving evidence onto a
 * task and deleting the task would get round the hold.
 */
const TASK_LEGAL_HOLD_MESSAGE = 'This matter is under legal hold, so its tasks cannot be deleted. '
  + 'Lift the hold on the matter first.';

/**
 * Moving a task off a held matter is refused for the same reason: once the task
 * sits on another matter, or on none, nothing stops it being deleted along with
 * its documents. Moving a task ONTO a held matter is allowed.
 */
const TASK_LEGAL_HOLD_MOVE_MESSAGE = 'This matter is under legal hold, so its tasks cannot be moved to another matter. '
  + 'Lift the hold on the matter first.';

export async function updateTask({ lawFirmId, taskId, userId, timezone, skipCalendarEvent, ...body }: any) {
  const {
    title, description, location, status, dueDate, endsAt, allDay,
    assignedTo, practiceAreaId, courtId,
    matterId, attachments, priority,
    clientIds: reqClientIds, reminderRecipientIds, sendReminderEarly,
    recurrence, dependencies: reqDependencies,
  } = body;

  const current = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!current) throw new NotFoundError('Task');

  // Record-level gate: a task on a matter is only editable/readable by members of
  // that matter (mirrors getTask/deleteTask). Without this, any member with the
  // tasks.update permission could mutate and read back a task on a matter they
  // are deliberately walled off from.
  if (isNonEmptyStr(current.matterId)) await assertMatterMembership(lawFirmId, current.matterId, userId);

  const updates: Record<string, any> = {};
  if (isNonEmptyStr(title)) updates.title = title.trim();
  if (typeof description === 'string') updates.description = description.trim();
  if (typeof location !== 'undefined') updates.location = isNonEmptyStr(location) ? location.trim() : null;
  if (typeof priority !== 'undefined') updates.priority = priority;

  if (isNonEmptyStr(status)) {
    updates.status = normalizeStatus(status);
  }

  // Recurrence is checked against the state the task will END UP in: the incoming
  // value when the body carries one, else the stored one. A body that only clears
  // or moves `dueDate` must still be refused when the stored recurrence would be
  // left with no anchor (or an end date before the new start).
  if (typeof dueDate !== 'undefined' && typeof recurrence === 'undefined') {
    assertRecurrenceConsistent(current.recurrence, dateOnly(dueDate));
  }
  if (typeof recurrence !== 'undefined') {
    // The effective start to validate against is the incoming dueDate if supplied,
    // otherwise the task's existing dueDate.
    const effectiveDue = typeof dueDate !== 'undefined' ? dateOnly(dueDate) : current.dueDate;
    assertRecurrenceConsistent(recurrence, effectiveDue);
    updates.recurrence = (recurrence && recurrence.enabled) ? {
      enabled: true,
      pattern: recurrence.pattern,
      interval: recurrence.interval || 1,
      daysOfWeek: recurrence.daysOfWeek || null,
      dayOfMonth: recurrence.dayOfMonth || null,
      endDate: recurrence.endDate ? dateOnly(recurrence.endDate) : null,
      maxOccurrences: recurrence.maxOccurrences || null,
      occurrenceCount: current.recurrence?.occurrenceCount || 0,
      sourceTaskId: current.recurrence?.sourceTaskId || null,
    } : null;
  }

  if (typeof dueDate !== 'undefined') {
    const { dueDate: dueIso, dueAt, allDay: resolvedAllDay } = resolveDue(dueDate, timezone, allDay);
    updates.dueDate = dueIso;
    updates.dueAt = dueAt;
    updates.dueDateTimeZone = dueIso ? timezone : null;
    updates.allDay = resolvedAllDay;
  } else if (allDay !== undefined && allDay !== (current.allDay === true)) {
    // A partial toggle uses the stored day. Becoming timed starts at noon
    // in the caller's zone, the same default the forms offer.
    const input = allDay ? current.dueDate : (current.dueAt || (current.dueDate ? `${current.dueDate}T12:00` : null));
    const due = resolveDue(input, timezone, allDay);
    updates.dueDate = due.dueDate;
    updates.dueAt = due.dueAt;
    updates.dueDateTimeZone = due.dueDate ? timezone : null;
    updates.allDay = due.allDay;
  }

  // The end, checked against the start this write leaves in place. Without an
  // end of its own, a moved start carries the stored end along and an all-day
  // flip drops it (`endWithoutCallerEnd`); a cleared due date takes it too,
  // since an end needs a start.
  const nextDue = updates.dueDate !== undefined
    ? { dueDate: updates.dueDate, dueAt: updates.dueAt }
    : { dueDate: current.dueDate, dueAt: current.dueAt };
  const nextAllDay = updates.allDay !== undefined ? updates.allDay : current.allDay === true;
  if (typeof endsAt !== 'undefined') {
    updates.endsAt = resolveTaskEnd(endsAt, timezone, nextAllDay);
  } else if (updates.dueDate !== undefined && !updates.dueDate) {
    if (current.endsAt) updates.endsAt = null;
  } else {
    const implicitEnd = endWithoutCallerEnd(
      { date: taskDueInstant(current), endsAt: current.endsAt, allDay: current.allDay },
      {
        date: updates.dueDate !== undefined ? taskDueInstant(nextDue) : undefined,
        allDay: updates.allDay,
      },
    );
    if (implicitEnd !== undefined) updates.endsAt = implicitEnd;
  }
  if (updates.endsAt !== undefined) assertTaskEnd(nextDue, updates.endsAt);

  if (typeof assignedTo !== 'undefined') {
    updates.assignedTo = toAssigneeArray(assignedTo);
  }
  if (typeof practiceAreaId !== 'undefined') {
    updates.practiceAreaId = await resolveTaskReference(lawFirmId, practiceAreaId, 'practiceArea');
  }
  if (typeof courtId !== 'undefined') {
    updates.courtId = await resolveTaskReference(lawFirmId, courtId, 'court');
  }

  if (typeof matterId !== 'undefined') {
    if (matterId) await assertMatterMembership(lawFirmId, matterId, userId);
    if (isNonEmptyStr(current.matterId) && (matterId || null) !== current.matterId
      && (await mattersRepo.findHeldMatterIds(lawFirmId, [current.matterId])).size) {
      throw new ForbiddenError(TASK_LEGAL_HOLD_MOVE_MESSAGE);
    }
    updates.matterId = matterId || null;
    // clients are derived for matter-scoped; cleared by repo when switching to a matter
  }

  const effectiveMatterId = typeof matterId !== 'undefined' ? matterId : current.matterId;
  if (!effectiveMatterId && Array.isArray(reqClientIds)) {
    const previous = new Set<string>(current.matterId ? [] : current.clientIds);
    const requested = new Set<string>(reqClientIds);
    if (previous.size !== requested.size || [...requested].some((id) => !previous.has(id))) {
      await assertFirmPermission(lawFirmId, userId, 'clients.manage');
    }
    updates.clientIds = reqClientIds;
  }

  const effectiveAssignees = updates.assignedTo || current.assignedTo || [];
  const normalizedReminderRecipients = toAssigneeArray(reminderRecipientIds);
  const effectiveReminderRecipients = typeof reminderRecipientIds !== 'undefined'
    ? normalizedReminderRecipients
    : toAssigneeArray(current.reminderRecipientIds);

  // Validate assignees against the matter the task will end up on, not the one it
  // started on: moving a task onto a matter has to re-check the people already on
  // it, or an outsider rides along on the move.
  if (effectiveMatterId) {
    await assertMatterMemberships(lawFirmId, effectiveMatterId, effectiveAssignees);
    await assertMatterMemberships(lawFirmId, effectiveMatterId, effectiveReminderRecipients);
  } else if (updates.assignedTo !== undefined || typeof matterId !== 'undefined') {
    await assertLawFirmMemberships(lawFirmId, effectiveAssignees);
  }
  if (!effectiveMatterId && (typeof reminderRecipientIds !== 'undefined' || typeof matterId !== 'undefined')) {
    await assertLawFirmMemberships(lawFirmId, effectiveReminderRecipients);
  }

  if (typeof reminderRecipientIds !== 'undefined') {
    updates.reminderRecipientIds = normalizedReminderRecipients;
  }
  if (typeof sendReminderEarly !== 'undefined') updates.sendReminderEarly = sendReminderEarly === true;
  if (typeof reqDependencies !== 'undefined') updates.dependencies = Array.isArray(reqDependencies) ? reqDependencies : [];
  if (Array.isArray(attachments)) {
    await assertAttachmentsReadable(lawFirmId, attachments, userId);
    updates.attachments = attachments;
    // Who is attaching: the link check applies the matter wall to this person,
    // and the link row records them as its author.
    updates.editedBy = userId;
  }

  const updated = await tasksRepo.updateTask(lawFirmId, taskId, updates, { currentMatterId: current.matterId });

  if (!skipCalendarEvent) {
    // Detached fire-and-forget. Listeners are try/catch-wrapped and the outbox
    // is the durability backstop; the response returns without awaiting fan-out.
    // A task's provider copy may carry a location the member added in Google or
    // Outlook, which Paralegix never reads back. The push blanks it only when
    // this edit cleared a location Paralegix itself had set.
    const locationCleared = 'location' in updates && !updates.location && isNonEmptyStr(current.location);
    eventBus.emit(TASK_UPDATED, {
      lawFirmId, taskId, entityData: { ...updated, locationCleared }, userId, timeZone: timezone,
      previousData: { assignedTo: current.assignedTo || [] },
    });
  }

  return { message: 'Task updated successfully', task: formatTaskForResponse(updated, timezone) };
}

export async function deleteTask({ lawFirmId, taskId, userId }: any) {
  const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!task) throw new NotFoundError('Task');

  if (isNonEmptyStr(task.matterId)) {
    await assertMatterMembership(lawFirmId, task.matterId, userId);
    if ((await mattersRepo.findHeldMatterIds(lawFirmId, [task.matterId])).size) {
      throw new ForbiddenError(TASK_LEGAL_HOLD_MESSAGE);
    }
  }

  // Snapshotted before the row goes: the task's documents cascade with it, and
  // nothing after this point could name their stored objects or their bytes.
  const files = await filesRepo.scopeSnapshot(lawFirmId, { taskId });

  // No separate attachment sweep, and nothing is lost by dropping it. Every
  // task attachment is uploaded through `/upload-task-attachments`, which
  // stamps `files.task_id` even when the task is matter-linked and the document
  // sits in the MATTER's tree. The snapshot above matches on that same column,
  // and so does the cascade, so the objects were already being swept here. The
  // old `deleteAttachments(task.attachments)` call was a second delete over the
  // same set, driven by a jsonb copy that no longer exists.
  await tasksRepo.deleteTask(lawFirmId, taskId); // task_dependencies cascade both directions
  // Inside the request: after the response Cloud Run gives this process no
  // CPU, and a sweep left to an event listener did not finish.
  await removeCascadeObjects('TASK_DELETED', lawFirmId, files);
  await eventBus.emitAsync(TASK_DELETED, { lawFirmId, taskId, entityData: task, userId, files });

  return { message: 'Task deleted successfully', taskId };
}

// ── READ ──────────────────────────────────────────────────────

async function _resignTaskAttachments(items: any) {
  try { await resignAttachmentsOn(items); } catch (e: any) { console.error('[tasks] re-sign attachments failed:', e.message); }
  return items;
}

export async function getTask({ lawFirmId, taskId, userId, timezone }: any) {
  const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!task) throw new NotFoundError('Task');
  if (isNonEmptyStr(task.matterId)) await assertMatterReadAccess(lawFirmId, task.matterId, userId);

  const formatted = formatTaskForResponse(task, timezone);
  // The notes themselves no longer travel with the task — only the count, for the
  // tab badge. The notes tab reads its own page from the notes list endpoint, so
  // a task with a long note history doesn't weigh down every other tab.
  formatted.totalNotes = await tasksRepo.countTaskNotes(lawFirmId, taskId);
  await _resignTaskAttachments(formatted);
  return formatted;
}

export async function listLawFirmTasks({ lawFirmId, userId, timezone, page, limit, status, assignee, matterId, clientId, priority, search, sortBy, order, sort, dueFrom, dueTo, includeSpanning = false }: any) {
  // Paginated/filtered/sorted path only when the caller opts in (any of
  // page/limit/status/assignee/matter/sortBy present). With no params the response
  // is byte-identical to the legacy full-set behavior the calendar feed and
  // client portal still rely on.
  //
  // `dueFrom`/`dueTo` deliberately do NOT opt into paging. The calendar sends them
  // to bound its read to the days it is drawing and needs every task in that
  // window; flipping to the paged branch would silently hand it the first page.
  //
  // Ordering note: the two paths intentionally diverge. The paged path defaults
  // to `title asc` (matching the table UI's initial sort in useTasksTable.ts), so
  // the first table render and the server's default agree. The legacy full-set
  // path stays `created_at desc` for the calendar feed / client portal, which
  // expect newest-first and do not present a sortable table.
  // Firm owners/admins see every firm task (matching the firm-wide matters view);
  // regular members stay scoped to firm-wide + their matter tasks (the ethical
  // wall). Clients/portal callers are never owners, so they remain scoped.
  const seeAll = await isFirmOwnerOrAdmin(lawFirmId, userId);

  // The client-detail Tasks tab (and its invoice-task picker) is the sole
  // caller of this single-`clientId` filter, so widening it here to also
  // include every company that client is linked to via `client_company_links`
  // is safe: no other surface passes `clientId` through this endpoint.
  const effectiveClientIds = isUuid(clientId)
    ? (await resolveEffectiveClientIds(lawFirmId, clientId)).clientIds
    : clientId;

  const wantsPaged = page != null || limit != null || status != null || assignee != null
    || matterId != null || clientId != null || priority != null || (typeof search === 'string' && search.trim() !== '')
    || sortBy != null || (Array.isArray(sort) && sort.length > 0);
  if (wantsPaged) {
    const { tasks: docs, totalTasks } = await tasksRepo.findVisibleToUserPaged(lawFirmId, userId, {
      seeAll, page, limit, status, assignee, matterId, clientId: effectiveClientIds, priority, search, sortBy, order, sort, dueFrom, dueTo, includeSpanning,
      spanZone: normalizeTimeZone(timezone),
    });
    const tasks = docs.map((d: any) => formatTaskForResponse(d, timezone));
    await _resignTaskAttachments(tasks);
    return { tasks, totalTasks };
  }

  const docs = await tasksRepo.findVisibleToUser(lawFirmId, userId, {
    seeAll, dueFrom, dueTo, includeSpanning, spanZone: normalizeTimeZone(timezone),
  });
  const tasks = docs.map((d: any) => formatTaskForResponse(d, timezone));
  await _resignTaskAttachments(tasks);
  return { tasks, totalTasks: tasks.length };
}

/**
 * Firm-wide task counts per status.
 *
 * Kept separate from the list because a calendar's task list is date-windowed
 * while these totals are not: they report the state of the firm's work, not of
 * the days on screen.
 */
export async function getTaskStatusCounts({ lawFirmId, userId }: any) {
  const seeAll = await isFirmOwnerOrAdmin(lawFirmId, userId);
  return tasksRepo.countByStatus(lawFirmId, userId, { seeAll });
}

/**
 * Ceiling on a single "select all" answer AND the cap every bulk route applies to
 * its `taskIds` body. Well above any realistic firm-wide selection, low enough
 * that the response and the bulk request built from it stay a sane size. Past it
 * the caller is told the selection was capped rather than being handed a silent
 * subset.
 *
 * ONE constant on purpose. The grid sends a select-all answer straight to
 * bulk-delete / bulk-status / bulk-matter, so a cap below this ceiling would turn
 * a full, legitimate selection into a 400, and a cap above it would let a caller
 * hand the service an id list the grid could never have produced. Two numbers
 * that must be equal drift; one number cannot. `tasks.validation.ts` imports this
 * rather than restating it.
 */
export const MAX_BULK_TASK_IDS = 5000;

/**
 * The ids of every task the user can see under the given filters, with no
 * pagination. Backs "select all" in the tasks grid: the user means every task the
 * current filters match, not the page on screen, and a bulk action needs the ids
 * to act on.
 *
 * Visibility and filtering are the same ones `listLawFirmTasks` applies, so the
 * selection can never reach a task the list wouldn't have shown.
 */
export async function listTaskIds({ lawFirmId, userId, status, assignee, matterId, clientId, priority, search, dueFrom, dueTo }: any) {
  const seeAll = await isFirmOwnerOrAdmin(lawFirmId, userId);
  // Widened exactly as `listLawFirmTasks` widens it, so a person's selection
  // includes the tasks attached to the organizations they belong to.
  const effectiveClientIds = isUuid(clientId)
    ? (await resolveEffectiveClientIds(lawFirmId, clientId)).clientIds
    : clientId;
  const { ids, truncated } = await tasksRepo.listVisibleIds(lawFirmId, userId, {
    seeAll, status, assignee, matterId, clientId: effectiveClientIds, priority, search, dueFrom, dueTo,
    max: MAX_BULK_TASK_IDS,
  });
  return { ids, totalItems: ids.length, truncated, limit: MAX_BULK_TASK_IDS };
}

/**
 * Typeahead source for task pickers. Applies the same owner/admin vs
 * member-scoped visibility as the full list, so a picker can never surface a
 * task the user isn't allowed to see.
 */
export async function lookupTasks({ lawFirmId, userId, search, exactName, ids, clientId, matterId, limit }: any) {
  const seeAll = await isFirmOwnerOrAdmin(lawFirmId, userId);
  return tasksRepo.lookupTasks(lawFirmId, userId, { seeAll, search, exactName, ids, clientId, matterId, limit });
}

export async function listMatterTasks({ lawFirmId, matterId, userId, timezone }: any) {
  await assertMatterReadAccess(lawFirmId, matterId, userId);
  // The read check above admits firm owners and admins whether or not they are on
  // the matter, so the list must too (see `getTask` and `listLawFirmTasks`).
  const seeAll = await isFirmOwnerOrAdmin(lawFirmId, userId);
  const docs = await tasksRepo.findByMatterAndUser(lawFirmId, matterId, userId, { seeAll });
  const tasks = docs.map((d: any) => formatTaskForResponse(d, timezone));
  await _resignTaskAttachments(tasks);
  return { tasks, totalTasks: tasks.length };
}

// ── BULK OPS ──────────────────────────────────────────────────

/**
 * How many of a bulk route's listener chains may be in flight at once.
 *
 * Every task in a bulk request produces a domain event, and each event's
 * listeners run their own queries against the twelve connections an instance
 * shares with every other request. A "select all" selection is thousands of
 * tasks, so a bare emit-per-task loop starts thousands of chains in one tick and
 * the cost lands on unrelated requests. Three is the width the rest of this sweep
 * uses for detached per-item work.
 */
const BULK_EVENT_FANOUT = 3;

/**
 * Emit one event per item with at most `BULK_EVENT_FANOUT` listener chains running
 * at once, WITHOUT awaiting them.
 *
 * Detached on purpose, and the two halves are separate decisions. Bounding is what
 * stops a large batch monopolising the pool. Staying detached is what keeps the
 * route inside its request budget: a bulk body may carry thousands of tasks, and
 * awaiting thousands of listener chains three at a time would take far longer than
 * the 20s read / 40s write budgets no matter how fast any single chain is. The
 * route's contract is the write and the response; the listeners are consequences
 * of it, exactly as they were when `emit` returned before they finished.
 *
 * `emitAsync` (not `emit`) is what makes a slot mean something: it hands back a
 * promise that settles when that event's listeners do, so the next event waits for
 * a free slot rather than starting immediately. It settles listeners with
 * `allSettled` and `runWithConcurrency` never rejects, so a failing listener still
 * cannot change what the route returned.
 */
function emitBulkDetached(eventName: string, payloads: any[]) {
  if (!payloads.length) return;
  void runWithConcurrency(
    payloads.map((payload: any) => () => eventBus.emitAsync(eventName, payload)),
    BULK_EVENT_FANOUT,
  ).catch((err: any) => console.error(`tasks.service: ${eventName} bulk fan-out failed:`, err));
}

/**
 * Resolve matter-membership for a batch of fetched task docs in a SINGLE query
 * (replaces the per-task assertMatterMembership loop). Mutates `errors` for any
 * matter-scoped task whose matter the user can't access, using `reason`.
 */
async function _markInaccessibleMatters(lawFirmId: string, docs: any, errors: any, userId: string, reason: any) {
  const matterIds = docs.filter((d: any) => !errors[d.id] && isNonEmptyStr(d.data.matterId)).map((d: any) => d.data.matterId);
  if (!matterIds.length) return;
  const accessible = await getAccessibleMatterIds(lawFirmId, matterIds, userId);
  for (const d of docs) {
    if (!errors[d.id] && isNonEmptyStr(d.data.matterId) && !accessible.has(d.data.matterId)) {
      errors[d.id] = reason;
    }
  }
}

export async function bulkDelete({ lawFirmId, taskIds, userId }: any) {
  const { docs, errors } = await tasksRepo.fetchTasksForFirm(lawFirmId, taskIds);
  await _markInaccessibleMatters(lawFirmId, docs, errors, userId, 'No access to task matter');
  // One query for the whole batch; a held matter's task is a per-id failure,
  // matching the single delete's refusal.
  const held = await mattersRepo.findHeldMatterIds(
    lawFirmId,
    docs.filter((d: any) => !errors[d.id] && isNonEmptyStr(d.data.matterId)).map((d: any) => d.data.matterId),
  );
  for (const d of docs) {
    if (!errors[d.id] && held.has(d.data.matterId)) errors[d.id] = TASK_LEGAL_HOLD_MESSAGE;
  }
  const validDocs = docs.filter((d: any) => !errors[d.id]);
  if (validDocs.length > 0) {
    // Detached, bounded emits, each fanning out its own try/catch-wrapped
    // listeners. The snapshot names every document under each task, which is
    // also what is attached to it, so the file sweep covers both.
    // One query for every task's documents, so a large selection does not take
    // one pool connection per task.
    const snapshotsByTask = await filesRepo.scopeSnapshotsForTasks(lawFirmId, validDocs.map((d: any) => d.id));
    const fileSnapshots = validDocs.map((doc: any) => snapshotsByTask.get(doc.id));
    await tasksRepo.batchDelete(lawFirmId, validDocs.map((d: any) => d.id));
    // One task at a time, each eight objects at a time, after the rows are gone.
    for (const snapshot of fileSnapshots) {
      // eslint-disable-next-line no-await-in-loop
      await removeCascadeObjects('TASK_DELETED', lawFirmId, snapshot);
    }
    emitBulkDetached(TASK_DELETED, validDocs.map((doc: any, i: number) => ({
      lawFirmId, taskId: doc.id, entityData: doc.data, userId, files: fileSnapshots[i],
    })));
  }
  return { message: 'Bulk delete completed', requested: taskIds.length, deleted: validDocs.length, failed: Object.keys(errors), errors };
}

export async function bulkStatus({ lawFirmId, taskIds, status, userId, timezone }: any) {
  const normalized = normalizeStatus(status, { fallback: status });
  const { docs, errors } = await tasksRepo.fetchTasksForFirm(lawFirmId, taskIds);
  await _markInaccessibleMatters(lawFirmId, docs, errors, userId, 'No access to task matter');
  const validDocs = docs.filter((d: any) => !errors[d.id]);
  if (validDocs.length > 0) {
    await tasksRepo.batchUpdateStatus(lawFirmId, validDocs.map((d: any) => d.id), normalized);
    emitBulkDetached(TASK_UPDATED, validDocs.map((doc: any) => ({
      lawFirmId, taskId: doc.id, entityData: { ...doc.data, status: normalized }, userId, timeZone: timezone,
      previousData: { assignedTo: doc.data.assignedTo || [] },
    })));
  }
  return { message: 'Bulk status update completed', requested: taskIds.length, updated: validDocs.length, failed: Object.keys(errors), errors };
}

export async function bulkMatter({ lawFirmId, taskIds, matterId, userId, timezone }: any) {
  if (matterId) await assertMatterMembership(lawFirmId, matterId, userId);
  const { docs, errors } = await tasksRepo.fetchTasksForFirm(lawFirmId, taskIds);
  await _markInaccessibleMatters(lawFirmId, docs, errors, userId, 'No access to current task matter');
  // One query for the whole batch; a task leaving a held matter is a per-id
  // failure, matching the single update's refusal.
  const leaving = docs.filter((d: any) => !errors[d.id] && isNonEmptyStr(d.data.matterId)
    && d.data.matterId !== (matterId || null));
  const held = await mattersRepo.findHeldMatterIds(lawFirmId, leaving.map((d: any) => d.data.matterId));
  for (const d of leaving) {
    if (held.has(d.data.matterId)) errors[d.id] = TASK_LEGAL_HOLD_MOVE_MESSAGE;
  }
  // Moving a task onto a matter changes the membership boundary for its
  // existing assignees. Match updateTask's effective-matter check per item so
  // a bulk move cannot carry a colleague outside the destination matter into
  // its confidential work or reminder audience.
  if (matterId) {
    // Every task in one request shares the same destination, so the roster is
    // one query for the whole batch rather than two per task. The per-task
    // decision is then made in memory; only a task that actually carries an
    // outsider pays for `assertMatterMemberships` again, and it pays for it to
    // get the message naming that person, which is the part worth a round trip.
    const candidates = docs.filter((d: any) => !errors[d.id]);
    const audience = (doc: any) => [...(doc.data.assignedTo || []), ...(doc.data.reminderRecipientIds || [])];
    const members = await resolveMatterMembers(
      lawFirmId, matterId, candidates.flatMap(audience).filter(Boolean),
    );
    for (const doc of candidates) {
      if (!audience(doc).some((id: any) => id && !members.has(id))) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await assertMatterMemberships(lawFirmId, matterId, doc.data.assignedTo || []);
        // Assignees before reminder recipients, so a task with an outsider in
        // both reports the assignee, exactly as the per-task check did.
        // eslint-disable-next-line no-await-in-loop
        await assertMatterMemberships(lawFirmId, matterId, doc.data.reminderRecipientIds || []);
      } catch (err: any) {
        errors[doc.id] = err?.message || 'One or more assignees cannot access the destination matter';
      }
    }
  }
  const validDocs = docs.filter((d: any) => !errors[d.id]);
  if (validDocs.length > 0) {
    await tasksRepo.batchUpdateMatter(lawFirmId, validDocs.map((d: any) => d.id), matterId);
    emitBulkDetached(TASK_UPDATED, validDocs.map((doc: any) => ({
      lawFirmId, taskId: doc.id, entityData: { ...doc.data, matterId: matterId || null }, userId, timeZone: timezone,
      previousData: { assignedTo: doc.data.assignedTo || [] },
    })));
  }
  return { message: 'Bulk matter update completed', requested: taskIds.length, updated: validDocs.length, failed: Object.keys(errors), errors };
}

// ── DASHBOARD / GRAPH / ANALYTICS ─────────────────────────────

export async function getMyAssignments({ lawFirmId, userId, timezone }: any) {
  const rawTasks = await tasksRepo.findAssignedToUser(lawFirmId, userId);
  const tasks = rawTasks.map((t: any) => formatTaskForResponse(t, timezone));
  await _resignTaskAttachments(tasks);

  return { tasks, totalTasks: tasks.length };
}

export async function getTaskDependencyGraph({ lawFirmId, taskId, userId, timezone }: any) {
  const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!task) throw new NotFoundError('Task');
  if (isNonEmptyStr(task.matterId)) await assertMatterReadAccess(lawFirmId, task.matterId, userId);

  // Scope linked tasks to those the user can actually see. Following a
  // dependency edge must not expose a task in a matter they're not a member of.
  const fetchTasks = async (ids: any) =>
    (await tasksRepo.findByIdsVisibleToUser(lawFirmId, ids || [], userId)).map((t: any) => formatTaskForResponse(t, timezone));

  const [dependencies, dependents] = await Promise.all([
    fetchTasks(task.dependencies || []),
    fetchTasks(task.dependents || []),
  ]);

  return { dependencies, dependents };
}

export async function getTaskAnalytics({ lawFirmId, userId, timezone, dateRange }: any) {
  const now = new Date();
  let cutoff = null;
  if (dateRange === '7d') cutoff = new Date(now.getTime() - 7 * 86400000);
  else if (dateRange === '30d') cutoff = new Date(now.getTime() - 30 * 86400000);
  else if (dateRange === '90d') cutoff = new Date(now.getTime() - 90 * 86400000);

  // Aggregate in SQL (status/priority counts via FILTER, overdue + avg completion,
  // a per-assignee rollup, and a created/completed daily trend) instead of
  // hydrating the full TASK_SELECT and looping in Node. The dateRange cutoff is
  // pushed into `where created_at >= cutoff`.
  const { summary, byAssignee, trend } = await tasksRepo.getAnalyticsAggregates(lawFirmId, userId, {
    cutoff, timeZone: normalizeTimeZone(timezone), seeAll: await isFirmOwnerOrAdmin(lawFirmId, userId),
  });

  const avgSeconds = summary.avg_completion_seconds != null ? Number(summary.avg_completion_seconds) : null;
  const avgCompletionDays = avgSeconds != null ? Math.round((avgSeconds / 86400) * 10) / 10 : null;

  return {
    summary: {
      total: summary.total || 0,
      completed: summary.completed || 0,
      overdue: summary.overdue || 0,
      open: summary.open || 0,
      inProgress: summary.in_progress || 0,
      blocked: summary.blocked || 0,
    },
    byAssignee: byAssignee.map((a: any) => ({
      userId: a.user_id,
      name: a.name || a.user_id,
      total: a.total || 0,
      completed: a.completed || 0,
      overdue: a.overdue || 0,
    })),
    byPriority: {
      low: summary.p_low || 0,
      medium: summary.p_medium || 0,
      high: summary.p_high || 0,
      urgent: summary.p_urgent || 0,
    },
    completionTrend: trend.map((t: any) => ({ date: t.date, created: t.created || 0, completed: t.completed || 0 })),
    avgCompletionDays,
  };
}
