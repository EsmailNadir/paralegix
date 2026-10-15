const express = require('express');
const filesRepo = require('../files/files.repository');
const crypto = require('crypto');
const repo = require('./signatures.repository');
const { verifyToken, requireUserType } = require('../../shared/middleware/auth');
const { requirePermissionFrom } = require('../lawfirms/roles/requirePermission');
const { requireFeature } = require('../../shared/plans/requireFeature');
const { assertMatterReadAccess } = require('../../shared/utils/membership');
const { AppError, NotFoundError, ForbiddenError, ValidationError } = require('../../shared/errors/AppError');
const { admitStoredUpload, pdfDisplayName, SourceRefused } = require('./signingSources');
const { runJobNow } = require('./signingJobs');
require('./signingFinalize');
const { mintPreviewReadUrl } = require('./signingDownloads');
const { uploadLimiter, documentConvertLimiter } = require('../../shared/middleware/rateLimiters');
import { beginDirectUpload, settleDirectUpload } from '../../shared/storage/directUpload';
import { consumeScratchSource } from '../../shared/documentConversion/scratchSource';
const { signingUploadInitSchema, signingUploadFinalizeSchema, SIGNING_MAX_FILE_BYTES, SIGNING_MAX_FILE_LABEL, signingConversionCapBytes, signingConversionTooLargeMessage, SIGNING_INLINE_PREPARE_BYTES } = require('./signing.validation');
const { validate } = require('../../shared/middleware/validate');
const { isPdfFileName, toPdfFileName } = require('./signingSessions');
const { isSystemObjectPath } = require('../../shared/storage/recordArchive');
const { findExecutableSignature } = require('../../shared/utils/uploadPolicy');
const { signingUploadPath, signingUploadPrefix } = require('./signingWorkspace');
import { handler } from '../../shared/http/handler';
import { bucket, normalizeStoragePath, canViewSignatureSession, SIGNABLE_UPLOAD_EXTENSIONS } from './signingRouteSupport';

const router = express.Router();

// POST /api/signing/convert-upload-init
// Non-PDF signing sources use the same direct-upload shape as PDFs. LibreOffice
// later reads the temporary object from storage, so the API never buffers it.
router.post('/convert-upload-init',
  verifyToken,
  requireUserType(['firm_member']),
  uploadLimiter,
  requirePermissionFrom((req: any) => req.body?.lawFirmId, 'signatures.send'),
  requireFeature('documentSigning', (req: any) => req.body?.lawFirmId),
  documentConvertLimiter,
  handler(async (req) => {
    const lawFirmId = String(req.body?.lawFirmId || '');
    const fileName = String(req.body?.name || '');
    const lowerName = fileName.toLowerCase();
    if (!lawFirmId || !SIGNABLE_UPLOAD_EXTENSIONS.some((ext) => lowerName.endsWith(ext)) || isPdfFileName(fileName)) {
      throw new ValidationError(
        `Unsupported file format. Supported: ${SIGNABLE_UPLOAD_EXTENSIONS.filter((ext) => ext !== '.pdf').join(', ')}`,
      );
    }
    const uniqueId = crypto.randomBytes(12).toString('hex');
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectPath = signingUploadPath(lawFirmId, uniqueId, `source-${safeName}`);
    return beginDirectUpload({
      objectPath,
      contentType: String(req.body?.contentType || 'application/octet-stream'),
      uploadedBy: req.user.uid,
      maxBytes: signingConversionCapBytes(),
      tooLargeMessage: signingConversionTooLargeMessage,
      fileName,
      declaredSize: Number(req.body?.size) || undefined,
      origin: req.get('origin') || undefined,
      metadata: { lawFirmId, convertingForSigning: 'true', originalFileName: fileName },
    });
  })
);

// POST /api/signing/convert-upload-finalize
router.post('/convert-upload-finalize',
  verifyToken,
  requireUserType(['firm_member']),
  requirePermissionFrom((req: any) => req.body?.lawFirmId, 'signatures.send'),
  requireFeature('documentSigning', (req: any) => req.body?.lawFirmId),
  documentConvertLimiter,
  handler(async (req) => {
    const lawFirmId = String(req.body?.lawFirmId || '');
    const fileName = String(req.body?.name || '');
    const objectPath = normalizeStoragePath(req.body?.objectPath);
    if (!lawFirmId || !objectPath.startsWith(signingUploadPrefix(lawFirmId)) || !objectPath.includes('/source-')) {
      throw new ValidationError('That upload does not belong to this signing request.');
    }

    // The source is scratch and is deleted however this ends, with one
    // exception: a refusal because the converter is busy. That 503 invites a
    // retry of this same request, which needs the upload still in place. If the
    // retry never comes, the daily `signing-uploads/` sweep collects it.
    return consumeScratchSource(() => bucket.file(objectPath).delete(), async () => {
      const settled = await settleDirectUpload({
        objectPath,
        uploadedBy: req.user.uid,
        maxBytes: signingConversionCapBytes(),
        tooLargeMessage: signingConversionTooLargeMessage,
        fileName,
      });
      const converted = await require('./signatures.service').convertStoredDocument({
        sourceObjectPath: objectPath,
        outputFormat: 'pdf',
        inputFilename: fileName,
        sourceBytes: settled.size,
      });
      const pdfName = toPdfFileName(fileName);
      const finalPath = signingUploadPath(
        lawFirmId,
        crypto.randomBytes(12).toString('hex'),
        pdfName.replace(/[^a-zA-Z0-9._-]/g, '_'),
      );
      try {
        await bucket.file(converted.objectPath).copy(bucket.file(finalPath), {
          preconditionOpts: { ifGenerationMatch: 0 },
          sourceGeneration: converted.generation,
          contentType: 'application/pdf',
          metadata: {
            uploadedBy: req.user.uid,
            originalFileName: fileName,
            convertedToPdf: 'true',
            lawFirmId,
          },
        });
      } finally {
        await converted.cleanup().catch(() => {});
      }
      try {
        // A conversion is another source boundary, not an exception to one.
        // The worker's PDF must pass the same structural admission as a PDF the
        // browser uploaded directly before any signing flow can reach it.
        await admitStoredUpload({
          lawFirmId,
          uploadedBy: req.user.uid,
          objectPath: finalPath,
          declaredSizeBytes: null,
          maxSizeBytes: SIGNING_MAX_FILE_BYTES,
        });
      } catch (error) {
        await bucket.file(finalPath).delete().catch(() => {});
        throw error;
      }
      return { objectPath: finalPath, fileName: pdfName };
    });
  })
);

// POST /api/signing/upload-init (authenticated, opens a resumable GCS session for a PDF to be sent for signing)
//
// The browser PUTs the bytes straight into `signing-uploads/{firm}/{id}/` on a
// session this route opens, and /upload-finalize below vouches for what landed.
// The route that took a PDF through this container instead is gone: Cloud Run
// caps any request at 32 MiB, so a 40 MB scanned contract could never be sent
// for signature that way. The prefix and the `uploadedBy` stamp are unchanged,
// so everything downstream (preview, prepare, re-send, save-as-template) is
// unchanged with them.
//
// PDFs use this route. Non-PDFs use convert-upload-init, then the converter
// reads their temporary object from storage rather than an API request body.
router.post('/upload-init',
  verifyToken,
  requireUserType(['firm_member']),
  uploadLimiter,
  validate(signingUploadInitSchema),
  requirePermissionFrom((req: any) => req.body?.lawFirmId, 'signatures.send'),
  requireFeature('documentSigning', (req: any) => req.body?.lawFirmId),
  handler(async (req) => {
    const { lawFirmId, name, size } = req.body;

    // A PDF may arrive without an extension: a scanner names its output "scan",
    // and the browser routes by MIME type. Refusing by NAME alone meant such a
    // file could not be signed at all, because the browser had already chosen
    // the direct route and did not fall back. Accept either signal here and
    // normalize the name, and let finalize's leading-byte sniff be what
    // actually decides: a declared content type is a hint, never proof.
    const declaredPdf = String(req.body.contentType || '') === 'application/pdf';
    if (!isPdfFileName(name) && !declaredPdf) {
      throw new ValidationError(
        'Only a PDF can be uploaded directly. Other formats are converted on upload.',
      );
    }
    // Stored and reported with a .pdf extension so every reader, viewer and
    // download downstream sees the type they already assume from this prefix.
    const pdfName = isPdfFileName(name) ? name : toPdfFileName(name);
    if (Number(size) > SIGNING_MAX_FILE_BYTES) {
      const err = new AppError(
        `"${name}" is larger than the ${SIGNING_MAX_FILE_LABEL} limit for a document sent for signature.`,
        413,
        'FILE_TOO_LARGE',
      );
      err.details = { maxFileSizeBytes: SIGNING_MAX_FILE_BYTES };
      throw err;
    }

    const uniqueId = crypto.randomBytes(12).toString('hex');
    const safeName = String(pdfName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectPath = signingUploadPath(lawFirmId, uniqueId, safeName);

    const [uploadUrl] = await bucket.file(objectPath).createResumableUpload({
      origin: req.headers.origin || undefined,
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          uploadedBy: req.user.uid,
          originalFileName: pdfName,
          convertedToPdf: 'false',
          lawFirmId,
        },
      },
    });

    return { objectPath, fileName: pdfName, uploadUrl };
  }),
);

// POST /api/signing/upload-finalize (authenticated, vouches for a PDF the browser PUT to storage)
//
// Between init and here the server knows nothing: the session URL carries no
// size ceiling and the bytes never passed through this process. So the only
// facts worth checking are the ones storage reports back, and each check below
// closes a way to get the wrong document in front of a signer: the path must be
// this firm's transient prefix (a firm document reaches signing through
// /signature-links/prepare, which checks matter membership, and this must not be
// a way around it), the object must carry THIS caller's stamp, it must be a PDF
// by its leading bytes rather than its name, and it must not have landed past
// the cap the declaration promised.
router.post('/upload-finalize',
  verifyToken,
  requireUserType(['firm_member']),
  validate(signingUploadFinalizeSchema),
  requirePermissionFrom((req: any) => req.body?.lawFirmId, 'signatures.send'),
  requireFeature('documentSigning', (req: any) => req.body?.lawFirmId),
  handler(async (req, res) => {
    const { lawFirmId } = req.body;
    const objectPath = String(req.body.objectPath);

    if (!objectPath.startsWith(signingUploadPrefix(lawFirmId))) {
      throw new NotFoundError('Upload');
    }

    const file = bucket.file(objectPath);
    const [exists] = await file.exists();
    if (!exists) throw new NotFoundError('Upload');

    const [meta] = await file.getMetadata();
    if (String(meta.metadata?.uploadedBy || '') !== String(req.user.uid)) {
      throw new ForbiddenError('You do not have access to this uploaded document');
    }

    // Admission is a ROW, not a code path here. Every route that can put a
    // document in front of a signer goes through the same boundary, so a new
    // entry point cannot quietly skip the structural checks the way the
    // template route once did.
    let source;
    try {
      source = await admitStoredUpload({
        lawFirmId,
        uploadedBy: req.user.uid,
        objectPath,
        declaredSizeBytes: null,
        maxSizeBytes: SIGNING_MAX_FILE_BYTES,
      });
    } catch (err: any) {
      if (err instanceof SourceRefused) {
        // Read the leading bytes BEFORE deleting them. Naming the format the
        // file actually is tells the user they picked the wrong file rather
        // than that the service is broken, and after the delete there is
        // nothing left to name it from.
        const [head] = err.refusalCode === 'PDF_INVALID'
          ? await file.download({ start: 0, end: 7 }).catch(() => [Buffer.alloc(0)])
          : [Buffer.alloc(0)];

        // A refused upload is transient scratch nobody can use. Left behind it
        // is billed storage under a path the firm cannot see or delete.
        await file.delete().catch((e: any) =>
          console.error('[signing] delete of refused upload failed', objectPath, e?.message));

        if (err.refusalCode === 'FILE_TOO_LARGE') {
          const tooLarge: any = new AppError(
            `The uploaded file is larger than the ${SIGNING_MAX_FILE_LABEL} limit for a document sent for signature.`,
            413,
            'FILE_TOO_LARGE',
          );
          tooLarge.details = { maxFileSizeBytes: SIGNING_MAX_FILE_BYTES };
          throw tooLarge;
        }
        if (err.refusalCode === 'PDF_INVALID') {
          const executable = findExecutableSignature(head);
          throw new ValidationError(
            executable
              ? `Rejected: file appears to be a ${executable}`
              : 'The uploaded file is not a PDF.',
          );
        }
      }
      throw err;
    }

    // Admission committed a preparation job. Running it HERE is only an
    // optimization: hashing a small document while someone waits beats waiting
    // for a scheduler to notice. If this process dies now, the job is still owed
    // and the drain picks it up, which is the whole reason it is a row.
    //
    // It claims through the same lease as the drain, so the two cannot both be
    // inside one job. A claim that loses simply reports `preparing`.
    //
    // Past the inline threshold it is NOT run here. Hashing a multi-gigabyte
    // document behind an interactive request means the request times out, the
    // caller sees a failure, and the work carries on invisibly until the
    // instance is killed. The client polls `/signing/source/:sourceId` instead.
    const inlineEligible = Number(source.sizeBytes || 0) <= SIGNING_INLINE_PREPARE_BYTES;
    if (source.jobId && inlineEligible) {
      await runJobNow(lawFirmId, source.jobId, `request:${req.id || process.pid}`);
    }
    const prepared = await repo.getSource(lawFirmId, source.id);
    if (prepared.status === 'failed' && prepared.failureCode) {
      throw new SourceRefused(prepared.failureCode, prepared.failureDetail || undefined);
    }

    // `originalFileName` is the record of what the user called it. An object
    // path is opaque, so there is nothing else to read: its last segment is a
    // sanitised copy at best and a uuid elsewhere in the app.
    const fileName = pdfDisplayName(String(meta.metadata?.originalFileName || 'document.pdf'));
    const body = {
      objectPath,
      fileName,
      sourceId: prepared.id,
      status: prepared.status,
      generation: prepared.preparedGeneration,
      // Present while the work is still owed, so a client can poll rather than
      // guess how long to wait.
      jobId: prepared.status === 'ready' ? null : source.jobId,
    };
    // 202 when the work is still owed, so a client can tell "ready to send" from
    // "ask again shortly" without parsing a status string. Written here rather
    // than returned, because the wrapper fixes one status for the whole route.
    if (prepared.status !== 'ready') {
      res.status(202).json(body);
      return null;
    }
    return body;
  }),
);

// GET /api/signing/source/:sourceId (authenticated, reports whether an admitted
// document is ready to be sent for signature)
//
// Preparation hashes the whole source, which for a large document does not fit
// inside an interactive request. The client polls this instead of holding a
// connection open, and a refusal arrives here with the same stable code the
// finalize route would have returned.
router.get('/source/:sourceId',
  verifyToken,
  requireUserType(['firm_member']),
  requirePermissionFrom((req: any) => req.query?.lawFirmId, 'signatures.send'),
  handler(async (req) => {
    const lawFirmId = String(req.query.lawFirmId || '');
    const source = await repo.getSource(lawFirmId, req.params.sourceId);
    if (!source) throw new NotFoundError('Upload');
    if (String(source.uploadedBy || '') !== String(req.user.uid)) {
      throw new ForbiddenError('You do not have access to this uploaded document');
    }
    return {
      sourceId: source.id,
      status: source.status,
      pageCount: source.pageCount,
      failureCode: source.failureCode,
      generation: source.preparedGeneration,
    };
  }),
);

// GET /api/signing/preview-url (authenticated, mints a short-lived read url for
// a signing upload or a firm document, no session needed)
//
// This used to stream the object through the API. A document large enough to be
// worth previewing is a document large enough to be worth not holding, and the
// viewer reads ranges from a url on its own.
router.get('/preview-url', verifyToken, handler(async (req, res) => {
  const objectPath = normalizeStoragePath(req.query.objectPath);
  const lawFirmId = typeof req.query.lawFirmId === 'string' ? req.query.lawFirmId.trim() : '';

  if (!objectPath) {
    throw new ValidationError('Invalid object path');
  }

  // Preserved records and open sessions' scratch copies carry no uuid segment,
  // so the matter check below never fires for them and `signatures.view` alone
  // would stream a walled matter's executed document, its certificate, or a
  // half-signed working copy. Those have their own routes, which authorize
  // through the owning session. Nothing reaches them through a preview.
  if (isSystemObjectPath(objectPath)) {
    throw new NotFoundError('File');
  }

  let allowed = false;
  // What the object is called, from whatever recorded it: the upload stamp for a
  // signing upload, the `files` row for a firm document. Never from the path.
  let displayName = '';
  if (objectPath.startsWith('signing-uploads/')) {
    const [metadata] = await bucket.file(objectPath).getMetadata().catch(() => [null]);
    displayName = String(metadata?.metadata?.originalFileName || '');
    const uploadedBy =
      metadata?.metadata?.uploadedBy ||
      (metadata?.metadata as any)?.metadata?.uploadedBy ||
      (metadata as any)?.uploadedBy;
    allowed = Boolean(uploadedBy && uploadedBy === req.user.uid);

    if (!allowed) {
      // Scoped to the firm the REQUEST states. The firm id used to be read out
      // of the path's second segment, which made an opaque string an
      // authorization input; a request that names no firm is simply refused.
      if (lawFirmId) {
        const source = await repo.getSourceByObjectPath(lawFirmId, objectPath).catch(() => null);
        if (source && source.uploadedBy === req.user.uid) {
          allowed = true;
        }
      }
    }
  } else if (lawFirmId && objectPath.startsWith(`lawfirmids/${lawFirmId}/`)) {
    allowed = await canViewSignatureSession(lawFirmId, req.user.uid);
    // Matter-scoped files also require matter read access (same ACL the files
    // module enforces); otherwise a signatures.view holder who cannot read the
    // matter could stream a confidential matter document through this endpoint.
    if (allowed) {
      const row = await filesRepo.findByObjectPath(lawFirmId, objectPath, { includeDeleted: true })
        .catch(() => null);
      displayName = String(row?.name || '');
      const matterId = row?.matterId || null;
      if (matterId) {
        allowed = await assertMatterReadAccess(lawFirmId, matterId, req.user.uid)
          .then(() => true).catch(() => false);
      }
    }
  }

  if (!allowed) {
    throw new ForbiddenError('Access denied');
  }

  const read = await mintPreviewReadUrl({
    objectPath,
    fileName: displayName || 'document.pdf',
  });
  return res.json({
    url: read.url,
    fileName: read.fileName,
    contentType: read.contentType,
    sizeBytes: read.sizeBytes,
    generation: read.generation,
    expiresAt: read.expiresAt,
  });
}));

export = router;
