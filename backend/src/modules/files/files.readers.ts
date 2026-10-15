/**
 * Every read of the file tree, behind three functions.
 *
 * There used to be two implementations of each: one that walked the storage
 * bucket at request time and one that read the mirrored table, chosen by a
 * feature flag that was never turned on because the two had drifted apart. The
 * table is the tree now, so there is one.
 *
 * What that removes, beyond the duplication: the bucket walk had a ceiling of
 * 25,000 objects and reported `truncated` when it hit one, because a listing
 * that stopped early is indistinguishable from a complete one and that is how a
 * firm concludes a document was never uploaded. A folder listing is one indexed
 * query for one level now. A search is one indexed query too, but each hit
 * costs a chain read, so it is capped and says when it was.
 */

const filesRepo = require('./files.repository');
const { isPureMatterView } = require('./files.scope');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');

/** Hits one search returns. Each costs a recursive ancestor read. */
const SEARCH_LIMIT = 200;

/**
 * Ancestor reads in flight at once while resolving hit trails. One per hit, all
 * at once, is a request asking for more pool connections than the pool holds.
 */
const TRAIL_CONCURRENCY = 8;

/** Listings carry no signed URL; the client asks for one when it opens a file. */
const LIST_SIGNED_URL = '';

/** The shape every listing returns, so the three reads cannot drift. */
function entry(row: any, counts?: any) {
  const isFolder = row.kind === 'folder';
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    objectPath: row.objectPath,
    size: isFolder ? 0 : row.sizeBytes,
    contentType: isFolder ? 'folder' : (row.mimeType || 'application/octet-stream'),
    updated: row.updatedAt,
    signedUrl: LIST_SIGNED_URL,
    isFolder,
    clientVisible: row.clientVisible,
    ...(isFolder ? {
      folderColor: row.folderColor,
      fileCount: counts?.fileCount ?? 0,
      folderCount: counts?.folderCount ?? 0,
    } : {
      taskId: row.taskId,
    }),
  };
}

/**
 * A matter-linked task files into its matter tree, tagged with the task. A
 * matter listing hides those (they belong to the task) and a task listing keeps
 * only those.
 */
function taskFilterFor(scope: any) {
  if (scope.filterTaskId) return { taskId: scope.filterTaskId };
  if (isPureMatterView(scope)) return { excludeTaskOwned: true };
  return {};
}

/**
 * ONE PAGE of a scope, flattened. Backs `GET /list`, which is what the file
 * pickers read.
 *
 * Recursive on purpose. The old table-backed half returned direct children only,
 * so a picker could not reach a document two folders down, which is the defect
 * that kept the flag off.
 *
 * Paged since the read underneath it grew with the customer's document count
 * rather than with the request. The response keeps its old shape and gains a
 * `cursor` beside it, so a client that ignores the cursor still gets a valid
 * first page instead of an error, and `truncated` finally means something: it
 * says there is more, which is exactly what a cursor being present means.
 */
async function listScopeRoot({ lawFirmId, scope, limit, cursor = null }: any) {
  const page = await filesRepo.listSubtreePage(lawFirmId, scope.rootId, {
    ...taskFilterFor(scope), limit, cursor,
  });
  const counts = await filesRepo.subtreeCounts(
    lawFirmId, page.rows.filter((r: any) => r.kind === 'folder').map((r: any) => r.id),
  );
  return {
    files: page.rows.map((r: any) => entry(r, counts[r.id])),
    cursor: page.cursor,
    truncated: page.cursor !== null,
  };
}

/**
 * `listScopeRoot` for SEVERAL matters at once, as `{ [matterId]: page }`.
 *
 * Every matter in `matterIds` gets an entry, so a matter the caller can read but
 * which holds no documents is present and empty rather than missing. Deciding
 * WHICH matters may be read is the caller's job; by the time this runs the list
 * is already the visible one.
 *
 * Constant cost, whatever the matter count: one query for the rows of every
 * requested tree, and one for the folder counts over all of them. That is the
 * point of the batch, so both are written as set reads rather than loops.
 */
async function listScopeRootsForMatters({ lawFirmId, matterIds, limit }: any) {
  const pages = await filesRepo.listSubtreePagesForMatters(lawFirmId, matterIds, { limit });

  const folderIds: string[] = [];
  for (const page of pages.values()) {
    for (const row of page.rows) if (row.kind === 'folder') folderIds.push(row.id);
  }
  const counts = await filesRepo.subtreeCounts(lawFirmId, folderIds);

  const filesByMatterId: Record<string, any> = {};
  for (const matterId of matterIds) {
    const page = pages.get(matterId);
    filesByMatterId[matterId] = {
      files: (page?.rows || []).map((r: any) => entry(r, counts[r.id])),
      truncated: page?.truncated === true,
    };
  }
  return filesByMatterId;
}

/**
 * One level of a folder, with recursive counts on each subfolder.
 *
 * The counts are what the old implementation walked the whole subtree for. They
 * are one grouped query here, so opening a folder costs the same whether it
 * holds ten documents or ten thousand.
 */
async function listFolder({ lawFirmId, scope, folderId }: any) {
  const parentId = folderId || scope.rootId;
  const { folders, files } = await filesRepo.listChildren(lawFirmId, parentId);
  const filter = taskFilterFor(scope);
  const keep = (row: any) => {
    if (filter.taskId) return String(row.taskId) === String(filter.taskId);
    if (filter.excludeTaskOwned) return !row.taskId;
    return true;
  };
  const visibleFolders = folders.filter(keep);
  const visibleFiles = files.filter(keep);
  const counts = await filesRepo.subtreeCounts(lawFirmId, visibleFolders.map((f: any) => f.id));
  return {
    folderId: parentId,
    files: [
      ...visibleFolders.map((r: any) => entry(r, counts[r.id])),
      ...visibleFiles.map((r: any) => entry(r)),
    ],
    truncated: false,
  };
}

/**
 * Name search across a scope. Backs `GET /search`.
 *
 * At most `SEARCH_LIMIT` hits. One row past the limit is read so `truncated`
 * can say more exist without a second query or a count.
 */
async function searchScope({ lawFirmId, scope, query }: any) {
  const found = await filesRepo.search(lawFirmId, scope.rootId, query, {
    ...taskFilterFor(scope), limit: SEARCH_LIMIT + 1,
  });
  const truncated = found.length > SEARCH_LIMIT;
  const rows = found.slice(0, SEARCH_LIMIT);
  const counts = await filesRepo.subtreeCounts(
    lawFirmId, rows.filter((r: any) => r.kind === 'folder').map((r: any) => r.id),
  );
  // A hit needs to say where it lives, or a search result is a name with no way
  // back to it. `trail` is what the browser navigates by when a hit is opened,
  // and `folderPath` is the same chain as one string, for display.
  const settled = await runWithConcurrency(
    rows.map((row: any) => () => filesRepo.ancestors(lawFirmId, row.id)),
    TRAIL_CONCURRENCY,
  );
  const withPath = rows.map((row: any, i: number) => {
    const outcome = settled[i];
    if (outcome.status === 'rejected') throw outcome.reason;
    const trail = outcome.value.slice(1).map((a: any) => ({ id: a.id, name: a.name }));
    return {
      ...entry(row, counts[row.id]),
      trail,
      folderPath: trail.map((a: any) => a.name).join('/'),
    };
  });
  return { files: withPath, truncated };
}

export {
  listScopeRoot,
  listScopeRootsForMatters,
  listFolder,
  searchScope,
  entry,
  LIST_SIGNED_URL,
};
