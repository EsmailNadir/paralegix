/**
 * Connections out of a note: to a task, or to a document.
 *
 * One table for both, discriminated by `link_type`, because "create a task from
 * this note" and "link an existing task" produce the same row and the backlink
 * has to read identically from either end.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { noteLinks, tasks, files } from '../../../shared/database/drizzle/schema';
import { tenantQuery, type DrizzleExecutor } from '../../../shared/database/queryContext';
import { scopedDelete, scopedInsert } from '../../../shared/database/scopedWrite';
const { isUuid } = require('../../../shared/utils/isUuid');
const { rowIso: iso } = require('../../../shared/utils/dateConversion');

function formatLink(row: any) {
  return {
    id: row.id,
    noteId: row.noteId,
    linkType: row.linkType,
    taskId: row.taskId || null,
    fileId: row.fileId || null,
    replyId: row.replyId || null,
    createdFromNote: row.createdFromNote || false,
    createdBy: row.createdBy || null,
    createdAt: iso(row.createdAt),
    // Present only when the join found the target; a task or file removed
    // some other way still leaves the link row (and the chip falls back to a
    // generic label rather than disappearing silently).
    taskTitle: row.taskTitle ?? null,
    fileName: row.fileName ?? null,
  };
}

class MatterNoteLinksRepository {
  async createLink(lawFirmId: string, { noteId, linkType, taskId, fileId, replyId, createdFromNote, createdBy }: any, executor?: DrizzleExecutor) {
    const rows = await scopedInsert(noteLinks, lawFirmId, {
      noteId,
      linkType,
      taskId: taskId || null,
      fileId: fileId || null,
      replyId: replyId || null,
      createdFromNote: createdFromNote === true,
      createdBy: createdBy || null,
    }, executor);
    return formatLink(rows[0]);
  }

  /** True when a link was actually removed, so the caller can answer 404. */
  async deleteLink(lawFirmId: string, noteId: string, linkId: string) {
    if (!isUuid(linkId)) return false;
    const rows = await scopedDelete(noteLinks, lawFirmId, and(
      eq(noteLinks.noteId, noteId), eq(noteLinks.id, linkId),
    )!);
    return rows.length > 0;
  }

  /**
   * Every link on each of these notes, keyed by note id. Batched over the page
   * for the same reason the time summaries are.
   */
  async getLinksByNote(lawFirmId: string, noteIds: string[]) {
    const ids = (noteIds || []).filter((id: any) => isUuid(id));
    const byNote = new Map<string, any[]>();
    if (!ids.length) return byNote;
    const rows = await tenantQuery(noteLinks, lawFirmId, ({ executor, scope }) => executor
      .select({
        id: noteLinks.id,
        noteId: noteLinks.noteId,
        linkType: noteLinks.linkType,
        taskId: noteLinks.taskId,
        fileId: noteLinks.fileId,
        replyId: noteLinks.replyId,
        createdFromNote: noteLinks.createdFromNote,
        createdBy: noteLinks.createdBy,
        createdAt: noteLinks.createdAt,
        taskTitle: tasks.title,
        fileName: files.name,
      })
      .from(noteLinks)
      .leftJoin(tasks, eq(noteLinks.taskId, tasks.id))
      .leftJoin(files, eq(noteLinks.fileId, files.id))
      .where(and(scope, inArray(noteLinks.noteId, ids)))
      .orderBy(noteLinks.createdAt));
    for (const row of rows) {
      const key = String(row.noteId);
      const list = byNote.get(key) || [];
      list.push(formatLink(row));
      byNote.set(key, list);
    }
    return byNote;
  }

  /** The notes a given task was created from or linked to. */
  async getLinksForTask(lawFirmId: string, taskId: string) {
    if (!isUuid(taskId)) return [];
    const rows = await tenantQuery(noteLinks, lawFirmId, ({ executor, scope }) => executor
      .select().from(noteLinks)
      .where(and(scope, eq(noteLinks.taskId, taskId))));
    return rows.map(formatLink);
  }
}

export = new MatterNoteLinksRepository();
