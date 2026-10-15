const express = require('express');
const crypto = require('crypto');
const router = express.Router({ mergeParams: true });

const { admin } = require('../../shared/database/firebase');
const { verifyToken } = require('../../shared/middleware/auth');
const { assertMatterMembership } = require('../../shared/utils/membership');
const { isUuid } = require('../../shared/utils/isUuid');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
const { admitStoredUpload, inspectStoredPdf, pinStoredObject } = require('./signingSources');
const { openGcsPdfSource } = require('./pdf/gcsSource');
const { runJobNow } = require('./signingJobs');
const {
  SIGNING_INLINE_PREPARE_BYTES,
  signingConversionCapBytes,
  signingConversionTooLargeMessage,
} = require('./signing.validation');
const { validate } = require('../../shared/middleware/validate');

/**
 * The matter a stored document belongs to, or null when it belongs to none.
 *
 * A row lookup, not a path parse. It read the segment after the firm id, which
 * worked only while the tree lived in the path; an object path is opaque now, so
 * that parse quietly returned null for every document and the matter-level wall
 * stopped applying to anything sent for signature.
 */
async function matterIdOfObject(lawFirmId: string, objectPath: any) {
  const row = await filesRepo.findByObjectPath(lawFirmId, objectPath, { includeDeleted: true });
  return row?.matterId || null;
}
const { remindersGloballyDisabled } = require('../../shared/utils/reminderControl');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  prepareSigningFileSchema, generateLinkSchema, sendEmailSchema, sendSigningRequestSchema,
  listSessionsSchema, listSigningRecipientsSchema,
} = require('./signatureLinks.validation');
const { AppError, NotFoundError, ValidationError, ConflictError } = require('../../shared/errors/AppError');
const { convertStoredDocument } = require('./signatures.service');
const { writeAuditEvent, hashDocument, AUDIT_EVENTS } = require('./audit');
const { normalizeSignatureFields } = require('./fieldNormalization');
const {
  APP_URL,
  getLawFirmName,
  loadSenderProfile,
  sendSigningInviteEmail,
  sendParticipantInvitation,
} = require('./signingNotifications');
const repo = require('./signatures.repository');
const membersRepo = require('../lawfirms/members/members.repository');
const clientsRepo = require('../clients/clients.repository');
const { toMs } = require('./timeUtils');
const {
  isPdfFileName,
  toPdfFileName,
  createSigningSession,
  getParticipantById,
  ts,
} = require('./signingSessions');
const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const bucket = admin.storage().bucket(BUCKET_NAME);
const { workingCopyPath, signingUploadPath, UPLOAD_ROOT_PREFIX, sweepSession } = require('./signingWorkspace');
const filesRepo = require('../files/files.repository');
const { isSystemObjectPath } = require('../../shared/storage/recordArchive');
import { handler } from '../../shared/http/handler';
import {
  getFirmSigningSessionSummary,
  getPendingForUser,
  listFirmSigningSessions,
  listSigningTemplates,
} from './signatureWorkspaceReads';

function normalizeStoragePath(value: any) {
  return String(value || '').trim().replace(/^\/+/, '');
}

// Shared timestamp coercion (consolidated module-wide helper).
const tsMillis = toMs;

/**
 * Where the executed copy of this session may be filed.
 *
 * A folder ROW in this firm, and nothing else. That is the whole check now, and
 * it is worth saying why it got this short.
 *
 * The old form took a path and had to keep an allow-list, because the firm
 * storage prefix also held places that are not filing locations: the
 * preserved-record archives, the scratch prefix an open session works in, and
 * per-conversation attachment folders. Filing an executed document into one of
 * those put it somewhere its owner could not see or remove, and into the scratch
 * prefix the session own sweep binned it seconds after completion.
 *
 * None of those are rows in `files`. They are system storage, with no folder to
 * name, so a folder row is a legitimate filing location by construction and
 * there is no list left to keep in step.
 */
async function ensureFilingFolder(destinationFolderId: any, lawFirmId: string) {
  if (!destinationFolderId) return null;

  const folder = await filesRepo.findById(lawFirmId, destinationFolderId);
  if (!folder || folder.deletedAt) {
    const err: any = new Error('That folder no longer exists');
    err.statusCode = 404;
    throw err;
  }
  if (folder.kind !== 'folder') {
    const err: any = new Error('Choose a folder to file the signed document in');
    err.statusCode = 400;
    throw err;
  }
  return folder.id;
}

async function validateSigningSourcePath({ objectPath, lawFirmId, requestedByUserId }: any) {
  const normalizedPath = normalizeStoragePath(objectPath);
  const allowedLawFirmPrefix = `lawfirmids/${lawFirmId}/`;

  if (!normalizedPath) {
    const err: any = new Error('Document path is required');
    err.statusCode = 400;
    throw err;
  }

  const file = bucket.file(normalizedPath);
  const [exists] = await file.exists();
  if (!exists) {
    const err: any = new Error('Document not found for signing');
    err.statusCode = 404;
    throw err;
  }

  let metadata: Record<string, any> = {};
  try {
    [metadata] = await file.getMetadata();
  } catch {
    metadata = {};
  }

  if (normalizedPath.startsWith(allowedLawFirmPrefix)) {
    // Preserved records and open sessions' scratch copies are not documents the
    // firm can pick from. Their segments are not uuids, so the matter check below
    // never fires for them, and sending one for signature is a copy out of the
    // archive: it lands in `signing-uploads/` readable by the sender and is then
    // shown to whoever they name — a route around the matter wall for exactly the
    // documents the wall matters most for.
    if (isSystemObjectPath(normalizedPath)) {
      const err: any = new Error('Document not found for signing');
      err.statusCode = 404;
      throw err;
    }

    // Matter-scoped source files require the sender to be a member of that matter
    // (same ACL the files module enforces); otherwise a signatures.send holder not
    // on the matter could send-for-signature — and thereby exfiltrate — any matter
    // document in the firm.
    const matterId = await matterIdOfObject(lawFirmId, normalizedPath);
    if (matterId) {
      await assertMatterMembership(lawFirmId, matterId, requestedByUserId);
    }
    return { objectPath: normalizedPath, metadata };
  }

  if (normalizedPath.startsWith('signing-uploads/')) {
    const uploadedBy =
      metadata?.metadata?.uploadedBy ||
      (metadata?.metadata as any)?.metadata?.uploadedBy ||
      (metadata as any)?.uploadedBy ||
      null;
    if (uploadedBy === requestedByUserId) {
      return { objectPath: normalizedPath, metadata };
    }

    const pathFirmId = normalizedPath.split('/')[1] || lawFirmId;
    if (pathFirmId) {
      const source = await repo.getSourceByObjectPath(pathFirmId, normalizedPath).catch(() => null);
      if (source && source.uploadedBy === requestedByUserId) {
        return { objectPath: normalizedPath, metadata };
      }
    }

    const err: any = new Error('You do not have access to this uploaded document');
    err.statusCode = 403;
    throw err;
  }

  const err: any = new Error('Document path must stay within this law firm');
  err.statusCode = 403;
  throw err;
}

/**
 * Admit the copy this send has just made its own, and prepare it here when it
 * is small enough to finish inside the request.
 *
 * A session names a SOURCE ROW, not a path. Recording only a path left the row
 * to be claimed later, at finalize, from an object nothing had inspected, and
 * that cost two things while it stood. A document that cannot be signed was
 * refused when the last signer finished, by which point every invitation had
 * gone out. And the flatten and the hash that sealing needs were redone once
 * per session over bytes that never change.
 *
 * Above the inline threshold the row stays `pending` and the drain finishes it.
 * The signer's read waits on readiness rather than on this request.
 */
async function admitSendSource(lawFirmId: string, objectPath: string, requestedByUserId: string) {
  const admitted = await admitStoredUpload({ lawFirmId, uploadedBy: requestedByUserId, objectPath });
  if (admitted.jobId && Number(admitted.sizeBytes || 0) <= SIGNING_INLINE_PREPARE_BYTES) {
    await runJobNow(lawFirmId, admitted.jobId, `send:${requestedByUserId}`);
  }
  return {
    sourceId: String(admitted.id),
    documentHash: admitted.documentHash || null,
    generation: admitted.objectGeneration || null,
  };
}

async function preparePdfForSigning({
  objectPath,
  fileName,
  lawFirmId,
  requestedByUserId,
  requireFlatteningConfirmation = false,
}: any) {
  const validatedSource = await validateSigningSourcePath({
    objectPath,
    lawFirmId,
    requestedByUserId,
  });
  const metadata = validatedSource.metadata || {};
  // PINNED to the version that was validated. Between the check above and the
  // copy below the firm can replace the file, and an unpinned copy would take
  // the new bytes under a decision made about the old ones: a document the
  // signer never saw, signed under a check that passed for something else.
  const sourceGeneration = metadata.generation ? String(metadata.generation) : null;
  const sourceFile = sourceGeneration
    ? bucket.file(validatedSource.objectPath, { generation: sourceGeneration })
    : bucket.file(validatedSource.objectPath);

  const normalizedFileName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : 'document';
  const sourceIsPdf =
    isPdfFileName(normalizedFileName) ||
    validatedSource.objectPath.toLowerCase().endsWith('.pdf') ||
    String(metadata.contentType || '').includes('pdf');
  const pdfFileName = sourceIsPdf && isPdfFileName(normalizedFileName)
    ? normalizedFileName
    : toPdfFileName(normalizedFileName);

  if (sourceIsPdf) {
    if (requireFlatteningConfirmation && !validatedSource.objectPath.startsWith(UPLOAD_ROOT_PREFIX)) {
      const pinned = await pinStoredObject(validatedSource.objectPath);
      const pdf = openGcsPdfSource(pinned);
      try {
        const inspection = await inspectStoredPdf(pdf, new AbortController().signal);
        if (inspection.hasAcroForm) {
          throw new AppError(
            'This PDF contains interactive form fields and must be flattened before signing.',
            409,
            'PDF_REQUIRES_FLATTENING',
          );
        }
      } finally {
        await pdf.close();
      }
    }

    // Already a transient upload: it is the session's own copy, nobody can reach
    // it through the file browser, and copying it again would buy nothing.
    if (validatedSource.objectPath.startsWith(UPLOAD_ROOT_PREFIX)) {
      return {
        objectPath: validatedSource.objectPath,
        fileName: pdfFileName,
        ...await admitSendSource(lawFirmId, validatedSource.objectPath, requestedByUserId),
      };
    }

    // A PDF picked out of the firm's documents used to be signed against in
    // place, which left the session depending on a file the firm can freely
    // delete, rename, move or replace while signing is still open. Doing any of
    // those broke the signer's link with no diagnosis, and replacing the file
    // silently changed what finalize rebuilds the authoritative signed PDF from,
    // so the executed document could differ from what the signer was shown.
    //
    // The session takes its own copy instead, which is what the conversion branch
    // below has always done. Server-side copy, so the bytes never travel through
    // this process.
    const uniqueId = crypto.randomBytes(12).toString('hex');
    const safeName = pdfFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const frozenObjectPath = signingUploadPath(lawFirmId, uniqueId, safeName);
    await sourceFile.copy(bucket.file(frozenObjectPath), {
      // Create-only. A retried prepare that found the destination already there
      // would otherwise overwrite a copy another attempt is already signing
      // against.
      preconditionOpts: { ifGenerationMatch: 0 },
      ...(sourceGeneration ? { sourceGeneration } : {}),
      contentType: 'application/pdf',
      metadata: {
        frozenForSigning: 'true',
        sourceObjectPath: validatedSource.objectPath,
        sourceGeneration: sourceGeneration || '',
        uploadedBy: requestedByUserId || '',
        lawFirmId: lawFirmId || '',
      },
    });

    return {
      objectPath: frozenObjectPath,
      fileName: pdfFileName,
      ...await admitSendSource(lawFirmId, frozenObjectPath, requestedByUserId),
    };
  }

  const uniqueId = crypto.randomBytes(12).toString('hex');
  const safeName = pdfFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const preparedObjectPath = signingUploadPath(lawFirmId, uniqueId, safeName);

  // The converter reads the source where it already sits and writes the PDF back
  // to storage, so neither the input nor the output passes through this process.
  // The buffered path held both at once, on the instance that also serves
  // requests. It falls back to buffering when no document worker is configured,
  // which is what keeps local development working.
  // The same conversion cap a direct signing upload meets. A firm document can
  // be any size its plan allows, and without this it reached the converter,
  // whose local adapter reads the whole source into this process.
  const sourceBytes = Number(metadata.size || 0);
  const conversionCap = signingConversionCapBytes();
  if (sourceBytes > conversionCap) {
    throw new AppError(
      signingConversionTooLargeMessage(sourceBytes),
      413,
      'SIGNING_CONVERSION_TOO_LARGE',
    );
  }
  const converted = await convertStoredDocument({
    sourceObjectPath: validatedSource.objectPath,
    outputFormat: 'pdf',
    inputFilename: normalizedFileName,
    sourceBytes: sourceBytes || undefined,
    maxBytes: conversionCap,
  });

  try {
    // Server-side copy from the converter's scratch object to the session's own,
    // so the bytes still never travel through here. The metadata has to be set
    // on the destination: the preview, re-send and save-as-template gates all
    // key on `uploadedBy` for a signing-uploads path, and reject the prepared
    // copy as someone else's without it.
    await bucket.file(converted.objectPath).copy(bucket.file(preparedObjectPath), {
      preconditionOpts: { ifGenerationMatch: 0 },
      contentType: 'application/pdf',
      metadata: {
        normalizedForSigning: 'true',
        sourceObjectPath: validatedSource.objectPath,
        sourceGeneration: sourceGeneration || '',
        uploadedBy: requestedByUserId || '',
        lawFirmId: lawFirmId || '',
      },
    });
  } finally {
    // On failure too. The converter's scratch output is billed storage nobody
    // can identify once this function has returned.
    await converted.cleanup().catch(() => {});
  }

  return {
    objectPath: preparedObjectPath,
    fileName: pdfFileName,
    ...await admitSendSource(lawFirmId, preparedObjectPath, requestedByUserId),
  };
}

// Working copies written at once. Each is a full upload of the source PDF, so a
// large envelope would otherwise put the whole document in flight once per signer
// and make session creation as slow as the sum of every upload.
const WORKING_COPY_UPLOAD_CONCURRENCY = 4;

/**
 * Give each participant in a parallel-routed session its own working copy of the
 * prepared PDF, so signers stamp their fields onto independent objects.
 *
 * The uploads are independent: every copy is the same `sourceBuffer` (downloaded
 * once by the caller, never re-fetched per signer) written to a path keyed by the
 * participant's own id, and nothing is accumulated across iterations. Results come
 * back in participant order because the runner preserves input order, which the
 * caller relies on when it replaces the session's participant list.
 */
async function createParallelWorkingCopies({ sessionId, lawFirmId, source, participants }: any) {
  const list = participants || [];

  const settled = await runWithConcurrency(
    list.map((participant: any) => async () => {
      const workingObjectPath = workingCopyPath(lawFirmId, sessionId, `${participant.participantId}.pdf`);
      // A server-side copy, pinned to the version that was admitted. This used
      // to write a Buffer of the whole document once per participant, so a
      // ten-signer parallel session held the document in this process and wrote
      // it out ten times from there. Storage copies it without the bytes
      // reaching this instance at all, and the pin means every signer sees the
      // version that was inspected rather than whatever is there now.
      const prepared = source.generation
        ? bucket.file(source.objectPath, { generation: String(source.generation) })
        : bucket.file(source.objectPath);
      await prepared.copy(bucket.file(workingObjectPath), {
        ...(source.generation ? { sourceGeneration: String(source.generation) } : {}),
        contentType: 'application/pdf',
        metadata: {
          sessionId,
          participantId: participant.participantId,
          workingCopy: 'true',
        },
      });

      return { ...participant, workingObjectPath };
    }),
    WORKING_COPY_UPLOAD_CONCURRENCY,
  );

  // A session missing any working copy is not usable, so the first failure fails
  // the create — the same all-or-nothing outcome the serial upload had.
  const failure = settled.find((r: any) => r.status === 'rejected');
  if (failure) throw failure.reason;

  return settled.map((r: any) => r.value);
}

// Reject two signers that send the same participantId. The client's ids only
// key fields to signers within this request (the server mints the stored ids),
// so a shared one leaves it undecidable which signer a field belongs to.
function assertDistinctParticipantIds(signers: any) {
  const seen = new Set<string>();
  for (const signer of Array.isArray(signers) ? signers : []) {
    const id = typeof signer?.participantId === 'string' ? signer.participantId : null;
    if (!id) continue;
    if (seen.has(id)) {
      throw new ValidationError([{
        path: 'signers',
        message: `More than one signer uses participantId "${id}". Each signer needs its own.`,
      }]);
    }
    seen.add(id);
  }
}

// Reject any field whose signerId does not point at a supplied signer. When a
// signers[] array is provided, fields are keyed to participants by the
// participantId the client sent; createSigningSession then mints the stored ids
// and repoints each field at its signer's. A field referencing an unknown
// signerId would be silently filtered out on the public read path, so we fail
// fast at create time instead.
function assertFieldSignerIdsMatchSigners(fields: any, signers: any) {
  const fieldsWithSigner = (fields || []).filter(
    (field: any) => typeof field?.signerId === 'string' && field.signerId.trim() !== ''
  );
  if (fieldsWithSigner.length === 0) return;

  const signerIds = new Set(
    (Array.isArray(signers) ? signers : [])
      .map((signer) => (typeof signer?.participantId === 'string' ? signer.participantId : null))
      .filter(Boolean)
  );

  // Collect ALL unmatched fields (not just the first) so a user fixing miskeyed
  // signerIds sees every bad field at once instead of one error per round-trip.
  const unmatched = fieldsWithSigner.filter((field: any) => !signerIds.has(field.signerId));
  if (unmatched.length > 0) {
    throw new ValidationError(
      unmatched.map((field: any) => ({
        path: 'fields',
        message: `Field "${field.id}" references signerId "${field.signerId}" which does not match any signer. Each signer must supply a participantId matching its fields.`,
      }))
    );
  }
}

// Validate that each signer's bound identity actually belongs to this law firm:
// a memberUserId must be a firm member and a clientUserId must be a client of the
// firm. A company's people are now their own standalone Person `clients` rows
// (client_company_links migration), not a separate roster identity, so
// `clientsRepo.findByUserId` alone covers both a direct person client and a
// company-linked one - a company itself never carries clients.user_id (Phase 1
// invariant). Without this, an arbitrary uid could be bound to a signer, and
// portal delivery would later post the completed PDF into that uid's
// conversation thread and treat them as the signer.
async function validateSignerIdentityRefs(signers: any, lawFirmId: string) {
  for (const signer of Array.isArray(signers) ? signers : []) {
    if (signer?.memberUserId) {
      // eslint-disable-next-line no-await-in-loop
      const member = await membersRepo.findByUserId(lawFirmId, signer.memberUserId);
      if (!member) {
        throw new ValidationError('A signer is linked to a user who is not a member of this law firm');
      }
    }
    if (signer?.clientUserId) {
      // eslint-disable-next-line no-await-in-loop
      const client = await clientsRepo.findByUserId(lawFirmId, signer.clientUserId);
      if (!client) {
        throw new ValidationError('A signer is linked to a client who does not belong to this law firm');
      }
    }
  }
}

async function createPreparedSigningSession({
  objectPath,
  fileName,
  fields,
  lawFirmId,
  createdBy,
  destinationFolderId,
  destinationLabel,
  clientId,
  notifyEmail,
  notifyName,
  recipientEmail,
  recipientName,
  accessCode,
  signers,
  routingMode,
  emailSignersOnComplete,
  requestedByUserId,
}: any) {
  // `clientId` binds the sole signer to a portal account (buildParticipants
  // turns it into the participant's clientUserId), so it gets the same check a
  // signer's clientUserId does. Checked before any storage work so a refused
  // request leaves nothing behind.
  await validateSignerIdentityRefs(clientId ? [{ clientUserId: clientId }] : [], lawFirmId);

  const preparedFile = await preparePdfForSigning({
    objectPath,
    fileName,
    lawFirmId,
    requestedByUserId,
  });
  const safeDestinationFolderId = await ensureFilingFolder(destinationFolderId, lawFirmId);
  const normalizedFields = normalizeSignatureFields(fields || null).fields;

  // Validate each field.signerId against a supplied signer participantId. Without
  // this, a mis-keyed signerId is silently dropped on read (signing.routes GET
  // /:token filters fields by participantId), so the field never appears.
  assertDistinctParticipantIds(signers);
  assertFieldSignerIdsMatchSigners(normalizedFields, signers);

  // Reject signers bound to a member/client identity that is not part of this firm.
  await validateSignerIdentityRefs(signers, lawFirmId);

  // The hash admission already computed over these exact bytes, in ONE bounded
  // streamed pass. This used to download the whole prepared document a second
  // time purely to hash it, which put an entire document in the process on the
  // send request, for a value that was already recorded beside it.
  const documentHash = preparedFile.documentHash;
  const session = await createSigningSession({
    sourceId: preparedFile.sourceId,
    preparedObjectPath: preparedFile.objectPath,
    fileName: preparedFile.fileName,
    fields: normalizedFields.length > 0 ? normalizedFields : null,
    lawFirmId,
    createdBy,
    destinationFolderId: safeDestinationFolderId,
    destinationLabel,
    clientId,
    notifyEmail,
    notifyName,
    documentHash,
    signers,
    routingMode,
    soleRecipientName: recipientName,
    soleRecipientEmail: recipientEmail,
    accessCode,
    emailSignersOnComplete: !!emailSignersOnComplete,
  });

  if (session.sessionRecord.routingMode === 'parallel') {
    let participantsWithCopies;
    try {
      participantsWithCopies = await createParallelWorkingCopies({
        sessionId: session.sessionId,
        lawFirmId,
        source: { objectPath: preparedFile.objectPath, generation: preparedFile.generation },
        participants: session.sessionRecord.participants,
      });
    } catch (err: any) {
      // `createSigningSession` already committed the session, its participants
      // and their public tokens in one transaction before this ran. Nobody has
      // been notified yet (the invite email/portal push only happens after this
      // function returns), so there is nothing worth preserving for a retry -
      // an orphaned `pending` session the firm was never told about, with no
      // way to complete it, is strictly worse than a clean failure the caller
      // can just resubmit. Roll both halves back: the DB row (which cascades to
      // participants, tokens and fields) and whatever working copies for THIS
      // session did manage to land in storage before the failing one.
      await repo.deleteSession(session.sessionId).catch((cleanupErr: any) => {
        console.error('[signing] Failed to roll back session after working-copy failure:', cleanupErr.message);
      });
      await sweepSession(lawFirmId, session.sessionId).catch((cleanupErr: any) => {
        console.error('[signing] Failed to sweep working copies after rollback:', cleanupErr.message);
      });
      throw err;
    }

    await repo.replaceParticipants(session.sessionId, participantsWithCopies);

    session.sessionRecord = {
      ...session.sessionRecord,
      participants: participantsWithCopies,
    };
  }

  writeAuditEvent(session.sessionId, AUDIT_EVENTS.SESSION_CREATED, {
    actorUid: createdBy,
    metadata: {
      lawFirmId,
      fileName: preparedFile.fileName,
      documentHash,
      fieldCount: fields ? fields.length : 0,
      routingMode: routingMode || 'sequential',
    },
  }).catch((err: any) => console.error('[audit] SESSION_CREATED failed:', err.message));

  return {
    ...session,
    fileName: preparedFile.fileName,
    objectPath: preparedFile.objectPath,
  };
}

// POST /api/lawfirms/:lawFirmId/signature-links/generate
// POST /api/lawfirms/:lawFirmId/signature-links/prepare
// Resolve a firm document into a signing-ready PDF entirely server-side and
// return the prepared objectPath. This is what lets the frontend hand a
// non-PDF straight to the signing flow without downloading the bytes,
// converting them through /signatures/convert, and re-uploading: the source
// never leaves storage. PDFs are frozen and non-PDFs converted by the same
// preparePdfForSigning the session-create path uses, so a later send accepts
// the prepared path as-is.
router.post('/prepare',
  verifyToken,
  requirePermission('signatures.send'),
  validate(prepareSigningFileSchema),
  handler(async (req) => {
    const { objectPath, fileName, requireFlatteningConfirmation } = req.body;
    const { lawFirmId } = req.params;

    const prepared = await preparePdfForSigning({
      objectPath,
      fileName,
      lawFirmId,
      requestedByUserId: req.user.uid,
      requireFlatteningConfirmation,
    });

    return { objectPath: prepared.objectPath, fileName: prepared.fileName, sourceId: prepared.sourceId };
  }),
);

router.post('/generate',
  verifyToken,
  requirePermission('signatures.send'),
  validate(generateLinkSchema),
  handler(async (req) => {
    const { objectPath, fileName, fields, signers, routingMode, destinationFolderId, destinationLabel, clientId, accessCode, emailSignersOnComplete } = req.body;
    const { lawFirmId } = req.params;

    const session = await createPreparedSigningSession({
      objectPath,
      fileName,
      fields: fields || null,
      signers: signers || null,
      routingMode,
      lawFirmId,
      createdBy: req.user.uid,
      destinationFolderId,
      destinationLabel,
      clientId,
      accessCode,
      emailSignersOnComplete,
      requestedByUserId: req.user.uid,
    });

    const publicToken = session.firstParticipantToken || session.sessionId;
    const link = `${APP_URL}/signature?token=${publicToken}`;
    return {
      link,
      token: publicToken,
      sessionToken: session.sessionId,
      fileName: session.fileName,
    };
  }),
);

// POST /api/lawfirms/:lawFirmId/signature-links/send-email
router.post('/send-email',
  verifyToken,
  requirePermission('signatures.send'),
  validate(sendEmailSchema),
  handler(async (req, res) => {
    const { recipientEmail, recipientName, objectPath, fileName, fields, message, replyToEmail, routingMode, destinationFolderId, destinationLabel, accessCode, emailSignersOnComplete } = req.body;
    const { lawFirmId } = req.params;

    const { senderName, senderEmail } = await loadSenderProfile(req.user);
    const notifyEmail = (replyToEmail || senderEmail || '').trim() || null;
    const lawFirmName = await getLawFirmName(lawFirmId);

    const session = await createPreparedSigningSession({
      objectPath,
      fileName,
      fields: fields || null,
      routingMode,
      lawFirmId,
      createdBy: req.user.uid,
      destinationFolderId,
      destinationLabel,
      notifyEmail,
      notifyName: senderName,
      recipientEmail,
      recipientName,
      accessCode,
      emailSignersOnComplete,
      requestedByUserId: req.user.uid,
    });
    const result = await sendSigningInviteEmail({
      to: recipientEmail,
      recipientName,
      senderName,
      lawFirmName,
      fileName: session.fileName,
      signingLink: `${APP_URL}/signature?token=${session.firstParticipantToken || session.sessionId}`,
      message,
      replyTo: notifyEmail || undefined,
      roleLabel: 'Signer',
    });

    if (!result.sent) {
      return res.status(502).json({
        error: 'The signing request was created, but the email could not be delivered. Check the recipient address, then use Resend from the document.',
        code: 'SIGNING_EMAIL_NOT_SENT',
        sessionId: session.sessionId,
        requestId: req.id || null,
      });
    }

    writeAuditEvent(session.sessionId, AUDIT_EVENTS.EMAIL_SENT, {
      actorUid: req.user.uid,
      metadata: { recipientEmail, recipientName: recipientName || null, messageId: result.messageId || null },
    }).catch((err: any) => console.error('[audit] EMAIL_SENT failed:', err.message));

    res.status(200).json({ sent: true, messageId: result.messageId, sessionToken: session.sessionId });
  }),
);

// POST /api/lawfirms/:lawFirmId/signature-links/send (create a multi-signer session and notify the signer(s))
router.post('/send',
  verifyToken,
  requirePermission('signatures.send'),
  validate(sendSigningRequestSchema),
  handler(async (req, res) => {
    const { objectPath, fileName, fields, signers, routingMode, message, replyToEmail, destinationFolderId, destinationLabel, emailSignersOnComplete } = req.body;
    const { lawFirmId } = req.params;
    const { senderName, senderEmail } = await loadSenderProfile(req.user);
    const notifyEmail = (replyToEmail || senderEmail || '').trim() || null;

    const session = await createPreparedSigningSession({
      objectPath,
      fileName,
      fields,
      signers,
      routingMode,
      lawFirmId,
      createdBy: req.user.uid,
      destinationFolderId,
      destinationLabel,
      notifyEmail,
      notifyName: senderName,
      emailSignersOnComplete,
      requestedByUserId: req.user.uid,
    });

    const activeParticipants = session.sessionRecord.participants.filter((participant: any) => participant.status === 'active');
    const participantsToNotify = (session.sessionRecord.routingMode || 'sequential') === 'parallel'
      ? activeParticipants
      : activeParticipants.slice(0, 1);

    // The session is already committed, so one signer who cannot be reached
    // must not stop the others being notified. Every signer is tried, and the
    // ones that failed are reported with the session id so the sender can use
    // Resend rather than submitting again and creating a second session.
    const undeliveredParticipantIds: string[] = [];
    for (const participant of participantsToNotify) {
      let notificationResult: { sent: boolean };
      try {
        // eslint-disable-next-line no-await-in-loop -- one delivery per signer, in order
        notificationResult = await sendParticipantInvitation({
          participant,
          publicToken: session.publicTokens[participant.participantId],
          lawFirmId,
          senderName,
          senderEmail: notifyEmail || senderEmail,
          fileName: session.fileName,
          message,
        });
      } catch (err: any) {
        console.error('[signing] Signing request delivery failed for a participant:', err.message);
        notificationResult = { sent: false };
      }

      if (!notificationResult.sent) {
        undeliveredParticipantIds.push(participant.participantId);
        continue;
      }

      writeAuditEvent(session.sessionId, AUDIT_EVENTS.EMAIL_SENT, {
        actorUid: req.user.uid,
        metadata: {
          participantId: participant.participantId,
          recipientEmail: participant.email || null,
          deliveryMethod: participant.deliveryMethod,
        },
      }).catch((err: any) => console.error('[audit] EMAIL_SENT failed:', err.message));
    }

    if (undeliveredParticipantIds.length > 0) {
      return res.status(502).json({
        error: 'The signing request was created, but it could not be delivered to every signer. Check the recipient details, then use Resend from the document.',
        code: 'SIGNING_EMAIL_NOT_SENT',
        sessionId: session.sessionId,
        sessionToken: session.sessionId,
        undeliveredParticipantIds,
        requestId: req.id || null,
      });
    }

    // Collect copy links for ALL copy_link participants (not just notified ones)
    // so the sender can share links even for signers waiting in sequential mode
    const copyLinks = session.sessionRecord.participants
      .filter((p: any) => p.deliveryMethod === 'copy_link')
      .map((p: any) => ({
        participantId: p.participantId,
        name: p.name || p.roleLabel,
        link: `${APP_URL}/signature?token=${session.publicTokens[p.participantId]}`,
      }));

    res.status(200).json({
      sent: true,
      sessionToken: session.sessionId,
      firstParticipantToken: participantsToNotify[0]
        ? session.publicTokens[participantsToNotify[0].participantId]
        : (session.firstParticipantToken || null),
      copyLinks: copyLinks.length > 0 ? copyLinks : undefined,
    });
  }),
);

// GET /api/lawfirms/:lawFirmId/signature-links/recipients
//
// The dedicated portal-recipient picker: who can be addressed for an
// account-backed ('portal' / 'internal_dashboard' style) signing request.
// Every recipient is a `clients` row with a portal account - person and
// company-linked people are the same shape now, no `kind` discriminator -
// each carrying its own `userId` (the uid a signer's `clientUserId` should be
// set to) and, when linked to a company, `companyLinkId` (the exact
// `client_company_links.id` it resolves to) + `companyName`, so the picker
// can show "{person name} - {company name}" instead of just the company
// generically. Deliberately separate from the generic client lookup
// (clients.routes.ts's `portalOnly` filter), which only tests
// `clients.user_id` directly with no company-linkage annotation.
router.get('/recipients',
  verifyToken,
  requirePermission('signatures.send'),
  validate(listSigningRecipientsSchema),
  handler(async (req) => {
    const { lawFirmId } = req.params;
    const result = await repo.listSigningRecipients(lawFirmId, {
      search: req.query.search,
      clientId: req.query.clientId,
      limit: req.query.limit,
    });
    return result;
  }),
);

router.get('/pending-for-user',
  verifyToken,
  requirePermission('signatures.view'),
  handler(async (req) => getPendingForUser({ lawFirmId: req.params.lawFirmId, userId: req.user.uid })),
);

// How long a manually resent reminder blocks the next one for that signer. The
// cron sweep's window is a day; a firm member watching a signer stall wants to
// nudge sooner than that, and the only thing being prevented here is a
// double-submit sending twice.
const MANUAL_RESEND_WINDOW_SECONDS = 60;

// POST /api/lawfirms/:lawFirmId/signature-links/:sessionToken/resend-participant/:participantId
router.post('/:sessionToken/resend-participant/:participantId',
  verifyToken,
  requirePermission('signatures.send'),
  handler(async (req, res) => {
    const { lawFirmId, sessionToken, participantId } = req.params;
    const sessionData = await repo.getSessionByToken(sessionToken);

    if (!sessionData) {
      throw new NotFoundError('Signing session');
    }

    if (sessionData.lawFirmId !== lawFirmId) {
      throw new NotFoundError('Signing session');
    }
    if (sessionData.status === 'completed' || sessionData.status === 'cancelled') {
      throw new ConflictError('This signing session is no longer active');
    }

    const participant = getParticipantById(sessionData, participantId);
    if (!participant) {
      throw new NotFoundError('Signer');
    }
    if (!['active', 'waiting'].includes(participant.status)) {
      throw new ValidationError('Only active or waiting signers can be resent');
    }
    if (remindersGloballyDisabled()) {
      throw new ConflictError('Reminders are currently disabled.');
    }

    // CLAIM BEFORE SENDING, for the reason the cron sweep states at
    // `signingReminders.service.ts`. This used to read `lastReminderSentAt`,
    // compare it, send, and stamp afterwards. That is check-then-act: a
    // double-submit puts two requests past the same stale read and the signer
    // gets the nudge twice, because the write that would have stopped the
    // second one happens after the first email is already out. Moving the
    // window into the `where` clause of one UPDATE makes Postgres pick the
    // winner. `waiting` is allowed here and not in the sweep: a firm member may
    // deliberately nudge a signer whose turn has not come.
    const previousSentAt = participant.lastReminderSentAt || null;
    const lastReminderMs = tsMillis(participant.lastReminderSentAt);
    if (!(await repo.claimReminderSend(sessionToken, participantId, {
      withinSeconds: MANUAL_RESEND_WINDOW_SECONDS, statuses: ['active', 'waiting'],
    }))) {
      const elapsedMs = Date.now() - lastReminderMs;
      const rateLimitError = new AppError('Please wait before sending another reminder.', 429, 'RATE_LIMITED');
      // Advisory only. The claim, not this arithmetic, is what refused the send,
      // and a claim lost to a concurrent request has no elapsed time to report.
      rateLimitError.details = {
        retryAfterSeconds: lastReminderMs
          ? Math.max(1, Math.ceil((MANUAL_RESEND_WINDOW_SECONDS * 1000 - elapsedMs) / 1000))
          : MANUAL_RESEND_WINDOW_SECONDS,
      };
      throw rateLimitError;
    }

    const { senderName, senderEmail } = await loadSenderProfile(req.user);
    const result = await sendParticipantInvitation({
      participant,
      publicToken: participant.publicToken,
      lawFirmId,
      senderName,
      senderEmail,
      fileName: sessionData.fileName,
      message: `Reminder from ${senderName}: please review and sign ${sessionData.fileName}.`,
      reminder: true,
    });

    if (!result.sent) {
      // Give the claim back, so the firm member can correct the address and try
      // again immediately rather than waiting out a window for a send that
      // never happened.
      await repo.releaseReminderClaim(sessionToken, participantId, previousSentAt)
        .catch((err: any) => console.error('[signing] Failed to release a manual resend claim:', err.message));
      return res.status(502).json({
        error: 'This reminder could not be delivered. Check the recipient\'s email address before resending.',
        code: 'SIGNING_EMAIL_NOT_SENT',
        sessionId: sessionData.token,
        requestId: req.id || null,
      });
    }

    // The claim already stamped `last_sent_at` and bumped `sent_count`, so
    // there is nothing to write here. Stamping again would double-count the
    // send, which is what the old code did on the way to the response.
    const lastReminderSentAt = new Date().toISOString();
    const newReminderCount = (participant.reminderCount || 0) + 1;

    writeAuditEvent(sessionToken, AUDIT_EVENTS.REMINDER_SENT, {
      actorUid: req.user.uid,
      metadata: {
        participantId,
        recipientEmail: participant.email || null,
        deliveryMethod: participant.deliveryMethod,
      },
    }).catch((err: any) => console.error('[audit] REMINDER_SENT failed:', err.message));

    res.status(200).json({
      sent: true,
      participantId,
      reminderCount: newReminderCount,
      lastReminderSentAt: ts(lastReminderSentAt),
    });
  }),
);

// GET /api/lawfirms/:lawFirmId/signature-links/sessions/summary
//
// How much each status filter would match, over the whole history rather than
// the page on screen. The list response cannot answer this: it is already
// narrowed by the active filter, so the filters would only ever be able to
// count themselves.
router.get('/sessions/summary',
  verifyToken,
  requirePermission('signatures.view'),
  handler(async (req) => getFirmSigningSessionSummary({ lawFirmId: req.params.lawFirmId })),
);

// GET /api/lawfirms/:lawFirmId/signature-links/sessions (list signing sessions for this firm)
//
// Paged, filtered and counted in SQL. Signing sessions are append-only, so the
// history grows without bound; windowing it here is what keeps older sessions
// reachable at all (the read used to stop at the 100 most recent) and keeps the
// response a page rather than the firm's whole signing history.
router.get('/sessions',
  verifyToken,
  requirePermission('signatures.view'),
  validate(listSessionsSchema),
  handler(async (req) => listFirmSigningSessions({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    limit: req.query.limit,
    offset: req.query.offset,
    page: req.query.page,
    status: req.query.status,
    search: req.query.search,
  })),
);

// GET /api/lawfirms/:lawFirmId/signature-links/workspace
//
// Everything the Signatures page opens with, in one request:
// `{ sessions, summary, pendingForUser, templates }`, each the body of
// `GET /sessions` (taking the same page/limit/offset/status/search query),
// `GET /sessions/summary`, `GET /pending-for-user` and `GET /signing-templates`.
// All four share this gate (`signatures.view`, behind the `documentSigning`
// plan feature mounted in app.ts on both routers), so a caller either reads all
// of it or none. Run as two pairs: the session list and the pending read each
// load participants and tokens together, so each pair peaks at three pool
// connections rather than all four reads taking six at once.
router.get('/workspace',
  verifyToken,
  requirePermission('signatures.view'),
  validate(listSessionsSchema),
  handler(async (req) => {
    const { lawFirmId } = req.params;
    const userId = req.user.uid;
    const [sessions, summary] = await Promise.all([
      listFirmSigningSessions({
        lawFirmId,
        userId,
        limit: req.query.limit,
        offset: req.query.offset,
        page: req.query.page,
        status: req.query.status,
        search: req.query.search,
      }),
      getFirmSigningSessionSummary({ lawFirmId }),
    ]);
    const [pendingForUser, templates] = await Promise.all([
      getPendingForUser({ lawFirmId, userId }),
      listSigningTemplates({ lawFirmId }),
    ]);
    return { sessions, summary, pendingForUser, templates };
  }),
);

export = router;
