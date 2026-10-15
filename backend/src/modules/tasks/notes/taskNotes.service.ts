/**
 * Task notes.
 *
 * The full feature lives in the shared notes engine (`shared/notes/notesEngine.ts`),
 * which matter, task, and client notes all use identically. This module
 * supplies only what's task-specific: task visibility as the access check,
 * and the task's own matter (or, if it has none, its first linked client) as
 * the billing context for "Add time".
 */

const tasksRepo = require('../tasks.repository');
const { NotFoundError, ForbiddenError } = require('../../../shared/errors/AppError');
const { assertLawFirmMembership, isFirmOwnerOrAdmin } = require('../../../shared/utils/membership');
const {
  TASK_NOTE_CREATED, TASK_NOTE_UPDATED, TASK_NOTE_RETRACTED, TASK_NOTE_TIME_RECORDED,
} = require('../../../shared/events/eventTypes');
const { notes, noteVersions, noteReplies } = require('../../../shared/database/drizzle/schema');
const { createNotesEngine } = require('../../../shared/notes/notesEngine');
const { CONTEXT_TYPES } = require('../../billing/context');

/**
 * A task is visible to a user if the task itself names them (`visibleToUserIds`,
 * derived from matter membership or explicit assignment), else any firm member
 * can see it. This is the WRITE gate; reads go through `assertTaskReadAccess`.
 */
export async function assertTaskAccess(lawFirmId: string, taskId: string, userId: string) {
  const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!task) throw new NotFoundError('Task');
  if (Array.isArray(task.visibleToUserIds) && task.visibleToUserIds.length > 0) {
    if (!task.visibleToUserIds.includes(userId)) throw new ForbiddenError('No access to this task');
  } else {
    await assertLawFirmMembership(lawFirmId, userId);
  }
}

/**
 * Read gate: `assertTaskAccess`, widened so firm owners and admins pass. The task
 * list already shows them every task in the firm (`seeAll` in tasks.service), so
 * holding the notes to the task's own audience left them able to open a task and
 * not read its thread. Writing still runs the strict gate, matching the split
 * matter notes already use (assertMatterReadAccess / assertMatterMembership).
 */
export async function assertTaskReadAccess(lawFirmId: string, taskId: string, userId: string) {
  if (await isFirmOwnerOrAdmin(lawFirmId, userId)) {
    // Widened on WHO may read, never on WHETHER the task exists in this firm.
    // Returning here without the lookup let the notes SQL run with whatever the
    // URL carried: a non-uuid reached `task_id = $2` as a cast error and
    // surfaced as a 500, and another firm's task id answered 200 with an empty
    // list instead of the 404 the strict path gives.
    const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
    if (!task) throw new NotFoundError('Task');
    return;
  }
  await assertTaskAccess(lawFirmId, taskId, userId);
}

/**
 * A task's billing context: its own matter if it has one, else its first
 * linked client (a firm-scoped task can be tied directly to one or more
 * clients instead of a matter), else null — "Add time" simply isn't offered
 * on a task with neither.
 */
async function resolveTaskBillingContext(lawFirmId: string, taskId: string) {
  const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!task) return null;
  if (task.matterId) return { type: CONTEXT_TYPES.matter, lawFirmId, entityId: task.matterId };
  if (task.clientIds?.length) return { type: CONTEXT_TYPES.client, lawFirmId, entityId: task.clientIds[0] };
  return null;
}

/**
 * Fields every task note event carries beyond the task id: the task's matter,
 * so a mention notification is tagged with it and goes when the matter does.
 * Shared with the task note replies adapter.
 */
export async function taskNoteEventContext(lawFirmId: string, taskId: string) {
  const task = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  return { matterId: task?.matterId || null };
}

const TASK_NOTE_COLUMNS = {
  content: 'notes.content',
  subject: 'notes.subject',
  // The author's CURRENT name, joined at search time. `created_by_name` was a
  // frozen copy, so a renamed member could not be found under the name their
  // colleagues actually use. A subquery rather than a join alias because this
  // expression also runs inside the count and page-locator queries, which
  // have no join to alias against.
  author: '(select u.name from users u where u.id = notes.created_by)',
  author_id: 'notes.created_by',
  noteType: 'notes.note_type',
  noteDate: 'notes.note_date',
  hasTime: `exists (
    select 1 from activities te
     where te.kind = 'time'
       and te.law_firm_id = notes.law_firm_id
       and te.linked_note_id = notes.id
  )`,
};

const engine = createNotesEngine({
  parentColumn: 'taskId',
  rawTableName: 'notes',
  parentRawColumn: 'task_id',
  columns: TASK_NOTE_COLUMNS,
  assertReadAccess: assertTaskReadAccess,
  assertWriteAccess: assertTaskAccess,
  isOverrideAuthor: isFirmOwnerOrAdmin,
  resolveBillingContext: resolveTaskBillingContext,
  // Time logged on a task note is time on the task: the task's Time Logged sums
  // entries whose source is the task, whichever context they bill against.
  timeEntrySource: (taskId: string) => ({ sourceTaskId: taskId }),
  eventContext: taskNoteEventContext,
  events: {
    created: TASK_NOTE_CREATED,
    updated: TASK_NOTE_UPDATED,
    retracted: TASK_NOTE_RETRACTED,
    timeRecorded: TASK_NOTE_TIME_RECORDED,
  },
});

export async function listNotes({ lawFirmId, taskId, userId, query = {} }: any) {
  return engine.listNotes({ lawFirmId, parentId: taskId, userId, query });
}

export async function getNoteDetail({ lawFirmId, taskId, noteId, userId }: any) {
  return engine.getNoteDetail({ lawFirmId, parentId: taskId, noteId, userId });
}

export async function addNote({ lawFirmId, taskId, userId, timeZone, body }: any) {
  return engine.addNote({ lawFirmId, parentId: taskId, userId, timeZone, body });
}

export async function updateNote({ lawFirmId, taskId, noteId, userId, body }: any) {
  return engine.updateNote({ lawFirmId, parentId: taskId, noteId, userId, body });
}

export async function listNoteVersions({ lawFirmId, taskId, noteId, userId }: any) {
  return engine.listNoteVersions({ lawFirmId, parentId: taskId, noteId, userId });
}

export async function retractNote({ lawFirmId, taskId, noteId, userId, reason }: any) {
  return engine.retractNote({ lawFirmId, parentId: taskId, noteId, userId, reason });
}

export async function setNotePinned({ lawFirmId, taskId, noteId, userId, pinned }: any) {
  return engine.setNotePinned({ lawFirmId, parentId: taskId, noteId, userId, pinned });
}

export async function addTimeToNote({ lawFirmId, taskId, noteId, userId, timeZone, body }: any) {
  return engine.addTimeToNote({ lawFirmId, parentId: taskId, noteId, userId, timeZone, body });
}

export async function updateNoteTimeEntry({ lawFirmId, taskId, noteId, timeEntryId, userId, body }: any) {
  return engine.updateNoteTimeEntry({ lawFirmId, parentId: taskId, noteId, timeEntryId, userId, body });
}

export async function removeNoteTimeEntry({ lawFirmId, taskId, noteId, timeEntryId, userId }: any) {
  return engine.removeNoteTimeEntry({ lawFirmId, parentId: taskId, noteId, timeEntryId, userId });
}
