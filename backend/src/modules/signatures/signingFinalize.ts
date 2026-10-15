/**
 * Turning a completed session into its two executed artifacts, durably.
 *
 * The work itself is `signingPipeline.ts`: it appends, so a 3 GB document never
 * enters memory. What this file adds is everything that has to be true AROUND
 * that work for it to be safe to run from a queue.
 *
 * It reads the session's own record of what was agreed rather than trusting
 * anything the request carried. The values a signer submitted are already
 * stored, filtered to the fields that signer owned, so rebuilding from them is
 * what makes finalization repeatable: the same session finalized twice produces
 * the same document, and a worker that dies partway leaves nothing to reconcile.
 *
 * It refuses rather than improvises. A session whose source is gone, whose
 * fields cannot be placed, or whose seals do not verify is left retryable or
 * failed. A completed session pointing at an unsigned or partial artifact is
 * the one outcome that must never happen, because nothing downstream can tell.
 */
import { AppError } from '../../shared/errors/AppError';
import { runSigningPipeline } from './signingPipeline';
import { buildFieldAppearance, loadFieldAppearanceFonts } from './pdf/fieldAppearance';
import { inspectStoredPdf, pinStoredObject, savedDigestStateOf } from './signingSources';
import { openGcsPdfSource } from './pdf/gcsSource';
import { artifactPaths } from './signingWorkspace';
import { deliverOwedSessions, publishCompletedSession } from './signingPublication';
import { signingIdentity } from './digitalSign';
import type { PipelineResult, StampableField } from './signingPipeline';
import type { StoredPdf } from './pdf/types';

const repo = require('./signatures.repository');
const { registerJobHandler, registerDrainSweep } = require('./signingJobs');

export class SigningFinalizeError extends AppError {
  constructor(message: string, code = 'SIGNING_FINALIZE_FAILED') {
    super(message, 500, code);
  }
}

/**
 * Every value the signers submitted, by field.
 *
 * Taken from the stored per-participant arrays, which were already filtered to
 * the fields each participant owned. Merging them here cannot reintroduce
 * another signer's value into a field they do not own, because the filter
 * happened before storage rather than after.
 */
function valuesByField(participants: any[]): Map<string, any> {
  const values = new Map<string, any>();
  for (const participant of participants || []) {
    for (const item of participant.fieldValues || []) {
      if (item && item.fieldId != null) values.set(String(item.fieldId), item.value);
    }
  }
  return values;
}

/** Whether a stored value is something to draw. */
function hasValue(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

export async function sessionStampableFields(data: any, participants: any[]): Promise<StampableField[]> {
  const values = valuesByField(participants);
  const fonts = await loadFieldAppearanceFonts();
  return (data.fields || [])
    .filter((field: any) => hasValue(values.get(String(field.id))))
    .map((field: any) => ({
      id: String(field.id),
      page: field.page ?? 1,
      xPercent: Number(field.xPercent),
      yPercent: Number(field.yPercent),
      widthPercent: Number(field.widthPercent),
      heightPercent: Number(field.heightPercent),
      appearance: (allocate: any, box: { width: number; height: number }) => buildFieldAppearance({
        fieldType: field.fieldType,
        value: values.get(String(field.id)),
        style: field.style,
        boxWidth: box.width,
        boxHeight: box.height,
        fonts,
        allocate,
      }),
    }));
}

/**
 * The source the signer actually saw, pinned.
 *
 * The admitted source's PREPARED object is the right one: it is what the signer
 * viewed, forms flattened, and its saved hash state is what lets sealing avoid
 * reading the document again. A session recorded before the admission boundary
 * existed has none, so its upload is pinned here and streamed once instead.
 */
async function resolveSource(lawFirmId: string, data: any): Promise<{
  ref: StoredPdf;
  savedDigest: any;
}> {
  const source = data.sourceId ? await repo.getSource(lawFirmId, data.sourceId) : null;
  if (!source || source.status !== 'ready' || !source.preparedObjectPath) {
    // No fallback to the raw upload. There was one, for sessions recorded
    // before the admission boundary existed, and it cost a full streamed read
    // of the document on every finalize because such a source has no saved hash
    // state. Every session now names a source that was admitted before it
    // existed, so arriving here without a ready one is a defect upstream, not a
    // case to work around by sealing bytes nothing inspected.
    throw new SigningFinalizeError(
      `Session ${data.token} has no ready source to finalize from.`,
      'SIGNING_SOURCE_NOT_READY',
    );
  }
  return {
    ref: {
      objectPath: source.preparedObjectPath,
      generation: String(source.preparedGeneration),
      sizeBytes: Number(source.preparedSizeBytes),
    },
    savedDigest: savedDigestStateOf(source),
  };
}

/** What the certificate states, from the session's own record. */
function certificateFrom(data: any, participants: any[]) {
  const completed = (participants || []).filter((p: any) => p.status === 'completed');
  return {
    documentTitle: data.fileName || null,
    transactionId: data.id || data.token || null,
    sessionCreatedAt: data.createdAt || null,
    signedAt: completed[completed.length - 1]?.completedAt || null,
    originalDocumentHash: data.documentHash || null,
    signerName: completed[completed.length - 1]?.signerName || data.signerName || null,
    signers: completed.map((p: any) => ({
      name: p.signerName || p.name || null,
      roleLabel: p.roleLabel || null,
      email: p.email || null,
      completedAt: p.completedAt || null,
      signerIp: p.signerIp || null,
    })),
  };
}

/**
 * Build, seal and store both artifacts for a completed session.
 *
 * The session row is updated only after BOTH seals verify and both objects
 * exist. Recording a reference before that would leave a completed session
 * pointing at a document that is not finished.
 */
export async function buildSessionArtifacts(options: {
  lawFirmId: string;
  token: string;
  /**
   * Whether this worker still holds the job, asked only when a destination is
   * already taken by an attempt that died before recording anything. Absent, a
   * taken destination is refused rather than replaced.
   */
  claimStillHeld?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<PipelineResult> {
  const { lawFirmId, token } = options;
  const signal = options.signal || new AbortController().signal;

  const data = await repo.getSessionByToken(token);
  if (!data) throw new SigningFinalizeError(`Session ${token} does not exist.`);
  if (data.lawFirmId !== lawFirmId) {
    throw new SigningFinalizeError(`Session ${token} belongs to another firm.`);
  }

  const participants = data.participants || [];
  if (participants.length === 0 || !participants.every((p: any) => p.status === 'completed')) {
    // Not an error state: the session simply is not finished. Producing an
    // artifact now would seal a document a signer has not agreed to yet.
    throw new SigningFinalizeError(
      `Session ${token} is not complete.`, 'SIGNING_SESSION_NOT_COMPLETE',
    );
  }

  const { ref, savedDigest } = await resolveSource(lawFirmId, data);
  const fields = await sessionStampableFields(data, participants);

  if (fields.length === 0) {
    // A session with no stamped marks has nothing that identifies it as signed
    // by anyone. Sealing it would produce a tamper-evident copy of a blank form.
    throw new SigningFinalizeError(
      `Session ${token} has no field values to stamp.`, 'SIGNING_NO_FIELD_VALUES',
    );
  }

  const result = await runSigningPipeline({
    source: ref,
    savedDigest,
    fields,
    certificate: certificateFrom(data, participants),
    identity: signingIdentity(),
    claimStillHeld: options.claimStillHeld,
    signal,
    ...artifactPaths(lawFirmId, token),
  });

  if (result.failures.length > 0 || !result.delivery || !result.filed) {
    // Recoverable, and deliberately not written anywhere. The signers' consent
    // stands; what failed is the layout, and a sender who repairs it can
    // finalize again.
    throw new SigningFinalizeError(
      `Session ${token} has ${result.failures.length} field(s) that cannot be placed: `
        + result.failures.map((f) => `${f.fieldId} (${f.reason})`).join('; '),
      'SIGNING_FIELDS_UNPLACEABLE',
    );
  }

  await repo.updateSession(token, {
    finalObjectPath: result.delivery.ref.objectPath,
    signedObjectPath: result.filed.ref.objectPath,
    signedDocumentHash: result.filed.digestHex,
    deliveryDocumentHash: result.delivery.digestHex,
  });

  return result;
}

/**
 * Whether a session's executed document is rebuilt from its field values.
 *
 * A session with fields is: the stored values are drawn onto the admitted
 * source. A session with none is FIELDLESS, and its executed document is the
 * copy the signer marked up in the browser and uploaded.
 */
export function rebuildsFromFieldValues(data: any): boolean {
  return Array.isArray(data?.fields) && data.fields.length > 0;
}

/**
 * Seal a fieldless session's uploaded copy without loading it into API memory.
 *
 * The copy is named by the session's `workingObjectPath`, recorded in the same
 * transaction as the last consent. It crosses the same admission every other
 * document crosses before anything is appended to it: the browser built it from
 * an admitted source, but nothing here depends on that being true.
 */
export async function buildFieldlessSessionArtifacts(options: {
  lawFirmId: string;
  token: string;
  claimStillHeld?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<PipelineResult> {
  const signal = options.signal || new AbortController().signal;
  const data = await repo.getSessionByToken(options.token);
  if (!data || data.lawFirmId !== options.lawFirmId) {
    throw new SigningFinalizeError(`Session ${options.token} does not exist.`);
  }
  const participants = data.participants || [];
  if (participants.length === 0 || !participants.every((p: any) => p.status === 'completed')) {
    throw new SigningFinalizeError(`Session ${options.token} is not complete.`, 'SIGNING_SESSION_NOT_COMPLETE');
  }
  if (!data.workingObjectPath) {
    throw new SigningFinalizeError(
      `Session ${options.token} has no uploaded copy to seal.`, 'SIGNING_SOURCE_NOT_READY',
    );
  }

  const source = await pinStoredObject(data.workingObjectPath);
  const pdf = openGcsPdfSource(source);
  try {
    await inspectStoredPdf(pdf, signal);
  } finally {
    await pdf.close();
  }

  const result = await runSigningPipeline({
    source,
    fields: [],
    allowUnstampedSource: true,
    certificate: certificateFrom(data, participants),
    identity: signingIdentity(),
    claimStillHeld: options.claimStillHeld,
    signal,
    ...artifactPaths(options.lawFirmId, options.token),
  });
  if (!result.delivery || !result.filed) {
    throw new SigningFinalizeError(`Session ${options.token} could not be sealed.`);
  }
  await repo.updateSession(options.token, {
    finalObjectPath: result.delivery.ref.objectPath,
    signedObjectPath: result.filed.ref.objectPath,
    signedDocumentHash: result.filed.digestHex,
    deliveryDocumentHash: result.delivery.digestHex,
  });
  return result;
}

/**
 * Finalization, as a durable job.
 *
 * The lease is re-checked before the session row is touched, because the row is
 * the publication: a worker that lost its claim and writes anyway gives the
 * session a second set of artifact references, and the first worker's documents
 * become unreachable storage nobody can identify.
 */
registerJobHandler('finalize', async (job: any, context: any) => {
  const token = await repo.getSessionTokenById(job.lawFirmId, job.sessionId);
  if (!token) {
    throw new SigningFinalizeError(`Job ${job.id} names a session that does not exist.`);
  }

  // An attempt that already sealed both artifacts must NOT build a second set.
  // The compose is create-only, so a rebuild fails at the destination with a
  // precondition error that says nothing about the document being finished and
  // correct. What a retry is actually for is everything AFTER the seals, and
  // publication reads the references it needs off the session row.
  const recorded = await repo.getSessionByToken(token);
  const alreadySealed = !!(recorded?.signedObjectPath && recorded?.finalObjectPath
    && recorded?.signedDocumentHash && recorded?.deliveryDocumentHash);

  const result: { delivery?: any; filed?: any } = alreadySealed
    ? { delivery: null, filed: null }
    : await (rebuildsFromFieldValues(recorded) ? buildSessionArtifacts : buildFieldlessSessionArtifacts)({
      lawFirmId: job.lawFirmId,
      token,
      // The lease, re-read from the database rather than from this worker's own
      // belief about it. It decides one thing: whether a destination an earlier
      // attempt abandoned may be replaced.
      claimStillHeld: () => context.checkpoint('composing', { token }),
    });

  if (!(await context.checkpoint('sealed', {
    delivery: result.delivery?.ref ?? null,
    filed: result.filed?.ref ?? null,
    resumed: alreadySealed,
  }))) {
    throw new SigningFinalizeError(
      `Job ${job.id} lost its lease before it could record what it produced.`,
      'SIGNING_LEASE_LOST',
    );
  }

  // Filing, preserving, completing and delivering happen HERE rather than in
  // the request that triggered the job. A step that lives in the request simply
  // never runs for a session the drain finishes, which is every session whose
  // request died: that one used to leave a firm looking at a finished document
  // while its signers received nothing.
  await publishCompletedSession({
    lawFirmId: job.lawFirmId,
    token,
    result,
    recovered: Number(job.attempt || 0) > 1,
    // The emails wait on a mail provider, not on the document, so they are
    // sent once this job has given its transfer slot back.
    deferDelivery: context.afterSlot,
  });
});

// Wherever the finalize handler is registered, so is the backstop for the one
// thing a finalize owes after its job has settled: the signers' copies, when
// the worker that completed the session died before sending them.
registerDrainSweep(deliverOwedSessions);
