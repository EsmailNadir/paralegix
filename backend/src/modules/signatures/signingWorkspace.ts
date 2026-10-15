/**
 * Scratch storage for a signing session that is still open.
 *
 * A session in flight needs somewhere to accumulate marks: a copy per
 * participant for parallel routing, one shared copy for sequential. Neither is
 * the pristine source (which stays untouched so the authoritative signed PDF can
 * be rebuilt from it at finalize) and neither is a record. They exist only until
 * the session stops being open.
 *
 * They live under the firm's `signing-work/{token}/` prefix, which is
 * swept by the firm delete like everything else beneath it, is excluded from the
 * firm's storage quota (see shared/storage/recordArchive: the firm did not ask
 * for these and has no way to remove one), and is cleared by `sweepSession` when
 * the session completes, is cancelled, or expires.
 *
 */

const { archivePath, archivePrefix, deletePrefix } = require('../../shared/storage/recordArchive');

export const SEGMENT = 'signing-work';

/**
 * Root prefix for documents uploaded (or converted) to be sent for signing.
 *
 * These stay at the bucket root rather than moving under `lawfirmids/`, because
 * their authorization model is different from everything there: an upload is
 * readable by the person who made it, checked against `uploadedBy` on the object,
 * and several call sites recognize a transient source precisely BY this prefix.
 * Putting them under the firm prefix would make them match the firm-membership
 * branch of `validateSigningSourcePath` instead, widening access from the
 * uploader to every member of the firm.
 *
 * The firm id is a path segment instead, which changes nothing for those checks
 * (the prefix they test is unchanged) while giving firm deletion something to
 * sweep. A path carrying no firm id cannot be reached by a firm-scoped erasure,
 * which is how these came to outlive the firms that owned them.
 */
export const UPLOAD_ROOT_PREFIX = 'signing-uploads/';

/** Where one uploaded signing source lives. */
export function signingUploadPath(lawFirmId: string, uniqueId: any, fileName: any) {
  // An upload with no firm id keeps the flat shape rather than landing under a
  // literal "undefined" folder.
  const scope = lawFirmId ? `${lawFirmId}/` : '';
  return `${UPLOAD_ROOT_PREFIX}${scope}${uniqueId}/${fileName}`;
}

/** Every signing upload belonging to one firm. */
export function signingUploadPrefix(lawFirmId: string) {
  return `${UPLOAD_ROOT_PREFIX}${lawFirmId}/`;
}

/** Every working copy belonging to one firm. */
export function firmWorkingPrefix(lawFirmId: string) {
  return `lawfirmids/${lawFirmId}/${SEGMENT}/`;
}

/** Where one participant's working copy lives. */
export function workingCopyPath(lawFirmId: string, token: any, artifact: any) {
  return archivePath(lawFirmId, SEGMENT, token, artifact);
}

/** The prefix holding every working copy of one session. */
export function workingPrefix(lawFirmId: string, token: any) {
  return archivePrefix(lawFirmId, SEGMENT, token);
}

/**
 * Discard a finished session's scratch copies.
 *
 * Best-effort and never awaited for correctness: the session has already reached
 * its terminal state, and refusing to complete it because a scratch file would
 * not delete would be reporting a housekeeping problem as a signing failure. The
 * TTL sweep catches whatever this misses.
 */
export async function sweepSession(lawFirmId: string, token: any) {
  if (!lawFirmId || !token) return 0;
  return deletePrefix(workingPrefix(lawFirmId, token));
}

/**
 * Discard everything transient a firm owned. Called when the firm is deleted.
 *
 * The working prefix sits under `lawfirmids/{firmId}/`, which the firm-wide file
 * sweep already covers, so it is repeated here only so this function is the whole
 * answer regardless of which sweep runs first. The upload prefix is at the bucket
 * root and is reachable no other way.
 */
export async function sweepFirm(lawFirmId: string) {
  if (!lawFirmId) return 0;
  const swept = await Promise.all([
    deletePrefix(signingUploadPrefix(lawFirmId)),
    deletePrefix(firmWorkingPrefix(lawFirmId)),
  ]);
  return swept.reduce((sum, n) => sum + n, 0);
}

/** Where a session's artifacts live. One prefix, so a sweep can find them all. */
export function artifactPaths(lawFirmId: string, token: string) {
  const root = `lawfirmids/${lawFirmId}/signatures/${token}/`;
  return {
    scratchPrefix: `${root}scratch/`,
    stampedPath: `${root}stamped.pdf`,
    deliveryPath: `${root}delivery.pdf`,
    filedPath: `${root}filed.pdf`,
  };
}

/**
 * Remove what producing a session's artifacts left behind.
 *
 * The stamped copy both artifacts are composed from is a full-size document,
 * and nothing reads it once they are sealed and published. The scratch prefix
 * holds suffixes a crash stranded between their save and their compose. Both
 * are outside the firm's quota and every listing, so left alone they are
 * storage nobody is charged for and nobody can see.
 */
export async function removeArtifactIntermediates(lawFirmId: string, token: any) {
  if (!lawFirmId || !token) return 0;
  const { stampedPath, scratchPrefix } = artifactPaths(lawFirmId, String(token));
  const [stamped, scratch] = await Promise.all([deletePrefix(stampedPath), deletePrefix(scratchPrefix)]);
  return stamped + scratch;
}
