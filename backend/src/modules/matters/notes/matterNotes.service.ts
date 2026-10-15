/**
 * Matter notes.
 *
 * The full feature (rich content, subject, type, tags, attachments, mentions,
 * pinning, retraction, versioning, replies, time entries) lives in the shared
 * notes engine (`shared/notes/notesEngine.ts`), which matter, task, and
 * client notes all use identically. This module supplies only what's
 * genuinely matter-specific: matter membership as the access check, the
 * matter itself as the billing context, and the matter-only extras (links to
 * tasks/files, sending a client update, and the firm-wide notes list) that
 * don't apply to tasks or clients.
 *
 * Every exported function still takes `matterId` (not `parentId`) so
 * `notes.routes.ts` and its callers need no changes.
 */

const mattersRepo = require('../matters.repository');
const {
  assertMatterMembership, assertMatterReadAccess, isFirmOwnerOrAdmin, assertLawFirmMembership,
} = require('../../../shared/utils/membership');
const { loadResolvedMember } = require('../../lawfirms/roles/requirePermission');
const {
  MATTER_NOTE_CREATED, MATTER_NOTE_UPDATED, MATTER_NOTE_RETRACTED, MATTER_NOTE_TIME_RECORDED, MATTER_NOTE_SHARED,
} = require('../../../shared/events/eventTypes');
const eventBus = require('../../../shared/events/eventBus');
const linksRepo = require('./matterNoteLinks.repository');
const messagingService = require('../../messaging/messaging.service');
const { notes, noteVersions, noteReplies } = require('../../../shared/database/drizzle/schema');
const { createNotesEngine } = require('../../../shared/notes/notesEngine');
const { CONTEXT_TYPES } = require('../../billing/context');
const { eligibleCompanyPortalUserIds } = require('../../clients/companyPortalRecipients');
const { runWithConcurrency } = require('../../../shared/utils/runWithConcurrency');

const { ValidationError, NotFoundError } = require('../../../shared/errors/AppError');

/**
 * SQL expressions the shared filter builder uses against `notes`.
 * `hasTime` describes live note-linked activities.
 */
const MATTER_NOTE_COLUMNS = {
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
  parentColumn: 'matterId',
  rawTableName: 'notes',
  parentRawColumn: 'matter_id',
  columns: MATTER_NOTE_COLUMNS,
  assertReadAccess: assertMatterReadAccess,
  assertWriteAccess: assertMatterMembership,
  isOverrideAuthor: isFirmOwnerOrAdmin,
  // Billing for a matter note is always the matter itself.
  resolveBillingContext: async (lawFirmId: string, matterId: string) => ({ type: CONTEXT_TYPES.matter, lawFirmId, entityId: matterId }),
  events: {
    created: MATTER_NOTE_CREATED,
    updated: MATTER_NOTE_UPDATED,
    retracted: MATTER_NOTE_RETRACTED,
    timeRecorded: MATTER_NOTE_TIME_RECORDED,
  },
});

/**
 * Attach a matter note's matter-only extras (links to tasks/files) on top of
 * what the shared engine already attached (time summary, reply count).
 */
async function withLinks(lawFirmId: string, notes: any[]) {
  if (!notes.length) return notes;
  const linksByNote = await linksRepo.getLinksByNote(lawFirmId, notes.map((n: any) => n.id));
  return notes.map((n: any) => ({ ...n, links: linksByNote.get(String(n.id)) || [] }));
}

export async function listNotes({ lawFirmId, matterId, userId, query = {} }: any) {
  const result = await engine.listNotes({ lawFirmId, parentId: matterId, userId, query });
  return { ...result, notes: await withLinks(lawFirmId, result.notes) };
}

export async function getNoteDetail({ lawFirmId, matterId, noteId, userId }: any) {
  const result = await engine.getNoteDetail({ lawFirmId, parentId: matterId, noteId, userId });
  const [note] = await withLinks(lawFirmId, [result.note]);
  return { note };
}

export async function addNote({ lawFirmId, matterId, userId, timeZone, body }: any) {
  const result = await engine.addNote({ lawFirmId, parentId: matterId, userId, timeZone, body });
  const [note] = await withLinks(lawFirmId, [result.note]);
  return { ...result, note };
}

export async function updateNote({ lawFirmId, matterId, noteId, userId, body }: any) {
  const result = await engine.updateNote({ lawFirmId, parentId: matterId, noteId, userId, body });
  const [note] = await withLinks(lawFirmId, [result.note]);
  return { ...result, note };
}

export async function listNoteVersions({ lawFirmId, matterId, noteId, userId }: any) {
  return engine.listNoteVersions({ lawFirmId, parentId: matterId, noteId, userId });
}

export async function retractNote({ lawFirmId, matterId, noteId, userId, reason }: any) {
  return engine.retractNote({ lawFirmId, parentId: matterId, noteId, userId, reason });
}

export async function setNotePinned({ lawFirmId, matterId, noteId, userId, pinned }: any) {
  return engine.setNotePinned({ lawFirmId, parentId: matterId, noteId, userId, pinned });
}

export async function addTimeToNote({ lawFirmId, matterId, noteId, userId, timeZone, body }: any) {
  const result = await engine.addTimeToNote({ lawFirmId, parentId: matterId, noteId, userId, timeZone, body });
  const [note] = await withLinks(lawFirmId, [result.note]);
  return { ...result, note };
}

export async function updateNoteTimeEntry({ lawFirmId, matterId, noteId, timeEntryId, userId, body }: any) {
  const result = await engine.updateNoteTimeEntry({ lawFirmId, parentId: matterId, noteId, timeEntryId, userId, body });
  const [note] = await withLinks(lawFirmId, [result.note]);
  return { ...result, note };
}

export async function removeNoteTimeEntry({ lawFirmId, matterId, noteId, timeEntryId, userId }: any) {
  const result = await engine.removeNoteTimeEntry({ lawFirmId, parentId: matterId, noteId, timeEntryId, userId });
  const [note] = await withLinks(lawFirmId, [result.note]);
  return { ...result, note };
}

/**
 * One page of the firm's notes, across every matter the reader can see.
 *
 * An ordinary member is narrowed to the matters they belong to (enforced in
 * the query, not filtered afterward, so pages and totals stay honest). Owners
 * and admins hold `notes.viewFirmWide` via `ALL_PERMISSIONS` and see every
 * matter in the firm.
 *
 * Time summaries are resolved per matter rather than in one sweep, because
 * `invoicePlacementsForSources` is scoped to a single matter's invoices. A
 * page spans few enough matters that this stays a small number of queries.
 * Firm-wide is its own read path (joined across every matter) rather than
 * the shared engine's `listNotes`, so it's not part of the engine itself.
 */
export async function listFirmNotes({ lawFirmId, userId, query = {} }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const member = await loadResolvedMember(lawFirmId, userId);
  const seesAllMatters = !!member?.isOwner
    || !!member?.resolvedPermissions?.includes('notes.viewFirmWide');

  const filters = {
    search: query.search,
    noteType: query.noteType,
    timeFilter: query.timeFilter,
    tag: query.tag,
    authorId: query.authorId,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  };

  const [page, counts] = await Promise.all([
    mattersRepo.getFirmNotes(lawFirmId, {
      userId,
      seesAllMatters,
      page: query.page,
      limit: query.limit,
      offset: query.offset,
      matterId: query.matterId,
      ...filters,
    }),
    mattersRepo.getFirmNoteCounts(lawFirmId, { userId, seesAllMatters, matterId: query.matterId, ...filters }),
  ]);

  const byMatter = new Map<string, any[]>();
  for (const note of page.notes) {
    const list = byMatter.get(String(note.matterId)) || [];
    list.push(note);
    byMatter.set(String(note.matterId), list);
  }
  const summarized = new Map<string, any>();
  for (const [matterId, notesForMatter] of byMatter) {
    for (const n of await withLinks(lawFirmId, await engine.enrichNotes(lawFirmId, matterId, notesForMatter))) {
      summarized.set(String(n.id), n);
    }
  }

  return {
    ...page,
    notes: page.notes.map((n: any) => summarized.get(String(n.id)) || n),
    counts,
    // The firm-wide list reads tags per matter elsewhere; it offers no tag
    // dropdown of its own.
    tags: [],
  };
}

/**
 * Send a client update drawn from a note.
 *
 * The note itself is never shared. The author writes the message that goes
 * out, and what the client receives is an ordinary matter message: it appears
 * in the portal thread they already read, carries read state, and can be
 * replied to. A whole internal note pushed into the portal would carry
 * impressions and strategy that were never written for the client.
 *
 * Creates a fresh group conversation scoped to the matter and the chosen
 * recipients each time: there is no single canonical "the matter's client
 * conversation" in the messaging model to append to instead, group
 * conversations are just tagged with the matters they concern.
 */
export async function sendNoteAsClientUpdate({ lawFirmId, matterId, noteId, userId, body }: any) {
  await assertMatterMembership(lawFirmId, matterId, userId);
  const note = await engine.repo.getNote(lawFirmId, matterId, noteId);
  if (!note) throw new NotFoundError('Note');

  const message = (body.message || '').trim();
  if (!message) throw new ValidationError('An update message is required');

  // `recipientClientIds` (request body, optional) and the matter-clients list both
  // identify clients by their `clients.id` uuid, but messaging identifies
  // participants by portal login uid - resolve here rather than passing the
  // wrong id space into createGroupConversation.
  const matterClients = await mattersRepo.listMatterClients(lawFirmId, matterId);
  if (!matterClients.length) throw new ValidationError('This matter has no clients to send an update to');

  const requestedIds = Array.isArray(body.recipientClientIds) && body.recipientClientIds.length
    ? new Set(body.recipientClientIds)
    : null;
  const targetClients = matterClients.filter((c: any) => !requestedIds || requestedIds.has(c.id));

  // A company matter-client has no `clients.user_id` of its own (Phase 1
  // invariant) - resolve it to its portal-enabled roster instead, same as
  // every other company-portal fan-out (organization-clients plan Phase 7).
  // A person matter-client without portal access yet contributes nothing.
  // Bounded at three roster reads at once so a matter with many company clients
  // cannot take the shared pool; the first failure still rejects the send.
  const recipientSettled = await runWithConcurrency(targetClients.map((c: any) => () => (
    c.clientType === 'company'
      ? eligibleCompanyPortalUserIds(lawFirmId, c.id)
      : Promise.resolve(c.userId ? [c.userId] : [])
  )), 3);
  const recipientFailure = recipientSettled.find((r: any) => r.status === 'rejected');
  if (recipientFailure) throw recipientFailure.reason;
  const recipientIdLists = recipientSettled.map((r: any) => r.value);
  const recipientClientIds = [...new Set(recipientIdLists.flat())];
  if (!recipientClientIds.length) {
    throw new ValidationError("None of this matter's clients have portal access yet, so there's no one to send an update to");
  }

  const { conversationId } = await messagingService.createGroupConversation({
    lawFirmId,
    userId,
    matterId,
    clientIds: recipientClientIds,
  });
  await messagingService.sendGroupMessage({
    conversationId,
    userId,
    body: { content: message },
  });

  eventBus.emit(MATTER_NOTE_SHARED, {
    lawFirmId,
    matterId,
    noteId,
    actorUserId: userId,
    recipientCount: recipientClientIds.length,
  });

  return { message: 'Client update sent', conversationId };
}
