import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
import { handler } from '../../shared/http/handler';
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');

/** Resumable upload sessions opened at once. Caller-controlled array size. */
const UPLOAD_INIT_CONCURRENCY = Number(process.env.UPLOAD_INIT_CONCURRENCY) || 6;
/** Files finalized at once. Each is ~5 GCS/DB round trips. */
const UPLOAD_FINALIZE_CONCURRENCY = Number(process.env.UPLOAD_FINALIZE_CONCURRENCY) || 4;

const express = require('express');
const { verifyToken } = require('../../shared/middleware/auth');
const { uploadLimiter } = require('../../shared/middleware/rateLimiters');
const { AppError, ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const {
  adjustStorageUsageByDelta,
  reserveStorageUsage,
  releaseStorageReservations,
  storageLimitError,
} = require('../../shared/utils/storageUsage');
const { loadFirmPlan } = require('../../shared/plans/planEnforcement');
const { getEffectiveLimits } = require('../../shared/plans/planDefinitions');
const { findExecutableSignature } = require('../../shared/utils/uploadPolicy');
const filesRepo = require('./files.repository');
const {
  SCOPE_MATTER,
  SCOPE_TASK,
  SCOPE_CLIENT,
  SCOPE_FIRM,
  MODE_WRITE,
  resolveFileScope,
} = require('./files.scope');
const {
  BUCKET_NAME,
  bucket,
  SIGNED_URL_TTL_ATTACHMENT,
  SIGNED_URL_TTL_DEFAULT,
  dispositionFor,
  rejectUploadIfDangerous,
  assertSafePathComponent,
  formatBytes,
  safeDisplayName,
  signObject,
} = require('./files.storage');

const router = express.Router();

/**
 * The four upload contexts, and which id each one requires.
 *
 * The context is named by the caller rather than inferred from whichever id the
 * request happens to carry: an upload is a deliberate act of filing something
 * somewhere, so a request that names a matter AND a task should file where the
 * caller said, not wherever a precedence rule lands.
 */
const UPLOAD_CONTEXTS: any = {
  matter: { requires: 'matterId', message: 'Files uploaded to matter' },
  lawfirm: { requires: null, message: 'Files uploaded to law firm general folder' },
  task: { requires: 'taskId', message: 'Files uploaded to task' },
  client: { requires: 'clientId', message: 'Files uploaded to client' },
};

/**
 * Authorize an upload for a context and resolve where its objects live, plus the
 * GCS metadata and `files`-row fields to stamp on them.
 *
 * Shared by every upload route so authorization and object tagging are applied
 * in exactly one place.
 */
/**
 * Walk a relative folder path to the row it names, one level at a time from the
 * scope's root.
 *
 * Kept for callers that know where a document goes by name rather than by id.
 * Walking beats parsing: a request cannot address a folder outside the scope it
 * was authorized for, because every step starts from a row already inside it.
 */
async function resolveFolderByPath(lawFirmId: string, rootId: string, folderPath: any) {
  const segments = String(folderPath || '').split('/').map((x) => x.trim()).filter(Boolean);
  let current = rootId;
  for (const segment of segments) {
    // eslint-disable-next-line no-await-in-loop -- one level at a time, depth-bounded
    const { folders } = await filesRepo.listChildren(lawFirmId, current);
    const next = folders.find((f: any) => f.name.toLowerCase() === segment.toLowerCase());
    if (!next) throw new NotFoundError('Folder');
    current = next.id;
  }
  return current;
}

/**
 * A folder id the caller may write into: a live folder inside the scope this
 * request was already authorized for.
 *
 * Without the scope check a member authorized for one matter could name a folder
 * in another and file a document there, which is the check the prefix comparison
 * used to make.
 */
async function requireFolderInScope(lawFirmId: string, scope: any, folderId: any) {
  const row = await filesRepo.findById(lawFirmId, folderId);
  if (!row || row.kind !== 'folder') throw new NotFoundError('Folder');
  if (row.matterId !== (scope.matterId ?? null)) throw new NotFoundError('Folder');
  if (scope.type === SCOPE_CLIENT && row.clientId !== scope.clientId) throw new NotFoundError('Folder');
  if (scope.type === SCOPE_TASK && !scope.matterId && row.taskId !== scope.taskId) {
    throw new NotFoundError('Folder');
  }
  return row.id;
}

async function resolveUploadTarget({ context, lawFirmId, matterId, taskId, clientId, folder, folderId, attachmentFolder, userId }: any) {
  const definition = UPLOAD_CONTEXTS[context];
  if (!definition) throw new ValidationError('Invalid or missing upload context');

  const ids: any = { matterId, taskId, clientId };
  if (definition.requires && !ids[definition.requires]) {
    throw new ValidationError(`${definition.requires} is required for a ${context} upload`);
  }

  const scope = await resolveFileScope({
    lawFirmId,
    matterId: context === 'matter' ? matterId : null,
    taskId: context === 'task' ? taskId : null,
    clientId: context === 'client' ? clientId : null,
    userId,
    mode: MODE_WRITE,
  });

  const gcsMetadata: any = { uploadedBy: userId, lawFirmId };
  const record: any = { lawFirmId, uploadedBy: userId };

  switch (scope.type) {
    case SCOPE_MATTER:
      gcsMetadata.matterId = scope.matterId;
      record.matterId = scope.matterId;
      break;
    case SCOPE_TASK:
      gcsMetadata.taskId = scope.taskId;
      record.taskId = scope.taskId;
      // A matter-linked task files under its matter's prefix, so its objects
      // carry the matter too — that is what keeps them out of the matter's own
      // browser and inside the task's.
      if (scope.taskContext.isMatterLinked) {
        gcsMetadata.matterId = scope.matterId;
        gcsMetadata.taskTitle = scope.taskContext.taskData.title || '';
        record.matterId = scope.matterId;
      }
      break;
    case SCOPE_CLIENT:
      gcsMetadata.clientId = scope.clientId;
      record.clientId = scope.clientId;
      break;
    case SCOPE_FIRM:
      gcsMetadata.folder = 'gen';
      break;
    default:
      break;
  }

  // A folder id is the ordinary form and what the browser sends: it lists a
  // folder, so it holds the id. A relative path is walked instead, for the
  // callers that only know where a document goes by name.
  //
  // `attachmentFolder` is the third form and the narrowest: one NAME, created
  // if absent, always directly under this scope's root. Note attachments use it
  // so they land in a real folder that can be browsed, renamed and moved, which
  // a bare path segment could not be. It is deliberately not a path: treated as
  // one it would reach any folder in the firm, and the scope check above is the
  // only thing standing between a caller and another matter's documents.
  // A file in an attachment folder belongs to the RECORD that references it, not
  // to the entity whose scope authorized the upload, and on a MATTER-LINKED task
  // those differ. Its attachments file into the MATTER's tree, so tagging the row
  // with `task_id` would make the document cascade away when the task is
  // deleted, taking a note's attachment with it. The note is meant to cascade;
  // the document is meant to stay where the matter's browser lists it.
  //
  // A STANDALONE task is not the same case and must keep the tag. Its own root
  // IS the tree, and the row inherits `task_id` from that folder, so clearing it
  // here would leave the row and the authorized scope disagreeing and finalize
  // would refuse the row it had just created.
  if (attachmentFolder && scope.type === SCOPE_TASK && scope.taskContext?.isMatterLinked) {
    delete record.taskId;
    delete gcsMetadata.taskId;
    delete gcsMetadata.taskTitle;
  }

  let target;
  if (attachmentFolder) {
    const name = String(attachmentFolder);
    // One name, checked here rather than with `isSafePathComponent`, which
    // validates a relative PATH and so allows separators. A separator is
    // exactly what would turn this into a walk out of the scope root.
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) {
      throw new ValidationError('Invalid attachment folder name');
    }
    target = (await filesRepo.ensureFolder(lawFirmId, scope.rootId, name)).id;
  } else if (folderId) {
    target = await requireFolderInScope(lawFirmId, scope, folderId);
  } else if (folder) {
    target = await resolveFolderByPath(lawFirmId, scope.rootId, folder);
  } else {
    target = scope.rootId;
  }
  return { scope, folderId: target, gcsMetadata, record, message: definition.message };
}

// ===================================================================
// RESUMABLE DIRECT-TO-GCS UPLOADS (large files)
//
// These routes keep the bytes off the backend entirely, so an upload is not
// bounded by the container's memory:
//
//   1. POST /upload-init     - authorize, enforce the per-file size cap + the
//      firm storage quota, claim a row and hold a quota reservation per file,
//      and mint a resumable GCS upload URL per file. The browser then PUTs the
//      bytes straight to GCS (never through this server).
//   2. POST /upload-finalize - after the browser finishes, verify each object,
//      sniff its leading bytes for a disguised executable, stamp the row, charge
//      the bytes that actually landed and delete the reservations.
//   3. POST /upload-cancel   - the user gave up: delete the reservations and the
//      rows (and any partial objects) the upload claimed, at once.
//
// Quota: `storage_used_bytes` counts saved files only. An upload in flight holds
// its declared size as `storage_reservations` rows that lapse on their own, so
// one that is abandoned without a cancel stops blocking the firm within
// STORAGE_RESERVATION_TTL_MS. See shared/utils/storageUsage.ts.
//
// The per-file size limit comes from the firm's plan (`maxFileSizeBytes` in
// planDefinitions, overridable per firm). Because the bytes skip the backend, the
// magic-byte sniff happens at finalize
// instead (a tiny ranged read of the first 8 bytes from GCS).
// ===================================================================

/** The firm's per-file size ceiling, from its plan (overridable per firm). */
async function maxFileSizeFor(lawFirmId: string) {
  const firmData = await loadFirmPlan(lawFirmId);
  return getEffectiveLimits(firmData || {}).maxFileSizeBytes;
}

// POST /upload-init — reserve quota + mint resumable upload URLs.
router.post('/upload-init', verifyToken, uploadLimiter, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.uid;
    const lawFirmId = req.body.lawFirmId || req.query.lawFirmId;
    const { context, matterId, taskId, clientId, folder, folderId, attachmentFolder, files } = req.body || {};

    // lawFirmId is always supplied by the calling frontend code (never a
    // user-typed field), so a missing value here is a client bug, not
    // user-actionable input. A generic Error becomes a scrubbed 500.
    if (!lawFirmId) throw new Error('lawFirmId is required');
    if (!Array.isArray(files) || files.length === 0) {
      throw new ValidationError('A non-empty "files" array is required');
    }
    if (files.length > 20) throw new ValidationError('Too many files (max 20 per upload)');
    assertSafePathComponent(folder, 'folder path');

    const target = await resolveUploadTarget({
      context, lawFirmId, matterId, taskId, clientId, folder, folderId, attachmentFolder, userId,
    });

    // Validate each declared file + reject clearly-dangerous types by name/mimetype
    // (the bytes aren't here yet, so the magic-byte check happens at finalize).
    for (const f of files) {
      if (!f || typeof f.name !== 'string' || !f.name.trim()) {
        throw new ValidationError('Each file requires a name');
      }
      const size = Number(f.size);
      if (!Number.isFinite(size) || size < 0) {
        throw new ValidationError(`Invalid size for "${f.name}"`);
      }
      const typeErr = rejectUploadIfDangerous({ originalname: f.name, mimetype: f.contentType });
      if (typeErr) throw new AppError(typeErr.message, typeErr.status, typeErr.code);
    }

    const maxFileSizeBytes = await maxFileSizeFor(lawFirmId);
    const tooBig = files.find((f) => Number(f.size) > maxFileSizeBytes);
    if (tooBig) {
      const tooBigErr = new AppError(
        `"${tooBig.name}" is ${formatBytes(Number(tooBig.size))}, which exceeds the `
          + `${formatBytes(maxFileSizeBytes)} per-file limit for this plan.`,
        413,
        'FILE_TOO_LARGE'
      );
      tooBigErr.details = { maxFileSizeBytes };
      throw tooBigErr;
    }

    // Reserve every declared size before minting any URL, one reservation per
    // file, so a hard-limit firm is rejected (413) before bytes can be uploaded
    // and each upload can later release only its own hold.
    const declaredSizes = files.map((f) => Math.max(0, Number(f.size) || 0));
    const declaredTotal = declaredSizes.reduce((sum, n) => sum + n, 0);
    const reservation = await reserveStorageUsage({ lawFirmId, createdBy: userId, sizes: declaredSizes });
    if (!reservation.reserved) {
      throw storageLimitError({
        currentUsage: reservation.usedBytes + reservation.heldBytes,
        incomingSize: declaredTotal,
        quotaBytes: reservation.quotaBytes,
      });
    }
    const { reservationIds } = reservation;

    // Claim a row per file, then open a resumable session on the object each row
    // names. Release the reservations if anything throws, so a partial init
    // cannot hold quota.
    const claimedIds: string[] = [];
    try {
      const origin = req.headers.origin || undefined;
      // The ROW claims the name, and the database decides. A probe against
      // storage could not: at init time neither upload has written a byte, so
      // two callers asking for `Retainer.pdf` both saw a free path, were handed
      // the same one, and the second PUT replaced the first while both were
      // reported as uploaded. The unique index on (parent, name) has no such
      // window, and `createFile` takes the next free "(n)" when it loses.
      //
      // The row exists before the bytes do. `upload-finalize` stamps it once the
      // object lands; one that never gets there is an abandoned upload the
      // sweeper collects, and until then it is invisible to every listing.
      const resolved: any[] = [];
      for (const f of files) {
        // eslint-disable-next-line no-await-in-loop -- one insert per file, each may retry a name
        const row = await filesRepo.createFile(lawFirmId, {
          parentId: target.folderId,
          name: safeDisplayName(f.name),
          mimeType: f.contentType || 'application/octet-stream',
          uploadedBy: userId,
          ...(target.record.taskId ? { taskId: target.record.taskId } : {}),
        });
        claimedIds.push(row.id);
        resolved.push({
          row,
          contentType: f.contentType || 'application/octet-stream',
          declaredSize: Math.max(0, Number(f.size) || 0),
        });
      }

      // Opening the resumable sessions is independent per file and is pure
      // network latency, so it does not need to be serial: a 10-file upload was
      // paying roughly 10x the latency of one for no reason. Bounded rather than
      // unbounded because the array size is caller-controlled.
      const sessions = await runWithConcurrency(
        resolved.map((r) => () => bucket.file(r.row.objectPath).createResumableUpload({
          origin,
          metadata: { contentType: r.contentType, metadata: target.gcsMetadata },
        })),
        UPLOAD_INIT_CONCURRENCY,
      );
      const firstFailure = sessions.find((x: any) => x.status === 'rejected');
      if (firstFailure) throw firstFailure.reason;

      const uploads = resolved.map((r, i) => ({
        fileId: r.row.id,
        name: r.row.name,
        objectPath: r.row.objectPath,
        uploadUrl: sessions[i].value[0],
        contentType: r.contentType,
        declaredSize: r.declaredSize,
        // Echoed back to finalize or cancel, which delete it.
        reservationId: reservationIds[i],
      }));
      return res.status(200).json({ uploads });
    } catch (err) {
      await releaseStorageReservations({ lawFirmId, createdBy: userId, reservationIds })
        .catch((e: any) => console.error('upload-init: reservation release on failure failed', e));
      // The rows claimed before the failure go with the reservation. Left
      // behind, each holds its name in the folder for a day until the sweeper
      // finds it, and a retry of the same upload lands as "name (1)".
      await filesRepo.hardDelete(claimedIds).catch((e: any) =>
        console.error('upload-init: claimed row cleanup on failure failed', e));
      throw err;
    }
  } catch (error) {
    if (!(error instanceof AppError)) console.error('Upload init error:', error);
    return next(error);
  }
});

// POST /upload-finalize - verify uploaded objects, sniff bytes, charge what landed.
router.post('/upload-finalize', verifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.uid;
    const lawFirmId = req.body.lawFirmId || req.query.lawFirmId;
    const { context, matterId, taskId, clientId, attachmentFolder, uploads } = req.body || {};

    // lawFirmId is always supplied by the calling frontend code (never a
    // user-typed field), so a missing value here is a client bug, not
    // user-actionable input. A generic Error becomes a scrubbed 500.
    if (!lawFirmId) throw new Error('lawFirmId is required');
    if (!Array.isArray(uploads) || uploads.length === 0) {
      throw new ValidationError('A non-empty "uploads" array is required');
    }

    // `attachmentFolder` matters here for the record it produces, not the folder:
    // init dropped `task_id` for an attachment, so finalize has to expect a row
    // shaped the same way or it refuses its own rows as "not in this context".
    const target = await resolveUploadTarget({
      context, lawFirmId, matterId, taskId, clientId, attachmentFolder, userId,
    });

    // Per-file plan cap, re-checked against ACTUAL bytes here. Init only saw the
    // client-declared size and the resumable URL carries no size ceiling, so
    // without this a client could under-declare at init and land an oversized file.
    const maxFileSizeBytes = await maxFileSizeFor(lawFirmId);

    let landedActual = 0;

    // Each file is four sequential round trips (exists, getMetadata, a ranged
    // download for the magic-byte sniff, and signing), and they were run strictly
    // one file after another. Files are independent, so bound them instead.
    // `landedActual` is commutative addition; `results` and `failures` are
    // rebuilt in input order below so the response is unchanged.
    const settled = await runWithConcurrency(
      uploads.map((u) => async () => {
        // The row `upload-init` wrote is the authorization: it already carries
        // the scope the caller was granted, so a request naming someone else's
        // file finds nothing here rather than being checked against a prefix.
        const row = u?.fileId ? await filesRepo.findById(lawFirmId, u.fileId) : null;
        const objectPath = row?.objectPath || null;
        if (!row || row.parentId == null) {
          return { failure: { objectPath: u?.objectPath || null, error: 'Not an upload of yours' } };
        }
        // The row's own scope has to be the scope this request was authorized
        // for. The row is where it is and finalizing cannot move it, so this is
        // not about where the document ends up; it is about who gets told about
        // it. Without this, a member authorized for one matter could name a row
        // in another and be handed a signed download URL for it in the response.
        if (row.matterId !== (target.record.matterId ?? null)
          || row.taskId !== (target.record.taskId ?? null)
          || row.clientId !== (target.record.clientId ?? null)) {
          return { failure: { objectPath, error: 'Not in this context' } };
        }

        const file = bucket.file(objectPath);
        const [exists] = await file.exists();
        if (!exists) {
          // Upload never completed (abandoned/failed). It is charged nothing,
          // its reservation is deleted below with the rest, and the row it
          // claimed stays unfinalized for a cancel or the sweeper to collect.
          return { failure: { objectPath, error: 'Object was not uploaded' } };
        }

        const [meta] = await file.getMetadata();

        // Only finalize an object THIS user initiated. upload-init stamps
        // gcsMetadata.uploadedBy = the init caller, so a mismatch means the
        // caller is trying to adopt a pre-existing object in the same scope that
        // someone else uploaded, which would charge these bytes to them twice.
        // (A legitimately initiated object always carries the stamp; absence is
        // left permissive for anything written before the stamp existed.)
        if (meta.metadata?.uploadedBy && String(meta.metadata.uploadedBy) !== String(userId)) {
          return { failure: { objectPath, error: 'Object was not uploaded by you' } };
        }

        const actualSize = Number(meta.size || 0);
        const contentType = meta.contentType || u.contentType || 'application/octet-stream';

        // Enforce the per-file plan cap against the ACTUAL landed bytes: init
        // only saw the declared size, and the resumable URL carries no ceiling
        // of its own. An oversized object is deleted and fails, so it is never
        // counted and never survives past the cap.
        if (actualSize > maxFileSizeBytes) {
          await file.delete().catch((e: any) => console.error('finalize: delete of oversized object failed', objectPath, e));
          return { failure: { objectPath, error: `Rejected: ${formatBytes(actualSize)} exceeds the ${formatBytes(maxFileSizeBytes)} per-file limit for this plan.` } };
        }

        // Magic-byte sniff, the protection the multipart path does at upload
        // time. A disguised executable that slipped past the name and mimetype
        // deny-list at init is caught here, on the first 8 bytes.
        const head = await file.download({ start: 0, end: 7 })
          .then(([buf]: any[]) => buf)
          .catch(() => null);
        const signature = findExecutableSignature(head);
        if (signature) {
          await file.delete().catch((e: any) => console.error('finalize: delete of rejected object failed', objectPath, e));
          return { failure: { objectPath, error: `Rejected: file appears to be a ${signature}` } };
        }

        // Stamping the row is what makes this a document: nothing lists it
        // before this point. It is NOT best-effort. The row is the record, so a
        // stamp that cannot land has to fail the upload rather than report
        // success over a document no listing will ever show.
        const stamped = await filesRepo.finalize(lawFirmId, row.id, {
          sizeBytes: actualSize,
          mimeType: contentType,
        });

        const signedUrl = await signObject(objectPath, contentType, stamped.name, SIGNED_URL_TTL_DEFAULT);
        return {
          result: {
            fileId: stamped.id, objectPath, name: stamped.name,
            size: actualSize, contentType, signedUrl,
          },
          // Charged for the CHANGE in stored bytes, which makes a retried
          // finalize free. `previouslyCounted` comes from the stamp itself,
          // under the row lock: a retry that OVERLAPS the first call (a client
          // re-sending a slow finalize) reads the row as unfinalized in both
          // requests if the route reads it, and the document is charged twice.
          landed: actualSize - stamped.previouslyCounted,
        };
      }),
      UPLOAD_FINALIZE_CONCURRENCY,
    );

    const results = [];
    const failures = [];
    for (let i = 0; i < settled.length; i += 1) {
      const s = settled[i];
      if (s.status === 'rejected') {
        failures.push({ objectPath: uploads[i]?.objectPath || null, error: s.reason?.message || 'Finalize failed' });
        continue;
      }
      if (s.value.failure) { failures.push(s.value.failure); continue; }
      results.push(s.value.result);
      landedActual += s.value.landed;
    }

    // Charge what landed, counting only the CHANGE against each stamped row, so
    // re-finalizing an object already counted adds nothing. Nothing here is
    // refused for quota: the bytes are already stored, and a reservation that
    // lapsed while a slow upload ran does not change that. The firm may end up
    // slightly over its quota, and its next init is refused.
    //
    // Then delete the reservations the uploads name. The charge goes first so
    // the landed bytes are never counted as neither usage nor held. The delete
    // is scoped to this caller, so naming a colleague's reservation releases
    // nothing, and an id already gone is a no-op, which keeps a retry free.
    if (landedActual !== 0) await adjustStorageUsageByDelta(lawFirmId, landedActual);
    await releaseStorageReservations({
      lawFirmId, createdBy: userId, reservationIds: uploads.map((u: any) => u?.reservationId),
    });

    return res.status(201).json({
      message: 'Upload finalized',
      count: results.length,
      files: results,
      failures,
    });
  } catch (error) {
    if (!(error instanceof AppError)) console.error('Upload finalize error:', error);
    return next(error);
  }
});

// POST /upload-cancel - the user abandoned an upload: free its quota and its
// claimed names now rather than when the reservation lapses.
//
// Body: the same scope as init/finalize, plus `uploads: [{ fileId,
// reservationId }]`. Answers `{ cancelled: n }`, n being the rows removed.
//
// Nothing here can reach a document. A row is removed only when it is in this
// firm, in the scope this request was authorized for, still unfinalized, and was
// claimed by the caller; its object is the one the row names, so a caller cannot
// point the delete at anything else. A finalized row is never touched.
router.post('/upload-cancel', verifyToken, handler(async (req, res) => {
  const userId = req.user.uid;
  const lawFirmId = req.body.lawFirmId || req.query.lawFirmId;
  const { context, matterId, taskId, clientId, attachmentFolder, uploads } = req.body || {};

  if (!lawFirmId) throw new Error('lawFirmId is required');
  if (!Array.isArray(uploads) || uploads.length === 0) {
    throw new ValidationError('A non-empty "uploads" array is required');
  }
  if (uploads.length > 20) throw new ValidationError('Too many files (max 20 per upload)');

  // The same authorization init and finalize run, and the same expected row
  // shape (`attachmentFolder` drops `task_id` on a matter-linked task).
  const target = await resolveUploadTarget({
    context, lawFirmId, matterId, taskId, clientId, attachmentFolder, userId,
  });

  await releaseStorageReservations({
    lawFirmId, createdBy: userId, reservationIds: uploads.map((u: any) => u?.reservationId),
  });

  const inScope = (await filesRepo.findManyByIds(lawFirmId, uploads.map((u: any) => u?.fileId)))
    .filter((row: any) => row.parentId != null
      && row.matterId === (target.record.matterId ?? null)
      && row.taskId === (target.record.taskId ?? null)
      && row.clientId === (target.record.clientId ?? null));

  const removed = await filesRepo.deleteUnfinalizedUploads(
    lawFirmId, inScope.map((row: any) => row.id), userId,
  );

  // Best effort: a partial upload may have written some bytes, or none. An
  // object left behind here has no row naming it, so no listing reaches it and
  // it counts against nothing.
  await Promise.all(removed.map((row: any) => bucket.file(row.objectPath).delete()
    .catch((e: any) => {
      if (e?.code !== 404) console.error('upload-cancel: object delete failed', row.objectPath, e?.message);
    })));

  return res.status(200).json({ cancelled: removed.length });
}));

// ===================================================================
// NOTE / TASK ATTACHMENTS
//
// Attachments are addressed by the record that owns them (a note body, a task's
// `attachments` array) rather than browsed to, so the record keeps the user's
// original filename even when the folder listing shows a deduped one.
// ===================================================================


// Note and task attachments upload through `upload-init` / `upload-finalize`
// above, the same pair every other document uses. They had their own multipart
// routes, which held ten files at a hundred megabytes each in a 512 MiB
// container that serves eighty concurrent requests and also signs documents.
//
// Nothing was reimplemented to remove them: the pair already claimed the row,
// resolved the name and reserved the quota. It gained one option,
// `attachmentFolder`, for the folder a note attachment belongs in. A task
// attachment needs no option at all, because `context: 'task'` already resolves
// to the scope root and stamps `task_id`, which is what puts it in the task's
// view rather than the matter's.

export = Object.assign(router, { resolveUploadTarget });
