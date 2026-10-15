/**
 * Re-reading a sealed artifact from storage, to catch what nothing else can.
 *
 * Finalizing a large document is cheap because it RESUMES the hash state
 * preparation saved, rather than reading the document again. Verification in
 * the same request resumes the same state. That is the point, and it is also a
 * blind spot: a defect in the resume path produces the same wrong answer twice,
 * and the two agree with each other.
 *
 * This is the one reader that does not share the assumption. It streams every
 * byte of a sampled artifact back out of storage, recomputes the digest from
 * nothing, and verifies the signature over the range the document itself
 * declares. Nothing is resumed and nothing is trusted.
 *
 * A mismatch is an ALERT, not a quiet retry. It means either the stored bytes
 * changed or this service computed the wrong digest, and both are things a
 * person has to look at. Retrying would turn a serious finding into a log line.
 *
 * One artifact per drain, behind the same per-instance slot as signing, so the
 * check costs a bounded amount of a machine that is also serving requests.
 */
import { createResumableDigest } from './pdf/resumableDigest';
import { openGcsPdfSource } from './pdf/gcsSource';
import { verifySealedArtifact } from './pdf/verifySeal';
import { withPdfSlot } from './signingJobs';

const repo = require('./signatures.repository');

function bucket() {
  const { admin } = require('../../shared/database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

export interface AuditOutcome {
  /** Null when there was nothing to audit. */
  sessionId: string | null;
  result?: 'ok' | 'mismatch' | 'unreadable';
  detail?: string;
}

/**
 * Audit one sampled artifact, or report that there was nothing to audit.
 *
 * "Nothing to audit" is the ordinary steady state: an artifact is audited once
 * soon after it is sealed and then again only at the repeat interval
 * `claimSessionForAudit` applies, not on every drain.
 *
 * Every failure is recorded rather than thrown. The drain that calls this is
 * doing other work, and an audit that can break the drain is one that gets
 * turned off.
 */
export async function auditOneArtifact(signal?: AbortSignal): Promise<AuditOutcome> {
  const session = await repo.claimSessionForAudit();
  if (!session) return { sessionId: null };

  const aborter = signal ?? new AbortController().signal;
  return withPdfSlot(async () => {
    try {
      const [meta] = await bucket().file(session.signedObjectPath).getMetadata();
      const ref = {
        objectPath: session.signedObjectPath,
        generation: String(meta.generation ?? ''),
        sizeBytes: Number(meta.size || 0),
      };
      if (!ref.generation || ref.sizeBytes <= 0) {
        return await record(session, 'unreadable', `${ref.objectPath} reports no usable metadata.`);
      }

      const source = openGcsPdfSource(ref);
      let digestHex: string;
      let seal;
      try {
        // From nothing. A resumed state here would make the audit agree with
        // exactly the thing it exists to check.
        const digest = await createResumableDigest();
        for await (const chunk of source.stream(0, ref.sizeBytes, aborter)) digest.update(chunk);
        if (digest.absorbed() !== ref.sizeBytes) {
          return await record(
            session, 'unreadable',
            `Read ${digest.absorbed()} bytes of a ${ref.sizeBytes}-byte object.`,
          );
        }
        digestHex = digest.digestHex();
        seal = await verifySealedArtifact(source, aborter);
      } finally {
        await source.close();
      }

      if (digestHex !== session.signedDocumentHash) {
        // The stored bytes are not the artifact this session says it produced.
        return await record(
          session, 'mismatch',
          `Stored bytes hash to ${digestHex}, and the session records ${session.signedDocumentHash}.`,
        );
      }
      if (!seal.sealValid) {
        return await record(session, 'mismatch', `The seal did not verify: ${seal.reason}`);
      }
      return await record(session, 'ok');
    } catch (err: any) {
      return record(session, 'unreadable', String(err?.message || err));
    }
  });
}

async function record(
  session: any,
  result: 'ok' | 'mismatch' | 'unreadable',
  detail?: string,
): Promise<AuditOutcome> {
  await repo.recordAuditResult(session.id, result, detail);
  if (result === 'mismatch') {
    // Loud on purpose. This says either storage changed under a sealed document
    // or this service computed a digest that does not describe it.
    console.error(
      `[signing:audit] ALERT: session ${session.token} artifact ${session.signedObjectPath}: ${detail}`,
    );
  } else if (result === 'unreadable') {
    console.warn(`[signing:audit] session ${session.token} could not be audited: ${detail}`);
  }
  return { sessionId: session.id, result, detail };
}
