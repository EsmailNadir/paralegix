/**
 * Append-only history of a note's prior states, for every kind of note.
 * Version N holds the content that version N+1 replaced, written
 * immediately before the update lands. Rows are never edited or deleted
 * except by the note's own cascade.
 *
 * Scoped only by `noteId` (plus tenant) — the versions table carries no
 * separate parent-id column, since `note_id` already pins it to one note.
 */

import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { noteVersions, users } from '../database/drizzle/schema';
import { tenantQuery } from '../database/queryContext';
import { scopedInsert } from '../database/scopedWrite';
const { isUuid } = require('../utils/isUuid');
const { rowIso: iso } = require('../utils/dateConversion');

function formatVersion(row: any) {
  return {
    id: row.id,
    version: row.version,
    content: row.content || '',
    contentHtml: row.contentHtml || row.content || '',
    subject: row.subject || null,
    noteType: row.noteType || null,
    noteDate: typeof row.noteDate === 'string' ? row.noteDate.slice(0, 10) : null,
    editedBy: row.editedBy || null,
    editedByName: row.editedByName || null,
    createdAt: iso(row.createdAt),
  };
}

export function createNoteVersionsRepository() {
  const versionsTable: any = noteVersions;
  // Joined, not stored. A version row records WHO edited; the name they had at
  // that moment is not a separate fact worth freezing, and freezing it meant a
  // renamed member appeared under two names in one note's history.
  const editor = alias(users, 'version_editor');
  return {
    /**
     * Append the note's current state as the next version.
     *
     * The next version number is read just before the insert. A concurrent
     * save of the same note within the same instant could in principle
     * collide; the unique index on (note_id, version) is the backstop that
     * turns a collision into a clear error rather than a silently
     * overwritten history row.
     */
    async appendVersion(lawFirmId: string, noteId: string, data: any) {
      if (!isUuid(noteId)) return null;
      const [{ maxVersion }] = await tenantQuery(versionsTable, lawFirmId, ({ executor, scope }) => executor
        .select({ maxVersion: sql<number>`coalesce(max(${versionsTable.version}), 0)` })
        .from(versionsTable)
        .where(and(scope, eq(versionsTable.noteId, noteId))));
      const rows = await scopedInsert(versionsTable, lawFirmId, {
        noteId,
        version: Number(maxVersion) + 1,
        content: data.content || '',
        contentHtml: data.contentHtml || null,
        subject: data.subject || null,
        noteType: data.noteType || null,
        noteDate: data.noteDate || null,
        editedBy: data.editedBy || null,
      });
      if (!rows[0]) return null;
      // The caller uses this only to confirm the append; the name comes back on
      // the next `listVersions`, which joins it.
      return formatVersion(rows[0]);
    },

    /** Every prior version of a note, newest first. */
    async listVersions(lawFirmId: string, noteId: string) {
      if (!isUuid(noteId)) return [];
      const rows: any[] = await tenantQuery(versionsTable, lawFirmId, ({ executor, scope }) => executor
        .select({ ...getTableColumns(versionsTable), editedByName: editor.name })
        .from(versionsTable)
        .leftJoin(editor, eq(editor.id, versionsTable.editedBy))
        .where(and(scope, eq(versionsTable.noteId, noteId)))
        .orderBy(desc(versionsTable.version)));
      return rows.map(formatVersion);
    },
  };
}
