/**
 * Replies under a note (matter, task, or client). The note stays the work
 * product; replies are the conversation about it. Replies carry their own
 * author and timestamps and are retracted, never deleted, for the same
 * reason notes are.
 */

import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { noteReplies, users } from '../database/drizzle/schema';
import { tenantQuery, withDrizzleTransaction } from '../database/queryContext';
import { scopedInsert, scopedUpdate } from '../database/scopedWrite';
import { attachmentsForOne, setAttachments, withAttachments } from '../attachments/attachmentLinks';
const { isUuid } = require('../utils/isUuid');
const { rowIso: iso } = require('../utils/dateConversion');

function formatReply(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    noteId: row.noteId,
    parentReplyId: row.parentReplyId || null,
    content: row.content || '',
    contentHtml: row.contentHtml || row.content || '',
    mentions: row.mentions || [],
    // Filled from the `attachments` table by whoever read the reply. The reply
    // row no longer carries a copy of what is attached to it.
    attachments: row.attachments || [],
    createdBy: row.createdBy || null,
    createdByName: row.createdByName || '',
    createdAt: iso(row.createdAt),
    editedAt: iso(row.editedAt),
    retractedAt: iso(row.retractedAt),
    retractedBy: row.retractedBy || null,
    retractionReason: row.retractionReason || null,
  };
}

export interface NoteRepliesRepositoryConfig {
  /** Which parent column this caller's replies hang off: matterId | taskId | clientId. */
  parentColumn: string;
}

export function createNoteRepliesRepository(_config: NoteRepliesRepositoryConfig) {
  const repliesTable: any = noteReplies;
  // Joined, not stored: `note_replies.created_by_name` was a frozen copy that
  // kept a member's old name on every reply they had written.
  const author = alias(users, 'reply_author');
  const replyWithAuthor = { ...getTableColumns(repliesTable), createdByName: author.name };
  return {
    // `parentId` is accepted and deliberately not stored. The caller has already
    // used it to authorize the write and to prove the note belongs to that
    // parent; the reply's own parent is its note, reached by `noteId`. Migration
    // 0207 dropped the copies, which were written on every insert, never read
    // back, and free to disagree with the note they hung off.
    async createReply(lawFirmId: string, { noteId, ...data }: any) {
      // The reply and what it has attached are one write, so an insert that
      // fails on the links does not leave a reply that lost them.
      const replyId = await withDrizzleTransaction(async (tx: any) => {
        const rows = await scopedInsert(repliesTable, lawFirmId, {
          noteId,
          parentReplyId: data.parentReplyId || null,
          content: data.content || '',
          contentHtml: data.contentHtml || data.content || '',
          mentions: Array.isArray(data.mentions) ? data.mentions : [],
          createdBy: data.createdBy || null,
        }, tx);
        await setAttachments(lawFirmId, 'noteReplyId', rows[0].id, data.attachments,
          { createdBy: data.createdBy || null, executor: tx });
        return rows[0].id;
      });
      // Re-read: the author's name is a join now, and an insert cannot return it.
      return this.getReply(lawFirmId, noteId, replyId);
    },

    async getReply(lawFirmId: string, noteId: string, replyId: any) {
      if (!isUuid(replyId)) return null;
      const rows: any[] = await tenantQuery(repliesTable, lawFirmId, ({ executor, scope }) => executor
        .select(replyWithAuthor).from(repliesTable)
        .leftJoin(author, eq(author.id, repliesTable.createdBy))
        .where(and(scope, eq(repliesTable.noteId, noteId), eq(repliesTable.id, replyId)))
        .limit(1));
      const reply = formatReply(rows[0]);
      if (!reply) return null;
      reply.attachments = await attachmentsForOne(lawFirmId, 'noteReplyId', reply.id);
      return reply;
    },

    async updateReply(lawFirmId: string, noteId: string, replyId: any, patch: any) {
      if (!isUuid(replyId)) return null;
      const values: Record<string, unknown> = {};
      for (const field of ['content', 'contentHtml', 'retractedAt', 'retractedBy', 'retractionReason']) {
        if (patch[field] !== undefined) values[field] = patch[field];
      }
      if (patch.markEdited) values.editedAt = sql`now()`;
      const match = and(eq(repliesTable.noteId, noteId), eq(repliesTable.id, replyId))!;
      const updatedId = await withDrizzleTransaction(async (tx: any) => {
        // A patch carrying only `attachments` sets no column on the reply itself,
        // and an UPDATE with an empty SET is not a statement.
        const rows = Object.keys(values).length
          ? await scopedUpdate(repliesTable, lawFirmId, match, values, tx)
          : await tenantQuery(repliesTable, lawFirmId, ({ executor, scope }) => executor
            .select({ id: repliesTable.id, createdBy: repliesTable.createdBy })
            .from(repliesTable).where(and(scope, match)).limit(1), tx);
        if (!rows[0]) return null;
        if (patch.attachments !== undefined) {
          // A reply has no `edited_by` column, so the author is who attached it.
          // Leaving it null instead would blank the attribution on every edit.
          await setAttachments(lawFirmId, 'noteReplyId', rows[0].id, patch.attachments,
            { createdBy: (rows[0] as any).createdBy || null, executor: tx });
        }
        return rows[0].id;
      });
      if (!updatedId) return null;
      return this.getReply(lawFirmId, noteId, updatedId);
    },

    /** Every reply on a note, oldest first. Threads are short by design. */
    async listReplies(lawFirmId: string, noteId: string) {
      if (!isUuid(noteId)) return [];
      const rows: any[] = await tenantQuery(repliesTable, lawFirmId, ({ executor, scope }) => executor
        .select(replyWithAuthor).from(repliesTable)
        .leftJoin(author, eq(author.id, repliesTable.createdBy))
        .where(and(scope, eq(repliesTable.noteId, noteId)))
        .orderBy(asc(repliesTable.createdAt)));
      // One query for the whole thread's attachments, not one per reply.
      return withAttachments(lawFirmId, 'noteReplyId', rows.map(formatReply).filter(Boolean) as any[]);
    },

    /**
     * Reply counts for a page of notes, so the list can show "3 replies"
     * without loading three threads it may never open.
     */
    async countRepliesByNote(lawFirmId: string, noteIds: string[]) {
      const ids = (noteIds || []).filter((id: any) => isUuid(id));
      const counts = new Map<string, number>();
      if (!ids.length) return counts;
      const rows = await tenantQuery(repliesTable, lawFirmId, ({ executor, scope }) => executor
        .select({ noteId: repliesTable.noteId, total: sql<number>`count(*)` })
        .from(repliesTable)
        .where(and(scope, inArray(repliesTable.noteId, ids), sql`${repliesTable.retractedAt} is null`))
        .groupBy(repliesTable.noteId));
      for (const row of rows) counts.set(String(row.noteId), Number(row.total) || 0);
      return counts;
    },
  };
}
