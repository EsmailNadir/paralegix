/**
 * Where a set of files lives, and whether the caller may touch them.
 *
 * Every storage route answers the same two questions before it does anything:
 * which prefix are we addressing, and is this user allowed to address it. That
 * answer was written out longhand in each route as a four-branch
 * matter/task/client/firm cascade, so a change to how any one scope is
 * authorized (or where it stores its bytes) had to be made in a dozen places and
 * was reliably made in eleven. `resolveFileScope` is that cascade, once.
 */

const { ForbiddenError, NotFoundError } = require('../../shared/errors/AppError');
const {
  assertMatterMembership,
  assertMatterReadAccess,
  assertLawFirmMembership,
  getAccessibleMatterIds,
  isFirmOwnerOrAdmin,
} = require('../../shared/utils/membership');
const { isSystemObjectPath } = require('../../shared/storage/recordArchive');
const tasksRepo = require('../tasks/tasks.repository');
const mattersRepo = require('../matters/matters.repository');
const filesRepo = require('./files.repository');
const { BASE_FOLDER, FILE_CONTEXT_TYPES, contextToPrefix, parseFilingPath } = require('./files.context');

export const SCOPE_MATTER = 'matter';
export const SCOPE_TASK = 'task';
export const SCOPE_CLIENT = 'client';
export const SCOPE_FIRM = 'firm';

/**
 * Reads govern who may SEE a matter's documents, writes who may change them.
 *
 * A firm owner or admin can read any matter in the firm (matching how matters,
 * billing and the dashboard behave) but still may not write into one they are not
 * a member of.
 */
export const MODE_READ = 'read';
export const MODE_WRITE = 'write';

// One implementation, in shared/utils. The files module had a second copy that
// drifted from it; re-exported here so the module's own routes keep importing
// it from the module.
export { assertObjectPathReadAccess } from '../../shared/utils/objectPathAccess';
const { assertClientFileAccess } = require('../../shared/utils/objectPathAccess');

export const firmPrefix = (lawFirmId: string) => `${BASE_FOLDER}/${lawFirmId}/`;

export const matterPrefix = (lawFirmId: string, matterId: string) =>
  contextToPrefix({ type: FILE_CONTEXT_TYPES.matter, lawFirmId, entityId: matterId });

export const taskPrefix = (lawFirmId: string, taskId: string) =>
  contextToPrefix({ type: FILE_CONTEXT_TYPES.task, lawFirmId, entityId: taskId });

export const clientPrefix = (lawFirmId: string, clientId: string) =>
  contextToPrefix({ type: FILE_CONTEXT_TYPES.client, lawFirmId, entityId: clientId });

export const firmGeneralPrefix = (lawFirmId: string) =>
  contextToPrefix({ type: FILE_CONTEXT_TYPES.general, lawFirmId });

/**
 * Resolves storage prefix and context for a task.
 * Matter-linked tasks: returns matterPrefix (files at matter root, filtered by metadata).
 * Standalone tasks: returns taskPrefix.
 */
export async function resolveTaskContext(lawFirmId: string, taskId: string, userId: string, mode = MODE_WRITE) {
  const taskData = await tasksRepo.findByIdRaw(lawFirmId, taskId);
  if (!taskData) {
    throw new NotFoundError('Task');
  }
  // Gate task FILES by the same visibility model notes.assertTaskAccess uses so
  // a restricted-visibility task's attachments aren't reachable by firm members the
  // task isn't shared with. A non-empty visibleToUserIds restricts to those users;
  // otherwise a matter-linked task falls back to the matter gate for this `mode`
  // and a standalone task to firm membership (already asserted by the caller
  // before this point). On a read, firm owners and admins pass an explicit
  // visibility list too, since the task list already shows them every task.
  if (Array.isArray(taskData.visibleToUserIds) && taskData.visibleToUserIds.length > 0) {
    if (!taskData.visibleToUserIds.includes(userId)
      && !(mode === MODE_READ && await isFirmOwnerOrAdmin(lawFirmId, userId))) {
      throw new ForbiddenError('No access to this task');
    }
  } else if (taskData.matterId) {
    await (mode === MODE_READ ? assertMatterReadAccess : assertMatterMembership)(lawFirmId, taskData.matterId, userId);
  }
  if (taskData.matterId) {
    return {
      prefix: matterPrefix(lawFirmId, taskData.matterId),
      matterId: taskData.matterId,
      taskData,
      isMatterLinked: true,
    };
  }
  return {
    prefix: taskPrefix(lawFirmId, taskId),
    matterId: null,
    taskData,
    isMatterLinked: false,
  };
}

/**
 * Read gate for one file, by id.
 *
 * The row carries the matter, task or client it belongs to, so this is a lookup
 * and a membership check. It replaces four separate parsers that each worked out
 * "which matter owns this path" by splitting a string, in `files.scope`,
 * `objectPathAccess`, and twice inside the signatures module. That decision is
 * the ethical wall, and four copies of it was four chances to drift.
 *
 * `NotFoundError` rather than a refusal, so probing cannot tell "not yours"
 * from "not there".
 */
export async function assertFileReadAccess(lawFirmId: string, fileId: any, userId: string) {
  const filesRepository = require('./files.repository');
  const row = await filesRepository.findById(lawFirmId, fileId);
  if (!row) throw new NotFoundError('File');
  await assertFileRowsReadable(lawFirmId, [row], userId);
  return row;
}

/**
 * The read decision for file rows already in hand, resolved once per distinct
 * context rather than once per row.
 *
 * A row's own matter wins, then its task, then its client (the client's matter
 * wall, as for client notes), and a row with none of them needs only firm
 * membership. This is the single definition of that order: `assertFileReadAccess`
 * is this over one row, and the attachment link check is this over the rows a
 * note or task names, so the two cannot disagree about who may see a file.
 *
 * Throws on the first context the caller cannot open.
 */
export async function assertFileRowsReadable(
  lawFirmId: string,
  rows: Array<{ matterId?: string | null; taskId?: string | null; clientId?: string | null }>,
  userId: string,
) {
  const matterIds = new Set<string>();
  const taskIds = new Set<string>();
  const clientIds = new Set<string>();
  let needsMembership = false;
  for (const row of rows) {
    if (row.matterId) matterIds.add(String(row.matterId));
    else if (row.taskId) taskIds.add(String(row.taskId));
    else if (row.clientId) clientIds.add(String(row.clientId));
    else needsMembership = true;
  }
  for (const matterId of matterIds) {
    await assertMatterReadAccess(lawFirmId, matterId, userId);
  }
  for (const taskId of taskIds) {
    await resolveTaskContext(lawFirmId, taskId, userId, MODE_READ);
  }
  for (const clientId of clientIds) {
    await assertClientFileAccess(lawFirmId, clientId, userId);
  }
  if (needsMembership) await assertLawFirmMembership(lawFirmId, userId);
}

/**
 * Authorize the caller for one file scope and return where that scope's objects
 * live.
 *
 * The scope is chosen by which id the request carries, in the order
 * matter > task > client > firm-general — the order the routes have always used,
 * so a request naming both a matter and a task addresses the matter's prefix.
 *
 * @param {object} args
 * @param {string} args.lawFirmId
 * @param {string} [args.matterId]
 * @param {string} [args.taskId]
 * @param {string} [args.clientId]
 * @param {string} args.userId
 * @param {'read'|'write'} [args.mode] - which matter gate to apply; see MODE_READ.
 *
 * @returns {Promise<{
 *   type: 'matter'|'task'|'client'|'firm',
 *   prefix: string,
 *   matterId: string|null,
 *   taskId: string|null,
 *   clientId: string|null,
 *   taskContext: object|null,
 *   filterTaskId: string|null,
 * }>}
 *
 * `filterTaskId` is only meaningful to the listing routes: a matter-linked
 * task's documents sit under the matter's tree tagged with the task id, so
 * narrowing to that task is a filter over the matter's rows rather than a
 * different root. Routes that address a single object ignore it.
 *
 * `rootId` is the scope's root folder, created on first use. A matter-linked
 * task shares its matter's root for the same reason it shared the matter's
 * prefix before: its documents belong to the matter's tree and are told apart
 * by `task_id`.
 */
export async function resolveFileScope({
  lawFirmId,
  matterId = null,
  taskId = null,
  clientId = null,
  userId,
  mode = MODE_WRITE,
}: any) {
  const assertMatter = mode === MODE_READ ? assertMatterReadAccess : assertMatterMembership;

  if (matterId) {
    await assertMatter(lawFirmId, matterId, userId);
    return {
      type: SCOPE_MATTER,
      prefix: matterPrefix(lawFirmId, matterId),
      rootId: await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId }),
      matterId,
      taskId: taskId || null,
      clientId: null,
      taskContext: null,
      // A task id alongside a matter id narrows the matter's listing to that
      // task's own documents.
      filterTaskId: taskId || null,
    };
  }

  if (taskId) {
    await assertLawFirmMembership(lawFirmId, userId);
    const taskContext = await resolveTaskContext(lawFirmId, taskId, userId, mode);
    return {
      type: SCOPE_TASK,
      prefix: taskContext.prefix,
      rootId: taskContext.isMatterLinked
        ? await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'matter', matterId: taskContext.matterId })
        : await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'task', taskId }),
      matterId: taskContext.matterId,
      taskId,
      clientId: null,
      taskContext,
      // A standalone task owns its whole prefix, so nothing needs filtering out.
      filterTaskId: taskContext.isMatterLinked ? taskId : null,
    };
  }

  if (clientId) {
    // Firm membership, then the client belongs to this firm (without that the
    // scope root is created for another firm's client id and the composite
    // foreign key turns the request into a 500), then the client's matter wall.
    // Reads and writes alike, as for client notes.
    await assertClientFileAccess(lawFirmId, clientId, userId);
    return {
      type: SCOPE_CLIENT,
      prefix: clientPrefix(lawFirmId, clientId),
      rootId: await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'client', clientId }),
      matterId: null,
      taskId: null,
      clientId,
      taskContext: null,
      filterTaskId: null,
    };
  }

  await assertLawFirmMembership(lawFirmId, userId);
  return {
    type: SCOPE_FIRM,
    prefix: firmGeneralPrefix(lawFirmId),
    rootId: await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'firm' }),
    matterId: null,
    taskId: null,
    clientId: null,
    taskContext: null,
    filterTaskId: null,
  };
}

/**
 * Which of `matterIds` this user may READ the documents of, in a constant number
 * of queries.
 *
 * This is the matter arm of `resolveFileScope({ mode: MODE_READ })` answered for
 * a whole set instead of one id: owners and firm admins reach any matter that
 * exists IN THIS FIRM, everyone else must be staffed on the matter. Both halves
 * are the same shared primitives `assertMatterFirmWideAccess` composes itself
 * from, so the ethical wall has one definition and this has no opinion of its
 * own. Answering a set rather than one id is the whole point of a batch: a
 * per-matter assertion would put the round trips straight back.
 *
 * Nothing here throws on an id the caller cannot reach. A batch names matters
 * the caller merely holds a list of, so an unreachable one is omitted rather
 * than failing the whole request the way a per-matter 403 would.
 */
export async function resolveReadableMatterIds(
  lawFirmId: string,
  userId: string,
  matterIds: string[],
): Promise<Set<string>> {
  if (await isFirmOwnerOrAdmin(lawFirmId, userId)) {
    // Scoped to the firm, so an id from another firm is dropped here rather than
    // waved through on the strength of who is asking.
    return mattersRepo.filterExistingMatterIds(lawFirmId, matterIds);
  }
  return getAccessibleMatterIds(lawFirmId, matterIds, userId);
}

/**
 * True when a listing addresses a matter itself rather than one of its tasks.
 *
 * A matter-linked task stores its documents under the matter's prefix, so a
 * matter's own browser has to hide them or every task's attachments pollute it.
 */
export const isPureMatterView = (scope: any) => scope.type === SCOPE_MATTER && !scope.filterTaskId;

// Re-exported so callers keep importing these from here.
export { BASE_FOLDER };
