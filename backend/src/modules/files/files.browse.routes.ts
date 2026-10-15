import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
const express = require('express');
const { verifyToken } = require('../../shared/middleware/auth');
const { heavyReadLimiter } = require('../../shared/middleware/rateLimiters');
const { AppError, NotFoundError, ForbiddenError, ValidationError } = require('../../shared/errors/AppError');
const { assertLawFirmMembership, assertMatterReadAccess } = require('../../shared/utils/membership');
const { getLawFirmStorageSettings } = require('../../shared/utils/storageUsage');
const { isTransientError } = require('../../shared/utils/retryTransient');
const { isSystemObjectPath } = require('../../shared/storage/recordArchive');
const {
  MODE_READ,
  resolveFileScope,
  resolveReadableMatterIds,
  assertFileReadAccess,
} = require('./files.scope');
const { validate } = require('../../shared/middleware/validate');
const { listClientTaskFilesSchema, listFilesForMattersSchema } = require('./files.validation');
import { handler } from '../../shared/http/handler';
const {
  SIGNED_URL_TTL_DEFAULT,
  formatBytes,
  signObject,
} = require('./files.storage');
const filesRepo = require('./files.repository');
const {
  listScopeRoot,
  listScopeRootsForMatters,
  listFolder,
  searchScope,
} = require('./files.readers');

const router = express.Router();

/**
 * GET /list?lawFirmId=…&matterId=…
 *
 * Everything under a matter's prefix (or the firm's General Files when no matter
 * is named), flattened to one level. Superseded by `/list-folder` for browsing;
 * kept for the callers that read a whole scope.
 *
 * One page per response. `cursor` from a previous response continues the walk,
 * and `truncated` says another page exists. A caller that ignores both gets the
 * first page, which is what the old unpaged response returned for every folder
 * small enough to matter.
 */
// Same recursive prefix scan `/list-folder` does, so it carries the same limiter.
router.get('/list', verifyToken, heavyReadLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId, matterId } = req.query;
    if (!lawFirmId) throw new ValidationError('lawFirmId is required');

    // Deliberately narrower than `/list-folder`: this endpoint has only ever
    // addressed a matter or the firm's general folder.
    const scope = await resolveFileScope({
      lawFirmId, matterId, userId: req.user.uid, mode: MODE_READ,
    });

    const { files, cursor, truncated } = await listScopeRoot({
      lawFirmId, scope, limit: req.query.limit, cursor: req.query.cursor ?? null,
    });
    return res.status(200).json({
      rootId: scope.rootId, count: files.length, files, truncated, cursor,
    });
  } catch (error: any) {
    if (!(error instanceof AppError)) console.error('List error:', error);
    return next(error);
  }
});

/**
 * GET /list-matters?matterIds=a,b,c
 *
 * The first page of SEVERAL matters' documents in one request, as
 * `{ filesByMatterId: { [matterId]: { files, truncated } } }`.
 *
 * WHY IT EXISTS. `/list` answers for one matter, so a page holding a list of
 * matters (the client detail page's Files tab) called it once per matter the
 * moment the tab opened, unbounded. Every instance shares one 12-connection pool
 * against a session pooler that allows 15, so a corporate client with eighty
 * matters could hold the whole pool on its own and leave every other user
 * queued behind it.
 *
 * Same rows, same permission and the same matter-level wall `/list` applies, in
 * a constant number of queries. A matter the caller may not read is ABSENT from
 * the map; a matter they may read that holds no documents is present and empty.
 * Absent rather than refused because a batch names matters the caller merely
 * holds a list of, and one walled-off matter must not fail the other seventy.
 *
 * The cap on `matterIds` is enforced by `validate`, so an over-long list is
 * refused before this handler and therefore before any read.
 */
// Recursive, like `/list` and `/list-folder`, so it carries the same limiter.
router.get('/list-matters',
  verifyToken,
  heavyReadLimiter,
  validate(listFilesForMattersSchema),
  handler(async (req) => {
    const lawFirmId = String(req.query.lawFirmId);
    await assertLawFirmMembership(lawFirmId, req.user.uid);

    // `validate` writes the schema's transform back onto the query, so this is
    // the split and capped array, not the raw comma-separated string.
    const requested = [...new Set(req.query.matterIds as unknown as string[])];
    const readable = await resolveReadableMatterIds(lawFirmId, req.user.uid, requested);
    const visible = requested.filter((id) => readable.has(id));
    if (!visible.length) return { filesByMatterId: {} };

    // No caller-supplied page size, unlike `/list`. The id count already
    // multiplies the response, so a second caller-controlled multiplier on top
    // of it is how one request asks for every document the firm owns. Each
    // matter gets the same default page `/list` gives it.
    return {
      filesByMatterId: await listScopeRootsForMatters({ lawFirmId, matterIds: visible }),
    };
  }),
);

/**
 * GET /list-client-tasks?clientId=…
 *
 * The standalone tasks attached to a client that hold files, as
 * `{ tasks: [{ id, title, fileCount }] }`. The client detail page lists them as
 * folders beside the client's matters: a task with no matter keeps its
 * documents in its own tree, which nothing else on that page reaches.
 *
 * Firm membership and `files.view` are the whole gate, the same one
 * `resolveTaskContext` applies to a standalone task's files: such a task is
 * visible to every member of the firm.
 */
router.get('/list-client-tasks',
  verifyToken,
  validate(listClientTaskFilesSchema),
  handler(async (req) => {
    const lawFirmId = String(req.query.lawFirmId);
    await assertLawFirmMembership(lawFirmId, req.user.uid);
    return {
      tasks: await filesRepo.listClientTaskFileCounts(lawFirmId, String(req.query.clientId)),
    };
  }),
);

// LIST FOLDER ENDPOINT
router.get('/list-folder', verifyToken, heavyReadLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId, matterId, taskId, clientId, folderId } = req.query;

    if (!lawFirmId) throw new ValidationError('lawFirmId is required');

    const scope = await resolveFileScope({
      lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_READ,
    });

    const { folderId: listedId, files, truncated } = await listFolder({
      lawFirmId, scope, folderId: folderId || null,
    });

    // Whether the listed folder inherits a share from itself or an ancestor, so
    // the firm side can show the files inside a shared folder as visible. One
    // walk up the parent chain, rather than one storage call per ancestor.
    const chain = await filesRepo.ancestors(lawFirmId, listedId);
    const self = await filesRepo.findById(lawFirmId, listedId);
    const inheritedClientVisible = [...chain, self]
      .some((row: any) => row && row.clientVisible === true);

    // The breadcrumb. The browser used to build this by splitting a path.
    const breadcrumb = chain.slice(1).map((row: any) => ({ id: row.id, name: row.name }));
    if (self && self.parentId) breadcrumb.push({ id: self.id, name: self.name });

    return res.status(200).json({
      folderId: listedId,
      breadcrumb,
      count: files.length,
      files,
      inheritedClientVisible,
      truncated,
    });
  } catch (error: any) {
    if (!(error instanceof AppError)) console.error('List folder error:', error);
    return next(error);
  }
});

// SEARCH ENDPOINT - Recursively search all files and folders
router.get('/search', verifyToken, heavyReadLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId, matterId, taskId, clientId, query } = req.query;
    if (!lawFirmId || !query) throw new ValidationError('lawFirmId and query are required');

    // Search resolves its scope exactly the way `/list-folder` does. It used to
    // understand only `matterId`, so searching from a task's or a client's file
    // view fell through to the firm's General Files: the box sat above the task's
    // documents and answered with somebody else's.
    const scope = await resolveFileScope({
      lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_READ,
    });

    const { files, truncated } = await searchScope({ lawFirmId, scope, query });
    return res.status(200).json({ query, count: files.length, files, truncated });
  } catch (error: any) {
    if (!(error instanceof AppError)) console.error('Search error:', error);
    return next(error);
  }
});


// GET FRESH SIGNED URL FOR A FILE (e.g. expired note attachments)
router.get('/refresh-url', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId, fileId } = req.query;

    if (!lawFirmId || !fileId) {
      throw new ValidationError('lawFirmId and fileId are required');
    }

    // The row carries the matter, task or client it belongs to, so the read gate
    // is a lookup rather than four parsers over an object path. A file id from
    // another firm finds nothing.
    const row = await assertFileReadAccess(lawFirmId, fileId, req.user.uid);

    const signedUrl = await signObject(
      row.objectPath, row.mimeType, row.name, SIGNED_URL_TTL_DEFAULT,
    );

    return res.status(200).json({ signedUrl, name: row.name });
  } catch (error: any) {
    if (!(error instanceof AppError)) console.error('Refresh URL error:', error);
    return next(error);
  }
});

/**
 * Where one document sits: which scope owns it, and the folders above it.
 *
 * "Reveal this file" is what needs it. A surface that holds only a file id (a
 * document request's fulfillment, a note's linked document, a search result
 * opened from elsewhere) has to move the file browser to the folder the document
 * is in before it can flash the row. That used to be a string slice on the
 * object path, which is exactly the coupling the tree removed: the path says
 * nothing about the tree any more.
 */
router.get('/location', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId, fileId } = req.query;
    if (!lawFirmId || !fileId) {
      throw new ValidationError('lawFirmId and fileId are required');
    }

    // The same read gate the download path applies: a document a caller cannot
    // read must not have its location described to them either, or the folder
    // names alone leak how a walled-off matter is organised.
    const row = await assertFileReadAccess(lawFirmId, fileId, req.user.uid);
    const chain = await filesRepo.ancestors(lawFirmId, row.id);

    return res.status(200).json({
      fileId: row.id,
      name: row.name,
      isFolder: row.kind === 'folder',
      scope: row.scope,
      matterId: row.matterId,
      taskId: row.taskId,
      clientId: row.clientId,
      // The root is not a crumb: it is the scope itself, and nothing renders it
      // as a folder.
      trail: chain.slice(1).map((a: any) => ({ id: a.id, name: a.name })),
    });
  } catch (error: any) {
    if (!(error instanceof AppError)) console.error('File location error:', error);
    return next(error);
  }
});

// GET STORAGE USAGE FOR A LAW FIRM
router.get('/usage', verifyToken, heavyReadLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { lawFirmId } = req.query;
    if (!lawFirmId) throw new ValidationError('lawFirmId is required');

    await assertLawFirmMembership(lawFirmId, req.user.uid);

    const storage = await getLawFirmStorageSettings(lawFirmId);
    // One indexed sum over the firm's live rows. This used to walk every object
    // the firm owned, which grew with their document count on a page people open
    // constantly, so it was cached for six hours and reconciled in the
    // background. There is nothing to reconcile: the rows ARE the usage.
    const { bytes, count } = await filesRepo.sumFinalizedBytes(lawFirmId);

    return res.status(200).json({
      usedBytes: bytes,
      limitBytes: storage.quotaBytes,
      warnAtPercent: storage.warnAtPercent,
      hardLimit: storage.hardLimit,
      fileCount: count,
      usedFormatted: formatBytes(bytes),
      limitFormatted: formatBytes(storage.quotaBytes),
      percentUsed: storage.quotaBytes > 0
        ? Math.min(100, Math.round((bytes / storage.quotaBytes) * 100))
        : 0,
      stale: false,
    });
  } catch (error: any) {
    if (!(error instanceof AppError)) console.error('Storage usage error:', error);
    return next(error);
  }
});

export = router;
