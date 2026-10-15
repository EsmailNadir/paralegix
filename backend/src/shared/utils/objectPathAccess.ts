const { assertMatterReadAccess, assertLawFirmMembership, isFirmOwnerOrAdmin } = require('./membership');
const { ForbiddenError, NotFoundError } = require('../errors/AppError');
const { isSystemObjectPath } = require('../storage/recordArchive');
const tasksRepo = require('../../modules/tasks/tasks.repository');
const filesRepo = require('../../modules/files/files.repository');
const { assertClientInFirm } = require('./clientScope');

/**
 * Read and write gate for a client's own documents (the client scope, not a
 * matter's or a task's).
 *
 * The rule is the client notes rule, by calling the notes gate itself rather
 * than restating it: a client on one or more matters is reachable only by
 * someone staffed on one of them; a client on no matter is firm-wide; owners,
 * firm admins and `notes.viewFirmWide` holders always pass. A client's
 * documents are the same privileged material as its notes, and gating them on
 * firm membership alone let a member walled off from every one of the client's
 * matters list, download and re-attach them.
 *
 * Firm membership first, so a caller from another firm is refused before the
 * client is looked up; then the client's existence, so an id that is not this
 * firm's answers 404 and never reveals whether it exists elsewhere; then the
 * wall. The notes gate words its refusal for notes, so it is reworded here.
 */
export async function assertClientFileAccess(lawFirmId: string, clientId: string, userId: string) {
  await assertLawFirmMembership(lawFirmId, userId);
  await assertClientInFirm(lawFirmId, clientId);
  // Required here: the client notes service reaches the notes engine, which
  // reaches the attachment links, which reach the files module that imports this.
  const { assertClientNoteAccess } = require('../../modules/clients/notes/clientNotes.service');
  try {
    await assertClientNoteAccess(lawFirmId, clientId, userId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new ForbiddenError('You must be on one of this client\'s matters to open its files');
    }
    throw err;
  }
}

/**
 * Read gate for a standalone-task file, mirroring `resolveTaskContext` in
 * files.scope: a non-empty `visibleToUserIds` restricts the task to those users;
 * otherwise a matter-linked task falls back to matter read access and a pure
 * standalone task to firm membership.
 *
 * Firm owners and admins pass an explicit visibility list, because the task list
 * already shows them every task in the firm (`seeAll` in tasks.service). Without
 * that they could open a task and then fail to load its attachments.
 */
async function assertTaskFileAccess(lawFirmId: string, taskId: string, userId: string) {
  const taskData = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!taskData) throw new NotFoundError('Task');
  if (Array.isArray(taskData.visibleToUserIds) && taskData.visibleToUserIds.length > 0) {
    if (taskData.visibleToUserIds.includes(userId)) return;
    if (await isFirmOwnerOrAdmin(lawFirmId, userId)) return;
    throw new ForbiddenError('No access to this task');
  }
  if (taskData.matterId) {
    await assertMatterReadAccess(lawFirmId, taskData.matterId, userId);
    return;
  }
  await assertLawFirmMembership(lawFirmId, userId);
}

/**
 * Assert the caller may READ a caller-supplied object path already confirmed to
 * be under this firm's prefix.
 *
 * The FILE ROW decides. A matter document requires matter read access, a
 * standalone-task document requires task visibility, a client document the
 * client's matter wall (`assertClientFileAccess`), and everything else falls
 * back to firm membership.
 *
 * This used to read the path itself, taking the segment after the firm id as a
 * matter id. That worked only while the path encoded the tree, and it is exactly
 * what made the tree unrenamable. It also put the ethical wall at the mercy of
 * how a name happened to be spelled. The row carries the same three columns the
 * path used to spell out, and it carries them whatever the object is called.
 *
 * A DELETED row still gates. An access rule that stops applying the moment a
 * document is deleted is not an access rule, and the bytes outlive the row by
 * the length of the restore window.
 *
 * This is the canonical read decision for the file-serving endpoints and for any
 * feature that lets a caller name an existing file (attaching a document to a
 * message, for one). Callers MUST have already confirmed the path is under
 * `lawfirmids/{lawFirmId}/`.
 */
export async function assertObjectPathReadAccess(lawFirmId: string, objectPath: string, userId: string) {
  // Objects the system placed here for itself: preserved records (executed
  // documents, their certificates, invoices as sent) and the scratch copies an
  // open signing session works in. None of them are rows in `files`, so without
  // this they fall to the no-row branch below and onto plain firm membership,
  // which is a hole in the ethical wall. A matter's executed signed document
  // lives under `signatures/`, and a member walled off from that matter could
  // read it, forward it into a client conversation, or mint a share link to it,
  // by naming the path directly. Each of these prefixes has its own routes,
  // which authorize through the owning session or invoice; nothing legitimately
  // reaches these bytes through a generic file read.
  //
  // NotFoundError rather than Forbidden, matching the portal's scope resolver:
  // probing should not distinguish "not yours" from "not there".
  if (isSystemObjectPath(objectPath)) {
    throw new NotFoundError('File');
  }

  const row = await filesRepo.findByObjectPath(lawFirmId, objectPath, { includeDeleted: true });
  if (!row) {
    // Not a document in the browsable tree. Conversation attachments are the
    // real case: they are authorized by conversation participation at their own
    // route, and firm membership is the floor under that.
    await assertLawFirmMembership(lawFirmId, userId);
    return;
  }

  if (row.matterId) {
    await assertMatterReadAccess(lawFirmId, row.matterId, userId);
    return;
  }
  if (row.taskId) {
    await assertTaskFileAccess(lawFirmId, row.taskId, userId);
    return;
  }
  if (row.clientId) {
    await assertClientFileAccess(lawFirmId, row.clientId, userId);
    return;
  }
  await assertLawFirmMembership(lawFirmId, userId);
}
