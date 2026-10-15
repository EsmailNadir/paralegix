/**
 * Replies to a matter note.
 *
 * A thin instantiation of the shared reply service (`shared/notes/noteReplies.ts`),
 * which matter, task, and client note replies all use identically. Matter
 * membership is the access check; matter notes are the only ones that also
 * feed the activity feed and mention notifications from this event, which
 * `notes.events.ts`/`notifications.events.ts` already listen for.
 */

const { assertMatterMembership, assertMatterReadAccess } = require('../../../shared/utils/membership');
const { MATTER_NOTE_REPLY_ADDED } = require('../../../shared/events/eventTypes');
const { notes, noteReplies } = require('../../../shared/database/drizzle/schema');
const { createNoteRepliesService } = require('../../../shared/notes/noteReplies');

const service = createNoteRepliesService({
  parentColumn: 'matterId',
  assertReadAccess: assertMatterReadAccess,
  assertWriteAccess: assertMatterMembership,
  replyAddedEvent: MATTER_NOTE_REPLY_ADDED,
});

export async function listReplies({ lawFirmId, matterId, noteId, userId }: any) {
  return service.listReplies({ lawFirmId, parentId: matterId, noteId, userId });
}

export async function addReply({ lawFirmId, matterId, noteId, userId, body }: any) {
  return service.addReply({ lawFirmId, parentId: matterId, noteId, userId, body });
}

export async function updateReply({ lawFirmId, matterId, noteId, replyId, userId, body }: any) {
  return service.updateReply({ lawFirmId, parentId: matterId, noteId, replyId, userId, body });
}

export async function retractReply({ lawFirmId, matterId, noteId, replyId, userId, reason }: any) {
  return service.retractReply({ lawFirmId, parentId: matterId, noteId, replyId, userId, reason });
}
