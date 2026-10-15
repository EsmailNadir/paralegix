/**
 * The notes feature, shared by matters, tasks, and clients.
 *
 * A note is a rich record (subject, HTML content, type, attachments,
 * mentions), pinnable, retracted rather than deleted, versioned on every
 * edit, threaded with replies, and optionally billable via one or more time
 * entries. All three entity types get the identical behavior; a domain module
 * (`matters/notes`, `tasks/notes`, `clients/notes`) supplies only what
 * actually differs: which table, how to check access, and how to resolve a
 * billing context.
 */

import { NotFoundError, ForbiddenError } from '../errors/AppError';
import { sanitizeRichText } from '../utils/htmlSanitizer';
import { notes as notesSchemaTable } from '../database/drizzle/schema';
import { createNotesRepository, formatNote } from './notesRepository';
import { assertAttachmentsReadable, withAttachments } from '../attachments/attachmentLinks';
import { createNoteVersionsRepository } from './noteVersionsRepository';
import { createNoteRepliesRepository } from './noteRepliesRepository';
import { readableMentions } from './noteMentions';
import { EMPTY_NOTE_TIME, summarizeNoteTime, toEntrySummary } from './noteTimeSummary';
import { and, eq, inArray } from 'drizzle-orm';
import { activities } from '../database/drizzle/schema';
import { tenantQuery, tenantParameterizedQuery } from '../database/queryContext';
import { assertFirmPermission } from '../../modules/lawfirms/roles/requirePermission';
const eventBus = require('../events/eventBus');
const { personalToday } = require('../utils/personalDay');
const usersRepo = require('../../modules/users/users.repository');
const timeEntriesService = require('../../modules/billing/timeEntries/timeEntries.service');
const timeEntriesRepo = require('../../modules/billing/timeEntries/timeEntries.repository');
const billingReads = require('../../modules/billing/shared/billingReads');
const { readNotesPage, readNoteTimeCounts, readNoteTags, buildNotesFilters } = require('../database/notesPage');
const { clampLimit } = require('../database/pagination');

/** A note can carry several billable lines; each one may run up to a full day. */
const MAX_HOURS_PER_ENTRY = 24;
/** Pinned is firm-wide on the parent, not per reader — capped so it stays a short list. */
const MAX_PINNED_NOTES = 5;

export interface NotesEngineConfig {
  /**
   * Drizzle column key naming this caller's parent: matterId | taskId |
   * clientId. Notes, versions and replies all live in one table set since
   * migration 0202, so the column is the only thing that varies.
   */
  parentColumn: string;
  /** Raw SQL table name — always 'notes' now; kept so the SQL reads explicitly. */
  rawTableName: string;
  /** Raw SQL column name, e.g. 'matter_id'. */
  parentRawColumn: string;
  /** Filter-column SQL expressions for `buildNotesFilters` (content/subject/author/etc). */
  columns: Record<string, any>;
  /** Read access: can this user see the parent's notes at all. */
  assertReadAccess(lawFirmId: string, parentId: any, userId: string): Promise<void>;
  /** Write access: can this user add/edit/retract/pin a note on the parent. */
  assertWriteAccess(lawFirmId: string, parentId: any, userId: string): Promise<void>;
  /** Can this user retract/edit someone else's note or reply (e.g. a firm admin). */
  isOverrideAuthor(lawFirmId: string, userId: string): Promise<boolean>;
  /**
   * The billing context a time entry on one of this parent's notes should be
   * recorded against, or null if none is available (e.g. a task with neither
   * a matter nor a linked client — "Add time" simply isn't offered there).
   */
  resolveBillingContext(lawFirmId: string, parentId: any): Promise<{ type: string; lawFirmId: string; entityId: any } | null>;
  /**
   * Source fields stamped on every time entry created from one of this
   * parent's notes, beyond the billing context. A task note's time names the
   * task (`sourceTaskId`), which is what the task's own Time Logged sums.
   */
  timeEntrySource?(parentId: any): Record<string, unknown>;
  /**
   * Extra fields carried on every event this parent's notes emit. A task note's
   * events carry the task's `matterId`, so a mention notification is tagged with
   * the matter and removed with it.
   */
  eventContext?(lawFirmId: string, parentId: any): Promise<Record<string, unknown>>;
  events: {
    created: string;
    updated: string;
    retracted: string;
    timeRecorded: string;
  };
}

function badRequest(msg: string) {
  return Object.assign(new Error(msg), { statusCode: 400 });
}

/** Every time entry linked to any of these notes, keyed by note id. */
async function getTimeEntriesByNote(lawFirmId: string, noteIds: string[]) {
  const byNote = new Map<string, any[]>();
  if (!noteIds.length) return byNote;
  const rows = await tenantQuery(activities, lawFirmId, ({ executor, scope }) => executor
    .select().from(activities)
    .where(and(scope, eq(activities.kind, 'time'), inArray(activities.linkedNoteId, noteIds)))
    .orderBy(activities.activityDate, activities.createdAt));
  for (const row of rows) {
    const key = String(row.linkedNoteId);
    const list = byNote.get(key) || [];
    list.push(row);
    byNote.set(key, list);
  }
  return byNote;
}

export function createNotesEngine(config: NotesEngineConfig) {
  const notesRepo = createNotesRepository({ parentColumn: config.parentColumn });
  const versionsRepo = createNoteVersionsRepository();
  const repliesRepo = createNoteRepliesRepository({ parentColumn: config.parentColumn });

  // `useIn` is an opt-in switch (default off, exact `$2` match, byte-identical
  // to the pre-widening SQL) so only a caller that actually passes
  // `additionalParentIds` (today, only the client-notes path) ever gets the
  // `= any($2::uuid[])` shape below; matter/task notes never set it and so
  // never change behavior. See `listNotes`.
  const parentMatchSql = (useIn: boolean) => (useIn
    ? `${config.rawTableName}.${config.parentRawColumn} = any($2::uuid[])`
    : `${config.rawTableName}.${config.parentRawColumn} = $2`);
  // The author's name is JOINED, never stored. `notes.created_by_name` and
  // `edited_by_name` were frozen copies written beside their id columns, so a
  // member who changed their name kept the old one on every note they had ever
  // written. The join makes the panel and the search agree with the member
  // list. It is safe because migration 0226 keyed `created_by` and `edited_by`
  // to `users`, and the privacy erase anonymizes rather than deletes, so the
  // name resolves for as long as the note exists.
  const selectSql = (where: string, pageClause: string, useIn = false) =>
    `select ${config.rawTableName}.*,
            author.name as created_by_name,
            editor.name as edited_by_name,
            count(*) over() as total_count
       from ${config.rawTableName}
       left join users author on author.id = ${config.rawTableName}.created_by
       left join users editor on editor.id = ${config.rawTableName}.edited_by
      where ${config.rawTableName}.law_firm_id = $1 and ${parentMatchSql(useIn)}${where}
      order by (pinned_at is null), pinned_at desc, note_date desc, created_at desc, id desc${pageClause}`;
  const countSql = (where: string, extra?: string, useIn = false) =>
    `select count(*) as total${extra ? `, ${extra}` : ''} from ${config.rawTableName}
      where ${config.rawTableName}.law_firm_id = $1 and ${parentMatchSql(useIn)}${where}`;
  // `tenantParameterizedQuery` needs the real lawFirmId per call (it asserts
  // the tenant predicate actually made it into the SQL); `query` is built
  // fresh from the caller's own lawFirmId rather than one closed over here.
  // `selectSql`/`countSql` above alias the table by its real name, matching
  // the default; `readNoteTags`'s query always aliases it `n`, so that one
  // needs the alias passed explicitly or the tenant-predicate audit can't
  // find `n.law_firm_id = $1` in the compiled SQL.
  const queryAs = (lawFirmId: string) => (text: string, params: unknown[]) =>
    tenantParameterizedQuery(notesSchemaTable, lawFirmId, text, params);
  const tagsQueryAs = (lawFirmId: string) => (text: string, params: unknown[]) =>
    tenantParameterizedQuery(notesSchemaTable, lawFirmId, text, params, 'n');

  /**
   * Attach each note's derived state: its billing summary and its reply
   * count. Batched over the whole page — one query over `activities`, one
   * over the invoice line items for the entries that came back, one over the
   * replies table — regardless of how many notes are on screen.
   */
  async function enrichNotes(lawFirmId: string, parentId: any, notes: any[]) {
    if (!notes.length) return notes;
    const ids = notes.map((n: any) => n.id);
    const [byNote, replyCounts, billingContext] = await Promise.all([
      getTimeEntriesByNote(lawFirmId, ids),
      repliesRepo.countRepliesByNote(lawFirmId, ids),
      config.resolveBillingContext(lawFirmId, parentId),
    ]);

    // The page's attachments in one query, from the `attachments` table. The
    // note row no longer carries a copy of what is attached to it.
    await withAttachments(lawFirmId, 'noteId', notes);

    const allRows = [...byNote.values()].flat();
    const placements = allRows.length && billingContext
      ? await billingReads.invoicePlacementsForSources(billingContext, 'time_entry', allRows.map((r: any) => r.id))
      : new Map();

    return notes.map((n: any) => {
      const rows = byNote.get(String(n.id)) || [];
      const entries = rows.map((r: any) => toEntrySummary(r, placements.get(String(r.id))));
      return {
        ...n,
        time: entries.length ? summarizeNoteTime(entries) : EMPTY_NOTE_TIME,
        replyCount: replyCounts.get(String(n.id)) || 0,
      };
    });
  }

  /**
   * Which page a note falls on under the given filters, for a deep link that
   * names a note without saying which page it's on. `parentIds`, when given,
   * widens the match to that whole set (see `listNotes`'s `additionalParentIds`).
   */
  async function getNotePage(lawFirmId: string, parentId: any, noteId: string, { limit, ...filters }: any = {}, parentIds: string[] | null = null) {
    const useIn = Boolean(parentIds);
    const params: unknown[] = [lawFirmId, parentIds || parentId];
    const filterSql = buildNotesFilters({ filters, columns: config.columns, params });
    params.push(clampLimit(limit, { fallback: 10, max: 200 }));
    const limitParam = `$${params.length}`;
    params.push(noteId);
    const noteIdParam = `$${params.length}`;
    const { rows } = await queryAs(lawFirmId)(`
      select page from (
        select id,
          ((row_number() over (
            order by (pinned_at is null), pinned_at desc, note_date desc, created_at desc, id desc
          ) - 1) / ${limitParam}::bigint) + 1 as page
        from ${config.rawTableName}
        where ${config.rawTableName}.law_firm_id = $1 and ${parentMatchSql(useIn)}${filterSql}
      ) ranked
      where ranked.id = ${noteIdParam}
    `, params);
    return rows[0] ? Number(rows[0].page) : null;
  }

  /**
   * `additionalParentIds` is opt-in and used only by the client-notes path
   * (`clients/notes/notes.service.ts`), which passes the ids of every
   * company the viewed person client is linked to via `client_company_links`.
   * Matter and task notes never pass it, so their listing SQL is byte-identical
   * to before this widening existed.
   */
  async function listNotes({ lawFirmId, parentId, userId, query: q = {}, additionalParentIds }: any) {
    await config.assertReadAccess(lawFirmId, parentId, userId);
    const filters = {
      search: q.search, noteType: q.noteType, timeFilter: q.timeFilter, tag: q.tag,
      authorId: q.authorId, dateFrom: q.dateFrom, dateTo: q.dateTo,
    };

    const parentIds: string[] | null = Array.isArray(additionalParentIds) && additionalParentIds.length
      ? [parentId, ...additionalParentIds]
      : null;
    const useIn = Boolean(parentIds);
    const selectSqlForCall = (where: string, pageClause: string) => selectSql(where, pageClause, useIn);
    const countSqlForCall = (where: string, extra?: string) => countSql(where, extra, useIn);

    let requestedPage = q.page;
    let resolvedPage: number | null = null;
    if (q.jumpToNoteId) {
      resolvedPage = await getNotePage(lawFirmId, parentId, q.jumpToNoteId, { limit: q.limit, ...filters }, parentIds);
      if (resolvedPage) requestedPage = resolvedPage;
    }

    const query = queryAs(lawFirmId);
    const baseParams = [lawFirmId, parentIds || parentId];
    const [page, counts, tags] = await Promise.all([
      readNotesPage({
        query, baseParams, filters, columns: config.columns,
        paging: { page: requestedPage, limit: q.limit, offset: q.offset },
        selectSql: selectSqlForCall, countSql: countSqlForCall, format: (row: any) => formatNote(row),
      }),
      readNoteTimeCounts({ query, baseParams, filters, columns: config.columns, countSql: countSqlForCall }),
      readNoteTags({
        query: tagsQueryAs(lawFirmId), table: config.rawTableName, parentColumn: config.parentRawColumn,
        lawFirmId, parentId: parentIds || parentId, useIn,
      }),
    ]);
    const notes = await enrichNotes(lawFirmId, parentId, page.notes);
    return { ...page, notes, counts, tags, resolvedPage };
  }

  async function getNoteDetail({ lawFirmId, parentId, noteId, userId }: any) {
    await config.assertReadAccess(lawFirmId, parentId, userId);
    const note = await notesRepo.getNoteFormatted(lawFirmId, parentId, noteId);
    if (!note) throw new NotFoundError('Note');
    const [withDetail] = await enrichNotes(lawFirmId, parentId, [note]);
    return { note: withDetail };
  }

  /** Shared by note creation and the note's own Add time action. */
  async function createEntryForNote({ lawFirmId, parentId, noteId, userId, timeZone, entry, note, billingContext }: any) {
    if (!billingContext) throw badRequest('This note has no billing context to add time against');
    if (typeof entry.timeSpent !== 'number' || entry.timeSpent <= 0 || entry.timeSpent > MAX_HOURS_PER_ENTRY) {
      throw badRequest(`Time spent must be a positive number, up to ${MAX_HOURS_PER_ENTRY} hours for a single entry`);
    }
    return timeEntriesService.createTimeEntry({
      lawFirmId,
      context: billingContext,
      actingUserId: userId,
      body: {
        userId,
        hours: entry.timeSpent,
        // Today for the person logging it; the UTC day is tomorrow every
        // evening in the Americas.
        date: entry.timeEntryDate || note?.noteDate || await personalToday({ timeZone, userId }),
        name: entry.activityName || note?.subject || 'Note',
        description: entry.activityDescription || (note?.content || '').trim().substring(0, 100) || '',
        // Time written off on the note must not still land on an invoice.
        billable: entry.isBillable !== false,
        linkedNoteId: noteId,
        source: 'note',
        ...(config.timeEntrySource ? config.timeEntrySource(parentId) : {}),
      },
    });
  }

  const eventContext = async (lawFirmId: string, parentId: any) => (
    config.eventContext ? config.eventContext(lawFirmId, parentId) : {}
  );

  async function addNote({ lawFirmId, parentId, userId, timeZone, body }: any) {
    const { content, contentHtml, subject, noteType, attachments, mentions, noteDate } = body;
    await config.assertWriteAccess(lawFirmId, parentId, userId);
    await assertAttachmentsReadable(lawFirmId, attachments, userId);
    // A note posted with time attached is billable work whichever parent it sits
    // on, so it needs the same permission as the note's own time routes. Checked
    // before the note exists, so a refusal leaves no half-written note behind.
    if (body.timeEntries?.length) {
      await assertFirmPermission(lawFirmId, userId, 'billing.manageTimeEntries');
    }
    const user = await usersRepo.findById(userId);
    const userName = user?.name || '';
    // Only mentions of people who could read this note are stored or notified.
    const cleanMentions = await readableMentions(lawFirmId, parentId, mentions, config.assertReadAccess);

    // Non-null: a fresh insert always returns its row.
    const note = (await notesRepo.createNote(lawFirmId, parentId, {
      content: (content || '').trim(),
      contentHtml: sanitizeRichText(contentHtml || (content || '').trim()),
      mentions: cleanMentions,
      subject: subject || null,
      noteType: noteType || 'general',
      attachments: attachments || [],
      // A note with no date is dated today for its author, not the UTC day.
      noteDate: noteDate || await personalToday({ timeZone, userId }),
      createdBy: userId,
    }))!;

    if (body.timeEntries?.length) {
      const billingContext = await config.resolveBillingContext(lawFirmId, parentId);
      for (const entry of body.timeEntries) {
        await createEntryForNote({ lawFirmId, parentId, noteId: note.id, userId, timeZone, entry, note, billingContext });
      }
    }

    eventBus.emit(config.events.created, {
      ...(await eventContext(lawFirmId, parentId)),
      lawFirmId, [config.parentColumn]: parentId, noteId: note.id, authorId: userId, authorName: userName,
      mentions: cleanMentions, subject: subject || null, preview: (content || '').trim().substring(0, 100),
    });

    const [withTime] = await enrichNotes(lawFirmId, parentId, [note]);
    return { message: 'Note added successfully', note: withTime };
  }

  async function updateNote({ lawFirmId, parentId, noteId, userId, body }: any) {
    const { content, contentHtml, subject, noteType, attachments, noteDate } = body;
    await config.assertWriteAccess(lawFirmId, parentId, userId);
    if (attachments !== undefined) await assertAttachmentsReadable(lawFirmId, attachments, userId);

    const existing = await notesRepo.getNote(lawFirmId, parentId, noteId);
    if (!existing) throw new NotFoundError('Note');
    if (existing.retracted_at) throw new ForbiddenError('This note has been retracted and can no longer be edited');

    const user = await usersRepo.findById(userId);
    const userName = user?.name || '';
    await versionsRepo.appendVersion(lawFirmId, noteId, {
      content: existing.content || '',
      contentHtml: existing.content_html || null,
      subject: existing.subject || null,
      noteType: existing.note_type || null,
      noteDate: existing.note_date || null,
      editedBy: userId,
    });

    const patch: any = { content: (content || '').trim(), editedBy: userId, markEdited: true };
    if (contentHtml !== undefined) patch.contentHtml = sanitizeRichText(contentHtml);
    if (subject !== undefined) patch.subject = subject || null;
    if (noteType !== undefined) patch.noteType = noteType || 'general';
    if (attachments !== undefined) patch.attachments = attachments || [];
    if (noteDate !== undefined) patch.noteDate = noteDate || null;

    const note = await notesRepo.updateNote(lawFirmId, parentId, noteId, patch);
    eventBus.emit(config.events.updated, {
      ...(await eventContext(lawFirmId, parentId)),
      lawFirmId, [config.parentColumn]: parentId, noteId, authorId: userId, authorName: userName, subject: note?.subject || null,
    });
    const [withTime] = await enrichNotes(lawFirmId, parentId, [note]);
    return { message: 'Note updated successfully', note: withTime };
  }

  async function listNoteVersions({ lawFirmId, parentId, noteId, userId }: any) {
    await config.assertReadAccess(lawFirmId, parentId, userId);
    const existing = await notesRepo.getNote(lawFirmId, parentId, noteId);
    if (!existing) throw new NotFoundError('Note');
    const versions = await versionsRepo.listVersions(lawFirmId, noteId);
    return { versions, totalItems: versions.length };
  }

  /**
   * Retract a note. Not deleted: it is a record of work performed, and its
   * time entries point at it from the billing tables. Retracting keeps the
   * row, marks it, and leaves the version history intact.
   */
  async function retractNote({ lawFirmId, parentId, noteId, userId, reason }: any) {
    await config.assertWriteAccess(lawFirmId, parentId, userId);
    const existing = await notesRepo.getNote(lawFirmId, parentId, noteId);
    if (!existing) throw new NotFoundError('Note');
    if (existing.retracted_at) return { message: 'Note already retracted', noteId };
    if (existing.created_by !== userId && !(await config.isOverrideAuthor(lawFirmId, userId))) {
      throw new ForbiddenError('Only the note author or a firm admin can retract this note');
    }

    const note = await notesRepo.updateNote(lawFirmId, parentId, noteId, {
      retractedAt: new Date(), retractedBy: userId, retractionReason: (reason || '').trim() || null,
    });
    eventBus.emit(config.events.retracted, {
      ...(await eventContext(lawFirmId, parentId)),
      lawFirmId, [config.parentColumn]: parentId, noteId, actorUserId: userId, subject: existing.subject || null,
    });
    return { message: 'Note retracted successfully', note };
  }

  /** Pinning is firm-wide on the parent, not per reader. */
  async function setNotePinned({ lawFirmId, parentId, noteId, userId, pinned }: any) {
    await config.assertWriteAccess(lawFirmId, parentId, userId);
    const existing = await notesRepo.getNote(lawFirmId, parentId, noteId);
    if (!existing) throw new NotFoundError('Note');

    if (pinned && !existing.pinned_at) {
      const count = await notesRepo.countPinnedNotes(lawFirmId, parentId);
      if (count >= MAX_PINNED_NOTES) {
        throw badRequest(`At most ${MAX_PINNED_NOTES} notes can be pinned. Unpin one first.`);
      }
    }

    const note = await notesRepo.updateNote(lawFirmId, parentId, noteId, {
      pinnedAt: pinned ? new Date() : null, pinnedBy: pinned ? userId : null,
    });
    return { message: pinned ? 'Note pinned' : 'Note unpinned', note };
  }

  async function addTimeToNote({ lawFirmId, parentId, noteId, userId, timeZone, body }: any) {
    await config.assertWriteAccess(lawFirmId, parentId, userId);
    const existing = await notesRepo.getNote(lawFirmId, parentId, noteId);
    if (!existing) throw new NotFoundError('Note');
    const billingContext = await config.resolveBillingContext(lawFirmId, parentId);

    await createEntryForNote({
      lawFirmId, parentId, noteId,
      // Credited to whoever is logging it, not to the note's author: a
      // colleague adding time to someone else's note records their own work.
      userId, timeZone, entry: body,
      note: { noteDate: existing.note_date, subject: existing.subject, content: existing.content },
      billingContext,
    });

    eventBus.emit(config.events.timeRecorded, {
      ...(await eventContext(lawFirmId, parentId)),
      lawFirmId, [config.parentColumn]: parentId, noteId, actorUserId: userId, hours: body.timeSpent,
    });

    const note = await notesRepo.getNoteFormatted(lawFirmId, parentId, noteId);
    const [withTime] = await enrichNotes(lawFirmId, parentId, [note]);
    return { message: 'Time entry added successfully', note: withTime };
  }

  async function updateNoteTimeEntry({ lawFirmId, parentId, noteId, timeEntryId, userId, body }: any) {
    const { timeSpent, timeEntryDate, activityName, activityDescription, isBillable } = body;
    await config.assertWriteAccess(lawFirmId, parentId, userId);

    const existing = await notesRepo.getNote(lawFirmId, parentId, noteId);
    if (!existing) throw new NotFoundError('Note');
    const billingContext = await config.resolveBillingContext(lawFirmId, parentId);
    if (!billingContext) throw new NotFoundError('Time entry');
    const entry = await timeEntriesRepo.findById(billingContext, timeEntryId);
    if (!entry || String(entry.linkedNoteId) !== String(noteId)) {
      throw new NotFoundError('Time entry not found on this note');
    }

    await timeEntriesService.updateTimeEntry({
      lawFirmId, context: billingContext, timeEntryId, actingUserId: userId,
      body: {
        hours: timeSpent, date: timeEntryDate,
        name: activityName || existing.subject || 'Note',
        description: activityDescription || (existing.content || '').substring(0, 100) || '',
        billable: isBillable !== false,
      },
    });

    const note = await notesRepo.getNoteFormatted(lawFirmId, parentId, noteId);
    const [withTime] = await enrichNotes(lawFirmId, parentId, [note]);
    return { message: 'Time entry updated successfully', note: withTime };
  }

  async function removeNoteTimeEntry({ lawFirmId, parentId, noteId, timeEntryId, userId }: any) {
    await config.assertWriteAccess(lawFirmId, parentId, userId);
    const existing = await notesRepo.getNote(lawFirmId, parentId, noteId);
    if (!existing) throw new NotFoundError('Note');
    const billingContext = await config.resolveBillingContext(lawFirmId, parentId);
    if (!billingContext) throw new NotFoundError('Time entry');
    const entry = await timeEntriesRepo.findById(billingContext, timeEntryId);
    if (!entry || String(entry.linkedNoteId) !== String(noteId)) {
      throw new NotFoundError('Time entry not found on this note');
    }

    await timeEntriesService.deleteTimeEntry({ lawFirmId, context: billingContext, timeEntryId, actingUserId: userId });

    const note = await notesRepo.getNoteFormatted(lawFirmId, parentId, noteId);
    const [withTime] = await enrichNotes(lawFirmId, parentId, [note]);
    return { message: 'Time entry removed successfully', note: withTime };
  }

  return {
    repo: notesRepo,
    versionsRepo,
    repliesRepo,
    listNotes,
    getNoteDetail,
    addNote,
    updateNote,
    listNoteVersions,
    retractNote,
    setNotePinned,
    addTimeToNote,
    updateNoteTimeEntry,
    removeNoteTimeEntry,
    enrichNotes,
  };
}

