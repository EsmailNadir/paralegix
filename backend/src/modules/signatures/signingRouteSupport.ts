const filesRepo = require('../files/files.repository');
const crypto = require('crypto');
const { admin } = require('../../shared/database/firebase');
const { toIso, toMs } = require('./timeUtils');
const repo = require('./signatures.repository');
const { assertMatterReadAccess } = require('../../shared/utils/membership');
const { AppError, NotFoundError, ForbiddenError, ConflictError } = require('../../shared/errors/AppError');
const { SourceRefused, savedDigestStateOf } = require('./signingSources');
const { runJobNow } = require('./signingJobs');
const { DEFAULT_REQUEST_TIMEOUT_MS } = require('../../shared/middleware/requestTimeout');
const { removeArtifactIntermediates } = require('./signingWorkspace');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');
require('./signingFinalize');
const { resolveAuthorizedParticipant: resolveParticipantFor } = require('./signingDownloads');
import { openGcsPdfSource } from './pdf/gcsSource';
import { createResumableDigest } from './pdf/resumableDigest';
import { sessionStampableFields } from './signingFinalize';
import { stampStoredPdf } from './signingPipeline';
const { writeAuditEvent, writeAuditEvents, listAuditEvents, AUDIT_EVENTS } = require('./audit');
const { formatTimestamp, wrapText, sanitizeForStandardFont } = require('./certificatePage');
const { digitallySignPdf } = require('./digitalSign');
const rolesService = require('../lawfirms/roles/roles.service');
const membersRepo = require('../lawfirms/members/members.repository');
const { SIGNING_IMAGE_MAX_BYTES, SIGNING_IMAGE_TOTAL_MAX_BYTES, SIGNING_IMAGE_MAX_PIXELS } = require('./signingFieldValues');
const { normalizeSignatureFields } = require('./fieldNormalization');
const { maskEmail, getActiveParticipant } = require('./signingSessions');
const { buildConsentStatement, sendParticipantInvitation } = require('./signingNotifications');
const { destinationScope } = require('./signedFileRegistration');
import { createBoundedCache } from '../../shared/utils/boundedCache';
const { putCertificate, getCertificate } = require('./signingArchive');
const { workingPrefix: sessionWorkingPrefix, sweepSession: sweepSessionWorkspace, UPLOAD_ROOT_PREFIX } = require('./signingWorkspace');
const { forEachObjectPage } = require('../../shared/storage/listObjects');



// A signing-session token is the sole bearer credential for the public signing
// flow (PK of signature_sessions), so it must never be written to logs in
// plaintext: anyone with log-viewer access could lift it and impersonate the
// signer. Log a short, non-reversible reference instead.
export function tokenRef(token: any) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

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



// Firm-side access to a completed session's outputs (signed document, certificate,
// audit trail). The creator always passes; otherwise the caller needs
// signatures.view AND, when the session's document is matter-scoped, read access
// to that matter. This mirrors the /preview and send-for-signature guards so a
// signatures.view holder who is NOT on a confidential/walled matter cannot stream
// its executed PDF, certificate, or audit trail (with signer IPs). Throws on deny.
//
// Matter access is `assertMatterReadAccess`, the same gate the files module uses
// to serve the filed copy, NOT strict membership. Under strict membership an
// owner could open the executed PDF in the file browser and then be refused its
// certificate and audit trail, for the same document.
//
// A matter that no longer exists stops gating rather than denying everyone. This
// is the case the archive exists for: deleting a matter sweeps its whole subtree,
// including the filed copy, so the archived copy becomes the ONLY executed copy
// at precisely the moment a membership check against a missing matter would 404
// every caller except the original sender. With the matter gone there is no wall
// left to enforce, and firm membership plus signatures.view still had to pass.
export async function assertSessionOutputAccess(data: any, uid: string) {
  if (data.createdBy === uid) return;
  const allowed = await canViewSignatureSession(data.lawFirmId, uid);
  if (!allowed) {
    throw new ForbiddenError('You do not have access to this signing session');
  }
  const { matterId } = await destinationScope(data.lawFirmId, data.destinationFolderId);
  if (!matterId) return;
  try {
    await assertMatterReadAccess(data.lawFirmId, matterId, uid);
  } catch (err: any) {
    if (err instanceof NotFoundError) return;
    throw err;
  }
}


export const shouldRebuildSessionPdfFromFieldValues = (sessionData: any) =>
  Array.isArray(sessionData?.fields) && sessionData.fields.length > 0;

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';


export const bucket = admin.storage().bucket(BUCKET_NAME);


export function normalizeStoragePath(value: any) {
  return String(value || '').trim().replace(/^\/+/, '');
}



// Constant-time comparison of two SHA-256 hex digests. Guards on equal length
// (timingSafeEqual throws on mismatched buffer sizes) and returns false on any
// non-string / malformed input so callers never leak timing on secret compares.
export function hashesEqual(a: any, b: any) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}



// Shared timestamp coercion (consolidated module-wide helper). Kept as thin
// aliases so the existing call sites (getTimestampMs / tsToIso) stay unchanged.
export const getTimestampMs = toMs;


export const tsToIso = toIso;

function buildSignerSummaries(sessionData: any) {
  return (sessionData.participants || []).map((participant: any) => ({
    roleLabel: participant.roleLabel || 'Signer',
    name: participant.signerName || participant.name || null,
    email: participant.email || null,
    completedAt: tsToIso(participant.completedAt),
    signerIp: participant.signerIp || null,
    consentStatement: participant.consent?.consentName
      ? buildConsentStatement(participant.consent.consentName)
      : null,
  }));
}



export function buildSessionStatusPayload(sessionData: any, participant: any) {
  const activeParticipant = getActiveParticipant(sessionData);
  const completedParticipants = (sessionData.participants || []).filter((entry: any) => entry.status === 'completed');
  return {
    fileName: sessionData.fileName,
    status: sessionData.status || 'pending',
    routingMode: sessionData.routingMode || 'sequential',
    participantStatus: participant?.status || null,
    participantRole: participant?.roleLabel || null,
    participantName: participant?.name || null,
    participantDeliveryMethod: participant?.deliveryMethod || null,
    activeSignerName: activeParticipant?.name || null,
    activeSignerRole: activeParticipant?.roleLabel || null,
    completedParticipants: completedParticipants.length,
    totalParticipants: (sessionData.participants || []).length,
    // Whether signers (not just the sender) receive the finished document by
    // email once everyone has signed. Lets the signing view tell the signer what
    // to expect after they submit.
    emailSignersOnComplete: !!sessionData.emailSignersOnComplete,
    expiresAt: sessionData.expiresAt || null,
  };
}



/**
 * Who this caller is allowed to act as, in `signingDownloads.ts`'s terms.
 *
 * Deliberately not a second implementation. Two copies of a rule that decides
 * whether a caller may see a document drift, and the drift is invisible: each
 * copy keeps working, and only the difference between them is a hole.
 */
export const resolveAuthorizedParticipant = (resolved: any, reqUser: any) =>
  resolveParticipantFor(resolved, reqUser?.uid || null);

const VIEW_AUDIT_THROTTLE_MS = 60 * 60 * 1000;

 // 1 hour

// Gate brute-force controls. The soft window (5 tries -> 60s wait) slows guessing
// but resets, so a hard cumulative cap caps the total guesses a single token can
// ever make. Once GATE_HARD_ATTEMPT_CAP cumulative failures accrue, the gate is
// locked for an effectively indefinite window (the sender must re-issue the link).
export const GATE_SOFT_ATTEMPT_LIMIT = 5;

const GATE_SOFT_LOCK_MS = 60 * 1000;

 // 60s
export const GATE_HARD_ATTEMPT_CAP = 20;

const GATE_HARD_LOCK_MS = 365 * 24 * 60 * 60 * 1000;

 // ~1 year (effectively permanent)
// Shared policy passed to repo.recordGateFailure (atomic attempt increment).
export const GATE_POLICY = {
  softLimit: GATE_SOFT_ATTEMPT_LIMIT,
  softLockMs: GATE_SOFT_LOCK_MS,
  hardCap: GATE_HARD_ATTEMPT_CAP,
  hardLockMs: GATE_HARD_LOCK_MS,
};

function actorKeyForParticipant(req: any, participant: any) {
  return (
    req?.user?.uid
    || participant?.participantId
    || participant?.memberUserId
    || participant?.clientUserId
    || 'anonymous'
  );
}



// S11: The once-per-hour throttle is enforced atomically by stampViewIfStale.
// a single conditional INSERT...ON CONFLICT...WHERE that stamps (and returns
// true) only if the prior stamp is older than the window. We write the audit
// event only when our stamp won, so concurrent views can no longer both pass a
// stale-map check and double-write. The stale `data.last*ViewedAt` map is no
// longer consulted (it could be stale by the time we read it).
export async function maybeWriteSessionViewed({ sessionId, participant, req, facilitatedSigning }: any) {
  const actorKey = actorKeyForParticipant(req, participant);

  let didStamp;
  try {
    didStamp = await repo.stampViewIfStale(sessionId, actorKey, 'session', VIEW_AUDIT_THROTTLE_MS);
  } catch (err: any) {
    // If the stamp write fails, skip the audit event rather than risk an
    // unthrottled write. View audits are best-effort.
    return;
  }
  if (!didStamp) return;

  return writeAuditEvent(sessionId, AUDIT_EVENTS.SESSION_VIEWED, {
    req,
    actorUid: req.user?.uid || participant?.memberUserId || participant?.clientUserId || null,
    metadata: {
      actorKey,
      ...(participant ? {
        participantId: participant.participantId,
        deliveryMethod: participant.deliveryMethod || null,
        facilitatedBy: facilitatedSigning ? req.user?.uid || null : null,
      } : {}),
    },
  });
}



export async function maybeWriteDocumentViewed({ sessionId, participant, req, facilitatedSigning }: any) {
  const actorKey = actorKeyForParticipant(req, participant);

  let didStamp;
  try {
    didStamp = await repo.stampViewIfStale(sessionId, actorKey, 'document', VIEW_AUDIT_THROTTLE_MS);
  } catch (err: any) {
    return;
  }
  if (!didStamp) return;

  return writeAuditEvent(sessionId, AUDIT_EVENTS.DOCUMENT_VIEWED, {
    req,
    actorUid: req.user?.uid || participant?.memberUserId || participant?.clientUserId || null,
    metadata: {
      actorKey,
      ...(participant ? {
        participantId: participant.participantId,
        deliveryMethod: participant.deliveryMethod || null,
        facilitatedBy: facilitatedSigning ? req.user?.uid || null : null,
      } : {}),
    },
  });
}




export async function buildFieldStampedWorkingCopy({ sessionData, participants, destination }: any) {
  const source = await repo.getSource(sessionData.lawFirmId, sessionData.sourceId);
  if (!source?.preparedObjectPath || !source?.preparedGeneration) {
    throw new AppError('The signing source is not ready.', 500, 'SIGNING_SOURCE_NOT_READY');
  }
  const fields = await sessionStampableFields(sessionData, participants);
  // Bounded work: the stamp reads windows and storage joins the suffix to the
  // source server side. The hash is the source's saved state resumed over the
  // suffix. Nothing here reads the document, which is also why it does not
  // take a transfer slot: it runs after the signer's consent is committed, and
  // a slot that timed out there would answer them with an error.
  const result = await stampStoredPdf({
    source: {
      objectPath: source.preparedObjectPath,
      generation: String(source.preparedGeneration),
      sizeBytes: Number(source.preparedSizeBytes),
    },
    fields,
    destination,
    scratchPrefix: `${sessionWorkingPrefix(sessionData.lawFirmId, sessionData.token)}compose/`,
    savedDigest: savedDigestStateOf(source),
  });
  if (result.failures.length > 0) {
    throw new AppError('One or more signing fields could not be placed.', 422, 'SIGNING_FIELDS_UNPLACEABLE');
  }
  if (result.digestHex) return { ref: result.stamped, hash: result.digestHex };
  // A source with no saved state was prepared before states existed. Every
  // source preparation writes one now, so this is the rare path, and it pays
  // the full read it always did.
  console.warn(`[signing] No saved digest for source ${source.id}; hashing the working copy in full.`);
  return { ref: result.stamped, hash: await hashStoredObject(result.stamped) };
}



/** SHA-256 of a stored object, streamed through in bounded chunks. */
export async function hashStoredObject(ref: { objectPath: string; generation: string; sizeBytes: number }) {
  const digest = await createResumableDigest();
  const reader = openGcsPdfSource(ref);
  try {
    for await (const chunk of reader.stream(0, ref.sizeBytes, new AbortController().signal)) {
      digest.update(chunk);
    }
  } finally {
    await reader.close();
  }
  return digest.digestHex();
}



/**
 * The admitted source this session names.
 *
 * Every session records one when it is created, so there is nothing to resolve
 * or claim here. There used to be: a session created before the admission
 * boundary existed carried only an object path, so the row was claimed at this
 * point, from an object nothing had inspected, and finalization then streamed
 * the raw upload because that row had no prepared copy. Both of those are gone
 * with the sessions they existed for.
 */
export async function finalizeSource(data: any): Promise<{ id: string; sizeBytes: number }> {
  const source = await repo.getSource(data.lawFirmId, data.sourceId);
  if (!source) {
    throw new AppError(
      'This session names a source that no longer exists.', 500, 'SIGNING_SOURCE_MISSING',
    );
  }
  return {
    id: source.id,
    sizeBytes: Number(source.preparedSizeBytes || source.sizeBytes || 0),
  };
}



/**
 * How a completion that enqueued a finalize job should answer.
 *
 * `runJobNow` reports what happened to the JOB, and the five completion states
 * describe what happened to the SIGNER. They are not the same question, and
 * collapsing them is what leaves a signing page guessing: the usual guess is to
 * make the signer sign again, for a document that is already signed.
 *
 * Everything short of a settled success is "keep the page open" or "someone else
 * has to act", never "try signing again". Consent is committed before any of
 * this runs, so there is nothing left for the signer to do in any of them.
 */
export function completionStateForJob(outcome: string, failureCode: string | null): string {
  if (outcome === 'succeeded') return 'completed';
  // Another worker holds the job, or took it away mid-run. It is still owed and
  // still being worked; the page polls.
  if (outcome === 'busy' || outcome === 'lost') return 'processing';
  if (outcome === 'failed') {
    // Settled without a retry. Only a refusal about the DOCUMENT is something a
    // person can act on; a job that merely exhausted its attempts is still the
    // recovery pass's to finish.
    return failureCode && SOURCE_REFUSAL_CODES.has(failureCode)
      ? 'permanent_refusal'
      : 'recoverable_failure';
  }
  return 'recoverable_failure';
}

/**
 * Time a completion keeps, after its inline queue wait, for the finalize work
 * itself and the response. Not the work's worst case: a document that runs past
 * it still finishes and still lands, it only answers late.
 */
const INLINE_FINALIZE_MARGIN_MS = Number(process.env.SIGNING_INLINE_FINALIZE_MARGIN_MS) || 15_000;



/**
 * How long a completion may queue for a transfer slot before answering
 * `processing` instead.
 *
 * The slot's own queue deadline is longer than the request's, so without this a
 * completion queued behind other signers was answered 504 by the request
 * deadline while its job went on to finish the document anyway. A signer told
 * 504 for a signature that landed tries again. Bounded here, a busy slot is the
 * ordinary durable path: the job is committed with the consent and the drain
 * finishes it.
 *
 * Undefined when the request has no deadline, which leaves the slot's default.
 * Zero or less means there is no time left to queue at all.
 */
export function inlineFinalizeQueueBudgetMs(requestStartedAt: number): number | undefined {
  if (!DEFAULT_REQUEST_TIMEOUT_MS) return undefined;
  return DEFAULT_REQUEST_TIMEOUT_MS - (Date.now() - requestStartedAt) - INLINE_FINALIZE_MARGIN_MS;
}

/** Refusals that describe the stored document rather than the attempt. */
const SOURCE_REFUSAL_CODES = new Set([
  'PDF_INVALID',
  'PDF_ENCRYPTED',
  'PDF_EXISTING_SIGNATURE',
  'PDF_UNSUPPORTED_FORM',
  'PDF_RESOURCE_LIMIT',
  'FILE_TOO_LARGE',
  'SOURCE_CHANGED',
]);



// S1: Normalize field ids IN MEMORY only. Never write on a read path.
// Sessions and templates are normalized at the write path
// (signatureLinks/template create), so this is a no-op for them.
export function ensureNormalizedSessionFields(_sessionRef: any, sessionData: any) {
  const normalization = normalizeSignatureFields(sessionData.fields);
  if (normalization.changed) {
    sessionData.fields = normalization.fields;
  }
  return sessionData.fields || [];
}



/**
 * Tell the signer whose turn just arrived. Runs after the previous signer's
 * signature is committed, so a delivery failure is logged and reported as
 * `sent: false` rather than thrown: the signer who just signed must not see an
 * error for a signature that was recorded. The firm can Resend to the next one.
 */
export async function notifyNextParticipant({ sessionId, sessionData, participant }: any) {
  if (!participant) return { sent: false, skipped: true };

  try {
    return await sendParticipantInvitation({
      participant,
      publicToken: participant.publicToken,
      lawFirmId: sessionData.lawFirmId,
      senderName: sessionData.notifyName || 'Someone',
      senderEmail: sessionData.notifyEmail || null,
      fileName: sessionData.fileName,
      message: null,
    });
  } catch (err: any) {
    console.error('[signing] Failed to notify the next signer', {
      tokenRef: tokenRef(sessionId),
      error: err.message,
    });
    return { sent: false };
  }
}



/**
 * Where a fieldless session's executed document is uploaded to.
 *
 * Its own folder under the session's working prefix, so the session sweep takes
 * it with everything else once the session closes, and so a path check is a
 * prefix comparison rather than a guess about what a name means.
 */
export function completionUploadPrefix(lawFirmId: string, sessionId: string) {
  return `${sessionWorkingPrefix(lawFirmId, sessionId)}completion/`;
}



/**
 * Render a session's Certificate of Completion from its current rows and seal it.
 *
 * An unsealed certificate is still a truthful record, so a signing failure falls
 * back to the unsealed PDF rather than denying the firm its evidence entirely.
 */
export async function renderCompletionCertificate(token: any, data: any) {
  const events = await listAuditEvents(token);

  // The signer on the certificate is the participant who completed, falling back
  // to the first participant. Every session carries participant rows.
  const participants = Array.isArray(data.participants) ? data.participants : [];
  const signerEmailForCertificate =
    participants.find((p: any) => p.status === 'completed')?.email
    || participants[0]?.email
    || null;

  const certPdf = await generateCompletionCertificate({
    token,
    fileName: data.fileName,
    signerName: data.signerName || 'N/A',
    signerEmail: signerEmailForCertificate ? maskEmail(signerEmailForCertificate) : 'N/A',
    signerIp: events.find((e: any) => e.eventType === 'session.completed')?.ip || 'N/A',
    createdAt: tsToIso(data.createdAt),
    completedAt: tsToIso(data.completedAt),
    originalDocumentHash: data.documentHash || 'N/A',
    signedDocumentHash: data.signedDocumentHash || 'N/A',
    deliveryDocumentHash: data.deliveryDocumentHash || 'N/A',
    events,
    signers: buildSignerSummaries(data),
  });

  try {
    return await digitallySignPdf(certPdf);
  } catch (signErr: any) {
    console.error('[signing] Certificate digital signature failed:', signErr.message);
    return certPdf;
  }
}



/**
 * Archive a just-completed session's certificate without making anyone wait for it.
 *
 * The certificate is rendered from the audit trail and then frozen: the archived
 * bytes are what every later download returns, forever. So it must not be
 * rendered until the events describing the final signature have been written.
 * Those writes are deliberately not awaited by the completion request (the signer
 * is waiting on that response), which left the ordering to chance , and a lost
 * race permanently froze a certificate whose timeline stops before the signature,
 * reporting the signer's IP as N/A because it is read out of `session.completed`.
 *
 * `pendingAuditWrites` is the settled-or-not promise for those writes. Waiting on
 * it here costs nothing anyone can perceive, because this whole function already
 * runs after the response. A write that FAILED is not worth withholding the
 * certificate over , an audit trail missing one row is still the trail , so this
 * waits for the writes to settle rather than to succeed.
 */
export function archiveCertificateAfterCompletion(token: any, pendingAuditWrites: any = null) {
  setImmediate(async () => {
    try {
      if (pendingAuditWrites) await pendingAuditWrites;
      const data = await repo.getSessionByToken(token);
      if (!data || data.status !== 'completed') return;
      if (await getCertificate(data.lawFirmId, token)) return;
      await putCertificate(data.lawFirmId, token, await renderCompletionCertificate(token, data));
    } catch (err: any) {
      console.error('[signing] Post-completion certificate archive failed for', tokenRef(token), err.message);
    }
  });
}

// Short TTL cache: these two lookups (member + resolved permissions) otherwise
// run on every audit/certificate request for the same user.
// Keyed on `${lawFirmId}:${userId}`, so its key count is firms times members.
// A TTL alone never removed an entry for a user who did not come back, which
// is most of them, so it grew with the customer base for the life of the
// instance. The ceiling is what actually bounds it.
const _canViewCache = createBoundedCache<boolean>({
  name: 'canViewSignatureSession',
  maxEntries: 5000,
  ttlMs: 30 * 1000,
});



export async function canViewSignatureSession(lawFirmId: string, userId: string) {
  if (!lawFirmId || !userId) return false;

  const key = `${lawFirmId}:${userId}`;
  // `has` before `get`: the cached answer may legitimately be `false`, which is
  // the answer that matters most, and treating it as a miss would re-run the
  // permission lookup on every denied request.
  if (_canViewCache.has(key)) return _canViewCache.get(key) as boolean;

  let allowed = false;
  const member = await membersRepo.findByUserId(lawFirmId, userId);
  if (member) {
    allowed = member.isOwner
      || (await rolesService.resolvePermissions(lawFirmId, member)).includes('signatures.view');
  }
  _canViewCache.set(key, allowed);
  return allowed;
}



// Kept in step with the frontend's SIGNABLE_EXTENSIONS (SignaturesWorkspace)
// and the convert endpoint's ALLOWED_CONVERT_EXTENSIONS: everything here is a
// format the LibreOffice converter genuinely handles. Without this gate the
// route fed arbitrary bytes (spreadsheets, images) straight to the converter.
export const SIGNABLE_UPLOAD_EXTENSIONS = ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt'];



// POST /api/signing/:token/complete (public, uploads the signed PDF back to the law firm's files)
/**
 * The five outcomes a completion can have, and the status each is reported with.
 *
 * They are separated because a client cannot tell them apart otherwise, and each
 * one asks for something different. `processing` and `waiting_for_others` both
 * mean "keep the page open"; `recoverable_failure` means the signer is finished
 * and the recovery pass will produce the document without them;
 * `permanent_refusal` means no retry of any kind will help and the sender has to
 * act. Collapsing any pair of these into one status leaves the signing page
 * guessing, and the usual guess is to make the signer sign again.
 */
export const COMPLETION_OUTCOMES: Record<string, number> = {
  completed: 200,
  waiting_for_others: 200,
  processing: 202,
  recoverable_failure: 503,
  permanent_refusal: 422,
};



/**
 * The body every completion answers with. `completed` / `waitingForNextSigner`
 * are the fields the pre-JSON clients read and are kept exactly as they were;
 * `state` is the single field a new client switches on.
 */
export function completionBody(state: string, extra: Record<string, any> = {}) {
  return {
    success: state === 'completed' || state === 'waiting_for_others',
    state,
    consentRecorded: true,
    completed: state === 'completed',
    waitingForNextSigner: state === 'waiting_for_others',
    nextSignerName: null,
    ...extra,
  };
}



/** Which outcome a session that has already recorded this signer is in. */
export function replayState(sessionStatus: any, outstandingParticipants: number) {
  if (sessionStatus === 'completed') return 'completed';
  // Every signer has consented but the session has not been sealed, so the
  // artifacts are still being produced, either by the request that is building
  // them or by the recovery pass after one failed.
  if (outstandingParticipants === 0) return 'processing';
  return 'waiting_for_others';
}

function classifyFinalizeFailure(err: any) {
  // A SourceRefused names a property of the stored document that no retry
  // changes: an encrypted PDF is still encrypted on the next attempt. Everything
  // else (storage, network, a transient parse failure) is what the finalize
  // recovery pass exists to finish, without the signer returning.
  if (err instanceof SourceRefused) {
    return {
      permanent: true,
      state: 'permanent_refusal',
      status: err.statusCode || 422,
      code: err.refusalCode,
      message: err.message,
    };
  }
  return {
    permanent: false,
    state: 'recoverable_failure',
    status: 503,
    code: 'FINALIZE_RETRYING',
    message: 'Your signature was recorded. The executed document is still being produced.',
  };
}



/** User-facing copy for whichever image bound a submission broke. */
export function imageLimitError(violation: any) {
  if (violation.kind === 'bytes') {
    return new AppError(
      `A signature image is larger than the ${Math.floor(SIGNING_IMAGE_MAX_BYTES / 1024)} KB limit. Clear it and sign again.`,
      400, 'SIGNATURE_IMAGE_TOO_LARGE',
    );
  }
  if (violation.kind === 'pixels') {
    return new AppError(
      `A signature image is larger than ${SIGNING_IMAGE_MAX_PIXELS / 1_000_000} megapixels. Clear it and sign again.`,
      400, 'SIGNATURE_IMAGE_TOO_MANY_PIXELS',
    );
  }
  return new AppError(
    `The signature images total more than the ${Math.floor(SIGNING_IMAGE_TOTAL_MAX_BYTES / 1024)} KB limit. Clear them and sign again.`,
    400, 'SIGNATURE_IMAGES_TOO_LARGE',
  );
}

/**
 * Record consent on its own, for a completion whose artifacts did not get built.
 *
 * The full completion writes CONSENT_GIVEN and SESSION_COMPLETED together. When
 * the build fails, only the first of those happened, and writing the second
 * would put a completion in the evidentiary record that no document backs.
 */
function recordConsentAudit({ sessionId, req, consent, participant, signerUid, facilitatedBy }: any) {
  writeAuditEvent(sessionId, AUDIT_EVENTS.CONSENT_GIVEN, {
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
  }).catch((err: any) => console.error('[audit] CONSENT_GIVEN failed:', err.message));
}



/**
 * The outcome to report for a retried completion whose single-use link is spent.
 *
 * A participant token is consumed the moment its turn completes, so a retry no
 * longer resolves a session at all and would otherwise read as "link expired".
 * The key the original submission was accepted under is what separates a retry
 * from a second, different submission against a turn that is over.
 */
export async function replayConsumedCompletion(token: string, idempotencyKey: string | null) {
  if (!idempotencyKey) return null;
  const receipt = await repo.getCompletionReceiptByToken(token);
  if (!receipt || receipt.participantStatus !== 'completed') return null;
  if (receipt.consent?.idempotencyKey !== idempotencyKey) {
    throw new ConflictError('This signer has already completed their turn');
  }
  const state = replayState(receipt.sessionStatus, receipt.outstandingParticipants);
  return {
    status: COMPLETION_OUTCOMES[state],
    body: completionBody(state, { nextSignerName: receipt.nextSignerName }),
  };
}

/**
 * Generate a Certificate of Completion PDF with full audit timeline.
 */
async function generateCompletionCertificate({ token, fileName, signerName, signerEmail, signerIp, createdAt, completedAt, originalDocumentHash, signedDocumentHash, deliveryDocumentHash, events, signers = [] }: any) {
  const PAGE_WIDTH = 612;
  const PAGE_HEIGHT = 792;
  const MARGIN = 60;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
  // Required here rather than at the top of this router: pdf-lib is megabytes
  // once loaded and only this certificate render uses it.
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

  const COLORS = {
    title: rgb(0.1, 0.1, 0.1),
    section: rgb(0.15, 0.15, 0.15),
    label: rgb(0.35, 0.35, 0.35),
    value: rgb(0.1, 0.1, 0.1),
    line: rgb(0.7, 0.7, 0.7),
    footer: rgb(0.45, 0.45, 0.45),
    eventDot: rgb(0.22, 0.56, 0.24),
  };

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - 60;

  // Helper: draw separator
  function drawSep() {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: COLORS.line });
    y -= 16;
  }

  // Helper: draw section header
  function drawSection(text: any) {
    page.drawText(text, { x: MARGIN, y, size: 11, font: boldFont, color: COLORS.section });
    y -= 18;
  }

  // Helper: draw field
  function drawField(label: any, value: any) {
    const labelWidth = 180;
    page.drawText(label, { x: MARGIN, y, size: 9.5, font: boldFont, color: COLORS.label });
    const lines = wrapText(String(value || 'N/A'), font, 9.5, CONTENT_WIDTH - labelWidth);
    for (let i = 0; i < lines.length; i++) {
      page.drawText(lines[i], { x: MARGIN + labelWidth, y: y - i * 14, size: 9.5, font, color: COLORS.value });
    }
    y -= Math.max(lines.length, 1) * 14 + 4;
  }

  // Helper: check if we need a new page
  function ensureSpace(needed: any) {
    if (y - needed < 60) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - 60;
    }
  }

  // Title
  const titleText = 'CERTIFICATE OF COMPLETION';
  const titleWidth = boldFont.widthOfTextAtSize(titleText, 18);
  page.drawText(titleText, { x: (PAGE_WIDTH - titleWidth) / 2, y, size: 18, font: boldFont, color: COLORS.title });
  y -= 30;

  drawSep();

  // Document Details
  drawSection('DOCUMENT DETAILS');
  drawSep();
  drawField('Document:', fileName);
  drawField('Transaction ID:', token);
  y -= 6;

  // Signer Information
  const signerEntries = signers.length > 0
    ? signers
    : [{ roleLabel: 'Signer', name: signerName, email: signerEmail, signerIp, completedAt }];
  ensureSpace(120);
  drawSection('SIGNER INFORMATION');
  drawSep();
  signerEntries.forEach((signer: any, index: any) => {
    drawField(index === 0 ? 'Signer:' : 'Signer', signer.name || 'N/A');
    drawField('Role:', signer.roleLabel || 'Signer');
    if (signer.email) drawField('Email:', signer.email);
    if (signer.signerIp) drawField('IP Address:', signer.signerIp);
    if (signer.completedAt) drawField('Signed At:', formatTimestamp(signer.completedAt));
    y -= 4;
    ensureSpace(90);
  });
  y -= 6;

  // Timeline
  ensureSpace(100);
  drawSection('TIMELINE');
  drawSep();
  drawField('Session Created:', formatTimestamp(createdAt));
  drawField('Document Signed:', formatTimestamp(completedAt));
  y -= 6;

  // Audit Events
  ensureSpace(80);
  drawSection('AUDIT TRAIL');
  drawSep();

  const EVENT_LABELS: any = {
    'session.created': 'Signing session created',
    'session.viewed': 'Session viewed by signer',
    'document.viewed': 'Document viewed by signer',
    'consent.given': 'Electronic consent provided',
    'session.completed': 'Document signed and completed',
    'session.cancelled': 'Signing session cancelled',
    'participant.declined': 'Signer declined to sign',
    'email.sent': 'Signing email sent',
    'reminder.sent': 'Signing reminder sent',
    'accesscode.verified': 'Access code verified',
    'accesscode.failed': 'Access code attempt failed',
  };

  // Cap the rendered user agent so an unusually long header does not overflow
  // the certificate page. The full value remains on the audit record.
  function truncateUserAgent(value: any) {
    const text = String(value || '').trim();
    if (text.length <= 120) return text;
    return `${text.slice(0, 117)}...`;
  }

  for (const event of events) {
    // Sanitize the user-controlled device string so a glyph outside the standard
    // font's WinAnsi encoding cannot throw during drawing.
    const userAgentStr = sanitizeForStandardFont(truncateUserAgent(event.userAgent));
    ensureSpace(userAgentStr ? 42 : 30);

    // Green dot
    page.drawCircle({ x: MARGIN + 4, y: y + 3, size: 3, color: COLORS.eventDot });

    const label = sanitizeForStandardFont(EVENT_LABELS[event.eventType] || event.eventType);
    page.drawText(label, { x: MARGIN + 14, y, size: 9, font: boldFont, color: COLORS.value });

    const timeStr = formatTimestamp(event.timestamp);
    const ipStr = event.ip ? ` | IP: ${sanitizeForStandardFont(event.ip)}` : '';
    page.drawText(`${timeStr}${ipStr}`, { x: MARGIN + 14, y: y - 12, size: 8, font, color: COLORS.label });

    if (userAgentStr) {
      page.drawText(`Device: ${userAgentStr}`, { x: MARGIN + 14, y: y - 24, size: 8, font, color: COLORS.label });
      y -= 42;
    } else {
      y -= 30;
    }
  }

  y -= 6;

  // Document Integrity
  //
  // Unlike the certificate page bound into the executed PDF, this document is
  // outside both artifacts, so it can state both hashes , and it should, because
  // the two copies of a completed session differ. Whichever one a reader is
  // holding, one of these lines matches it.
  // Three hashes, each wrapping to two lines at this width, plus the header, the
  // separator and the note beneath them.
  ensureSpace(150);
  drawSection('DOCUMENT INTEGRITY');
  drawSep();
  drawField('Original Hash (SHA-256):', originalDocumentHash);
  drawField('Signed Hash, as delivered:', deliveryDocumentHash);
  drawField('Signed Hash, filed copy:', signedDocumentHash);
  page.drawText('The filed copy carries an appended Signature Certificate page; the delivered copy does not.', {
    x: MARGIN, y, size: 8, font, color: COLORS.label,
  });
  y -= 22;

  // Footer
  ensureSpace(60);
  drawSep();
  page.drawText('Generated by Paralegix  |  paralegix.com', { x: MARGIN, y, size: 8, font: boldFont, color: COLORS.footer });
  y -= 14;
  page.drawText('This Certificate of Completion is a record of the signing transaction and is digitally signed for authenticity.', { x: MARGIN, y, size: 8, font, color: COLORS.footer });

  const resultBytes = await pdfDoc.save();
  return Buffer.from(resultBytes);
}

// --- Periodic cleanup: delete signing-uploads older than 10 days & expired sessions ---

const UPLOAD_TTL_DAYS = 10;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 24 hours

// How long past its own `expires_at` a session waits before the sweep marks it
// expired. Only a guard against clock skew and a request that was already in
// flight: every signing route refuses an expired session on its own through
// `isSessionExpired`, so this decides when the STATUS and the audit row catch
// up, not when access ends. The daily interval above dominates anything shorter
// than a day, so the exact value only has to be small.
//
// It used to be `UPLOAD_TTL_DAYS`, borrowed from the bucket sweep beside it,
// which left a session sitting in `in_progress` for ten days after it expired
// and put the same delay on its `session.expired` audit row.
const SESSION_EXPIRY_GRACE_MS = 60 * 60 * 1000;

// 1 hour

// How long a settled session's scratch copies may linger before the backstop
// sweep collects them. Generous, because the inline sweep at the terminal
// transition is what normally clears them and this only catches what that lost.
const WORKSPACE_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

// 24 hours
// How far back the backstop looks. Sessions that settled longer ago than this
// have already had every run inside the window to be swept; continuing to
// revisit them would mean re-listing the same empty prefixes forever and never
// reaching anything newer.
const WORKSPACE_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

 // 7 days

/**
 * Age out `signing-uploads/`, the transient bucket-root prefix holding sources
 * uploaded or converted for signing.
 *
 * It is walked a page at a time. Listing a prefix without paging materializes
 * every object at once, which is exactly the unbounded read the rest of the
 * storage code was moved off, and it grows with every session ever created.
 */
export async function cleanupExpiredUploads() {
  const cutoff = new Date(Date.now() - UPLOAD_TTL_DAYS * 24 * 60 * 60 * 1000);

  for (const prefix of [UPLOAD_ROOT_PREFIX]) {
    try {
      // eslint-disable-next-line no-await-in-loop -- drained prefix by prefix
      await forEachObjectPage(bucket, prefix, async (files: any) => {
        // getFiles() already populates file.metadata.timeCreated. No per-file
        // getMetadata() round-trip (was an N+1 against GCS).
        const stale = files.filter((f: any) => new Date(f.metadata?.timeCreated || 0) < cutoff);
        if (stale.length === 0) return;

        // AGE IS NOT THE WHOLE QUESTION. A session may stay open for thirty days
        // while this sweep collects at ten, so a document signed on day fifteen
        // had its source deleted five days earlier and cannot be finalized. The
        // deletion is silent; what a user sees is a signing link that stops
        // working for no stated reason.
        const referenced = await repo.findReferencedObjectPaths(stale.map((f: any) => f.name));
        const collectable = stale.filter((f: any) => !referenced.has(f.name));

        await Promise.all(collectable.map((f: any) => f.delete().catch((err: any) =>
          console.error('[signing cleanup] Failed to delete', f.name, err.message))));
      });
    } catch (err: any) {
      console.error('[signing cleanup] Error cleaning up', prefix, err.message);
    }
  }
}

/** Storage sweeps in flight at once from one housekeeping pass. */
const SWEEP_CONCURRENCY = 8;



export async function cleanupExpiredSessions() {
  try {
    // S3: slim token-only listing (no session-graph load), set-based expiry,
    // and one batched audit INSERT instead of up to 500 single INSERTs.
    const cutoff = new Date(Date.now() - SESSION_EXPIRY_GRACE_MS).toISOString();
    const expired = await repo.listExpiredOpenSessions(cutoff);

    if (!expired.length) return;

    const tokens = expired.map((row: any) => row.token);
    // Only the tokens THIS pass actually transitioned. `bulkExpireSessions`
    // guards on status, so a session another concurrent sweep already expired
    // comes back excluded. Everything below keys off the claimed set rather than
    // the requested one , above all the audit write, since a duplicate
    // SESSION_EXPIRED row in a tamper-evident trail that gets rendered onto the
    // signing certificate is an evidentiary problem, not a cosmetic one.
    const claimedTokens = await repo.bulkExpireSessions(tokens);
    if (!claimedTokens.length) return;
    const claimed = new Set(claimedTokens);

    // Expired is terminal too, so each session's scratch copies go with it.
    // Eight at a time. Each sweep is a listing and a delete, and a batch can be
    // hundreds of sessions inside a request sharing one vCPU.
    await runWithConcurrency(expired
      .filter((row: any) => claimed.has(row.token))
      .map((row: any) => () =>
        sweepSessionWorkspace(row.law_firm_id, row.token).catch((err: any) =>
          console.error('[signing cleanup] Workspace sweep failed for', tokenRef(row.token), err.message))),
    SWEEP_CONCURRENCY);

    const expiredAt = new Date().toISOString();
    await writeAuditEvents(claimedTokens.map((token: any) => ({
      token,
      eventType: AUDIT_EVENTS.SESSION_EXPIRED,
      metadata: { expiredAt },
    }))).catch((err: any) => console.error('[audit] SESSION_EXPIRED batch failed:', err.message));
  } catch (err: any) {
    console.error('[signing cleanup] Error cleaning up sessions:', err.message);
  }
}



/**
 * Backstop for scratch copies whose inline sweep never ran.
 *
 * Every terminal transition (complete, cancel, decline, expire) fires
 * `sweepSessionWorkspace`, but none of them awaits it: the signer is waiting on a
 * response and a housekeeping delete must not sit in front of it. That makes each
 * sweep loseable to a crash, a deploy or a transient GCS error, with nothing
 * behind it. The working copies are excluded from the firm's storage quota and
 * appear in no listing, so what leaks is invisible and permanent.
 *
 * The bucket-root TTL pass cannot cover these: they live under
 * `lawfirmids/{firmId}/signing-work/`, one prefix per firm, with no single parent
 * to page through. Driving it from the settled sessions themselves is both cheaper
 * and exact.
 */
export async function sweepSettledWorkspaces() {
  try {
    const now = Date.now();
    const cutoff = new Date(now - WORKSPACE_SWEEP_GRACE_MS).toISOString();
    const windowStart = new Date(now - WORKSPACE_SWEEP_WINDOW_MS).toISOString();
    const settled = await repo.listSettledSessionsForWorkspaceSweep(cutoff, windowStart);
    if (!settled.length) return;

    // The artifact intermediates too: publication removes them, and this is
    // the backstop for a publication that crashed before it got there.
    const swept = await runWithConcurrency(settled.map((row: any) => async () => {
      try {
        const [working, intermediates] = await Promise.all([
          sweepSessionWorkspace(row.law_firm_id, row.token),
          removeArtifactIntermediates(row.law_firm_id, row.token),
        ]);
        return working + intermediates;
      } catch (err: any) {
        console.error('[signing cleanup] Workspace backstop sweep failed for', tokenRef(row.token), err.message);
        return 0;
      }
    }), SWEEP_CONCURRENCY);

    const deleted = swept.reduce((sum: number, n: any) => sum + Number(n || 0), 0);
    if (deleted > 0) {
      console.log(`[signing cleanup] Backstop swept ${deleted} orphaned working copies across ${settled.length} settled session(s)`);
    }
  } catch (err: any) {
    console.error('[signing cleanup] Error sweeping settled workspaces:', err.message);
  }
}

// Grace period before a fully-signed but not-yet-finalized session is treated as
// a stuck finalize, so an in-flight completion request is never disturbed.
const FINALIZE_RECOVERY_GRACE_MS = 5 * 60 * 1000;

// 5 minutes
const FINALIZE_RECOVERY_INTERVAL_MS = 10 * 60 * 1000;

 // 10 minutes

// Finish sessions whose last signer committed but whose executed document was
// never produced: the finalize job was committed with the consent and then
// nothing ran it, or what ran it died.
//
// It goes through the SAME job claim as everything else. It used to have a claim
// of its own, over `updated_at`, and two claim mechanisms for one piece of work
// is the defect rather than the safeguard: a live worker holding the job lease
// and this pass holding the session stamp were each correct on their own terms
// while producing two artifact sets, two quota charges and two sets of
// completion emails. Now the loser simply finds the job already leased.
//
// It also no longer rebuilds anything itself. The job handler is the one
// implementation, so a session recovered here goes through the appending
// pipeline, not the old buffered rebuild, and gets the same artifacts a live
// completion would have produced.
//
// A session with no finalize job owed is left alone. That is either a fieldless
// session, which has no server-rebuildable source and can only be finished by
// the request carrying the signer's bytes, or a session already finished by
// somebody else.
/**
 * Finish sessions whose finalization was owed and never landed.
 *
 * `deadline` stops it claiming more once passed. It runs inside the
 * housekeeping request, and each recovery can seal a whole document, so an
 * unbounded pass could hold that request past its own budget.
 */
export async function recoverStuckFinalizations(options: { deadline?: number } = {}) {
  try {
    const cutoff = new Date(Date.now() - FINALIZE_RECOVERY_GRACE_MS).toISOString();
    const tokens = await repo.listStuckFinalizingSessions(cutoff);
    const owner = `recovery:${process.pid}`;

    for (const token of tokens) {
      if (options.deadline && Date.now() >= options.deadline) {
        console.warn('[signing recovery] Deadline reached; the rest wait for the next pass.');
        break;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = await repo.getSessionByToken(token);
        if (!data || data.status !== 'in_progress') continue;

        const participants = data.participants || [];
        if (participants.length === 0 || !participants.every((p: any) => p.status === 'completed')) continue;
        if (!shouldRebuildSessionPdfFromFieldValues(data)) continue;

        // eslint-disable-next-line no-await-in-loop
        const owed = await repo.findLiveProcessingJob(data.lawFirmId, {
          sessionId: data.sessionUuid, kind: 'finalize',
        });
        if (!owed) {
          // Every signature is in and nothing is owed, which means the job was
          // committed before this table existed or was cancelled out from under
          // the session. Commit one now: the alternative is a session that stays
          // stuck for ever with nobody looking.
          // eslint-disable-next-line no-await-in-loop
          const owedSource = await finalizeSource(data);
          if (!owedSource) continue;
          // eslint-disable-next-line no-await-in-loop
          const created = await repo.enqueueProcessingJob(data.lawFirmId, {
            sourceId: owedSource.id, sessionId: data.sessionUuid, kind: 'finalize',
          });
          if (!created) continue;
          // eslint-disable-next-line no-await-in-loop
          await runJobNow(data.lawFirmId, created.id, owner);
          continue;
        }

        // A claim that loses means a live worker or a drain already holds this
        // one. That is the mechanism working, not a fault: this pass reports it
        // and moves on rather than racing the holder.
        // eslint-disable-next-line no-await-in-loop
        const outcome = await runJobNow(data.lawFirmId, owed.id, owner);
        if (outcome === 'busy' || outcome === 'lost') {
          console.warn('[signing recovery] Finalize for', tokenRef(token), 'is held by another worker');
        }
      } catch (err: any) {
        console.error('[signing recovery] Failed to finalize session', tokenRef(token), err.message);
      }
    }
  } catch (err: any) {
    console.error('[signing recovery] Error scanning stuck finalizations:', err.message);
  }
}
