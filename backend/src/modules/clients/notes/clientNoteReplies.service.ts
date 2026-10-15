/**
 * Replies to a client note.
 *
 * A thin instantiation of the shared reply service (`shared/notes/noteReplies.ts`),
 * which matter, task, and client note replies all use identically. A reply
 * thread answers the note, so it sits behind the note's own gate: the client's
 * existence in this firm first, then the matter wall (`assertClientNoteAccess`).
 */

const { CLIENT_NOTE_REPLY_ADDED } = require('../../../shared/events/eventTypes');
const { notes, noteReplies } = require('../../../shared/database/drizzle/schema');
const { createNoteRepliesService } = require('../../../shared/notes/noteReplies');
const { assertClientNoteAccess } = require('./clientNotes.service');

const service = createNoteRepliesService({
  parentColumn: 'clientId',
  assertReadAccess: assertClientNoteAccess,
  assertWriteAccess: assertClientNoteAccess,
  replyAddedEvent: CLIENT_NOTE_REPLY_ADDED,
});

export async function listReplies({ lawFirmId, clientId, noteId, userId }: any) {
  return service.listReplies({ lawFirmId, parentId: clientId, noteId, userId });
}

export async function addReply({ lawFirmId, clientId, noteId, userId, body }: any) {
  return service.addReply({ lawFirmId, parentId: clientId, noteId, userId, body });
}

export async function updateReply({ lawFirmId, clientId, noteId, replyId, userId, body }: any) {
  return service.updateReply({ lawFirmId, parentId: clientId, noteId, replyId, userId, body });
}

export async function retractReply({ lawFirmId, clientId, noteId, replyId, userId, reason }: any) {
  return service.retractReply({ lawFirmId, parentId: clientId, noteId, replyId, userId, reason });
}
