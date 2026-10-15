/**
 * Remembers an open upload session per file, so a reload resumes it.
 *
 * `POST /upload-init` returns one descriptor per file: the row it claimed and
 * the GCS session URL to PUT bytes to. Both outlive the page. The session URL
 * is valid for seven days and the backend keeps the unfinalized row for 24
 * hours. Keeping the descriptor here, keyed by what identifies the same file
 * being picked again, is what lets the second attempt ask GCS where the first
 * got to instead of opening a new session at byte zero.
 *
 * The key is the DESTINATION plus the file's identity. Both halves matter and
 * the destination half was missing.
 *
 * The file half is name, size, last-modified and a SHA-256 of the first and
 * last 8 MiB of the content (all of it for a file up to 16 MiB): any of those
 * differing means a different file, and resuming would splice new bytes onto
 * old ones. The hash is the only one of the four that is evidence about the
 * BYTES, and it is checked against the stored record as well as being part of
 * the key, so a resume is refused before a byte is sent.
 *
 * The destination half is the user, the firm, the scope ids and the folder. A
 * stored descriptor names a row the server already claimed in one specific
 * place. Keyed on the file alone, picking the same document again in another
 * folder resumed the first session and filed it where the user was not looking;
 * picking it under another matter produced a per-file rejection that surfaced
 * as one file silently missing. The user id keeps two people on a shared
 * device apart.
 *
 * The key is JSON rather than joined with a separator, because a file name may
 * contain any character including the separator, and two different uploads
 * could otherwise collide on one key.
 *
 * `localStorage` throws in a private window and in some managed browsers.
 * Every call here catches, because an upload with no memory is still an
 * upload, and an upload that cannot start because storage is locked is not.
 */

export interface StoredUploadSession {
  fileId: string;
  name: string;
  objectPath: string;
  uploadUrl: string;
  contentType: string;
  declaredSize: number;
}

/** What identifies a picked file across page loads. */
export interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
  /**
   * SHA-256 of the CONTENT, streamed from the file's slices before any byte is
   * sent (`lib/files/fileFingerprint`).
   *
   * The other three fields are metadata, and metadata is not content: a
   * document re-exported from the same template, or two scans off one device
   * saved in the same millisecond, agree on all of them. Without this the
   * second file resumes into the first one's session and the stored object ends
   * up holding the front of one document and the back of another, at a size
   * that looks entirely correct.
   */
  fingerprint: string;
}

/**
 * Everything that decides where an upload lands, and who is uploading it.
 *
 * Every field participates in the key. A null is meaningful: a task-scoped
 * upload with no matter is a different destination from a matter-scoped one.
 */
export interface UploadDestination {
  lawFirmId: string;
  /** The signed-in user, so a shared device does not resume someone else's upload. */
  userId: string;
  context: string;
  matterId?: string | null;
  taskId?: string | null;
  clientId?: string | null;
  folderId?: string | null;
}

/**
 * 20 hours. Under the backend's 24-hour unfinalized-row sweep with room for
 * clock drift, so a recalled session always still has a row to finalize into.
 */
export const UPLOAD_SESSION_MAX_AGE_MS = 20 * 60 * 60 * 1000;

const PREFIX = 'plx:upload-session:';

export function uploadSessionKey(to: UploadDestination, file: FileIdentity): string {
  // Fixed field order, JSON-encoded, so a name containing the separator cannot
  // produce another upload's key.
  return PREFIX + JSON.stringify([
    to.lawFirmId,
    to.userId,
    to.context,
    to.matterId ?? null,
    to.taskId ?? null,
    to.clientId ?? null,
    to.folderId ?? null,
    file.name,
    file.size,
    file.lastModified,
    file.fingerprint,
  ]);
}

interface StoredRecord {
  session: StoredUploadSession;
  savedAt: number;
  /**
   * The fingerprint this descriptor was saved against.
   *
   * Redundant with the key on purpose. The key is the fast path; this is what
   * `loadUploadSession` actually verifies, so resumption cannot be reduced to
   * "the key matched" by a later change to how keys are built. A record written
   * before the fingerprint existed has none and is discarded.
   */
  fingerprint?: string;
}

export function saveUploadSession(to: UploadDestination, file: FileIdentity, session: StoredUploadSession): void {
  try {
    const record: StoredRecord = { session, savedAt: Date.now(), fingerprint: file.fingerprint };
    window.localStorage.setItem(uploadSessionKey(to, file), JSON.stringify(record));
  } catch {
    // No memory for this upload. It still runs.
  }
}

export function loadUploadSession(to: UploadDestination, file: FileIdentity): StoredUploadSession | null {
  const key = uploadSessionKey(to, file);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<StoredRecord>;
    if (!record.session || typeof record.savedAt !== 'number') {
      window.localStorage.removeItem(key);
      return null;
    }
    if (Date.now() - record.savedAt >= UPLOAD_SESSION_MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    // Resumption verifies the content before another byte goes out. A record
    // with no fingerprint predates the check and cannot prove anything about
    // the bytes already in the session, so it is discarded rather than trusted.
    if (record.fingerprint !== file.fingerprint) {
      window.localStorage.removeItem(key);
      return null;
    }
    return record.session;
  } catch {
    // Unreadable storage or a corrupt record. Either way, no session to resume.
    try { window.localStorage.removeItem(key); } catch { /* storage itself is unavailable */ }
    return null;
  }
}

export function clearUploadSession(to: UploadDestination, file: FileIdentity): void {
  try {
    window.localStorage.removeItem(uploadSessionKey(to, file));
  } catch {
    // Nothing to forget, or nowhere to forget it from.
  }
}
