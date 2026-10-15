/**
 * Getting documents OUT of the firm's tree, without the bytes passing through
 * this process.
 *
 * Both routes here used to stream. A single-file download read the object and
 * wrote it to the response; a folder download opened a read stream per document
 * and piped all of them into one archive. Neither is a thing an API instance
 * should be doing: the transfer is the storage provider's job, and doing it here
 * puts the whole document in a 512 MiB container that is also sealing PDFs, for
 * as long as the client's connection lasts.
 *
 * So there are two shapes now, and which one a download gets depends on whether
 * anything has to be BUILT.
 *
 * A single file already exists as an object, so the answer is a signed URL: the
 * browser's download manager fetches it directly, and this process never sees a
 * byte. The URL is pinned to the object's generation, so a document replaced
 * after the caller was authorized cannot be served under it.
 *
 * A folder has to be assembled, so the answer is a JOB. The archive is a row
 * that survives the request, a worker builds it against a shared transfer
 * budget, and the finished object is handed back as the same kind of short-lived
 * signed URL. See `zipExportJobs.ts` for why the lease on that row is the part
 * that matters.
 */
const express = require('express');
const { verifyToken } = require('../../shared/middleware/auth');
const { heavyReadLimiter } = require('../../shared/middleware/rateLimiters');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { MODE_WRITE, resolveFileScope, assertFileReadAccess } = require('./files.scope');
const { MAX_ZIP_SELECTION, bucket } = require('./files.storage');
const filesRepo = require('./files.repository');

import { handler } from '../../shared/http/handler';
import {
  EXPORT_URL_TTL_MS,
  mintExportDownloadUrl,
  requestExport,
} from './zipExportJobs';

const exportRepo = require('./exportJobs.repository');

const router = express.Router();

/**
 * How long a single-file download URL lasts.
 *
 * The browser starts the transfer within seconds of being handed one, and the
 * URL needs no credential, so its lifetime is the whole of its revocation
 * story. It has to outlast the START of a large download, not the download.
 */
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;

/**
 * What a client is told about an export, and nothing more.
 *
 * The object path and the lease never leave the server: the URL is the only
 * handle anyone gets, and it expires. Reporting where the archive lives would
 * outlive every one of those limits.
 */
function formatExportJob(job: any, extra: { downloadUrl?: string; urlExpiresAt?: string } = {}) {
  const isExpired = job.status === 'succeeded' && !job.objectPath;
  return {
    id: job.id,
    status: job.status,
    attempt: job.attempt,
    entryCount: job.entryCount,
    sizeBytes: job.sizeBytes,
    isExpired,
    expiresAt: job.expiresAt,
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(extra.downloadUrl ? { downloadUrl: extra.downloadUrl, urlExpiresAt: extra.urlExpiresAt } : {}),
  };
}

/**
 * The archive's filename, from the folder it was rooted at.
 *
 * Derived at read time rather than stored: copying the folder's name onto the
 * job would be a second, staler copy of something the tree already owns, and a
 * folder renamed between the request and the download would hand back the old
 * name.
 */
async function archiveNameFor(lawFirmId: string, rootFileId: string): Promise<string> {
  const root = await filesRepo.findById(lawFirmId, rootFileId);
  // A scope ROOT carries no name (nothing renders it), so a whole-scope export
  // falls back to a generic one rather than to an empty filename.
  const base = String(root?.name || '').trim();
  if (!base) return 'files.zip';
  // A folder name is not restricted to the upload alphabet, and a quote or a
  // newline in one would mangle the Content-Disposition header or make the
  // signing call reject it outright.
  return `${base.replace(/[^a-zA-Z0-9._ -]/g, '_')}.zip`;
}

/**
 * GET /download-url?lawFirmId=…&fileId=…
 *
 * An authorized, generation-pinned URL for ONE document, for the browser's own
 * download manager to fetch.
 *
 * The generation is the whole reason this is not simply `/refresh-url` with a
 * different disposition. A URL is a bearer credential that outlives the request
 * that minted it, so it has to name the exact version the caller was authorized
 * for: a document replaced afterwards is a different document, and serving it
 * under this URL would be a disclosure nothing reports.
 */
router.get('/download-url', verifyToken, handler(async (req) => {
  const { lawFirmId, fileId } = req.query as Record<string, string>;
  if (!lawFirmId || !fileId) {
    throw new ValidationError('lawFirmId and fileId are required');
  }

  // The row carries the matter, task or client it belongs to, so the read gate
  // is a lookup rather than four parsers over an object path. A file id from
  // another firm finds nothing.
  const row = await assertFileReadAccess(lawFirmId, fileId, req.user.uid);
  if (row.kind !== 'file') throw new NotFoundError('File');

  const handle = bucket.file(row.objectPath);
  const [exists] = await handle.exists();
  if (!exists) throw new NotFoundError('File');
  const [metadata] = await handle.getMetadata();
  const generation = String(metadata.generation ?? '');
  if (!generation) throw new NotFoundError('File');

  const expires = Date.now() + DOWNLOAD_URL_TTL_MS;
  const [downloadUrl] = await bucket.file(row.objectPath, { generation }).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires,
    // Always an attachment, and deliberately NOT `dispositionFor`: that helper
    // decides between inline and attachment for a PREVIEW, and answers inline
    // for a PDF. This route exists because somebody pressed Download, so the
    // browser must save the file rather than open it. `/refresh-url` is what a
    // preview asks for.
    //
    // A name can carry a quote or a newline (only path separators and control
    // characters are stripped at upload), and either would split the header the
    // storage provider builds from this.
    responseDisposition: `attachment; filename="${String(row.name).replace(/["\r\n]/g, '_')}"`,
  });

  return {
    downloadUrl,
    name: row.name,
    sizeBytes: row.sizeBytes,
    generation,
    urlExpiresAt: new Date(expires).toISOString(),
  };
}));

/**
 * POST /export-jobs?lawFirmId=…
 *
 * Ask for a folder, or a selection, as one archive.
 *
 * Downloading a matter's documents has always required matter MEMBERSHIP rather
 * than the wider read access the listing routes grant firm owners and admins:
 * taking a copy of a matter's whole file tree is not the same act as seeing that
 * the files are there.
 *
 * The selection is resolved and filtered HERE, under this caller's access, and
 * only what survives is stored. The worker runs later and with no user, so a
 * job that stored ids to check afterwards would be checking them against
 * nobody.
 */
router.post('/export-jobs', verifyToken, heavyReadLimiter, handler(async (req) => {
  const { lawFirmId } = req.query as Record<string, string>;
  const { matterId, taskId, clientId, folderId, fileIds } = req.body || {};

  if (!lawFirmId) throw new ValidationError('lawFirmId is required');
  if (!folderId && !Array.isArray(fileIds)) {
    throw new ValidationError('folderId or fileIds is required');
  }
  if (Array.isArray(fileIds)) {
    if (fileIds.length === 0) throw new ValidationError('Select at least one item to download.');
    // Each selection can be a folder, expanded by the worker, so an unbounded
    // list is an unbounded amount of work. The ceiling sits far above any
    // selection a person can actually make.
    if (fileIds.length > MAX_ZIP_SELECTION) {
      throw new ValidationError(`Select at most ${MAX_ZIP_SELECTION} items to download at once.`);
    }
  }

  const scope = await resolveFileScope({
    lawFirmId, matterId, taskId, clientId, userId: req.user.uid, mode: MODE_WRITE,
  });

  let rootFileId = scope.rootId;
  let sourceFileIds: string[] | null = null;

  if (folderId) {
    const folder = await filesRepo.findById(lawFirmId, folderId);
    if (!folder || folder.kind !== 'folder' || folder.scope !== scope.type) {
      throw new NotFoundError('Folder');
    }
    if (scope.matterId && String(folder.matterId) !== String(scope.matterId)) {
      throw new NotFoundError('Folder');
    }
    if (scope.taskId && String(folder.taskId) !== String(scope.taskId)) throw new NotFoundError('Folder');
    if (scope.clientId && String(folder.clientId) !== String(scope.clientId)) throw new NotFoundError('Folder');
    rootFileId = folder.id;
  } else {
    // The rows decide what is in scope. A file id belonging to another matter
    // resolves to a row this scope does not own and is dropped. One query for
    // the whole selection: it may name thousands of items.
    const rows = await filesRepo.findManyByIds(lawFirmId, fileIds);
    const byId = new Map(rows.map((row: any) => [row.id, row]));
    const kept: string[] = [];
    for (const id of fileIds) {
      const row: any = byId.get(id);
      if (!row || row.scope !== scope.type) continue;
      if (scope.matterId && String(row.matterId) !== String(scope.matterId)) continue;
      if (scope.taskId && String(row.taskId) !== String(scope.taskId)) continue;
      if (scope.clientId && String(row.clientId) !== String(scope.clientId)) continue;
      kept.push(row.id);
    }
    if (kept.length === 0) throw new NotFoundError('Nothing to download');
    sourceFileIds = kept;
  }

  const job = await requestExport({
    lawFirmId, requestedBy: req.user.uid, rootFileId, sourceFileIds,
  });
  if (!job) throw new NotFoundError('Export');

  return {
    message: 'Export job created successfully',
    exportJobId: job.id,
    exportJob: formatExportJob(job),
  };
}, 201));

/**
 * GET /export-job?lawFirmId=…&jobId=…
 *
 * Where an export has got to, and the URL once it lands.
 *
 * Scoped to the REQUESTER, not to the firm. The archive's contents were decided
 * by what that person could read at the moment they asked, so handing it to a
 * colleague would hand them a selection nobody checked against their access.
 *
 * This route does not start the work. Firing a build off in the background here
 * would leave an archive running after the response was sent, holding a
 * database connection and the instance's transfer slot for a request that has
 * already finished, and Cloud Run stops scheduling CPU at that point anyway so
 * it would not reliably finish. The scheduled drain owns the queue.
 */
router.get('/export-job', verifyToken, handler(async (req) => {
  const { lawFirmId, jobId } = req.query as Record<string, string>;
  if (!lawFirmId || !jobId) throw new ValidationError('lawFirmId and jobId are required');

  const job = await exportRepo.getExportJob(lawFirmId, jobId);
  if (!job || job.requestedBy !== req.user.uid) throw new NotFoundError('Export');

  if (job.status !== 'succeeded' || !job.objectPath) {
    return { exportJob: formatExportJob(job) };
  }

  const minted = await mintExportDownloadUrl(job, await archiveNameFor(lawFirmId, job.rootFileId));
  return {
    exportJob: formatExportJob(job, {
      downloadUrl: minted?.url,
      urlExpiresAt: minted?.expiresAt ?? new Date(Date.now() + EXPORT_URL_TTL_MS).toISOString(),
    }),
  };
}));

/**
 * POST /export-job-cancel?lawFirmId=…&jobId=…
 *
 * Stop an export somebody no longer wants.
 *
 * Cancelling CLEARS the lease token rather than recording an intent. That is
 * what acts on a worker already inside the archive: the publish it is about to
 * attempt no longer matches anything, so it discards what it built instead of
 * charging the firm for an archive nobody will fetch.
 */
router.post('/export-job-cancel', verifyToken, handler(async (req) => {
  const { lawFirmId, jobId } = req.query as Record<string, string>;
  if (!lawFirmId || !jobId) throw new ValidationError('lawFirmId and jobId are required');

  const job = await exportRepo.getExportJob(lawFirmId, jobId);
  if (!job || job.requestedBy !== req.user.uid) throw new NotFoundError('Export');

  await exportRepo.cancelExportJobs(lawFirmId, { jobId: job.id, requestedBy: req.user.uid });
  return { message: 'Export job cancelled successfully', exportJobId: job.id };
}));

export = router;
