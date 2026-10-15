const express = require('express');
const repo = require('./signatures.repository');
const { verifyToken } = require('../../shared/middleware/auth');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { withPdfSlot } = require('./signingJobs');
require('./signingFinalize');
const { signingVerifyLimiter } = require('../../shared/middleware/rateLimiters');
import { finishVerification, readSealLayout, type SealVerification } from './pdf/verifySeal';
import { digestWholeAndSpans } from './pdf/digest';
import { openGcsPdfSource } from './pdf/gcsSource';
import { createResumableDigest } from './pdf/resumableDigest';
const { listAuditEvents } = require('./audit');
const { putCertificate, signingArchivePath, CERTIFICATE_ARTIFACT, DELIVERED_DOCUMENT_ARTIFACT, SIGNED_DOCUMENT_ARTIFACT } = require('./signingArchive');
import { handler } from '../../shared/http/handler';
import { assertSessionOutputAccess, bucket, tsToIso, renderCompletionCertificate } from './signingRouteSupport';

const router = express.Router();

// POST /api/signing/verify (public, verify a signed PDF hasn't been tampered with)
router.post('/verify',
  signingVerifyLimiter,
  handler(async (req, res) => {
    // The caller hashes the document and sends 32 bytes. This route used to
    // accept the document itself and hash it as it streamed, which kept it out
    // of memory but held an unauthenticated request open for a whole transfer.
    const uploadedHash = typeof req.body?.hash === 'string' ? req.body.hash.toLowerCase().trim() : null;
    if (!uploadedHash || !/^[0-9a-f]{64}$/.test(uploadedHash)) {
      throw new ValidationError('A SHA-256 hash of the document is required.');
    }

    // Search for a signing session with a matching signedDocumentHash
    const session = await repo.findSessionBySignedHash(uploadedHash);

    if (!session) {
      return res.status(200).json({
        valid: false,
        message: 'This document was not signed through Paralegix, or it has been modified since signing.',
      });
    }

    const ts = tsToIso;

    return res.status(200).json({
      valid: true,
      fileName: session.fileName,
      signerName: (session.participants || [])
        .filter((participant: any) => participant.status === 'completed')
        .map((participant: any) => participant.signerName || participant.name)
        .filter(Boolean)
        .join(', '),
      signedAt: ts(session.completedAt),
      transactionId: session.token,
      // Which of the two sealed copies this file is. The delivered copy is what
      // signers were emailed and portal clients received; the filed copy is the
      // one in the firm's documents, carrying the Signature Certificate page.
      // Both are genuine, and saying which avoids a reader concluding their copy
      // is the "wrong" one because it differs from a colleague's.
      matchedCopy: session.matchedCopy || 'filed',
    });
  }),
);

// GET /api/signing/:token/audit (authenticated, returns full audit trail)
router.get('/:token/audit', verifyToken, handler(async (req, res) => {
  const { token } = req.params;
  const data = await repo.getSessionByToken(token);

  if (!data) {
    throw new NotFoundError('Signing session');
  }

  // Authorization: creator, or signatures.view + matter membership for a
  // matter-scoped document (audit trail carries signer IPs).
  await assertSessionOutputAccess(data, req.user.uid);

  // Fetch all audit events ordered by timestamp
  const events = await listAuditEvents(token);

  const ts = tsToIso;

  res.status(200).json({
    session: {
      token,
      fileName: data.fileName,
      status: data.status,
      signerName: data.signerName || null,
      createdAt: ts(data.createdAt),
      completedAt: ts(data.completedAt),
      originalDocumentHash: data.documentHash || null,
      signedDocumentHash: data.signedDocumentHash || null,
      routingMode: data.routingMode || 'sequential',
      signers: (data.participants || []).map((participant: any) => ({
        participantId: participant.participantId,
        roleLabel: participant.roleLabel,
        name: participant.signerName || participant.name || null,
        email: participant.email || null,
        status: participant.status,
        order: participant.order,
        completedAt: tsToIso(participant.completedAt),
      })),
    },
    events,
  });
}));

// GET /api/signing/:token/certificate (authenticated, generates a Certificate of Completion PDF)
router.get('/:token/certificate', verifyToken, handler(async (req, res) => {
  try {
    const { token } = req.params;
    const data = await repo.getSessionByToken(token);

    if (!data) {
      throw new NotFoundError('Signing session');
    }

    if (data.status !== 'completed') {
      throw new ValidationError('Certificate is only available for completed signing sessions');
    }

    // Authorization: creator, or signatures.view + matter membership (matter-scoped).
    await assertSessionOutputAccess(data, req.user.uid);

    const certFileName = `Certificate of Completion - ${data.fileName.replace(/\.pdf$/i, '')}.pdf`;
    const wantsJson = req.query.format === 'json' || req.headers.accept?.includes('application/json');
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';

    // The archived copy is authoritative once it exists, so the certificate a firm
    // downloads years from now is byte-for-byte the one it downloaded originally.
    const certPath = signingArchivePath(data.lawFirmId, token, CERTIFICATE_ARTIFACT);
    const handle = bucket.file(certPath);
    const [exists] = await handle.exists().catch(() => [false]);
    if (!exists) {
      const finalCert = await renderCompletionCertificate(token, data);
      await putCertificate(data.lawFirmId, token, finalCert);
    }

    const [metadata] = await handle.getMetadata().catch(() => [{}]);
    const generation = String(metadata?.generation ?? '');
    const targetFile = generation ? bucket.file(certPath, { generation }) : handle;
    const [signedUrl] = await targetFile.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000,
      responseDisposition: `${disposition}; filename="${encodeURIComponent(certFileName)}"`,
    });

    if (wantsJson) {
      return res.status(200).json({
        url: signedUrl,
        fileName: certFileName,
      });
    }

    if (req.query.redirect === 'true') {
      return res.redirect(302, signedUrl);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(certFileName)}"`);
    if (metadata?.size) {
      res.setHeader('Content-Length', metadata.size);
    }
    handle.createReadStream().pipe(res);
  } catch (err: any) {
    throw err;
  }
}));

// GET /api/signing/:token/verification (authenticated, streams stored artifact through ByteRange/CMS verifier)
router.get('/:token/verification', verifyToken, handler(async (req, res) => {
  const { token } = req.params;
  const data = await repo.getSessionByToken(token);

  if (!data) {
    throw new NotFoundError('Signing session');
  }

  // Authorization: creator, or signatures.view + matter membership (matter-scoped).
  await assertSessionOutputAccess(data, req.user.uid);

  const wantsDelivered = req.query.copy === 'delivered';
  const expectedHash = wantsDelivered ? data.deliveryDocumentHash : data.signedDocumentHash;
  // Each copy is checked against its OWN hash. `finalObjectPath` is the
  // delivered copy and `signedObjectPath` the filed one; reading the delivered
  // bytes and comparing them with the filed hash reported every real session
  // as a mismatch.
  const chosenPath = wantsDelivered
    ? (data.finalObjectPath || signingArchivePath(data.lawFirmId, token, DELIVERED_DOCUMENT_ARTIFACT))
    : (data.signedObjectPath || signingArchivePath(data.lawFirmId, token, SIGNED_DOCUMENT_ARTIFACT));

  if (!chosenPath || data.status !== 'completed') {
    return res.status(200).json({
      token,
      copy: wantsDelivered ? 'delivered' : 'filed',
      status: data.status,
      identityMatch: false,
      sealed: false,
      sealValid: false,
      coversWholeFile: false,
      reason: data.status !== 'completed' ? 'Signing session is not completed' : 'No artifact path found',
    });
  }

  const handle = bucket.file(chosenPath);
  const [exists] = await handle.exists().catch(() => [false]);
  if (!exists) {
    return res.status(200).json({
      token,
      copy: wantsDelivered ? 'delivered' : 'filed',
      status: data.status,
      identityMatch: false,
      sealed: false,
      sealValid: false,
      coversWholeFile: false,
      reason: 'Artifact file does not exist in storage',
    });
  }

  const [metadata] = await handle.getMetadata();
  const ref = {
    objectPath: chosenPath,
    generation: String(metadata?.generation ?? ''),
    sizeBytes: Number(metadata?.size || 0),
  };

  // A caller who leaves stops the read. Without this a closed tab kept a full
  // pass over a 500 MB artifact running to the end.
  const aborter = new AbortController();
  req.on('close', () => aborter.abort());
  const source = openGcsPdfSource(ref);
  let digestHex: string;
  let sealVerification: SealVerification;
  try {
    // Under the transfer slot, like every other whole-document pass: this is
    // one full read of the artifact, and nothing else bounds how many firm
    // members can start one at once.
    ({ digestHex, sealVerification } = await withPdfSlot(async () => {
      const read = await readSealLayout(source, aborter.signal);
      if ('verification' in read) {
        // Unsealed or unreadable. The identity question still has an answer,
        // so this is one pass rather than none.
        const digest = await createResumableDigest();
        for await (const chunk of source.stream(0, ref.sizeBytes, aborter.signal)) digest.update(chunk);
        return { digestHex: digest.digestHex(), sealVerification: read.verification };
      }
      const both = await digestWholeAndSpans(source, read.layout.spans, aborter.signal);
      return { digestHex: both.wholeHex, sealVerification: finishVerification(read.layout, both.spansHex) };
    }));
  } catch (err: any) {
    if (err?.code !== 'CONCURRENCY_QUEUE_TIMEOUT') throw err;
    throw new AppError(
      'Verification is busy right now. Try again in a minute.', 503, 'SIGNING_BUSY',
      { retryAfterSeconds: 60 },
    );
  } finally {
    await source.close();
  }

  const identityMatch = !!expectedHash && digestHex === expectedHash;

  return res.status(200).json({
    token,
    copy: wantsDelivered ? 'delivered' : 'filed',
    identityMatch,
    sealed: sealVerification.sealed,
    sealValid: sealVerification.sealValid,
    coversWholeFile: sealVerification.coversWholeFile,
    signedDigestHex: sealVerification.signedDigestHex,
    signerCommonName: sealVerification.signerCommonName,
    signingTime: sealVerification.signingTime ? tsToIso(sealVerification.signingTime) : undefined,
    reason: sealVerification.reason || (!identityMatch ? 'Stored document hash does not match session record' : undefined),
  });
}));

// GET /api/signing/:token/signed-document (authenticated, streams the final
// signed PDF back to the session creator or any firm member with view access.
// Pass ?disposition=inline to view in-browser instead of forcing a download.
//
// A completed session has TWO genuine executed PDFs and they are not the same
// bytes: the FILED copy carries the appended Signature Certificate page, the
// DELIVERED copy is what signers were emailed and portal clients received.
// `?copy=delivered` asks for the latter, which is the one to reach for when the
// question is what a particular recipient is holding.
//
// `?copy=without-certificate` asks a softer question , the document body on its
// own, for reading on screen, where the certificate page is an interruption
// rather than evidence. It prefers the delivered copy and otherwise renders the
// filed one with its trailing certificate page dropped.
router.get('/:token/signed-document', verifyToken, handler(async (req, res) => {
  const { token } = req.params;
  const wantsDelivered = req.query.copy === 'delivered';
  const wantsWithoutCertificate = req.query.copy === 'without-certificate';
  const data = await repo.getSessionByToken(token);

  if (!data) {
    throw new NotFoundError('Signing session');
  }

  if (data.status !== 'completed') {
    throw new ValidationError('The signed document is only available once signing is complete');
  }

  // Authorization: creator, or signatures.view + matter read access.
  await assertSessionOutputAccess(data, req.user.uid);

  // Prefer direct GCS signed URL so the container never buffers the large executed PDF in memory.
  // The default is the FILED copy, `signedObjectPath`, which carries the
  // certificate page. `finalObjectPath` is the delivered copy; defaulting to it
  // handed the firm a document without its certificate under the filed name.
  const chosenPath = (wantsDelivered || wantsWithoutCertificate)
    ? signingArchivePath(data.lawFirmId, token, DELIVERED_DOCUMENT_ARTIFACT)
    : (data.signedObjectPath || signingArchivePath(data.lawFirmId, token, SIGNED_DOCUMENT_ARTIFACT));

  if (chosenPath) {
    const handle = bucket.file(chosenPath);
    const [exists] = await handle.exists().catch(() => [false]);
    if (exists) {
      const [metadata] = await handle.getMetadata();
      const generation = String(metadata.generation ?? '');
      const baseName = data.fileName.replace(/\.pdf$/i, '');
      const downloadName = wantsDelivered
        ? `Signed (as delivered) - ${baseName}.pdf`
        : `Signed - ${baseName}.pdf`;
      const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';

      const [downloadUrl] = await bucket.file(chosenPath, generation ? { generation } : {}).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000,
        responseDisposition: `${disposition}; filename="${encodeURIComponent(downloadName)}"`,
      });

      if (req.query.format === 'json') {
        return res.json({ url: downloadUrl, fileName: downloadName });
      }
      return res.redirect(302, downloadUrl);
    }
  }

  throw new AppError('The executed document is no longer available.', 404, 'NOT_FOUND');
}));

export = router;
