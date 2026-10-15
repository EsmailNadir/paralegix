import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
/**
 * The routes that CHANGE the file tree: create a folder, rename, move, colour,
 * share and delete.
 *
 * Every one of them is now a row write. The tree is `files.parent_id` and the
 * object under `lawfirmids/{firm}/objects/{id}` never moves, so renaming a
 * folder of thirty thousand documents is the same single UPDATE as renaming an
 * empty one.
 *
 * That replaces the walk these routes used to be. A rename copied every object
 * under a prefix to a new prefix a page at a time, verified each copy, deleted
 * each source and re-pointed each mirrored row; it could stop partway and leave
 * the folder split across two locations, and it patched only two of the nine
 * tables that stored the old path. None of that exists here: nothing that
 * references a file by id needs to be told the file was renamed.
 */
const express = require('express');
const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
import { handler } from '../../shared/http/handler';
const { setClientVisibilityBulkSchema } = require('./files.validation');
const {
  AppError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
} = require('../../shared/errors/AppError');
const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
const eventBus = require('../../shared/events/eventBus');
const { FILE_SHARED } = require('../../shared/events/eventTypes');
const filesRepo = require('./files.repository');
const {
  MODE_WRITE,
  resolveFileScope,
} = require('./files.scope');
const {
  isSafePathComponent,
  hasResolvedPermission,
  revokeShareLinksForFile,
  assertNotArchivedRecord,
  assertMatterNotUnderLegalHold,
} = require('./files.storage');

const router = express.Router();

/**
 * The row a request names, proven to sit inside the scope the caller was
 * authorized for.
 *
 * This is the ethical wall, and it is a lookup now rather than a string
 * comparison: the row carries the matter, task and client it belongs to, so a
 * caller naming somebody else's file id is refused by the row instead of by
 * parsing a path. `NotFoundError` rather than a refusal, so probing cannot tell
 * "not yours" from "not there".
 */
/**
 * The wall itself, as a decision about a row the caller already has.
 *
 * Separated from the lookup so the batched route applies the SAME rule to a
 * hundred rows it read in one query. Two copies of this predicate would be two
 * chances for one of them to forget a clause, and forgetting one here is how a
 * matter's documents become reachable from another matter's browser.
 */
function isInScope(scope: any, row: any): boolean {
  // A matter-linked task files into the MATTER's tree, so its rows carry the
  // matter's scope and the task's tag. The task page addresses them with only
  // the task id, and demanding the two scope labels match refused every write
  // from that view.
  const rowScope = scope.type === 'task' && scope.matterId ? 'matter' : scope.type;
  if (row.scope !== rowScope) return false;
  if (scope.matterId && String(row.matterId) !== String(scope.matterId)) return false;
  if (scope.clientId && String(row.clientId) !== String(scope.clientId)) return false;
  // A task view, linked or standalone, reaches only the task's own rows: it
  // lists nothing else, so it may touch nothing else.
  if (scope.type === 'task' && String(row.taskId) !== String(scope.taskId)) return false;
  return true;
}

async function requireInScope(lawFirmId: string, scope: any, fileId: any) {
  const row = await filesRepo.findById(lawFirmId, fileId);
  if (!row) throw new NotFoundError('File');
  if (!isInScope(scope, row)) throw new NotFoundError('File');
  return row;
}

/**
 * PATCH /client-visibility: share a file or folder into the client portal.
 *
 * Sharing a folder shares everything beneath it. `visibleClientIds` narrows a
 * share to named clients; it used to live as a key on the object metadata,
 * where no database read could apply it, and now sits in
 * `file_client_visibility` so the portal listing enforces it.
 */
router.patch('/client-visibility', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const {
    lawFirmId, matterId, clientId, taskId, fileId,
    clientVisible, visibleClientIds, notifyClient,
  } = { ...req.body, ...req.query };

  if (!lawFirmId || !fileId || (!matterId && !clientId && !taskId)) {
    throw new ValidationError('lawFirmId, fileId and one of matterId/taskId/clientId are required');
  }
  // Notify by default; a firm can share quietly (a work-in-progress document)
  // by passing notifyClient=false. Query strings arrive as strings.
  const notify = !(notifyClient === false || notifyClient === 'false');

  const scope = await resolveFileScope({
    lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
  });
  const row = await requireInScope(String(lawFirmId), scope, fileId);

  // The pre-write share state, so FILE_SHARED fires on a real share transition
  // and reaches only the clients newly gaining access.
  const wasVisible = row.clientVisible;
  const prevVisibleClientIds = await filesRepo.visibilityClientIds(lawFirmId, fileId);
  const visible = clientVisible === true || clientVisible === 'true';
  const restrictIds = Array.isArray(visibleClientIds)
    ? visibleClientIds.filter((id: any) => typeof id === 'string' && id)
    : null;

  await filesRepo.setVisibility(lawFirmId, fileId, { visible, clientIds: restrictIds });

  if (notify && visible) {
    eventBus.emit(FILE_SHARED, {
      sharedAt: new Date().toISOString(),
      lawFirmId,
      scopeType: scope.type,
      matterId: matterId || null,
      taskId: taskId || null,
      clientId: clientId || null,
      fileId: row.id,
      fileName: row.name,
      isFolder: row.kind === 'folder',
      wasVisible,
      // null on either side means "every client on the scope".
      prevVisibleClientIds: wasVisible && prevVisibleClientIds.length > 0 ? prevVisibleClientIds : null,
      newVisibleClientIds: restrictIds && restrictIds.length > 0 ? restrictIds : null,
      sharedByUserId: req.user.uid,
    });
  }

  return res.status(200).json({ message: 'Visibility updated', fileId: row.id, clientVisible: visible });
});

/**
 * PATCH /bulk-client-visibility: the same share, for a whole selection.
 *
 * WHY A SECOND ROUTE. The single-file form above takes one `fileId`, so sharing
 * a picker's selection was one request per file: bounded to four at a time in
 * the browser, a two-hundred-file share was still two hundred round trips
 * against an instance whose small Postgres pool is shared by every request on
 * it. This answers in a
 * constant number of queries whatever the selection holds.
 *
 * It is a separate path rather than an optional `fileIds` beside `fileId`
 * because the answer is a different document. A bulk mutation in this codebase
 * reports per item (`tasks/bulk-status`, `matters/bulk-delete`) and a
 * single-item one reports the item; folding both into one handler would make the
 * response shape depend on which key the caller happened to send, and every
 * caller would have to branch on it. The three batch READS added beside it
 * (`matters/clients`, `billing/flat-fees/firm`, `files/list-matters`) each took
 * the same decision.
 *
 * NOT ATOMIC, deliberately. A file the caller cannot reach is reported in
 * `errors` and the rest of the selection is shared. A selection names ids the
 * caller merely holds a list of, from a listing or a search that may be a moment
 * stale, so one bad id must not refuse the other hundred and ninety-nine; the
 * caller can then retry exactly what failed. `/list-matters` argues the same
 * thing for a read, with one difference: an unreachable id there is silently
 * ABSENT, and here it is REPORTED, because this is a write the user asked for
 * and silence would read as success.
 *
 * Every id that fails says "File not found" whatever the reason, which is the
 * same answer the single-file form gives, so probing still cannot tell "not
 * yours" from "not there".
 */
router.patch('/bulk-client-visibility',
  verifyToken,
  validate(setClientVisibilityBulkSchema),
  handler(async (req) => {
    const {
      lawFirmId, matterId, clientId, taskId, fileIds,
      clientVisible, visibleClientIds, notifyClient,
    } = req.body;

    if (!lawFirmId || (!matterId && !clientId && !taskId)) {
      throw new ValidationError('lawFirmId and one of matterId/taskId/clientId are required');
    }
    const notify = notifyClient !== false;
    const visible = clientVisible === true;

    // One authorization for the whole batch: the scope is what the caller was
    // authorized for, and every row below has to sit inside it.
    const scope = await resolveFileScope({
      lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
    });

    const requested: string[] = [...new Set(fileIds as string[])];
    // One query for every row, then the wall applied in memory. A per-file
    // lookup is what made this O(n) round trips in the first place.
    const rows = await filesRepo.findManyByIds(lawFirmId, requested);
    const byId = new Map<string, any>(rows.map((row: any) => [row.id, row]));

    const errors: Record<string, string> = {};
    const targets: any[] = [];
    for (const id of requested) {
      const row = byId.get(id);
      if (row && isInScope(scope, row)) targets.push(row);
      else errors[id] = 'File not found';
    }

    const restrictIds = Array.isArray(visibleClientIds)
      ? visibleClientIds.filter((id: any) => typeof id === 'string' && id)
      : null;

    let changed: any[] = [];
    if (targets.length > 0) {
      const targetIds = targets.map((row: any) => row.id);
      // The pre-write audience of every target, in one query, so FILE_SHARED
      // reaches only the clients NEWLY gaining access.
      const previousClientIds = notify && visible
        ? await filesRepo.visibilityClientIdsForMany(lawFirmId, targetIds)
        : new Map<string, string[]>();

      changed = await filesRepo.setVisibilityMany(
        lawFirmId, targetIds, { visible, clientIds: restrictIds },
      );
      const changedIds = new Set(changed.map((row: any) => row.id));
      // A row that vanished between the read and the write (a concurrent delete)
      // is reported like any other id this request could not apply.
      for (const row of targets) if (!changedIds.has(row.id)) errors[row.id] = 'File not found';

      if (notify && visible && changed.length > 0) {
        // ONE event for the batch. The digest behind it already coalesces a
        // burst of shares into a single per-client notification, so emitting per
        // file would only make the listener repeat the scope lookup per file and
        // put the round trips back on the other side of the bus.
        eventBus.emit(FILE_SHARED, {
          sharedAt: new Date().toISOString(),
          lawFirmId,
          scopeType: scope.type,
          matterId: matterId || null,
          taskId: taskId || null,
          clientId: clientId || null,
          // null on either side means "every client on the scope".
          newVisibleClientIds: restrictIds && restrictIds.length > 0 ? restrictIds : null,
          sharedByUserId: req.user.uid,
          files: targets.filter((row: any) => changedIds.has(row.id)).map((row: any) => {
            // `targets` is the PRE-write read, which is where the share
            // transition lives; `changed` rows already carry the new flag.
            const previous = previousClientIds.get(row.id) || [];
            return {
              fileId: row.id,
              fileName: row.name,
              isFolder: row.kind === 'folder',
              wasVisible: row.clientVisible,
              prevVisibleClientIds: row.clientVisible && previous.length > 0 ? previous : null,
            };
          }),
        });
      }
    }

    const failed = Object.keys(errors);
    return {
      message: 'Bulk visibility update completed',
      // The DEDUPED count: an id named twice is one file, and reporting it twice
      // would make `requested` disagree with `updated + failed`.
      requested: requested.length,
      updated: changed.length,
      failed,
      errors,
      clientVisible: visible,
    };
  }),
);

/**
 * DELETE /delete: soft-delete a file, or a folder and everything under it.
 *
 * The rows and their objects survive a retention window, so a delete is
 * recoverable and a legal hold still has something to hold. The sweeper destroys
 * both afterwards. The firm stops being charged now rather than at destruction:
 * nobody should pay for their own trash.
 *
 * One statement whatever the subtree holds. The old path deleted objects one at
 * a time and refused any folder larger than one scan, because a walk that
 * stopped early dropped the rows for objects it never reached.
 */
router.delete('/delete', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const { lawFirmId, matterId, taskId, clientId, fileId } = req.query;

  if (!lawFirmId) throw new ValidationError('lawFirmId is required');
  if (!fileId) throw new ValidationError('fileId is required');

  const scope = await resolveFileScope({
    lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
  });
  const row = await requireInScope(String(lawFirmId), scope, fileId);

  if (row.kind === 'folder' && !hasResolvedPermission(req, 'files.manageFolders')) {
    throw new ForbiddenError();
  }
  if (row.kind === 'file' && !hasResolvedPermission(req, 'files.delete')) {
    throw new ForbiddenError();
  }

  // Checked before the folder/file split, so deleting a folder inside a held
  // matter is refused rather than emptied one level down.
  await assertMatterNotUnderLegalHold(lawFirmId, row, 'deleted');
  if (row.kind === 'file') assertNotArchivedRecord(row, 'deleted');

  const removed = await filesRepo.softDeleteSubtree(lawFirmId, fileId, req.user.uid);

  const bytes = removed.reduce((sum: number, r: any) => sum + (r.kind === 'file' ? r.sizeBytes : 0), 0);
  if (bytes > 0) await adjustStorageUsageByDelta(lawFirmId, -bytes);
  await revokeShareLinksForFile(lawFirmId, removed.map((r: any) => r.id));

  return res.status(200).json({
    message: row.kind === 'folder' ? 'Folder deleted successfully' : 'File deleted successfully',
    deletedCount: removed.length,
  });
});

/** POST /create-folder: a folder is a row, so this is an insert. */
router.post('/create-folder', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const {
    lawFirmId, matterId, taskId, clientId, folderName, parentId, folderColor,
  } = req.body;

  if (!lawFirmId || !folderName) {
    throw new ValidationError('lawFirmId and folderName are required');
  }
  if (!isSafePathComponent(folderName)) throw new ValidationError('Invalid folderName');

  const scope = await resolveFileScope({
    lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
  });
  const parent = parentId
    ? (await requireInScope(lawFirmId, scope, parentId)).id
    : scope.rootId;

  // A duplicate name is refused by the unique index, not by a prior existence
  // check. Two people creating "Contracts" at the same moment used to both pass
  // the check, and the second marker replaced the first, taking its colour and
  // its client share state with it.
  const folder = await filesRepo.createFolder(lawFirmId, {
    parentId: parent,
    name: folderName,
    createdBy: req.user.uid,
    folderColor: folderColor || null,
    // A folder made from a task's view belongs to that task, or the task's own
    // filter hides it the moment it exists. A standalone task's root already
    // carries the tag; a matter-linked task's root is the matter's, and does not.
    ...(scope.type === 'task' || scope.filterTaskId ? { taskId: scope.taskId } : {}),
  });

  return res.status(201).json({
    message: 'Folder created successfully',
    folderId: folder.id,
    folderName: folder.name,
  });
});

/** POST /rename: one UPDATE, at any size. */
router.post('/rename', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const { lawFirmId, matterId, taskId, clientId, fileId, newName } = req.body;

  if (!lawFirmId || !fileId || !newName) {
    throw new ValidationError('lawFirmId, fileId and newName are required');
  }
  if (!isSafePathComponent(newName)) throw new ValidationError('Invalid newName');

  const scope = await resolveFileScope({
    lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
  });
  const row = await requireInScope(String(lawFirmId), scope, fileId);

  // A legal hold blocks a rename for the same reason it blocked one before: the
  // old path deleted the source object, so a held document could be relocated
  // out from under its hold. Nothing is deleted now, but the hold freezes the
  // record, and its name is part of that record.
  await assertMatterNotUnderLegalHold(lawFirmId, row, 'renamed');
  if (row.kind === 'file') assertNotArchivedRecord(row, 'renamed');

  const renamed = await filesRepo.rename(lawFirmId, fileId, newName);

  return res.status(200).json({
    message: renamed.kind === 'folder' ? 'Folder renamed successfully' : 'File renamed successfully',
    fileId: renamed.id,
    name: renamed.name,
  });
});

/** POST /move: re-parent one row. Nothing beneath it is touched. */
router.post('/move', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const {
    lawFirmId, matterId, taskId, clientId, fileId, destinationFolderId,
  } = req.body;

  if (!lawFirmId || !fileId) throw new ValidationError('lawFirmId and fileId are required');

  const scope = await resolveFileScope({
    lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
  });
  const row = await requireInScope(String(lawFirmId), scope, fileId);
  // No destination means the root of the scope, which is how the browser moves
  // something back to the top level.
  const destination = destinationFolderId
    ? (await requireInScope(lawFirmId, scope, destinationFolderId)).id
    : scope.rootId;

  await assertMatterNotUnderLegalHold(lawFirmId, row, 'moved');
  if (row.kind === 'file') assertNotArchivedRecord(row, 'moved');

  const moved = await filesRepo.move(lawFirmId, fileId, destination);

  return res.status(200).json({
    message: moved.kind === 'folder' ? 'Folder moved successfully' : 'File moved successfully',
    fileId: moved.id,
    parentId: moved.parentId,
  });
});

/** POST /update-folder-color */
router.post('/update-folder-color', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const { lawFirmId, matterId, taskId, clientId, folderId, folderColor } = req.body;

  if (!lawFirmId || !folderId) {
    throw new ValidationError('lawFirmId and folderId are required');
  }

  const scope = await resolveFileScope({
    lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
  });
  const row = await requireInScope(lawFirmId, scope, folderId);
  if (row.kind !== 'folder') throw new NotFoundError('Folder');

  await filesRepo.setColor(lawFirmId, folderId, folderColor || null);

  return res.status(200).json({ message: 'Folder color updated successfully', folderColor });
});

/**
 * DELETE /delete-task-attachment: remove one attachment from a task.
 *
 * Kept separate from `/delete` because the caller is authorized through the task
 * rather than through the file browser, and a matter-linked task attachment sits
 * in the matter tree.
 */
router.delete('/delete-task-attachment', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const { lawFirmId, taskId, fileId } = { ...req.body, ...req.query };

  if (!lawFirmId || !taskId || !fileId) {
    throw new ValidationError('lawFirmId, taskId and fileId are required');
  }

  const scope = await resolveFileScope({ lawFirmId, taskId, userId: req.user.uid, mode: MODE_WRITE });
  const row = await filesRepo.findById(lawFirmId, fileId);
  if (!row) throw new NotFoundError('File');
  // The row has to belong to THIS task. A matter-linked task files into the
  // matter tree tagged with the task, which is what the id check reads.
  if (String(row.taskId) !== String(taskId)) throw new ForbiddenError();
  if (scope.matterId && String(row.matterId) !== String(scope.matterId)) throw new ForbiddenError();

  assertNotArchivedRecord(row, 'deleted');
  await assertMatterNotUnderLegalHold(lawFirmId, row, 'deleted');

  const removed = await filesRepo.softDeleteSubtree(lawFirmId, fileId, req.user.uid);
  const bytes = removed.reduce((sum: number, r: any) => sum + (r.kind === 'file' ? r.sizeBytes : 0), 0);
  if (bytes > 0) await adjustStorageUsageByDelta(lawFirmId, -bytes);
  await revokeShareLinksForFile(lawFirmId, removed.map((r: any) => r.id));

  return res.status(200).json({ message: 'Attachment deleted' });
});

export = router;
