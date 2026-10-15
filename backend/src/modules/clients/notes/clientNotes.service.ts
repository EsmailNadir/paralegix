/**
 * Client notes.
 *
 * The full feature lives in the shared notes engine (`shared/notes/notesEngine.ts`),
 * which matter, task, and client notes all use identically. This module
 * supplies only what's client-specific: no per-user membership concept exists
 * for clients (unlike matters), so access is the client's existence plus the
 * firm-wide `clients.view`/`clients.manage` permission the routes already
 * gate on; billing is always the client itself.
 *
 * Client notes are always firm-internal — never shown in the client portal,
 * the same as before (see `portal.service.ts`, which hardcodes `notes: []`
 * for a client's own dashboard with an explicit comment on why).
 */

const clientsRepo = require('../clients.repository');
const { NotFoundError, ForbiddenError } = require('../../../shared/errors/AppError');
const { isFirmOwnerOrAdmin } = require('../../../shared/utils/membership');
const { loadResolvedMember } = require('../../lawfirms/roles/requirePermission');
const { tenantParameterizedQuery } = require('../../../shared/database/queryContext');
const { matterClients } = require('../../../shared/database/drizzle/schema');
const { resolveEffectiveClientIds } = require('../clientCompanyLinks.util');
const {
  CLIENT_NOTE_CREATED, CLIENT_NOTE_UPDATED, CLIENT_NOTE_RETRACTED, CLIENT_NOTE_TIME_RECORDED,
} = require('../../../shared/events/eventTypes');
const { notes, noteVersions, noteReplies } = require('../../../shared/database/drizzle/schema');
const { createNotesEngine } = require('../../../shared/notes/notesEngine');
const { CONTEXT_TYPES } = require('../../billing/context');

/**
 * Can this user read this client's notes at all.
 *
 * Clients have no membership model of their own, so unlike matter notes
 * (`assertMatterReadAccess`) and task notes (`assertTaskReadAccess`) there is
 * nothing to check directly. Access follows the MATTERS the client is on:
 *
 *   - on one or more matters -> the caller must be on one of them;
 *   - on NO matter          -> firm-wide;
 *   - owner, firm admin, or `notes.viewFirmWide` -> always.
 *
 * This gate used to be an existence check alone, and the route's permission is
 * `clients.view`, which is in DEFAULT_PERMISSIONS. So the read rule was "you are
 * in this firm", and every member could read every client's intake summaries and
 * privileged conversation records, including clients of matters they were
 * deliberately walled off from. The comment justifying `clients.view` as
 * baseline is explicitly about NAMES ("reads the same client names there"), and
 * notes are not names.
 *
 * The unattached case is not a loophole, it is the intake case. Notes are taken
 * on a prospective client before any matter exists, and a strict matter rule
 * would hide them from everyone including the person who just took the call.
 * There is no matter to be walled off from yet, and the client roster itself is
 * already firm-wide. The moment the client is attached to a matter, these notes
 * become matter-scoped with it.
 *
 * The existence check stays FIRST and unconditional. Widening who may read must
 * never become skipping whether the row is in this firm; that is the shape that
 * produced the task-notes leak.
 */
export async function assertClientNoteAccess(lawFirmId: string, clientId: string, userId: string) {
  const client = await clientsRepo.findByIdRaw(lawFirmId, clientId);
  if (!client) throw new NotFoundError('Client');

  if (await readsClientNotesFirmWide(lawFirmId, userId)) return;

  const { attached, mine } = (await matterStanding(lawFirmId, [clientId], userId)).get(clientId)
    || { attached: false, mine: false };
  if (!attached || mine) return;

  throw new ForbiddenError('You must be on one of this client\'s matters to read its notes');
}

/** Owners, firm admins and `notes.viewFirmWide` holders read every client's notes. */
async function readsClientNotesFirmWide(lawFirmId: string, userId: string): Promise<boolean> {
  const member = await loadResolvedMember(lawFirmId, userId);
  if (member?.isOwner || member?.resolvedPermissions?.includes('notes.viewFirmWide')) return true;
  return isFirmOwnerOrAdmin(lawFirmId, userId);
}

/**
 * For each client: is it on any matter, and is this user staffed on one of them.
 * One query for the whole set, so a gate over many clients costs the same as a
 * gate over one.
 */
async function matterStanding(lawFirmId: string, clientIds: string[], userId: string) {
  const rows = await tenantParameterizedQuery(
    matterClients,
    lawFirmId,
    `select mc.client_id,
            true as attached,
            bool_or(mm.user_id is not null) as mine
       from matter_clients mc
       left join matter_members mm
         on mm.law_firm_id = mc.law_firm_id and mm.matter_id = mc.matter_id and mm.user_id = $3
      where mc.law_firm_id = $1 and mc.client_id = any($2::uuid[])
      group by mc.client_id`,
    [lawFirmId, clientIds, userId],
    'mc',
  );
  const byClient = new Map<string, { attached: boolean; mine: boolean }>();
  for (const r of rows.rows) {
    byClient.set(String(r.client_id), { attached: !!r.attached, mine: !!r.mine });
  }
  return byClient;
}

/**
 * Which of these clients' notes the user may read: the batch form of
 * `assertClientNoteAccess`, with the same rule. A client that does not exist in
 * this firm is not readable, and an unreadable one is omitted rather than thrown
 * on, since the caller is filtering a roster rather than opening one client.
 */
async function readableClientIds(lawFirmId: string, clientIds: string[], userId: string): Promise<string[]> {
  if (clientIds.length === 0) return [];
  const existing = (await clientsRepo.findByIdsRaw(lawFirmId, clientIds)).map((c: any) => String(c.id));
  if (existing.length === 0) return [];
  if (await readsClientNotesFirmWide(lawFirmId, userId)) return existing;
  const standing = await matterStanding(lawFirmId, existing, userId);
  return existing.filter((id: string) => {
    const s = standing.get(id);
    return !s || !s.attached || s.mine;
  });
}

const CLIENT_NOTE_COLUMNS = {
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
  parentColumn: 'clientId',
  rawTableName: 'notes',
  parentRawColumn: 'client_id',
  columns: CLIENT_NOTE_COLUMNS,
  assertReadAccess: assertClientNoteAccess,
  assertWriteAccess: assertClientNoteAccess,
  isOverrideAuthor: isFirmOwnerOrAdmin,
  // Billing for a client note is always the client itself.
  resolveBillingContext: async (lawFirmId: string, clientId: string) => ({ type: CONTEXT_TYPES.client, lawFirmId, entityId: clientId }),
  events: {
    created: CLIENT_NOTE_CREATED,
    updated: CLIENT_NOTE_UPDATED,
    retracted: CLIENT_NOTE_RETRACTED,
    timeRecorded: CLIENT_NOTE_TIME_RECORDED,
  },
});

export async function listNotes({ lawFirmId, clientId, userId, query = {} }: any) {
  // Widen the listing to also surface notes recorded directly against any
  // company this person client is linked to via `client_company_links`. Only
  // the list read widens (`additionalParentIds` is opt-in on the shared notes
  // engine); reading/writing one note by id stays scoped to its actual parent.
  const { clientIds } = await resolveEffectiveClientIds(lawFirmId, clientId);
  // Each organization is its own client with its own matter wall, and the
  // engine only checks read access for the person being viewed. Drop every
  // organization the caller could not open directly, so the widened list never
  // shows notes the caller is walled off from.
  const candidateIds = clientIds.filter((id: string) => id !== clientId);
  const additionalParentIds = await readableClientIds(lawFirmId, candidateIds, userId);
  return engine.listNotes({ lawFirmId, parentId: clientId, userId, query, additionalParentIds });
}

export async function getNoteDetail({ lawFirmId, clientId, noteId, userId }: any) {
  return engine.getNoteDetail({ lawFirmId, parentId: clientId, noteId, userId });
}

export async function addNote({ lawFirmId, clientId, userId, timeZone, body }: any) {
  return engine.addNote({ lawFirmId, parentId: clientId, userId, timeZone, body });
}

export async function updateNote({ lawFirmId, clientId, noteId, userId, body }: any) {
  return engine.updateNote({ lawFirmId, parentId: clientId, noteId, userId, body });
}

export async function listNoteVersions({ lawFirmId, clientId, noteId, userId }: any) {
  return engine.listNoteVersions({ lawFirmId, parentId: clientId, noteId, userId });
}

export async function retractNote({ lawFirmId, clientId, noteId, userId, reason }: any) {
  return engine.retractNote({ lawFirmId, parentId: clientId, noteId, userId, reason });
}

export async function setNotePinned({ lawFirmId, clientId, noteId, userId, pinned }: any) {
  return engine.setNotePinned({ lawFirmId, parentId: clientId, noteId, userId, pinned });
}

export async function addTimeToNote({ lawFirmId, clientId, noteId, userId, timeZone, body }: any) {
  return engine.addTimeToNote({ lawFirmId, parentId: clientId, noteId, userId, timeZone, body });
}

export async function updateNoteTimeEntry({ lawFirmId, clientId, noteId, timeEntryId, userId, body }: any) {
  return engine.updateNoteTimeEntry({ lawFirmId, parentId: clientId, noteId, timeEntryId, userId, body });
}

export async function removeNoteTimeEntry({ lawFirmId, clientId, noteId, timeEntryId, userId }: any) {
  return engine.removeNoteTimeEntry({ lawFirmId, parentId: clientId, noteId, timeEntryId, userId });
}
