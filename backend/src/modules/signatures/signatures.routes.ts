import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
const express = require('express');
const {
  assertConvertibleUpload,
  assertConvertibleRun,
} = require('./signatures.validation');
const { FORMAT_MAP, convertStoredDocument } = require('./signatures.service');
const { verifyToken } = require('../../shared/middleware/auth');
const { documentConvertLimiter } = require('../../shared/middleware/rateLimiters');
const { ValidationError } = require('../../shared/errors/AppError');
const { formatBytes } = require('../../shared/utils/storageUsage');
import { beginDirectUpload } from '../../shared/storage/directUpload';
import { consumeScratchSource } from '../../shared/documentConversion/scratchSource';
import { randomUUID } from 'crypto';

const { admin } = require('../../shared/database/firebase');

const router = express.Router();

/**
 * Conversion used to be one multipart POST that answered with the converted
 * bytes, so BOTH directions passed through this process: a 100 MB input and its
 * output resident at once, per caller, on a 512 MiB container serving eighty
 * concurrent requests.
 *
 * It is two steps now. The browser PUTs to storage, the worker converts storage
 * to storage, and the browser fetches the result from a signed url. Both
 * callers still end up with the bytes, which is what they need them for; the
 * API holds neither side.
 */

/** Largest document this endpoint accepts, unchanged by the transport. */
const CONVERT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The scratch prefix one caller's conversions live under.
 *
 * Keyed on the CALLER, so two people converting `contract.docx` cannot land on
 * one path and overwrite each other's input mid-conversion. It is also what
 * confines the run step: a path outside this prefix is refused, because taken
 * from the request unchecked it would convert and hand back a signed url for
 * any object in the bucket.
 */
const scratchPrefix = (userId: string) => `document-conversion/callers/${userId}/`;

/**
 * How long the link to a converted document is good for.
 *
 * Minutes rather than the file module's hour. Nothing revokes a signed URL that
 * has already been handed out, so its lifetime is the whole of its revocation
 * story, and the holder here is a browser that asked for this conversion and is
 * sitting on the response waiting to fetch it.
 */
const CONVERT_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Resolved per call rather than at import, so requiring this router does not
 * depend on storage credentials being loadable.
 */
function bucket() {
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

// POST /api/signatures/convert/upload-init
router.post('/convert/upload-init',
  verifyToken,
  documentConvertLimiter,
  assertConvertibleUpload,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const fileName = String(req.body?.fileName || 'source');
      const opened = await beginDirectUpload({
        objectPath: `${scratchPrefix(req.user.uid)}${randomUUID()}/source`,
        contentType: req.body?.contentType || 'application/octet-stream',
        uploadedBy: req.user.uid,
        maxBytes: CONVERT_MAX_BYTES,
        tooLargeMessage: (size: number) => `This file is ${formatBytes(size)}. Documents can be converted up to ${formatBytes(CONVERT_MAX_BYTES)}.`,
        fileName,
        declaredSize: Number(req.body?.size) || undefined,
        origin: req.get('origin') || undefined,
      });
      return res.status(200).json(opened);
    } catch (error: any) {
      return next(error);
    }
  }
);

// POST /api/signatures/convert/run
router.post('/convert/run',
  verifyToken,
  documentConvertLimiter,
  assertConvertibleRun,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const objectPath = String(req.body?.objectPath || '');
    const prefix = scratchPrefix(req.user.uid);
    if (!objectPath.startsWith(prefix)) {
      return next(new ValidationError('That upload does not belong to this conversion.'));
    }

    // The INPUT is scratch, unlike every other upload in the app. Left behind,
    // every conversion keeps a billed copy of the source, so it is deleted
    // however this ends, except on a busy refusal the client will retry.
    const deleteSource = () => bucket().file(objectPath).delete();
    // Typed by assertion, not annotation: it is assigned inside the closure
    // below, which control-flow analysis does not see, so an annotated `null`
    // would narrow to `never` in the catch.
    let cleanupOutput = null as (() => Promise<void>) | null;
    try {
      return await consumeScratchSource(deleteSource, async () => {
        const outputFormat = req.body.format || 'pdf';
        const formatInfo = FORMAT_MAP[outputFormat];
        const sourceName = String(req.body?.fileName || 'source');

        // Through the service, not the adapter: that wrapper is what applies the
        // one-conversion-per-instance limit and its queue deadline. Calling the
        // adapter directly would leave this route unbounded while every other
        // conversion path waits its turn.
        const converted = await convertStoredDocument({
          sourceObjectPath: objectPath,
          outputFormat,
          inputFilename: sourceName,
        });
        cleanupOutput = converted.cleanup;

        const baseName = sourceName.replace(/\.[^.]+$/, '');
        const outputFilename = `${baseName}.${formatInfo.ext}`;

        // `attachment`, which is what the multipart route's own header said. The
        // files module's `signObject` would answer `inline` for a PDF, because it
        // decides disposition for a PREVIEW; somebody converting a document is
        // asking for a file, and a PDF that opened in a tab instead of saving
        // would be a change the status code cannot show.
        //
        // The name is echoed from the request, so a quote or a newline in it would
        // split the header the storage provider builds from this value.
        const safeName = String(outputFilename).replace(/["\r\n]/g, '_');
        // Pinned to the output version this conversion produced. The scratch path
        // is per-conversion, so nothing should overwrite it, and that is exactly
        // why an unpinned URL here would go unnoticed if something did.
        const [signedUrl] = await bucket()
          .file(converted.objectPath, { generation: converted.generation })
          .getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + CONVERT_URL_TTL_MS,
            responseDisposition: `attachment; filename="${safeName}"`,
          });

        return res.status(200).json({
          signedUrl,
          fileName: outputFilename,
          contentType: converted.contentType,
          size: converted.size,
          generation: converted.generation,
          urlExpiresAt: new Date(Date.now() + CONVERT_URL_TTL_MS).toISOString(),
        });
      });
    } catch (error: any) {
      if (cleanupOutput) await cleanupOutput().catch(() => {});
      return next(error);
    }
  }
);

export = router;
