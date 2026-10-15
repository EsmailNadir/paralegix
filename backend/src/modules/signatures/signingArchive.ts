/**
 * Durable storage for what a completed signing session leaves behind: the
 * executed PDF, and the Certificate of Completion describing how it was executed.
 *
 * The copy the sender files (into a matter, a client folder, General Files) stays
 * entirely theirs to move, rename and delete. That is the working copy. What it is
 * NOT is a safe place to keep the only copy of an executed document, because
 * nothing stops an ordinary file delete from removing it and leaving a session
 * that reports 'completed' but can produce nothing. The certificate was worse
 * still: it was stored nowhere at all and rebuilt from the session row, its
 * participants and its audit events on every download, so it survived exactly as
 * long as those rows did.
 *
 * Both now live under the firm's `signatures/{token}/` archive. See
 * shared/storage/recordArchive for what that placement buys and why the path
 * shape is defined in one place.
 */

const {
  archivePath,
  archivePrefix,
  putArtifact: putRecordArtifact,
  getArtifact: getRecordArtifact,
  copyArtifact: copyRecordArtifact,
} = require('../../shared/storage/recordArchive');

const SEGMENT = 'signatures';

export const CERTIFICATE_ARTIFACT = 'certificate-of-completion.pdf';
export const SIGNED_DOCUMENT_ARTIFACT = 'signed-document.pdf';

/**
 * The executed PDF as it was actually sent out: sealed, but without the appended
 * Signature Certificate page, so its bytes (and therefore its hash) differ from
 * the filed copy's.
 *
 * Kept because this is the copy recipients hold. It is the one emailed to
 * signers and posted into a portal client's thread, and its hash is the value
 * printed on the certificate as the integrity check a recipient can reproduce
 * against their own file. Preserving only the filed copy left the firm able to
 * quote that hash and unable to produce the document it describes, which is the
 * wrong half to keep in the dispute the archive exists for.
 */
export const DELIVERED_DOCUMENT_ARTIFACT = 'delivered-document.pdf';

export function signingArchivePath(lawFirmId: string, token: any, artifact: any) {
  return archivePath(lawFirmId, SEGMENT, token, artifact);
}

export function signingArchivePrefix(lawFirmId: string, token: any) {
  return archivePrefix(lawFirmId, SEGMENT, token);
}

/**
 * Store an artifact, best-effort. Never fails the caller's request.
 *
 * Create-only. What is archived under a session's token is the record of what
 * that session executed, and it is written once: at finalize, or by the first
 * read that finds the archive empty. A second write is either a retry that lost
 * a race or a later rebuild, and neither should be allowed to replace evidence
 * someone may already have downloaded and cited.
 */
async function putSigningArtifact(lawFirmId: string, token: any, artifact: any, buffer: any) {
  if (!lawFirmId || !token) return false;
  return putRecordArtifact(
    signingArchivePath(lawFirmId, token, artifact),
    buffer,
    { signingArchiveFor: token, signingArtifact: artifact },
    { overwrite: false },
  );
}

/**
 * Archived bytes, or null when nothing has been archived yet.
 *
 * Propagates a genuine read failure rather than reporting it as an empty
 * archive, so a caller cannot mistake "GCS is having a moment" for "this session
 * predates the archive" and fall back to a copy the firm can edit.
 */
async function getSigningArtifact(lawFirmId: string, token: any, artifact: any) {
  if (!lawFirmId || !token) return null;
  return getRecordArtifact(signingArchivePath(lawFirmId, token, artifact));
}

export const putCertificate = (lawFirmId: string, token: any, buffer: any) =>
  putSigningArtifact(lawFirmId, token, CERTIFICATE_ARTIFACT, buffer);
export const getCertificate = (lawFirmId: string, token: any) =>
  getSigningArtifact(lawFirmId, token, CERTIFICATE_ARTIFACT);
export const putSignedDocument = (lawFirmId: string, token: any, buffer: any) =>
  putSigningArtifact(lawFirmId, token, SIGNED_DOCUMENT_ARTIFACT, buffer);
export const getSignedDocument = (lawFirmId: string, token: any) =>
  getSigningArtifact(lawFirmId, token, SIGNED_DOCUMENT_ARTIFACT);
export const putDeliveredDocument = (lawFirmId: string, token: any, buffer: any) =>
  putSigningArtifact(lawFirmId, token, DELIVERED_DOCUMENT_ARTIFACT, buffer);

export const putArtifact = putSigningArtifact;
export const getArtifact = getSigningArtifact;

/** A sealed artifact as it sits in storage, which is all the archive needs. */
export interface ArchivableArtifact {
  objectPath: string;
  generation?: string | null;
  /** SHA-256 of the whole artifact. Stamped on the archived copy. */
  digestHex: string;
}

/**
 * Preserve an executed artifact by COPYING it, not by re-uploading it.
 *
 * The artifact is already a stored object, so the archive copy is a server-side
 * operation over a pinned generation: nothing passes through this process, and
 * the size of the document stops mattering.
 *
 * Returns what happened, rather than a boolean. A create-only write that lost
 * the race to a DIFFERENT attempt's bytes is not the outcome the caller asked
 * for, and collapsing it into success is how a session ends up citing an
 * archived document it never produced.
 */
export function archiveSignedDocument(lawFirmId: string, token: any, artifact: ArchivableArtifact) {
  return copyRecordArtifact({
    source: { objectPath: artifact.objectPath, generation: artifact.generation ?? null },
    destPath: signingArchivePath(lawFirmId, token, SIGNED_DOCUMENT_ARTIFACT),
    contentHash: artifact.digestHex,
    metadata: { signingArchiveFor: String(token), signingArtifact: SIGNED_DOCUMENT_ARTIFACT },
  });
}

export function archiveDeliveredDocument(lawFirmId: string, token: any, artifact: ArchivableArtifact) {
  return copyRecordArtifact({
    source: { objectPath: artifact.objectPath, generation: artifact.generation ?? null },
    destPath: signingArchivePath(lawFirmId, token, DELIVERED_DOCUMENT_ARTIFACT),
    contentHash: artifact.digestHex,
    metadata: { signingArchiveFor: String(token), signingArtifact: DELIVERED_DOCUMENT_ARTIFACT },
  });
}
