/**
 * CRUD against `notes`, parameterized by which column names the parent
 * (matterId / taskId / clientId).
 *
 * There used to be three tables here (notes / notes /
 * notes) and this factory took the table as well. Migration 0202
 * folded them into one row shape with three nullable parent foreign keys and
 * a CHECK that exactly one is set, so only the column name varies now.
 */

import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { notes, users } from '../database/drizzle/schema';
import { tenantQuery, withDrizzleTransaction } from '../database/queryContext';
import { scopedInsert, scopedUpdate } from '../database/scopedWrite';
import { attachmentsForOne, setAttachments } from '../attachments/attachmentLinks';
const { isUuid } = require('../utils/isUuid');
const { rowIso: iso } = require('../utils/dateConversion');

const dateOnly = (v: any) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return null;
};

/**
 * The note as the panel reads it.
 *
 * Carries no time fields. A note's time lives entirely in `activities`, keyed
 * by `linked_note_id`, and the service merges the summary in after the page is
 * read.
 */
export function formatNote(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    content: r.content || '',
    contentHtml: r.contentHtml || r.content || '',
    mentions: r.mentions || [],
    subject: r.subject || null,
    noteType: r.noteType || 'general',
    // Filled by the caller from the `attachments` table: a page fills a whole
    // list at once (`withAttachments`), a single read fills its own. A note is
    // never rendered with the field missing, so it defaults to empty here.
    attachments: r.attachments || [],
    createdBy: r.createdBy || null,
    createdByName: r.createdByName || '',
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    editedBy: r.editedBy || null,
    editedByName: r.editedByName || null,
    editedAt: iso(r.editedAt),
    noteDate: dateOnly(r.noteDate),
    pinnedAt: iso(r.pinnedAt),
    pinnedBy: r.pinnedBy || null,
    retractedAt: iso(r.retractedAt),
    retractedBy: r.retractedBy || null,
    retractionReason: r.retractionReason || null,
  };
}

/** Internal legacy shape consumed by the note engine's mutation guards. */
function rawNote(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    content: r.content,
    content_html: r.contentHtml,
    mentions: r.mentions,
    subject: r.subject,
    note_type: r.noteType,
    note_date: r.noteDate,
    created_by: r.createdBy,
    pinned_at: r.pinnedAt,
    retracted_at: r.retractedAt,
  };
}

export interface NotesRepositoryConfig {
  /** Which parent column this caller's notes hang off: matterId | taskId | clientId. */
  parentColumn: string;
}

export function createNotesRepository({ parentColumn }: NotesRepositoryConfig) {
  const notesTable: any = notes;
  // The author's name is joined, never stored: `notes.created_by_name` and
  // `edited_by_name` were frozen copies that kept a member's old name on every
  // note they had written. Two aliases because a note can have been written by
  // one person and last edited by another.
  const author = alias(users, 'note_author');
  const editor = alias(users, 'note_editor');
  const noteWithAuthors = {
    ...getTableColumns(notesTable),
    createdByName: author.name,
    editedByName: editor.name,
  };
  return {
    async getNote(lawFirmId: string, parentId: any, noteId: string) {
      if (!isUuid(noteId)) return null;
      const rows = await tenantQuery(notesTable, lawFirmId, ({ executor, scope }) => executor
        .select().from(notesTable).where(and(
          scope, eq(notesTable[parentColumn], parentId), eq(notesTable.id, noteId),
        )).limit(1));
      return rawNote(rows[0]);
    },

    /** The same note `getNote` returns, in the shape the panel renders. */
    async getNoteFormatted(lawFirmId: string, parentId: any, noteId: string) {
      if (!isUuid(noteId)) return null;
      const rows: any[] = await tenantQuery(notesTable, lawFirmId, ({ executor, scope }) => executor
        .select(noteWithAuthors).from(notesTable)
        .leftJoin(author, eq(author.id, notesTable.createdBy))
        .leftJoin(editor, eq(editor.id, notesTable.editedBy))
        .where(and(scope, eq(notesTable[parentColumn], parentId), eq(notesTable.id, noteId)))
        .limit(1));
      const note = formatNote(rows[0]);
      if (!note) return null;
      note.attachments = await attachmentsForOne(lawFirmId, 'noteId', note.id);
      return note;
    },

    async createNote(lawFirmId: string, parentId: any, data: any) {
      // The note and what it has attached are one write. Two statements without
      // a transaction can leave a note whose attachments never landed, and the
      // caller sees an error for a note that exists.
      const noteId = await withDrizzleTransaction(async (tx: any) => {
        const rows = await scopedInsert(notesTable, lawFirmId, {
          [parentColumn]: parentId,
          content: data.content || '',
          contentHtml: data.contentHtml || data.content || '',
          mentions: Array.isArray(data.mentions) ? data.mentions : [],
          subject: data.subject || null,
          noteType: data.noteType || 'general',
          createdBy: data.createdBy || null,
          // The engine passes the author's day; the UTC day is only a last resort.
          noteDate: dateOnly(data.noteDate) || dateOnly(new Date()),
        }, tx);
        await setAttachments(lawFirmId, 'noteId', rows[0].id, data.attachments,
          { createdBy: data.createdBy || null, executor: tx });
        return rows[0].id;
      });
      // Re-read rather than formatting the RETURNING row: the author's name is
      // a join now, and an insert cannot return it. One indexed lookup on a
      // write path, in exchange for one shape for every reader.
      return this.getNoteFormatted(lawFirmId, parentId, noteId);
    },

    async updateNote(lawFirmId: string, parentId: any, noteId: string, patch: any) {
      if (!isUuid(noteId)) return null;
      const values: Record<string, unknown> = {};
      for (const field of ['content', 'contentHtml', 'subject', 'noteType', 'editedBy',
        'noteDate', 'pinnedAt', 'pinnedBy', 'retractedAt', 'retractedBy', 'retractionReason']) {
        if (patch[field] !== undefined) {
          let v = patch[field];
          if (field === 'noteDate') v = dateOnly(v);
          values[field] = v;
        }
      }
      if (patch.markEdited) values.editedAt = sql`now()`;
      const match = and(eq(notesTable[parentColumn], parentId), eq(notesTable.id, noteId))!;
      // The note's own columns and its links move together, so an edit cannot
      // save the text and lose the attachments.
      const updatedId = await withDrizzleTransaction(async (tx: any) => {
        // A patch carrying only `attachments` sets no column on the note itself,
        // and an UPDATE with an empty SET is not a statement. Confirm the note
        // exists with a read instead, so the links still get written.
        const rows = Object.keys(values).length
          ? await scopedUpdate(notesTable, lawFirmId, match, values, tx)
          : await tenantQuery(notesTable, lawFirmId, ({ executor, scope }) => executor
            .select({ id: notesTable.id }).from(notesTable).where(and(scope, match)).limit(1), tx);
        if (!rows[0]) return null;
        // Only when the caller sent the array. An update that touches the subject
        // must not clear what is attached.
        if (patch.attachments !== undefined) {
          await setAttachments(lawFirmId, 'noteId', rows[0].id, patch.attachments,
            { createdBy: patch.editedBy || null, executor: tx });
        }
        return rows[0].id;
      });
      if (!updatedId) return null;
      return this.getNoteFormatted(lawFirmId, parentId, updatedId);
    },

    /** How many of the parent's notes are currently pinned, for the pin cap. */
    async countPinnedNotes(lawFirmId: string, parentId: any) {
      const rows = await tenantQuery(notesTable, lawFirmId, ({ executor, scope }) => executor
        .select({ total: sql<number>`count(*)` }).from(notesTable)
        .where(and(scope, eq(notesTable[parentColumn], parentId), sql`${notesTable.pinnedAt} is not null`)));
      return Number(rows[0]?.total) || 0;
    },
  };
}
