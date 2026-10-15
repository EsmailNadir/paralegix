/**
 * Replies to a task note.
 *
 * A thin instantiation of the shared reply service (`shared/notes/noteReplies.ts`),
 * which matter, task, and client note replies all use identically. The gates are
 * the task notes' own (`taskNotes.service.ts`), so the owner and admin read
 * widening still confirms the task exists in this firm before it lets them in.
 */

const { TASK_NOTE_REPLY_ADDED } = require('../../../shared/events/eventTypes');
const { notes, noteReplies } = require('../../../shared/database/drizzle/schema');
const { createNoteRepliesService } = require('../../../shared/notes/noteReplies');
const { assertTaskAccess, assertTaskReadAccess, taskNoteEventContext } = require('./taskNotes.service');

const service = createNoteRepliesService({
  parentColumn: 'taskId',
  assertReadAccess: assertTaskReadAccess,
  assertWriteAccess: assertTaskAccess,
  replyAddedEvent: TASK_NOTE_REPLY_ADDED,
  eventContext: taskNoteEventContext,
});

export async function listReplies({ lawFirmId, taskId, noteId, userId }: any) {
  return service.listReplies({ lawFirmId, parentId: taskId, noteId, userId });
}

export async function addReply({ lawFirmId, taskId, noteId, userId, body }: any) {
  return service.addReply({ lawFirmId, parentId: taskId, noteId, userId, body });
}

export async function updateReply({ lawFirmId, taskId, noteId, replyId, userId, body }: any) {
  return service.updateReply({ lawFirmId, parentId: taskId, noteId, replyId, userId, body });
}

export async function retractReply({ lawFirmId, taskId, noteId, replyId, userId, reason }: any) {
  return service.retractReply({ lawFirmId, parentId: taskId, noteId, replyId, userId, reason });
}
