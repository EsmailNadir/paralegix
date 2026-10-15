/**
 * Replies to a note (matter, task, or client).
 *
 * Reading follows the same access as the notes list. Writing requires the
 * same write access as adding a note itself. Replies are always internal —
 * a matter note shared with a client never carries its replies into the
 * portal, and task/client notes have no portal concept at all.
 *
 * Unlike retracting the note itself (author OR a firm admin), editing or
 * retracting a REPLY is author-only: there is no admin override. Matches the
 * existing matter-notes behavior exactly.
 */

import { NotFoundError, ForbiddenError } from '../errors/AppError';
import { sanitizeRichText } from '../utils/htmlSanitizer';
import { assertAttachmentsReadable } from '../attachments/attachmentLinks';
import { createNoteRepliesRepository } from './noteRepliesRepository';
import { createNotesRepository } from './notesRepository';
import { readableMentions } from './noteMentions';
const eventBus = require('../events/eventBus');
const usersRepo = require('../../modules/users/users.repository');

export interface NoteRepliesConfig {
  /** matterId | taskId | clientId. One table set since migration 0202. */
  parentColumn: string;
  assertReadAccess(lawFirmId: string, parentId: any, userId: string): Promise<void>;
  assertWriteAccess(lawFirmId: string, parentId: any, userId: string): Promise<void>;
  /**
   * Event constant, emitted with `{ lawFirmId, parentId, noteId, replyId,
   * authorId, authorName, noteAuthorId, mentions, preview, parentReplyId,
   * parentReplyAuthorId }`. `parentReplyAuthorId` is only present when the
   * reply was itself a reply to another reply.
   */
  replyAddedEvent: string;
  /** Extra fields carried on the reply event; see `NotesEngineConfig.eventContext`. */
  eventContext?(lawFirmId: string, parentId: any): Promise<Record<string, unknown>>;
}

export function createNoteRepliesService(config: NoteRepliesConfig) {
  const notesRepo = createNotesRepository({ parentColumn: config.parentColumn });
  const repliesRepo = createNoteRepliesRepository({ parentColumn: config.parentColumn });

  return {
    async listReplies({ lawFirmId, parentId, noteId, userId }: any) {
      await config.assertReadAccess(lawFirmId, parentId, userId);
      const note = await notesRepo.getNote(lawFirmId, parentId, noteId);
      if (!note) throw new NotFoundError('Note');
      const replies = await repliesRepo.listReplies(lawFirmId, noteId);
      return { replies, totalItems: replies.length };
    },

    async addReply({ lawFirmId, parentId, noteId, userId, body }: any) {
      await config.assertWriteAccess(lawFirmId, parentId, userId);
      await assertAttachmentsReadable(lawFirmId, body.attachments, userId);
      const note = await notesRepo.getNote(lawFirmId, parentId, noteId);
      if (!note) throw new NotFoundError('Note');

      // A reply may itself target another reply, nesting arbitrarily deep
      // (no depth limit is intentional). Replying to an already-retracted
      // reply is allowed: its content stays visible, so there's no reason to
      // block continuing the thread under it.
      let parentReply = null;
      if (body.parentReplyId) {
        parentReply = await repliesRepo.getReply(lawFirmId, noteId, body.parentReplyId);
        if (!parentReply) throw new NotFoundError('Parent reply');
      }

      const user = await usersRepo.findById(userId);
      const userName = user?.name || '';
      // Historic authors can lose access after their note or reply was written.
      // Every recipient of the preview must still pass the parent's read gate.
      const requestedMentions = new Set<string>(Array.isArray(body.mentions) ? body.mentions : []);
      const readableRecipients = await readableMentions(lawFirmId, parentId,
        [...requestedMentions, note.created_by, parentReply?.createdBy], config.assertReadAccess);
      const cleanMentions = readableRecipients.filter((id) => requestedMentions.has(id));

      // Non-null: a fresh insert always returns its row.
      const reply = (await repliesRepo.createReply(lawFirmId, {
        noteId,
        parentId,
        parentReplyId: body.parentReplyId || null,
        content: (body.content || '').trim(),
        contentHtml: sanitizeRichText(body.contentHtml || (body.content || '').trim()),
        mentions: cleanMentions,
        attachments: body.attachments || [],
        createdBy: userId,
      }))!;

      eventBus.emit(config.replyAddedEvent, {
        ...(config.eventContext ? await config.eventContext(lawFirmId, parentId) : {}),
        lawFirmId, [config.parentColumn]: parentId, noteId, replyId: reply.id, authorId: userId, authorName: userName,
        // The note's author hears about replies while retaining access; mentioned users hear
        // about theirs; the parent reply's author (when this is a reply to a
        // reply) hears about theirs too. All resolved by the notifications
        // listener, which dedupes so nobody gets notified twice.
        noteAuthorId: readableRecipients.includes(note.created_by) ? note.created_by : null,
        mentions: cleanMentions,
        preview: (body.content || '').trim().substring(0, 100),
        parentReplyId: body.parentReplyId || null,
        ...(parentReply ? {
          parentReplyAuthorId: readableRecipients.includes(parentReply.createdBy) ? parentReply.createdBy : null,
        } : {}),
      });

      return { message: 'Reply added successfully', reply };
    },

    async updateReply({ lawFirmId, parentId, noteId, replyId, userId, body }: any) {
      await config.assertWriteAccess(lawFirmId, parentId, userId);
      if (body.attachments !== undefined) await assertAttachmentsReadable(lawFirmId, body.attachments, userId);
      const note = await notesRepo.getNote(lawFirmId, parentId, noteId);
      if (!note) throw new NotFoundError('Note');
      const existing = await repliesRepo.getReply(lawFirmId, noteId, replyId);
      if (!existing) throw new NotFoundError('Reply');
      if (existing.createdBy !== userId) throw new ForbiddenError('Only the author can edit this reply');
      if (existing.retractedAt) throw new ForbiddenError('This reply has been retracted');

      const reply = await repliesRepo.updateReply(lawFirmId, noteId, replyId, {
        content: (body.content || '').trim(),
        contentHtml: sanitizeRichText(body.contentHtml || (body.content || '').trim()),
        attachments: body.attachments,
        markEdited: true,
      });
      return { message: 'Reply updated successfully', reply };
    },

    async retractReply({ lawFirmId, parentId, noteId, replyId, userId, reason }: any) {
      await config.assertWriteAccess(lawFirmId, parentId, userId);
      const note = await notesRepo.getNote(lawFirmId, parentId, noteId);
      if (!note) throw new NotFoundError('Note');
      const existing = await repliesRepo.getReply(lawFirmId, noteId, replyId);
      if (!existing) throw new NotFoundError('Reply');
      if (existing.createdBy !== userId) throw new ForbiddenError('Only the author can retract this reply');

      const reply = await repliesRepo.updateReply(lawFirmId, noteId, replyId, {
        retractedAt: new Date(), retractedBy: userId, retractionReason: (reason || '').trim() || null,
      });
      return { message: 'Reply retracted', reply };
    },
  };
}
