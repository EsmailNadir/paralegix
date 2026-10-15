import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../shared/http/handler';
const express = require('express');
const crypto = require('crypto');
const repo = require('./signatures.repository');
const { verifyToken, optionalVerifyToken, requireUserType } = require('../../shared/middleware/auth');
const { AppError, NotFoundError, ForbiddenError, ValidationError, ConflictError } = require('../../shared/errors/AppError');
const { runJobNow, kickSigningDrain } = require('./signingJobs');
const { trackBackgroundWrite } = require('../../shared/utils/backgroundWrites');
require('./signingFinalize');
const { mintSigningReadUrl } = require('./signingDownloads');
const { signingActionLimiter, signingReadLimiter, signingGateLimiter } = require('../../shared/middleware/rateLimiters');
import { beginDirectUpload, settleDirectUpload } from '../../shared/storage/directUpload';
import { openGcsPdfSource } from './pdf/gcsSource';
import { readDocumentIndex } from './pdf/reader';
import { resolvePages } from './pdf/pages';
const { writeAuditEvent, extractRequestMeta, AUDIT_EVENTS } = require('./audit');
const { completeSigningJsonSchema, pendingForClientQuerySchema, SIGNING_MAX_FILE_BYTES, SIGNING_INLINE_FINALIZE_BYTES } = require('./signing.validation');
const { validate } = require('../../shared/middleware/validate');
const { findMissingRequiredFields, findForeignFieldSubmissions, filterValuesToParticipant, findUnembeddableSignatureFields, findImageLimitViolation, findOversizedTextValue, SIGNING_TEXT_VALUE_MAX_CHARS } = require('./signingFieldValues');
const { computeSigningViewRevision } = require('./signingRevision');
const { isSessionExpired, maskEmail, hashAccessCode, resolveSigningContext, getParticipantById, getActiveParticipant, updateParticipant, makeSessionRef } = require('./signingSessions');
const { sendCancellationNotifications, sendSignerConfirmationEmail, sendSigningDeclinedEmail } = require('./signingNotifications');
const { destinationScope } = require('./signedFileRegistration');
const { deliverCompletedSession } = require('./signingDelivery');
const eventBus = require('../../shared/events/eventBus');
const { SIGNING_COMPLETED, SIGNING_DECLINED } = require('../../shared/events/eventTypes');
const { workingCopyPath: sessionWorkingCopyPath, sweepSession: sweepSessionWorkspace } = require('./signingWorkspace');
import { handler } from '../../shared/http/handler';
import { tokenRef, shouldRebuildSessionPdfFromFieldValues, bucket, hashesEqual, getTimestampMs, tsToIso, buildSessionStatusPayload, resolveAuthorizedParticipant, GATE_SOFT_ATTEMPT_LIMIT, GATE_HARD_ATTEMPT_CAP, GATE_POLICY, maybeWriteSessionViewed, maybeWriteDocumentViewed, buildFieldStampedWorkingCopy, hashStoredObject, finalizeSource, completionStateForJob, inlineFinalizeQueueBudgetMs, ensureNormalizedSessionFields, notifyNextParticipant, completionUploadPrefix, archiveCertificateAfterCompletion, COMPLETION_OUTCOMES, completionBody, replayState, imageLimitError, replayConsumedCompletion } from './signingRouteSupport';

const router = express.Router();

// GET /api/signing/pending-for-client (authenticated, returns documents waiting
// for the current client). Answers account-wide by default; `lawFirmId` narrows
// it to one firm and `limit`/`offset`/`page` window the result, with the count
// and the single-firm resolution taken over the whole matching set.
router.get('/pending-for-client',
  verifyToken,
  requireUserType(['client']),
  validate(pendingForClientQuerySchema),
  handler(async (req) => {
    // One slim query: session + matching active participant + counts.
    // No full session-graph load (was up to ~400 queries for 100 sessions),
    // and the SQL already filters to v2 + active + ordered by created_at desc.
    const { rows, totalItems, singleLawFirmId } = await repo.findPendingDocumentsForClient(
      req.user.uid,
      {
        lawFirmId: req.query.lawFirmId,
        limit: req.query.limit,
        offset: req.query.offset,
        page: req.query.page,
      },
    );

    const pendingDocuments = rows.map((row: any) => ({
      sessionToken: row.session_token,
      lawFirmId: row.law_firm_id,
      fileName: row.file_name,
      routingMode: row.routing_mode || 'sequential',
      createdAt: tsToIso(row.created_at),
      participantId: row.participant_id,
      participantRole: row.participant_role || 'Signer',
      participantName: row.participant_name || null,
      publicToken: row.public_token || null,
      totalParticipants: Number(row.total) || 0,
      completedParticipants: Number(row.completed) || 0,
    }));

    return { pendingDocuments, totalItems, singleLawFirmId };
  }),
);

// GET /api/signing/:token/status (public, lightweight status poll for the
// waiting-signer page. ONE query, no field normalization, no audit write.
router.get('/:token/status', signingReadLimiter, handler(async (req, res) => {
  const row = await repo.getParticipantStatusByToken(req.params.token);
  if (!row) throw new NotFoundError('Signing session');
  return res.status(200).json({
    sessionStatus: row.session_status || null,
    participantStatus: row.participant_status || null,
    totalParticipants: Number(row.total) || 0,
    completedParticipants: Number(row.completed) || 0,
  });
}));

// GET /api/signing/:token (public, returns session metadata)
router.get('/:token', signingReadLimiter, optionalVerifyToken, handler(async (req, res) => {
  const { token } = req.params;
  const resolved = await resolveSigningContext(token, req.user?.uid || null);

  if (!resolved) {
    // Item 1: single-use links are consumed (not deleted) on completion. If
    // this token genuinely belonged to a participant who already COMPLETED,
    // return a distinguishable 200 so a reloaded completed link renders the
    // friendly "Your Signature Is Complete" screen instead of InvalidLinkPage.
    const completed = await repo.getConsumedTokenCompletion(token);
    if (completed) {
      return res.status(200).json({
        status: 'completed',
        alreadySigned: true,
        participantStatus: 'completed',
        participantRole: completed.roleLabel,
        fileName: completed.fileName,
      });
    }
    throw new AppError('Signing session not found or expired', 404, 'NOT_FOUND');
  }

  const data = resolved.sessionData;
  ensureNormalizedSessionFields(resolved.sessionRef, data);
  if (isSessionExpired(data)) {
    throw new AppError('This signing link has expired', 410, 'GONE');
  }

  const { participant, facilitatedSigning } = resolveAuthorizedParticipant(resolved, req.user);
  if (!participant) {
    throw new ForbiddenError('You do not have access to this signing session');
  }

  const requiresAccessCode = !!participant.accessCodeHash;
  const accessCodeVerified = !!participant.accessCodeVerified;
  const accessCodePending = requiresAccessCode && !accessCodeVerified;

  if (accessCodePending) {
    // Until the access code is validated, expose only what the code-entry
    // screen needs. The file name, signer names, and progress counters stay
    // hidden so an unauthorized holder of the link learns nothing about the
    // document or its signers before clearing the gate.
    return res.status(200).json({
      requiresAccessCode,
      accessCodeVerified,
      status: data.status || 'pending',
      maskedEmail: participant.email ? maskEmail(participant.email) : null,
    });
  }

  maybeWriteSessionViewed({
    sessionRef: resolved.sessionRef,
    sessionId: resolved.sessionId,
    data,
    participant,
    req,
    facilitatedSigning,
  }).catch((err) => console.error('[audit] SESSION_VIEWED failed:', err.message));

  if (participant.status !== 'active') {
    return res.status(200).json({
      ...buildSessionStatusPayload(data, participant),
      fields: [],
      requiresAccessCode,
      accessCodeVerified,
    });
  }

  const participantFields = (data.fields || []).filter((field: any) => field.signerId === participant.participantId);

  return res.status(200).json({
    ...buildSessionStatusPayload(data, participant),
    fileName: data.fileName,
    fields: participantFields,
    // The fingerprint of the document and field layout this response describes.
    // The signer echoes it back on completion so a sender edit made while the
    // page was open is caught instead of having the signer's coordinates applied
    // to a document they never saw.
    sourceRevision: computeSigningViewRevision(data),
    objectPath: participant.workingObjectPath || data.workingObjectPath || data.objectPath,
    lawFirmId: data.lawFirmId,
    destinationFolderId: data.destinationFolderId || null,
    destinationLabel: data.destinationLabel || null,
    requiresAccessCode,
    accessCodeVerified,
    publicToken: participant.publicToken || resolved.participantToken || null,
    facilitatedSigning,
  });
}));

// GET /api/signing/:token/file (public, mints a short-lived read URL)
router.get('/:token/file', signingReadLimiter, optionalVerifyToken, handler(async (req, res) => {
  const { token } = req.params;
  let resolved = await resolveSigningContext(token, req.user?.uid || null);
  if (!resolved) {
    const completed = await repo.getCompletedSessionByParticipantToken(token);
    if (completed?.participant) {
      resolved = {
        sessionId: completed.sessionData.token,
        sessionRef: makeSessionRef(completed.sessionData.token),
        sessionData: completed.sessionData,
        participant: completed.participant,
        participantToken: token,
      };
    }
  }
  if (!resolved) throw new AppError('Signing session not found or expired', 404, 'NOT_FOUND');

  const sessionData = resolved.sessionData;
  if (isSessionExpired(sessionData)) {
    throw new AppError('This signing link has expired', 410, 'GONE');
  }

  const { participant, facilitatedSigning } = resolveAuthorizedParticipant(resolved, req.user);
  if (!participant) {
    throw new ForbiddenError('You do not have access to this document');
  }
  if (participant.accessCodeHash && !participant.accessCodeVerified) {
    throw new ForbiddenError('Access code verification required before accessing this document');
  }
  if (participant.status !== 'active' && participant.status !== 'completed') {
    throw new ForbiddenError(participant.status === 'waiting' ? 'It is not your turn to sign yet' : 'This document is no longer editable for you');
  }

  maybeWriteDocumentViewed({
    sessionRef: resolved.sessionRef,
    sessionId: resolved.sessionId,
    data: sessionData,
    participant,
    req,
    facilitatedSigning,
  }).catch((err) => console.error('[audit] DOCUMENT_VIEWED failed:', err.message));

  // Sign the exact generation only after the same gate above has passed. The
  // public page then fetches GCS directly, which keeps every PDF range out of
  // the API instance that is also preparing and sealing documents.
  const disposition = req.query.disposition === 'attachment' ? 'attachment' : 'inline';
  const read = await mintSigningReadUrl({
    token,
    userId: req.user?.uid || null,
    disposition,
  });

  let sizeBytes = 0;
  try {
    const [meta] = await bucket.file(read.objectPath).getMetadata();
    sizeBytes = Number(meta.size || 0);
  } catch {
    // Non-fatal if metadata fetch fails
  }

  return res.json({
    url: read.url,
    fileName: read.fileName,
    contentType: read.contentType,
    sizeBytes,
    generation: read.generation,
    expiresAt: read.expiresAt,
  });
}));

// POST /api/signing/:token/complete-upload-init (public, participant token)
//
// A FIELDLESS session's executed document is produced in the browser, freehand,
// so nothing on the server can reproduce it and it has to arrive from there.
// It used to arrive as a multipart body, which made this the last route in the
// module holding a whole document in the process. The browser now puts it in
// the session's own working prefix and the completion names it.
router.post('/:token/complete-upload-init',
  signingActionLimiter,
  optionalVerifyToken,
  handler(async (req: any) => {
    const { token } = req.params;
    const resolved = await resolveSigningContext(token, req.user?.uid || null);
    if (!resolved) throw new AppError('Signing session not found or expired', 404, 'NOT_FOUND');
    if (isSessionExpired(resolved.sessionData)) {
      throw new AppError('This signing link has expired', 410, 'GONE');
    }

    const { participant } = resolveAuthorizedParticipant(resolved, req.user);
    if (!participant) throw new ForbiddenError('You do not have access to this document');
    if (participant.accessCodeHash && !participant.accessCodeVerified) {
      throw new ForbiddenError('Access code verification required before accessing this document');
    }
    if (participant.status !== 'active') {
      throw new ForbiddenError(participant.status === 'waiting'
        ? 'It is not your turn to sign yet'
        : 'This document is no longer editable for you');
    }
    if (shouldRebuildSessionPdfFromFieldValues(resolved.sessionData)) {
      // A session with fields is rebuilt from the values its signers submitted.
      // Accepting bytes for one would let a signer replace the document the
      // server would otherwise produce from what they actually agreed to.
      throw new ValidationError('This session is completed from its field values.');
    }

    return beginDirectUpload({
      objectPath: `${completionUploadPrefix(resolved.sessionData.lawFirmId, resolved.sessionId)}${crypto.randomUUID()}.pdf`,
      contentType: 'application/pdf',
      // The participant, not a firm user: a public signer has no account here.
      uploadedBy: `participant:${participant.participantId}`,
      maxBytes: SIGNING_MAX_FILE_BYTES,
      allowedContentTypes: ['application/pdf'],
      fileName: String(req.body?.fileName || 'signed.pdf'),
      declaredSize: Number(req.body?.size) || undefined,
      origin: req.get('origin') || undefined,
      metadata: { cacheControl: 'private, max-age=0, no-transform' },
    });
  }),
);

router.post('/:token/complete',
  // First in the chain, so the inline finalize budget counts the time the
  // limiter and token check took against the request deadline as well.
  (req: any, _res: any, next: any) => {
    req.completionStartedAt = Date.now();
    next();
  },
  signingActionLimiter,
  optionalVerifyToken,
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    // What the finalize job deferred until after its transfer slot: the
    // completion emails. Started in the `finally` below, after the response is
    // written, so a slow mail provider never stands between a finished document
    // and the signer's answer. Durable either way: the publication records the
    // delivery as owed, and the drain sends it if this process never does.
    let afterResponse: (() => Promise<void>) | null = null;
    // Set when the inline finalize found every transfer slot busy. The job is
    // committed and owed; this instance starts its own drain once the signer
    // has been answered, so the document is produced as soon as a slot frees
    // rather than on the next cron tick.
    let drainOwner: string | null = null;
    try {
      const { token } = req.params;

      // JSON only. The multipart variant carried the executed document in the
      // request, which is the last place a whole one was resident in this
      // process. A fieldless session now uploads those bytes to storage through
      // `complete-upload-init` and names them here.
      if (!req.is('application/json')) {
        throw new AppError('Completion is a JSON request.', 415, 'UNSUPPORTED_MEDIA_TYPE');
      }

      let consent: any;
      let rawSubmittedFieldValues: any[];
      let submittedRevision: string | null = null;
      let idempotencyKey: string | null = null;

      const parsed = completeSigningJsonSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid consent data');
      }
      submittedRevision = parsed.data.sourceRevision;
      idempotencyKey = parsed.data.idempotencyKey;
      rawSubmittedFieldValues = parsed.data.fieldValues;
      // Stamp an authoritative server-side time alongside the client-supplied
      // consentTimestamp. The client value can be skewed or spoofed, so the
      // server clock is the trustworthy record of when consent was received.
      // The revision and the key are kept on the same record: it is what the
      // signer saw and how the submission is recognised again on a retry.
      consent = {
        consentAgreed: parsed.data.consentAgreed,
        consentName: parsed.data.consentName,
        consentTimestamp: parsed.data.consentTimestamp,
        serverConsentAt: new Date().toISOString(),
        sourceRevision: submittedRevision,
        idempotencyKey,
      };

      const resolved = await resolveSigningContext(token, req.user?.uid || null);
      if (!resolved) {
        const replay = await replayConsumedCompletion(token, idempotencyKey);
        if (replay) {
          return res.status(replay.status).json(replay.body);
        }
        throw new AppError('Signing session not found or expired', 404, 'NOT_FOUND');
      }

      const data = resolved.sessionData;
      ensureNormalizedSessionFields(resolved.sessionRef, data);

      if (isSessionExpired(data)) {
        throw new AppError('This signing link has expired', 410, 'GONE');
      }

      const { participant: resolvedParticipant, facilitatedSigning } = resolveAuthorizedParticipant(resolved, req.user);
      if (!resolvedParticipant) {
        throw new ForbiddenError('You do not have access to this signing session');
      }
      // A retry that still resolves a session: the same submission arriving
      // twice, reported with whatever outcome the session is in now rather than
      // as a conflicting second signature.
      if (resolvedParticipant.status === 'completed'
        && idempotencyKey && resolvedParticipant.consent?.idempotencyKey === idempotencyKey) {
        const outstanding = (data.participants || [])
          .filter((entry: any) => entry.status !== 'completed').length;
        const state = replayState(data.status, outstanding);
        const active = (data.participants || []).find((entry: any) => entry.status === 'active');
        return res.status(COMPLETION_OUTCOMES[state]).json(
          completionBody(state, { nextSignerName: active?.name || null }),
        );
      }
      if (data.status === 'cancelled') {
        throw new ConflictError('This signing session has been cancelled');
      }
      if (data.status === 'completed') {
        throw new ConflictError('This document has already been completed');
      }
      if (resolvedParticipant.accessCodeHash && !resolvedParticipant.accessCodeVerified) {
        throw new ForbiddenError('Access code verification required before signing this document');
      }
      if (resolvedParticipant.status !== 'active') {
        throw new ConflictError(resolvedParticipant.status === 'waiting' ? 'It is not your turn to sign yet' : 'This signer has already completed their turn');
      }

      // A field is a rectangle on a page of a particular document, and a
      // completion submits values for those rectangles rather than a rendered
      // result. If the sender moved a field or replaced the document while the
      // signer had the page open, applying these coordinates would stamp the
      // signature onto whatever now occupies that space.
      //
      // A FIELDLESS session has no rectangles to submit values for. It names an
      // uploaded object instead: without one there is nothing to execute, and
      // nothing on the server can reproduce marks that were drawn freehand in a
      // browser.
      if (!shouldRebuildSessionPdfFromFieldValues(data) && !req.body?.signedObjectPath) {
        throw new AppError(
          'This document has no signature fields, so its signed copy has to be uploaded.',
          422, 'SIGNING_SOURCE_NOT_REBUILDABLE',
        );
      }
      if (submittedRevision !== computeSigningViewRevision(data)) {
        throw new AppError(
          'This document changed after you opened it. Reload the page and sign again.',
          409, 'SOURCE_REVISION_STALE',
        );
      }

      const routingMode = data.routingMode || 'sequential';

      // Field ownership: a participant may submit values only for fields assigned
      // to them (a field's signerId equals the participantId) or for unassigned
      // fields. Reject any value targeting another signer's field so a later
      // signer can never overwrite (forge) an earlier signer's signature or
      // entry.
      const foreignFieldIds = findForeignFieldSubmissions(
        data.fields,
        resolvedParticipant.participantId,
        rawSubmittedFieldValues,
      );
      if (foreignFieldIds.length > 0) {
        throw new ValidationError('You cannot submit values for fields assigned to another signer.');
      }

      // Persist only this participant's own field values (drop anything not
      // owned), so a foreign value can never be stored and later stamped into
      // another signer's field.
      const submittedFieldValues = filterValuesToParticipant(
        data.fields,
        resolvedParticipant.participantId,
        rawSubmittedFieldValues,
      );

      // Before anything measures or stores a value. See SIGNING_TEXT_VALUE_MAX_CHARS.
      const oversizedText = findOversizedTextValue(data.fields, submittedFieldValues);
      if (oversizedText) {
        throw new AppError(
          `A field value is ${oversizedText.length} characters; the most a field can hold is ${SIGNING_TEXT_VALUE_MAX_CHARS}.`,
          400, 'SIGNING_TEXT_TOO_LONG',
        );
      }

      // Bound the images before anything decodes or embeds one. A PNG is
      // compressed, so its byte size says nothing about what decoding it costs:
      // a few hundred bytes can announce a bitmap of hundreds of millions of
      // pixels. The header's declared dimensions do say, and reading them
      // inflates nothing, so both bounds are applied here rather than after the
      // embed probe below has already paid for the decode.
      const imageViolation = findImageLimitViolation(submittedFieldValues);
      if (imageViolation) {
        throw imageLimitError(imageViolation);
      }

      // Enforce that this signer actually filled the required fields assigned
      // to them. Without this, a request omitting field values would finalize
      // a document with blank signature/initials fields (stamping silently
      // skips empty values), producing an unsigned "signed" PDF.
      const missingRequiredFields = findMissingRequiredFields(
        data.fields,
        resolvedParticipant.participantId,
        submittedFieldValues,
      );
      if (missingRequiredFields.length > 0) {
        throw new ValidationError('Please complete all required fields before signing.');
      }
      // Reject a signature/initials image whose PNG header is valid but whose body
      // can't be embedded: it would pass the check above, get stored, then throw at
      // finalize and permanently wedge this session (and the recovery cron).
      const unembeddable = await findUnembeddableSignatureFields(data.fields, submittedFieldValues);
      if (unembeddable.length > 0) {
        throw new ValidationError('One or more signature images are invalid or corrupted. Please clear and re-sign.');
      }

      // Validate a fieldless upload before the transaction consumes the
      // participant token or records consent. A refusal must leave the signer
      // able to correct the upload and submit again.
      let uploadedRef: { objectPath: string; generation: string; sizeBytes: number } | null = null;
      let uploadedCompletionPath: string | null = null;
      if (!shouldRebuildSessionPdfFromFieldValues(data)) {
        const named = String(req.body?.signedObjectPath || '');
        const prefix = completionUploadPrefix(data.lawFirmId, resolved.sessionId);
        if (!named.startsWith(prefix) || named.slice(prefix.length).includes('/')) {
          throw new ValidationError('That upload does not belong to this session.');
        }
        const settled = await settleDirectUpload({
          objectPath: named,
          uploadedBy: `participant:${resolvedParticipant.participantId}`,
          maxBytes: SIGNING_MAX_FILE_BYTES,
          allowedContentTypes: ['application/pdf'],
          fileName: 'signed.pdf',
        });
        const originalHandle = bucket.file(data.objectPath);
        const [originalMeta] = await originalHandle.getMetadata();
        const originalRef = {
          objectPath: data.objectPath,
          generation: String(originalMeta.generation || ''),
          sizeBytes: Number(originalMeta.size || 0),
        };
        const uploadedSource = openGcsPdfSource({
          objectPath: settled.objectPath,
          generation: settled.generation,
          sizeBytes: settled.size,
        });
        const originalSource = openGcsPdfSource(originalRef);
        let uploadedPages: number;
        let originalPages: number;
        try {
          const signal = new AbortController().signal;
          const [uploadedIndex, originalIndex] = await Promise.all([
            readDocumentIndex(uploadedSource, signal), readDocumentIndex(originalSource, signal),
          ]);
          [uploadedPages, originalPages] = await Promise.all([
            resolvePages(uploadedSource, uploadedIndex, signal).then((pages) => pages.length),
            resolvePages(originalSource, originalIndex, signal).then((pages) => pages.length),
          ]);
        } catch {
          throw new ValidationError('The uploaded signed document is not a readable PDF.');
        } finally {
          await Promise.all([uploadedSource.close(), originalSource.close()]);
        }
        if (uploadedPages !== originalPages) {
          throw new ValidationError('The signed document does not match the original document.');
        }
        uploadedRef = { objectPath: settled.objectPath, generation: settled.generation, sizeBytes: settled.size };
        uploadedCompletionPath = named;
      }
      const signerUid = facilitatedSigning
        ? (resolvedParticipant.memberUserId || resolvedParticipant.clientUserId || null)
        : (req.user?.uid || resolvedParticipant.memberUserId || resolvedParticipant.clientUserId || null);
      const facilitatedBy = facilitatedSigning ? req.user?.uid || null : null;
      const { ip: signerIp, userAgent: signerUserAgent } = extractRequestMeta(req);
      // Authoritative signing time is the server-captured consent timestamp, not
      // the client-supplied consent.consentTimestamp (which can be skewed or
      // spoofed). The client-reported value stays recorded on the `consent`
      // object for the audit trail.
      const completedAtTs = consent.serverConsentAt;
      const startedAt = new Date().toISOString();
      let participant = resolvedParticipant;
      let sessionForNotifications = data;
      let updatedParticipants = [];
      let nextParticipantsState = [];
      let nextParticipant = null;
      let finalizing = false;
      /** The durable finalize job this completion committed, when it is the last. */
      let finalizeJobId: string | null = null;
      /** How the job ended, when one ran here. Null on every other path. */
      let jobState: string | null = null;
      let jobFailure: { retryable: boolean; code: string; error: string } | null = null;

      // Resolved BEFORE the transaction, because a read of its own has no
      // business inside the lock the signer's consent is committed under.
      // Every session names an admitted source, so the finalize job always has
      // one to hang from. A fieldless session's executed document is the copy
      // the signer uploaded, so its SIZE, not the source's, decides whether
      // the job may finish inside this request.
      const rebuildable = shouldRebuildSessionPdfFromFieldValues(data);
      const source = await finalizeSource(data);
      const finalizeSourceId = source?.id || null;
      const finalizeSourceBytes = rebuildable
        ? Number(source?.sizeBytes || 0)
        : Number(uploadedRef?.sizeBytes || 0);

      if (routingMode === 'parallel') {
        const txResult = await repo.runSessionTransaction(resolved.sessionId, async (freshData: any, transaction: any) => {
          const freshParticipant = facilitatedSigning
            ? getActiveParticipant(freshData)
            : getParticipantById(freshData, resolvedParticipant.participantId);

          if (!freshParticipant) {
            const err: any = new Error('You do not have access to this signing session');
            err.statusCode = 403;
            throw err;
          }
          if (freshData.status === 'cancelled') {
            const err: any = new Error('This signing session has been cancelled');
            err.statusCode = 409;
            throw err;
          }
          if (freshData.status === 'completed') {
            const err: any = new Error('This document has already been completed');
            err.statusCode = 409;
            throw err;
          }
          if (freshParticipant.status !== 'active') {
            const err: any = new Error('This signer has already completed their turn');
            err.statusCode = 409;
            throw err;
          }

          const completedParticipants = updateParticipant(freshData, freshParticipant.participantId, (currentParticipant: any) => ({
            ...currentParticipant,
            status: 'completed',
            completedAt: completedAtTs,
            startedAt: currentParticipant.startedAt || startedAt,
            consent,
            signerUid,
            signerName: consent.consentName,
            signerIp,
            facilitatedBy,
            fieldValues: submittedFieldValues,
          }));

          const allCompleted = completedParticipants.every((entry: any) => entry.status === 'completed');

          // Targeted single-participant write for the just-completed signer
          // (was a whole-array replaceParticipants loop via updateSession).
          await transaction.updateParticipant(freshParticipant.participantId, {
            status: 'completed',
            completedAt: completedAtTs,
            startedAt: freshParticipant.startedAt || startedAt,
            consent,
            signerUid,
            signerName: consent.consentName,
            signerIp,
            facilitatedBy,
            fieldValues: submittedFieldValues,
          });
          // Defer the terminal 'completed' flip until after the sealed artifact
          // is durably stored (handled post-transaction). Committing 'completed'
          // here and then failing during build/seal/upload would leave a
          // "completed" session with no downloadable document. The session stays
          // 'in_progress' with all participants completed, a retryable state the
          // finalize step (or recovery pass) resolves.
          await transaction.updateSession({
            status: 'in_progress',
            currentSignerOrder: null,
          });

          // S4: single-use link: invalidate this signer's public token now that
          // their turn is done so a leaked link can't be reused. Other signers'
          // tokens (different participant_id) are untouched.
          await transaction.invalidateParticipantToken(freshParticipant.participantId);

          // The work is committed WITH the consent that owes it. Enqueued after
          // this transaction it would be lost by a process that died in between,
          // and the session would sit with every signature, no document, and
          // nothing recording that anything was owed.
          if (allCompleted && !rebuildable && uploadedRef) {
            // The copy the job seals, recorded WITH the consent, so a process
            // that dies here still owes exactly one artifact set from exactly
            // these bytes.
            await transaction.updateSession({ workingObjectPath: uploadedRef.objectPath });
          }
          const job = allCompleted && finalizeSourceId
            ? await transaction.enqueueProcessingJob({
              sourceId: finalizeSourceId,
              kind: 'finalize',
              inputRevision: computeSigningViewRevision(freshData),
            })
            : null;

          return {
            participant: freshParticipant,
            sessionData: freshData,
            updatedParticipants: completedParticipants,
            nextParticipantsState: completedParticipants,
            nextParticipant: null,
            finalizing: allCompleted,
            finalizeJobId: job?.id || null,
          };
        });

        participant = txResult.participant;
        sessionForNotifications = txResult.sessionData;
        updatedParticipants = txResult.updatedParticipants;
        nextParticipantsState = txResult.nextParticipantsState;
        nextParticipant = txResult.nextParticipant;
        finalizing = txResult.finalizing;
        finalizeJobId = txResult.finalizeJobId;
      } else {
        // S3: sequential completion now also runs through runSessionTransaction
        // so the session + participants are re-read under a FOR UPDATE row lock
        // (matches the parallel and /decline paths). Two concurrent completes
        // can no longer clobber each other / double-advance.
        const txResult = await repo.runSessionTransaction(resolved.sessionId, async (freshData: any, transaction: any) => {
          const freshParticipant = facilitatedSigning
            ? getActiveParticipant(freshData)
            : getParticipantById(freshData, resolvedParticipant.participantId);

          if (!freshParticipant) {
            const err: any = new Error('You do not have access to this signing session');
            err.statusCode = 403;
            throw err;
          }
          if (freshData.status === 'cancelled') {
            const err: any = new Error('This signing session has been cancelled');
            err.statusCode = 409;
            throw err;
          }
          if (freshData.status === 'completed') {
            const err: any = new Error('This document has already been completed');
            err.statusCode = 409;
            throw err;
          }
          if (freshParticipant.status !== 'active') {
            const err: any = new Error('This signer has already completed their turn');
            err.statusCode = 409;
            throw err;
          }

          const completedParticipants = updateParticipant(freshData, freshParticipant.participantId, (currentParticipant: any) => ({
            ...currentParticipant,
            status: 'completed',
            completedAt: completedAtTs,
            startedAt: currentParticipant.startedAt || startedAt,
            consent,
            signerUid,
            signerName: consent.consentName,
            signerIp,
            facilitatedBy,
            fieldValues: submittedFieldValues,
          }));

          const next = completedParticipants
            .filter((entry: any) => entry.status === 'waiting')
            .sort((a: any, b: any) => a.order - b.order)[0] || null;
          const isFinal = !next;
          const promotedParticipants = next
            ? completedParticipants.map((entry: any) => entry.participantId === next.participantId
                ? { ...entry, status: 'active', startedAt: entry.startedAt || startedAt }
                : entry)
            : completedParticipants;

          // Targeted single-participant write for the just-completed signer
          // (was a whole-array replaceParticipants loop via updateSession).
          await transaction.updateParticipant(freshParticipant.participantId, {
            status: 'completed',
            completedAt: completedAtTs,
            startedAt: freshParticipant.startedAt || startedAt,
            consent,
            signerUid,
            signerName: consent.consentName,
            signerIp,
            facilitatedBy,
            fieldValues: submittedFieldValues,
          });
          // Promote only the next waiting signer to active (one more targeted
          // write) instead of rewriting the whole participant array.
          if (next) {
            const nextFresh = getParticipantById(freshData, next.participantId);
            await transaction.updateParticipant(next.participantId, {
              status: 'active',
              startedAt: (nextFresh && nextFresh.startedAt) || startedAt,
            });
          }
          // Defer the terminal 'completed' flip until after the sealed artifact
          // is durably stored (handled post-transaction). For a non-final signer
          // this still advances to the next waiting signer. The final signer
          // leaves the session 'in_progress' with everyone completed, a
          // retryable state resolved once the signed document is persisted.
          await transaction.updateSession({
            status: 'in_progress',
            currentSignerOrder: next ? next.order : null,
          });

          // S4: single-use link: invalidate this signer's public token now that
          // their turn is done. The next signer's token (different participant_id)
          // stays valid so the sequential flow continues uninterrupted.
          await transaction.invalidateParticipantToken(freshParticipant.participantId);

          // Same reason as the parallel branch: the job is part of the commit
          // that recorded the last signature, not a follow-up to it.
          if (isFinal && !rebuildable && uploadedRef) {
            await transaction.updateSession({ workingObjectPath: uploadedRef.objectPath });
          }
          const job = isFinal && finalizeSourceId
            ? await transaction.enqueueProcessingJob({
              sourceId: finalizeSourceId,
              kind: 'finalize',
              inputRevision: computeSigningViewRevision(freshData),
            })
            : null;

          return {
            participant: freshParticipant,
            sessionData: freshData,
            updatedParticipants: completedParticipants,
            nextParticipantsState: promotedParticipants,
            nextParticipant: next,
            finalizing: isFinal,
            finalizeJobId: job?.id || null,
          };
        });

        participant = txResult.participant;
        sessionForNotifications = txResult.sessionData;
        updatedParticipants = txResult.updatedParticipants;
        nextParticipantsState = txResult.nextParticipantsState;
        nextParticipant = txResult.nextParticipant;
        finalizing = txResult.finalizing;
        finalizeJobId = txResult.finalizeJobId;
      }

      const baseName = data.fileName.replace(/\.pdf$/i, '');
      const signedFileName = `${baseName} (Signed).pdf`;
      const safeName = signedFileName.replace(/[^a-zA-Z0-9._() -]/g, '_');
      const destination = data.destinationFolderId || null;
      // Assigned by the finalize branch below once the executed copy has a
      // resolved, non-colliding home. Null until then, and stays null for an
      // intermediate signer (whose audit records the working copy instead).
      let finalObjectPath = null;

      // The copy delivered to signers/portal/notify recipients: the signed
      // document WITHOUT the Certificate of Completion page. Populated by the
      // finalize step below.
      // Null for a session with fields, which submits values rather than a
      // document: both the working copy and the executed copy are rebuilt from
      // the stored original plus the accumulated field values.
      //
      // A FIELDLESS session names an object it uploaded instead. The path is
      // caller input that becomes an executed legal document, so it is checked
      // against this session's own prefix and verified against what storage
      // recorded before a byte of it is read.
      /** Where the delivered copy landed, for the fieldless path's recipients. */
      let deliveryArtifact: { objectPath: string; generation: string | null; sizeBytes: number } | null = null;
      let signedDocumentHash = data.signedDocumentHash || null;
      let deliveryDocumentHash = data.deliveryDocumentHash || null;
      // For an intermediate (non-final) signer, the audit records the working
      // copy this signer produced. Captured in the !finalizing branch below.
      let intermediateObjectPath = null;
      let intermediateHash = null;

      if (!finalizing) {
        // Refresh the working copy so the NEXT signer views the document with
        // the marks accumulated so far. Never write over the pristine original
        // (data.objectPath): it is the immutable source the authoritative signed
        // PDF is rebuilt from at finalize. Sequential sessions otherwise share
        // the original path, so redirect that write to a dedicated working-copy
        // path and point the session at it.
        if (Array.isArray(data.fields) && data.fields.length > 0) {
          const workingCopyPath = sessionWorkingCopyPath(
            data.lawFirmId, resolved.sessionId, `${participant.participantId}.pdf`,
          );
          const rebuilt = await buildFieldStampedWorkingCopy({
            sessionData: data,
            participants: nextParticipantsState,
            destination: workingCopyPath,
          });
          intermediateObjectPath = rebuilt.ref.objectPath;
          intermediateHash = rebuilt.hash;
          if (data.workingObjectPath !== workingCopyPath) {
            await resolved.sessionRef.update({ workingObjectPath: workingCopyPath });
          }
        } else if (uploadedRef) {
          intermediateObjectPath = uploadedRef.objectPath;
          // A browser-produced copy has no saved state to resume, so hashing it
          // is a full read. It happens only at a size the final turn would
          // also finish inside the request; above that the audit row records
          // no intermediate hash, and the executed document is hashed by the
          // finalize job that seals it.
          intermediateHash = uploadedRef.sizeBytes <= SIGNING_INLINE_FINALIZE_BYTES
            ? await hashStoredObject(uploadedRef)
            : null;
          await resolved.sessionRef.update({ workingObjectPath: uploadedRef.objectPath });
        }
      } else if (finalizeJobId) {
        // The artifacts are DURABLE WORK now, committed in the same transaction
        // as the consent that owes them. Running the job here is only an
        // optimization: a document small enough to finish while the signer is
        // still on the page should finish there rather than wait for a
        // scheduler. If this process dies at this instant the job is still
        // owed and the drain produces exactly one artifact set, which is the
        // whole reason it is a row.
        //
        // It claims through the same lease as the drain and as the recovery
        // pass, so no two of them can ever be inside one session's finalize.
        // A claim that loses is not a failure: the job is somebody's, and the
        // page polls.
        const owner = `request:${req.id || process.pid}`;
        //
        // The queue wait is bounded by what is left of this request's deadline,
        // so a saturated slot answers `processing` rather than 504.
        const runsInline = finalizeSourceBytes <= SIGNING_INLINE_FINALIZE_BYTES;
        const outcome = runsInline
          ? await runJobNow(data.lawFirmId, finalizeJobId, owner, {
            queueTimeoutMs: inlineFinalizeQueueBudgetMs(req.completionStartedAt || Date.now()),
            deferAfterSlot: (run: () => Promise<void>) => { afterResponse = run; },
          })
          : 'busy';
        const settled = await repo.getProcessingJob(data.lawFirmId, finalizeJobId);
        jobState = completionStateForJob(outcome, settled?.failureCode || null);
        // Only a document that would have run here. One over the inline size is
        // left to the cron on purpose: that drain holds a request, and so CPU,
        // for as long as a large seal takes.
        if (runsInline && outcome === 'busy') drainOwner = `background:${req.id || process.pid}`;
        if (jobState !== 'completed') {
          console.error('[signing] Finalize did not settle in the signer request', {
            tokenRef: tokenRef(token),
            outcome,
            code: settled?.failureCode || null,
          });
          jobFailure = {
            retryable: jobState !== 'permanent_refusal',
            code: settled?.failureCode || 'FINALIZE_RETRYING',
            error: jobState === 'permanent_refusal'
              ? (settled?.failureDetail || 'This document cannot be executed.')
              : 'Your signature was recorded. The executed document is still being produced.',
          };
        }
      } else {
        // Finalizing with no job is not a state this route can produce: every
        // session names a source, and the job is committed with the consent.
        // Reporting `completed` here would tell a signer their document exists
        // when nothing is owed to produce it.
        throw new AppError('The finalize job was not committed.', 500, 'SIGNING_FINALIZE_NOT_COMMITTED');
      }

      // Item 7: record which identity gate(s) the signer actually cleared so
      // the completion audit carries the assurance basis for this signature
      // (access code, authenticated firm/client user) rather than relying
      // solely on the self-entered consent name.
      const gatesPassed = [];
      if (participant.accessCodeHash && participant.accessCodeVerified) gatesPassed.push('access_code');
      if (req.user?.uid) gatesPassed.push('authenticated');
      if (facilitatedSigning) gatesPassed.push('facilitated');

      // Not awaited by this request: the signer is waiting on the response and
      // an audit insert should not sit in front of it. The handle is kept
      // because the certificate archive below has to be rendered AFTER these
      // rows exist, and once frozen it is what every later download returns.
      const pendingAuditWrites = Promise.allSettled([
        writeAuditEvent(resolved.sessionId, AUDIT_EVENTS.CONSENT_GIVEN, {
          req,
          actorUid: signerUid || facilitatedBy,
          metadata: {
            participantId: participant.participantId,
            consentName: consent.consentName,
            consentTimestamp: consent.consentTimestamp,
            serverConsentAt: consent.serverConsentAt,
            deliveryMethod: participant.deliveryMethod || null,
            facilitatedBy,
          },
        }),
        // NOT written on the durable path. There the completion row belongs to
        // whichever worker actually publishes the session, and it is written
        // there so the frozen certificate can be ordered after it as a fact
        // rather than as a race. Writing it here as well would put a completion
        // in the evidentiary record before the document backing it exists.
        finalizeJobId ? Promise.resolve(null) : writeAuditEvent(resolved.sessionId, AUDIT_EVENTS.SESSION_COMPLETED, {
          req,
          actorUid: signerUid || facilitatedBy,
          metadata: {
            participantId: participant.participantId,
            signedDocumentHash: finalizing ? signedDocumentHash : intermediateHash,
            deliveryDocumentHash: finalizing ? deliveryDocumentHash : null,
            signedObjectPath: finalizing ? finalObjectPath : intermediateObjectPath,
            signerName: consent.consentName,
            gatesPassed,
            finalizing,
            deliveryMethod: participant.deliveryMethod || null,
            facilitatedBy,
          },
        }),
      ]);
      pendingAuditWrites.then((results) => {
        const labels = ['CONSENT_GIVEN', 'SESSION_COMPLETED'];
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.error(`[audit] ${labels[index]} failed:`, result.reason?.message || result.reason);
          }
        });
      });

      // Put the evidentiary record in the archive as soon as the session is
      // finished, so it exists whether or not anyone ever downloads it. On the
      // durable path this happens inside the publication, for the drain's sake:
      // a step that lives in the request never runs for a session the request
      // did not finish.
      if (finalizing && !finalizeJobId) {
        archiveCertificateAfterCompletion(resolved.sessionId, pendingAuditWrites);
      }

      if (!finalizing && participant.email) {
        const completedCount = updatedParticipants.filter((entry: any) => entry.status === 'completed').length;
        sendSignerConfirmationEmail({
          to: participant.email,
          recipientName: consent.consentName || participant.name,
          fileName: data.fileName,
          completedCount,
          totalParticipants: updatedParticipants.length,
          replyTo: data.notifyEmail || undefined,
        }).catch((err: any) => console.error('[signing] Signer confirmation email failed:', err.message));
      }

      if (nextParticipant && routingMode !== 'parallel') {
        const activatedParticipant = getParticipantById({ participants: nextParticipantsState }, nextParticipant.participantId);
        await notifyNextParticipant({
          sessionId: resolved.sessionId,
          sessionData: sessionForNotifications,
          participant: activatedParticipant,
        });
      }

      // Gate completion side-effects on `finalizing` (every participant done),
      // not `!nextParticipant`. In parallel routing there is never a "next"
      // signer, so `!nextParticipant` is true after each individual signer and
      // would fire these once per signer with a partially-signed attachment.
      // `finalizing` is only true once the last signer completes, in both
      // sequential and parallel modes.
      //
      // Only on the fieldless path. The durable path delivers from the
      // publication, so a session finished by the drain reaches its signers too.
      if (finalizing && !finalizeJobId) {
        await deliverCompletedSession({
          sessionId: resolved.sessionId,
          data: { ...data, signerName: consent.consentName },
          participants: nextParticipantsState,
          delivery: deliveryArtifact,
          signedFileName,
          safeName,
        });
      }

      // Surface completion in the firm's in-app notification feed. Best-effort:
      // a notification failure must never fail the signer's completion request.
      if (finalizing && !finalizeJobId) {
        try {
          const { matterId } = await destinationScope(data.lawFirmId, data.destinationFolderId);
          eventBus.emit(SIGNING_COMPLETED, {
            lawFirmId: data.lawFirmId,
            sessionId: resolved.sessionId,
            fileName: data.fileName,
            initiatorUserId: data.createdBy || null,
            matterId: matterId || null,
            actorUserId: signerUid || facilitatedBy || null,
          });
        } catch (err: any) {
          console.error('[signing] SIGNING_COMPLETED emit failed:', err.message);
        }
      }

      const state = finalizing ? (jobState || 'completed') : 'waiting_for_others';
      // The request deadline may already have answered 504 while this kept
      // working. The completion still happened, so there is nothing to report
      // as a failure, and a second write would only throw.
      if (res.headersSent) {
        console.warn('[signing] Completion answered after the request deadline', {
          tokenRef: tokenRef(token),
          state,
        });
        return;
      }
      res.status(COMPLETION_OUTCOMES[state]).json(completionBody(state, {
        nextSignerName: nextParticipant?.name || null,
        ...(jobFailure ? { success: false, ...jobFailure } : {}),
      }));
      return;
    } catch (err: any) {
      console.error('[signing] Failed to complete signing session', {
        tokenRef: tokenRef(req.params.token),
        error: err.message,
      });
      next(err);
    } finally {
      // On every path, including a failure after the job ran: the job's own
      // steps are owed once it has published, whatever this request does next.
      // Tracked so it is never an unawaitable straggler; the runner logs its own
      // failures and never rejects.
      const pending = afterResponse as (() => Promise<void>) | null;
      if (pending) trackBackgroundWrite(pending());
      if (drainOwner) kickSigningDrain(drainOwner);
    }
  },
);

// POST /api/signing/:token/decline (public, a signer declines to sign).
// Mirrors /complete (public, optionalVerifyToken) and /cancel (terminal state):
// the declining participant is marked 'declined' and the session moves to the
// module's terminal cancellation state ('cancelled'), notifying the other party.
router.post('/:token/decline', signingActionLimiter, optionalVerifyToken, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : null;

    const resolved = await resolveSigningContext(token, req.user?.uid || null);
    if (!resolved) {
      throw new AppError('Signing session not found or expired', 404, 'NOT_FOUND');
    }

    const data = resolved.sessionData;
    if (isSessionExpired(data)) {
      throw new AppError('This signing link has expired', 410, 'GONE');
    }
    if (data.status === 'completed') {
      throw new ConflictError('This document has already been completed');
    }
    if (data.status === 'cancelled') {
      return res.status(200).json({ success: true, status: 'declined' });
    }

    let decliningParticipant = null;

    const { participant } = resolveAuthorizedParticipant(resolved, req.user);
    if (!participant) {
      throw new ForbiddenError('You do not have access to this signing session');
    }
    if (['completed', 'declined', 'cancelled'].includes(participant.status)) {
      throw new ConflictError('This signer can no longer decline this document');
    }
    decliningParticipant = participant;

    // Re-acquire the session FOR UPDATE and re-check terminal status under the
    // lock so a concurrent /complete (which also uses runSessionTransaction)
    // can't race us. If the session already reached a terminal state, treat
    // this as an idempotent no-op (matches the /complete handler's pattern).
    const txResult = await repo.runSessionTransaction(resolved.sessionId, async (freshData: any, transaction: any) => {
      if (freshData.status === 'completed') {
        return { alreadyTerminal: true, status: 'completed', updatedParticipants: freshData.participants || [] };
      }
      if (freshData.status === 'cancelled') {
        return { alreadyTerminal: true, status: 'cancelled', updatedParticipants: freshData.participants || [] };
      }

      const freshParticipant = getParticipantById(freshData, participant.participantId);
      if (freshParticipant && ['completed', 'declined', 'cancelled'].includes(freshParticipant.status)) {
        return { alreadyTerminal: true, status: freshData.status, updatedParticipants: freshData.participants || [] };
      }

      // The declining signer is marked 'declined'; completed signers keep
      // their status; everyone else is cancelled. The session itself moves
      // to the terminal 'cancelled' state (consistent with /cancel).
      const updated = (freshData.participants || []).map((entry: any) => {
        if (entry.participantId === participant.participantId) {
          return { ...entry, status: 'declined' };
        }
        if (entry.status === 'completed') return entry;
        return { ...entry, status: 'cancelled' };
      });

      await transaction.updateSession({
        status: 'cancelled',
        currentSignerOrder: null,
        participants: updated,
      });

      // The signers this decline cut off, read under the lock with the status
      // they held before it. sendCancellationNotifications skips anyone already
      // terminal, so handing it the post-decline rows would notify nobody.
      const cutOff = (freshData.participants || []).filter((entry: any) =>
        entry.participantId !== participant.participantId
        && !['completed', 'cancelled', 'declined'].includes(entry.status));

      return { alreadyTerminal: false, status: 'cancelled', updatedParticipants: updated, cutOff };
    });

    // A concurrent completion/cancellation/decline already finalized the
    // session. Return idempotently without re-notifying.
    if (!txResult || txResult.alreadyTerminal) {
      if (txResult?.status === 'completed') {
        throw new ConflictError('This document has already been completed');
      }
      return res.status(200).json({ success: true, status: 'declined' });
    }

    // A decline is terminal for the whole session, exactly like /cancel, so its
    // scratch copies have no remaining reader. /cancel has always swept them and
    // this path never did, which left a full PDF per participant behind for every
    // declined session. Not awaited, for the same reason /cancel does not: the
    // signer is waiting on this response and housekeeping must not delay it.
    sweepSessionWorkspace(data.lawFirmId, resolved.sessionId).catch((err: any) =>
      console.error('[signing] Workspace sweep failed for', resolved.sessionId, err.message));

    writeAuditEvent(resolved.sessionId, AUDIT_EVENTS.PARTICIPANT_DECLINED, {
      req,
      actorUid: req.user?.uid || decliningParticipant?.memberUserId || decliningParticipant?.clientUserId || null,
      metadata: {
        participantId: decliningParticipant?.participantId || null,
        participantName: decliningParticipant?.name || data.signerName || null,
        deliveryMethod: decliningParticipant?.deliveryMethod || null,
        reason: reason || null,
      },
    }).catch((err: any) => console.error('[audit] PARTICIPANT_DECLINED failed:', err.message));

    // Notify the sender (matches the /complete completion-notification path) plus
    // the remaining participants (matches /cancel notification behavior).
    if (data.notifyEmail) {
      sendSigningDeclinedEmail({
        to: data.notifyEmail,
        signerName: decliningParticipant?.name || data.signerName || 'A signer',
        fileName: data.fileName,
        reason,
      }).catch((err: any) => console.error('[signing] Decline notification email failed:', err.message));
    }

    // Only the signers the decline cut off, so the decliner is never sent the
    // notice meant for the others; `declinedBy` gives the decliner their own.
    sendCancellationNotifications({
      sessionData: { ...data, participants: txResult.cutOff },
      senderName: data.notifyName || 'Someone',
      senderEmail: data.notifyEmail || null,
      declinedBy: decliningParticipant,
    }).catch((err: any) => console.error('[signing] Decline participant notifications failed:', err.message));

    // Surface the decline in the firm's in-app notification feed. Best-effort:
    // a notification failure must never fail the signer's decline request.
    try {
      const { matterId } = await destinationScope(data.lawFirmId, data.destinationFolderId);
      eventBus.emit(SIGNING_DECLINED, {
        lawFirmId: data.lawFirmId,
        sessionId: resolved.sessionId,
        fileName: data.fileName,
        initiatorUserId: data.createdBy || null,
        matterId: matterId || null,
        signerName: decliningParticipant?.name || data.signerName || null,
        actorUserId: req.user?.uid || decliningParticipant?.memberUserId || decliningParticipant?.clientUserId || null,
      });
    } catch (err: any) {
      console.error('[signing] SIGNING_DECLINED emit failed:', err.message);
    }

    res.status(200).json({ success: true, status: 'declined' });
  } catch (err: any) {
    console.error('[signing] Failed to decline signing session', {
      tokenRef: tokenRef(req.params.token),
      error: err.message,
    });
    next(err);
  }
});

// POST /api/signing/:token/verify-access-code (public, verifies the sender-provided access code)
router.post('/:token/verify-access-code', signingGateLimiter, handler(async (req, res) => {
  const { token } = req.params;
  const { code } = req.body;

  if (!code || typeof code !== 'string') {
    throw new ValidationError('Access code is required');
  }

  const resolved = await resolveSigningContext(token, req.user?.uid || null);
  if (!resolved) {
    throw new AppError('Signing session not found or expired', 404, 'NOT_FOUND');
  }

  const data = resolved.sessionData;
  if (isSessionExpired(data)) {
    throw new AppError('This signing link has expired', 410, 'GONE');
  }

  const participant = resolved.participant;
  if (!participant) {
    throw new ForbiddenError('You do not have access to this signing session');
  }
  // Mirrors the terminal-status checks every other stateful v2 route runs
  // (/complete, /decline, /cancel itself) right after the expiry check.
  // Without this, a still-valid participant link could clear the
  // access-code gate on a session the firm already ended: /complete still
  // refuses to finish signing a cancelled/completed session, so this could
  // not forge a signature, but it let a link holder pass a security control
  // on a resource that should be entirely inert.
  if (data.status === 'cancelled') {
    throw new ConflictError('This signing session has been cancelled');
  }
  if (data.status === 'completed') {
    throw new ConflictError('This document has already been completed');
  }
  if (!participant.accessCodeHash) {
    throw new ValidationError('This session does not require an access code');
  }
  if (participant.accessCodeVerified) {
    return res.status(200).json({ verified: true });
  }
  // Cumulative hard cap, enforced on the NON-RESETTABLE lifetimeAttempts counter
  // (not the soft `attempts` window, which resets every 60s).
  // Once total failed attempts reach GATE_HARD_ATTEMPT_CAP this gate is locked
  // OUTRIGHT. lifetimeAttempts only clears when the firm reissues the link
  // (accessCodeLock -> null), so clearing the lock requires a firm-side reissue.
  if ((participant.accessCodeLock?.lifetimeAttempts || 0) >= GATE_HARD_ATTEMPT_CAP) {
    return res.status(429).json({ error: 'This link is locked after too many failed attempts. Please request a new signing link.', locked: true });
  }
  if (participant.accessCodeLock?.lockedUntil) {
    const lockedUntilMs = getTimestampMs(participant.accessCodeLock.lockedUntil);
    const remaining = Math.ceil((lockedUntilMs - Date.now()) / 1000);
    if (remaining > 0) {
      return res.status(429).json({
        error: `Too many failed attempts. Please wait ${remaining} second${remaining === 1 ? '' : 's'} and try again.`,
        lockedSeconds: remaining,
      });
    }
  }

  const submittedHash = hashAccessCode(code);
  if (!hashesEqual(submittedHash, participant.accessCodeHash)) {
    // Atomic increment + lock (see repo.recordGateFailure) so concurrent
    // failed attempts can't lose increments and overshoot the hard cap.
    const gate = await repo.recordGateFailure('accessCode',
      { token: resolved.sessionId, participantId: participant.participantId }, GATE_POLICY);
    const attemptsRemaining = Math.max(0, GATE_SOFT_ATTEMPT_LIMIT - (gate?.attempts || 0));
    const hardCapped = Boolean(gate?.hardCapped);
    const softLocked = Boolean(gate?.softLocked);

    writeAuditEvent(resolved.sessionId, AUDIT_EVENTS.ACCESS_CODE_FAILED, {
      req,
      metadata: { attemptsRemaining, participantId: participant.participantId, hardCapped },
    }).catch((err: any) => console.error('[audit] ACCESS_CODE_FAILED failed:', err.message));

    if (hardCapped) {
      return res.status(429).json({ error: 'This link is locked after too many failed attempts. Please request a new signing link.', locked: true });
    }
    if (softLocked) {
      return res.status(429).json({ error: 'Too many failed attempts. Please wait 60 seconds.', lockedSeconds: 60 });
    }

    return res.status(400).json({ error: 'Incorrect access code', attemptsRemaining });
  }

  // S5: targeted single-participant update (no whole-set rewrite).
  await repo.updateParticipant(resolved.sessionId, participant.participantId, {
    accessCodeVerified: true,
    accessCodeLock: null,
  });

  writeAuditEvent(resolved.sessionId, AUDIT_EVENTS.ACCESS_CODE_VERIFIED, {
    req,
    metadata: { participantId: participant.participantId },
  }).catch((err: any) => console.error('[audit] ACCESS_CODE_VERIFIED failed:', err.message));

  return res.status(200).json({ verified: true });
}));

// POST /api/signing/:token/cancel (authenticated, creator only)
router.post('/:token/cancel', verifyToken, handler(async (req, res) => {
  const data = await repo.getSessionByToken(req.params.token);
  if (!data) {
    throw new NotFoundError('Signing session');
  }

  if (data.createdBy !== req.user.uid) {
    throw new ForbiddenError('Only the session creator can cancel this signing session');
  }
  if (data.status === 'completed') {
    throw new ConflictError('Completed signing sessions cannot be cancelled');
  }
  if (data.status === 'cancelled') {
    return res.status(200).json({ success: true, status: 'cancelled' });
  }

  // Single set-based UPDATE (mirrors bulkExpireSessions): mark the session
  // 'cancelled' and every non-completed participant 'cancelled' in one
  // transaction, instead of rewriting the whole participants array.
  await repo.cancelSession(req.params.token);

  // Cancelled is terminal, so the scratch copies have no remaining reader.
  sweepSessionWorkspace(data.lawFirmId, req.params.token).catch((err: any) =>
    console.error('[signing] Workspace sweep failed for', tokenRef(req.params.token), err.message));

  writeAuditEvent(req.params.token, AUDIT_EVENTS.SESSION_CANCELLED, {
    req,
    actorUid: req.user.uid,
    metadata: { cancelled: true },
  }).catch((err: any) => console.error('[audit] SESSION_CANCELLED failed:', err.message));

  // Notify from a fresh read rather than the pre-update snapshot: a signer who
  // completed between our initial read and the cancel is now 'completed' in the
  // database, so they are excluded here and never receive a spurious
  // cancellation notice. Notified participants keep their pre-cancel (pending)
  // status so sendCancellationNotifications still targets them (it skips
  // completed/cancelled/declined).
  const fresh = await repo.getSessionByToken(req.params.token).catch(() => null);
  const completedIds = new Set(
    (fresh?.participants || [])
      .filter((p: any) => p.status === 'completed')
      .map((p: any) => p.participantId)
  );
  const participantsToNotify = (data.participants || []).filter(
    (p: any) => !['completed', 'cancelled', 'declined'].includes(p.status) && !completedIds.has(p.participantId)
  );

  sendCancellationNotifications({
    sessionData: { ...data, participants: participantsToNotify },
    senderName: data.notifyName || req.user.name || req.user.email || 'Someone',
    senderEmail: data.notifyEmail || req.user.email || null,
  }).catch((err: any) => console.error('[signing] Cancellation notifications failed:', err.message));

  res.status(200).json({ success: true, status: 'cancelled' });
}));

export = router;
