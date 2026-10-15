/**
 * Making a sealed session visible: filing, preserving, completing, delivering.
 *
 * `signingFinalize.ts` produces the two artifacts and records where they are.
 * Everything AFTER that is here, and it is here rather than in the completion
 * route for one reason: the route is not the only thing that finishes a
 * session. The drain finishes the ones whose request died, and a step that
 * lives in the route simply never runs for those. A session recovered by a
 * worker used to look finished to the firm while its signers received nothing.
 *
 * The ORDER is the guarantee:
 *
 *   FILE FIRST. `fileSignedArtifact` claims the session's own row, copies the
 *   artifact into the object that row names, and stamps it. Nothing is
 *   listable, searchable or counted until the stamp, so a failure partway
 *   leaves nothing visible instead of a document the browser offers and cannot
 *   open.
 *
 *   THEN PRESERVE. The archived copies are what survive the firm deleting the
 *   filed one. They are create-only, and losing that race is only success when
 *   the incumbent bytes are the same bytes.
 *
 *   THEN COMPLETE, and only then. The terminal state is a promise that the
 *   executed document exists; writing it earlier makes that promise about
 *   something that may never arrive. The transition is GUARDED, so exactly one
 *   worker moves the session and therefore exactly one delivers, charges and
 *   notifies.
 *
 * Nothing after the completion write may throw. The signatures are collected
 * and the document is filed; a delivery failure is logged and retried by a
 * person, never by undoing any of that.
 */
import { fileSignedArtifact } from './signedFileRegistration';
import { archiveDeliveredDocument, archiveSignedDocument } from './signingArchive';
import { deliverCompletedSession } from './signingDelivery';
import type { SealedArtifact } from './signingPipeline';
import { removeArtifactIntermediates } from './signingWorkspace';

const repo = require('./signatures.repository');
const { destinationScope, resolveFilingFolder } = require('./signedFileRegistration');
const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
const { writeAuditEvent, AUDIT_EVENTS } = require('./audit');
const { sweepSession: sweepSessionWorkspace } = require('./signingWorkspace');
const eventBus = require('../../shared/events/eventBus');
const { SIGNING_COMPLETED } = require('../../shared/events/eventTypes');

/**
 * How long a delivery claim holds before another worker may take it over.
 *
 * Long against the work, which is one storage read and a few emails, because a
 * claim taken over from a worker that is merely slow means the signers get a
 * second copy. Short against the outcome it guards: a worker that died mid-send
 * is re-sent on the first drain after this lapses.
 */
const DELIVERY_LEASE_SECONDS = Number(process.env.SIGNING_DELIVERY_LEASE_SECONDS) || 10 * 60;

/** Claims before an owed delivery stops being retried and is logged instead. */
const DELIVERY_MAX_ATTEMPTS = Number(process.env.SIGNING_DELIVERY_MAX_ATTEMPTS) || 5;

/**
 * Send a completed session's copies if this worker wins the claim.
 *
 * Claimed before the send and stamped after it, so a crash in between is sent
 * again rather than lost (see `claimSessionDelivery`). A send that throws leaves
 * the claim to lapse, which is the same retry. False when another worker holds
 * the delivery or it is already done.
 */
async function deliverOnce(token: string, send: () => Promise<{ delivered: boolean }>): Promise<boolean> {
  if (!(await repo.claimSessionDelivery(token, DELIVERY_LEASE_SECONDS, DELIVERY_MAX_ATTEMPTS))) {
    return false;
  }
  const outcome = await send();
  if (!outcome.delivered) return false;
  await repo.markSessionDelivered(token);
  return true;
}

function bucket() {
  const { admin } = require('../../shared/database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

/** The name the executed copy is filed and delivered under. */
export function executedFileNames(fileName: any) {
  const baseName = String(fileName || 'document').replace(/\.pdf$/i, '');
  const signedFileName = `${baseName} (Signed).pdf`;
  return { signedFileName, safeName: signedFileName.replace(/[^a-zA-Z0-9._() -]/g, '_') };
}

/** The signer whose signature closed the session. */
function lastSigner(participants: any[]) {
  const completed = (participants || []).filter((p: any) => p.status === 'completed');
  return completed
    .slice()
    .sort((a: any, b: any) => Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0))[0]
    || null;
}

/**
 * Preserve both artifacts outside the firm's browsable tree.
 *
 * Best-effort by design, because the alternative is stranding a signer whose
 * signature already happened over a storage problem. A CONFLICT is logged
 * loudly rather than swallowed: it means the archive holds a different
 * attempt's bytes under this session's name, and only a person can tell which
 * one the firm should be citing.
 */
async function preserveArtifacts(lawFirmId: string, token: string, artifacts: ExecutedArtifacts) {
  const attempts: Array<[string, Promise<string>]> = [
    ['delivered', archiveDeliveredDocument(lawFirmId, token, {
      objectPath: artifacts.delivery.ref.objectPath,
      generation: artifacts.delivery.ref.generation,
      digestHex: artifacts.delivery.digestHex,
    })],
    ['filed', archiveSignedDocument(lawFirmId, token, {
      objectPath: artifacts.filed.ref.objectPath,
      generation: artifacts.filed.ref.generation,
      digestHex: artifacts.filed.digestHex,
    })],
  ];

  for (const [label, attempt] of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop -- two copies, and order is not worth the concurrency
      const outcome = await attempt;
      if (outcome === 'conflict') {
        console.error(
          `[signing] The ${label} archive for session ${token} already holds different bytes.`,
        );
      }
    } catch (err: any) {
      console.error(`[signing] Could not archive the ${label} copy for session ${token}:`, err.message);
    }
  }
}

/**
 * The artifacts a previous attempt already produced, from the session row.
 *
 * Sizes and generations are not on the row, so they are read back from storage.
 * That is two metadata calls and no bytes, and it is what lets the filing copy
 * pin the same version the seals were computed over.
 */
async function recordedArtifacts(data: any): Promise<ExecutedArtifacts> {
  const paths = { delivery: data.finalObjectPath, filed: data.signedObjectPath };
  if (!paths.delivery || !paths.filed || !data.signedDocumentHash || !data.deliveryDocumentHash) {
    throw new Error(`Session ${data.token} has no artifacts to publish.`);
  }

  const describe = async (objectPath: string, digestHex: string) => {
    const [meta] = await bucket().file(objectPath).getMetadata();
    return {
      ref: {
        objectPath,
        generation: String(meta.generation ?? ''),
        sizeBytes: Number(meta.size || 0),
      },
      digestHex,
      signedDigestHex: digestHex,
    };
  };

  return {
    delivery: await describe(paths.delivery, data.deliveryDocumentHash),
    filed: await describe(paths.filed, data.signedDocumentHash),
  };
}

/** The two executed artifacts, both present. What publication needs. */
export interface ExecutedArtifacts {
  delivery: SealedArtifact;
  filed: SealedArtifact;
}

export interface PublishResult {
  /** False when another worker had already completed this session. */
  published: boolean;
  filedObjectPath: string | null;
}

/**
 * File, preserve, complete and deliver a session whose artifacts exist.
 *
 * Safe to run twice. The filing claim lands on its own earlier row, the archive
 * copies recognise their own bytes, and the completion transition is guarded,
 * so a second run charges nothing and notifies nobody.
 */
export async function publishCompletedSession(options: {
  lawFirmId: string;
  token: string;
  /**
   * What the run produced. A run that found the work already done carries no
   * references, and they are read back off the session row instead.
   */
  result: { delivery?: SealedArtifact | null; filed?: SealedArtifact | null };
  /** Written into the completion audit row. */
  actorUid?: string | null;
  recovered?: boolean;
  /**
   * Where to hand the completion emails instead of awaiting them here. A job
   * passes its `afterSlot`, so the mail provider's latency is not spent holding
   * a transfer slot. Omitted, delivery is awaited inline as before.
   *
   * Either way it runs only for the one worker that won the completion write
   * below, so exactly one worker delivers.
   */
  deferDelivery?: (work: () => Promise<void>) => void;
}): Promise<PublishResult> {
  const { lawFirmId, token } = options;

  const data = await repo.getSessionByToken(token);
  if (!data || data.lawFirmId !== lawFirmId) {
    throw new Error(`Session ${token} does not belong to firm ${lawFirmId}.`);
  }

  // A run that found the artifacts already built produces no references of its
  // own, and that is the retry this whole path exists for: the seals landed and
  // one of the steps below did not. The session row is where the artifacts were
  // recorded, so it is what a retry publishes from.
  const artifacts: ExecutedArtifacts = options.result.delivery && options.result.filed
    ? { delivery: options.result.delivery, filed: options.result.filed }
    : await recordedArtifacts(data);
  const participants = data.participants || [];
  const signer = lastSigner(participants);
  const { signedFileName, safeName } = executedFileNames(data.fileName);

  // A session outlives what it points at. If the folder chosen at send time was
  // deleted while signing was open, filing there would put an executed document
  // somewhere nothing lists. General Files is the fallback: findable beats
  // correct-but-gone.
  const destinationFolderId = await resolveFilingFolder(lawFirmId, data.destinationFolderId || null);

  const filed = await fileSignedArtifact({
    lawFirmId,
    destinationFolderId,
    sessionId: token,
    name: safeName,
    artifact: {
      objectPath: artifacts.filed.ref.objectPath,
      generation: artifacts.filed.ref.generation,
      sizeBytes: artifacts.filed.ref.sizeBytes,
    },
    uploadedBy: data.createdBy || null,
    bucket: bucket(),
  });

  // The filed copy is an ordinary document in the firm tree: browsable,
  // deletable, and counted against their quota like anything else they store.
  // It is charged after the fact rather than reserved beforehand because a
  // signer has already signed by this point: refusing to file the result over a
  // quota would undo nothing and lose the document. The archive and the
  // pipeline's own artifacts are NOT charged; those are the system's, and the
  // firm cannot remove them.
  //
  // Charged for what this write actually ADDS. A retry lands on its own earlier
  // row, so only the difference belongs on the firm's usage; charging the full
  // size again would bill one executed document once per attempt.
  const storageDelta = filed
    ? artifacts.filed.ref.sizeBytes - (filed.reusedSizeBytes ?? 0)
    : 0;
  if (storageDelta !== 0) {
    await adjustStorageUsageByDelta(lawFirmId, storageDelta).catch((err: any) =>
      console.error('[signing] Storage usage adjust failed for', filed?.objectPath, err.message));
  }

  await preserveArtifacts(lawFirmId, token, artifacts);

  // The publication. Guarded, so two workers that both reached this point
  // cannot both deliver: the loser sees no row and stops.
  const published = await repo.markSessionCompleted(token, {
    completedAt: new Date().toISOString(),
  });
  if (!published) {
    return { published: false, filedObjectPath: filed?.objectPath || null };
  }

  // The session is closed, so its scratch copies have no remaining reader. Not
  // awaited: a housekeeping delete must not add latency to a signer's response,
  // nor fail a signature that already happened.
  sweepSessionWorkspace(lawFirmId, token).catch((err: any) =>
    console.error('[signing] Workspace sweep failed for', token, err.message));

  // The archived certificate is rendered from the audit trail and then FROZEN,
  // so it must not be built before the row describing this completion exists.
  // Writing that row here rather than in the caller is what makes the ordering
  // a fact instead of a race: the promise handed to the archiver is the write
  // itself.
  const pendingAuditWrite = writeAuditEvent(token, AUDIT_EVENTS.SESSION_COMPLETED, {
    actorUid: options.actorUid || signer?.signerUid || null,
    metadata: {
      participantId: signer?.participantId || null,
      signedDocumentHash: artifacts.filed.digestHex,
      deliveryDocumentHash: artifacts.delivery.digestHex,
      signedObjectPath: artifacts.filed.ref.objectPath,
      signerName: signer?.signerName || null,
      recovered: !!options.recovered,
    },
  }).catch((err: any) => console.error('[audit] SESSION_COMPLETED failed:', err.message));

  // Required at call time rather than imported: the routes module requires the
  // finalize handler, which requires this one, so a top-level import would be a
  // load-time cycle.
  // eslint-disable-next-line global-require
  const { archiveCertificateAfterCompletion } = require('./signing.routes');
  archiveCertificateAfterCompletion(token, pendingAuditWrite);

  // Claimed, not just sent: the completion write above recorded the delivery
  // as owed, so if this process never gets to send it the drain does.
  const deliver = async () => {
    await deliverOnce(token, () => deliverCompletedSession({
      sessionId: token,
      data: { ...data, signerName: signer?.signerName || data.signerName || null },
      participants,
      delivery: {
        objectPath: artifacts.delivery.ref.objectPath,
        generation: artifacts.delivery.ref.generation,
        sizeBytes: artifacts.delivery.ref.sizeBytes,
      },
      signedFileName,
      safeName,
    }));
  };
  if (options.deferDelivery) options.deferDelivery(deliver);
  else await deliver();

  // Surface completion in the firm's in-app notification feed. Best-effort: a
  // notification failure must never undo a completed session.
  try {
    const { matterId } = await destinationScope(lawFirmId, data.destinationFolderId);
    eventBus.emit(SIGNING_COMPLETED, {
      lawFirmId,
      sessionId: token,
      fileName: data.fileName,
      initiatorUserId: data.createdBy || null,
      matterId: matterId || null,
      actorUserId: options.actorUid || signer?.signerUid || null,
    });
  } catch (err: any) {
    console.error('[signing] SIGNING_COMPLETED emit failed:', err.message);
  }

  // Last, after every reader of the artifacts has what it needs. A failure here
  // leaves the intermediates to the settled-workspace sweep.
  await removeArtifactIntermediates(lawFirmId, token).catch((err: any) =>
    console.warn('[signing] Could not remove artifact intermediates:', err.message));

  return { published: true, filedObjectPath: filed?.objectPath || null };
}

/**
 * Send every completed session's copies that are owed and unclaimed.
 *
 * The backstop for a worker that died between completing a session and
 * delivering it: the completion write recorded the delivery as owed, and
 * nothing else would ever send it, because every retry of the job finds the
 * session already completed and stops. Run by the signing drain.
 *
 * Rebuilt from the session row, the same way a retried publication reads its
 * artifacts. Each session is claimed on its own, so two drains reaching the same
 * one send it once. Never throws; a failure is logged and the claim lapses into
 * the next run, up to the attempt cap.
 */
export async function deliverOwedSessions(options: { deadline?: number } = {}): Promise<number> {
  let delivered = 0;
  const owed = await repo.listOwedSessionDeliveries(DELIVERY_MAX_ATTEMPTS);
  for (const { token, law_firm_id: lawFirmId } of owed) {
    if (options.deadline && Date.now() >= options.deadline) break;
    try {
      // eslint-disable-next-line no-await-in-loop -- one session at a time, each with its own claim
      const sent = await deliverOnce(token, async () => {
        const data = await repo.getSessionByToken(token);
        if (!data || data.lawFirmId !== lawFirmId) {
          throw new Error(`Session ${token} does not belong to firm ${lawFirmId}.`);
        }
        const artifacts = await recordedArtifacts(data);
        const participants = data.participants || [];
        const signer = lastSigner(participants);
        const { signedFileName, safeName } = executedFileNames(data.fileName);
        return deliverCompletedSession({
          sessionId: token,
          data: { ...data, signerName: signer?.signerName || data.signerName || null },
          participants,
          delivery: {
            objectPath: artifacts.delivery.ref.objectPath,
            generation: artifacts.delivery.ref.generation,
            sizeBytes: artifacts.delivery.ref.sizeBytes,
          },
          signedFileName,
          safeName,
        });
      });
      if (sent) {
        delivered += 1;
        console.warn('[signing] Delivered the copies a completed session still owed.');
      }
    } catch (err: any) {
      console.error('[signing] Owed delivery failed; it is retried once its claim lapses:', err?.message || err);
    }
  }
  return delivered;
}
