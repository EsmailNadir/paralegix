import { getFirebaseToken, getFirebaseUid } from '@/lib/utils/auth';
import { getUserTimeZone } from '@/lib/utils/timezone';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { ApiError } from '@/lib/utils/apiErrors';
import { formatFileSize as formatFileSizeUtil } from '@/lib/utils/format';
import { type FileScope, scopeParams, uploadContextFor } from '@/lib/files/fileScope';
import {
  uploadResumable,
  UploadCancelledError,
  UploadSessionGoneError,
} from '@/lib/files/resumableUpload';
import {
  saveUploadSession,
  loadUploadSession,
  clearUploadSession,
  uploadSessionKey,
  type UploadDestination,
  type FileIdentity,
} from '@/lib/files/uploadSessionStore';
import { fingerprintFile } from '@/lib/files/fileFingerprint';
import { claimUploadSession, type UploadOwnership } from '@/lib/files/uploadOwnership';
import { runWithUploadLimit } from '@/lib/files/uploadConcurrency';
import { pollDelay } from '@/lib/utils/pollDelay';


/**
 * How long the wait for an export job may last.
 *
 * The archive is built by a worker on a schedule, so a large selection takes
 * minutes rather than seconds, and the reads back off (`pollDelay`) to match.
 * The ceiling exists because a job that never reaches a terminal state would
 * otherwise be polled for as long as the tab stays open, for nothing.
 */
const EXPORT_WAIT_LIMIT_MS = 15 * 60 * 1000;

/**
 * The server's cap on `matterIds` per batch listing. Over it the route answers
 * 400 without reading anything, so `listMatterFilesBatch` chunks rather than
 * letting a caller discover the limit as an error. Mirrors
 * `MAX_BATCH_MATTER_IDS` in `backend/src/modules/files/files.validation.ts`.
 */
const MAX_BATCH_MATTER_IDS = 100;

/**
 * The server's cap on `fileIds` per batched visibility change. Over it the route
 * answers 400 without writing anything, so `setClientVisibilityBulk` chunks
 * rather than letting a select-all over a very large folder discover the limit
 * as an error. Mirrors `MAX_BULK_VISIBILITY_FILE_IDS` in
 * `backend/src/modules/files/files.validation.ts`.
 */
export const MAX_BULK_VISIBILITY_FILE_IDS = 1000;

/**
 * Sleep until the next poll, or until the caller aborts, whichever is first.
 *
 * A backed-off delay is ten seconds, and an abort that waited out the sleep
 * before it was noticed would leave the job building for that long after the
 * user stopped wanting it.
 */
function waitForNextPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The rejection an aborted export produces, so a caller can recognise it. */
function abortedExport(): Error {
  const err = new Error('The download was cancelled.');
  err.name = 'AbortError';
  return err;
}

/**
 * The server's cap on files per `/upload-init`. Over it the route answers 400
 * without opening anything, so a larger selection is declared in groups of
 * this size. Mirrors the check in `backend/src/modules/files/files.upload.routes.ts`.
 */
export const MAX_FILES_PER_UPLOAD_INIT = 20;

/**
 * The server's cap on uploads named in one `/upload-cancel`. Mirrors the check
 * in `backend/src/modules/files/files.upload.routes.ts`.
 */
const MAX_FILES_PER_UPLOAD_CANCEL = 20;

export interface UploadedFile {
  /** The row's id. This is the file's identity everywhere. */
  fileId: string;
  name: string;
  objectPath: string;
  size: number;
  contentType: string;
  signedUrl: string;
}

export interface FileInfo {
  /**
   * The row's id, and the address every operation takes.
   *
   * A file used to be addressed by its storage path, which meant a rename or a
   * move rewrote the address of every document beneath a folder. The id never
   * changes, so a share link, a note attachment and an open browser tab all keep
   * working across a rename.
   */
  id: string;
  /** The folder this sits in. Null only for a scope root. */
  parentId: string | null;
  name: string;
  /** Where the bytes are. Opaque, and never parsed: it says nothing about the tree. */
  objectPath: string;
  size: number;
  contentType: string;
  updated: string;
  signedUrl: string;
  isFolder?: boolean;
  /** Whether this file is shared with the client portal (matter files only). */
  clientVisible?: boolean;
  /** When shared with only specific clients on the matter/task, their client-record
   *  ids. Null/absent = shared with all clients on the matter/task. */
  visibleClientIds?: string[] | null;
  fileCount?: number;
  folderCount?: number; // Number of subfolders inside this folder
  folderColor?: string | null;
  /**
   * For a search hit: the folders above it, from the scope root down.
   *
   * A search spans the whole scope, so a hit can sit anywhere under it. This is
   * what the browser navigates by when one is opened; names alone would not do,
   * because two folders can share a name in different parts of the tree.
   */
  trail?: { id: string; name: string }[];
  /** The same chain as one display string ("Discovery/Depositions"). */
  folderPath?: string;
  /** Human-readable label when it differs from the stored name. Paths still use name. */
  displayName?: string | null;
  /** ID of the originating task (if uploaded from a task) */
  taskId?: string;
  /** Title of the originating task */
  taskTitle?: string;
}

export interface UploadResponse {
  message: string;
  bucket: string;
  count: number;
  files: UploadedFile[];
  /**
   * The files that did not make it, by name.
   *
   * A batch used to reject as a whole on the first refusal, so nineteen
   * documents already in storage were reported as a failure and the user was
   * told nothing about which one was missing. A batch rejects only when NOTHING
   * in it landed.
   *
   * `index` is the file's position in the list the caller passed. Two picked
   * files can share a name, and only the position says which one to offer
   * again.
   */
  failures?: { name: string; error: string; index?: number }[];
}

/** What one batch of a resumable upload needs, once its files are identified and claimed. */
interface ResumableBatch {
  lawFirmId: string;
  scope: Record<string, unknown>;
  ids: { folderId?: string };
  files: File[];
  identities: FileIdentity[];
  claims: UploadOwnership[];
  destination: UploadDestination;
  onProgress?: UploadProgressCallback;
  signal?: AbortSignal;
  onFinalizing?: () => void;
}

/** One resumable upload session returned by `POST /upload-init`. */
interface InitUpload {
  /** The row claimed at init. Finalize names it; the browser never builds a path. */
  fileId: string;
  name: string;
  objectPath: string;
  uploadUrl: string;
  contentType: string;
  declaredSize: number;
  /**
   * The quota init holds for this file until finalize or cancel deletes it
   * (it lapses on its own after two hours). Absent on a descriptor remembered
   * from before init returned one; that hold has long since lapsed.
   */
  reservationId?: string;
}

export interface ListFilesResponse {
  /** The folder that was listed. Present on `list-folder`. */
  folderId?: string;
  count: number;
  files: FileInfo[];
  /** True when the listed folder (or an ancestor) is shared with the client, so
   *  its files inherit visibility. Only present on folder listings. */
  inheritedClientVisible?: boolean;
  /**
   * Always false. A listing is one indexed query now, so there is nothing to cut
   * short. It was true when a listing walked the storage bucket and gave up at
   * 25,000 objects, and a short list was indistinguishable from a complete one.
   */
  truncated?: boolean;
}

/**
 * What a batched client-visibility change reports.
 *
 * Per file, not all-or-nothing: `updated` counts what really changed and
 * `errors` names every id the server could not apply, keyed by file id, so a
 * caller can roll back exactly those rows and offer them for retry. `failed` is
 * the same ids as a list, in the order the request named them.
 */
export interface BulkVisibilityResult {
  message: string;
  /** Distinct ids the request named. */
  requested: number;
  /** How many rows really changed. */
  updated: number;
  failed: string[];
  errors: Record<string, string>;
  /** The direction that was asked for, echoed back. */
  clientVisible: boolean;
}

/** One matter's first page of documents within a batch listing. */
/** A standalone task on a client's Files tab: its title and document count. */
export interface ClientTaskFiles {
  id: string;
  title: string;
  fileCount: number;
}

export interface MatterFilesPage {
  files: FileInfo[];
  /** Means what it means on `/list`: another page of this matter exists. */
  truncated: boolean;
}

export interface UploadProgressCallback {
  (progress: number): void;
}

/** A single file the client can see in their portal (firm-side preview). */
export interface ClientVisibleDocument {
  id: string;
  /** Which scope shares this file: 'matter' | 'client' | 'task'. */
  contextType: 'matter' | 'client' | 'task';
  /** The matter / client / task id matching contextType (used to route un-share). */
  entityId: string;
  matterId: string | null;
  /** Path relative to the source root (e.g. "contracts/2024/nda.pdf"). */
  name: string;
  /** The file's own name, without the folders above it. */
  fileName: string;
  parentId: string | null;
  objectPath: string;
  type: string;
  size: number;
  uploadedAt: string | null;
  downloadUrl: string;
  sourceLabel: string;
  /** True when this file's own clientVisible flag is set (vs. inherited from a folder). */
  directlyShared: boolean;
  /** Name of the shared folder it inherits visibility from (null when shared directly). */
  viaFolderPath: string | null;
}

/** A folder shared with the client (firm-side preview). */
export interface ClientSharedFolder {
  /** The folder row. PATCH this id to un-share the folder. */
  id: string;
  contextType: 'matter' | 'client' | 'task';
  entityId: string;
  matterId: string | null;
  /** Path relative to the source root (e.g. "contracts/signed"). */
  relPath: string;
  name: string;
  /** The folder's chosen color key (e.g. "blue"), or null for the default. */
  folderColor?: string | null;
}

export interface ClientVisibleDocumentsResponse {
  documents: ClientVisibleDocument[];
  sharedFolders: ClientSharedFolder[];
  /** Always false; there is no scan left to cut short. */
  truncated?: boolean;
}

export interface StorageUsageResponse {
  usedBytes: number;
  limitBytes: number;
  fileCount: number;
  usedFormatted: string;
  limitFormatted: string;
  percentUsed: number;
}

/** Access level a secure external share link grants to whoever holds it. */
export type ShareLinkPermission = 'view' | 'download';

/**
 * A secure, tokenized external share link (no login required), to one file or
 * to a selection of files and folders.
 */
export interface ShareLink {
  token: string;
  /**
   * The document a single-file link serves. Null for a multi-item link, and
   * once a single-file link's document is destroyed.
   */
  fileId: string | null;
  /** True when the link names several items or a folder rather than one document. */
  isMultiItem: boolean;
  /** What the recipient is told they were sent: the file or folder name, or "3 items". */
  displayName: string;
  mimeType: string;
  permission: ShareLinkPermission;
  hasPassword: boolean;
  expiresAt: string | null;
  revoked: boolean;
  accessCount: number;
  lastAccessedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** Full public link the recipient opens (`.../share/<token>`). */
  url: string;
  /** What the link holds that the caller may read, by name. */
  items: ShareLinkContentItem[];
  /** What else the link holds, behind a matter or task the caller cannot read. */
  hiddenItemCount: number;
}

/** One file or folder a share link reaches. */
export interface ShareLinkContentItem {
  fileId: string;
  name: string;
  isFolder: boolean;
}

class FilesService {
  private apiRoot: string;

  constructor() {
    const API_ROOT = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
    this.apiRoot = API_ROOT.replace(/\/$/, '');
  }

  private filesBase(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/files`;
  }

  private shareLinksBase(lawFirmId: string): string {
    return `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/file-share-links`;
  }

  private async authHeaders(extra: Record<string, string> = {}) {
    const token = await getFirebaseToken();
    return {
      Authorization: `Bearer ${token}`,
      'X-Timezone': getUserTimeZone(),
      ...extra,
    };
  }

  /** A files endpoint URL carrying the scope, plus any extra query values. */
  private scopedUrl(
    lawFirmId: string,
    path: string,
    scope: FileScope,
    extra: Record<string, string | undefined> = {}
  ): string {
    const url = new URL(`${this.filesBase(lawFirmId)}/${path}`);
    for (const [key, value] of Object.entries({ ...scopeParams(scope), ...extra })) {
      if (value) url.searchParams.append(key, value);
    }
    return url.toString();
  }

  /** A request body carrying the firm, the scope, and the operation's own fields. */
  private scopedBody(
    lawFirmId: string,
    scope: FileScope,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return { lawFirmId, ...scopeParams(scope), ...extra };
  }

  /** GET a files endpoint and parse it, with the standard error mapping. */
  private async getJson<T>(url: string): Promise<T> {
    const headers = await this.authHeaders({ 'Content-Type': 'application/json' });
    const response = await apiFetch(url, { method: 'GET', headers });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as T;
  }

  /**
   * Resumable direct-to-GCS upload (init -> PUT bytes straight to GCS -> finalize).
   *
   * Replaces the old multipart POST that streamed the whole file through the
   * backend's memory, which capped file size at what the container's RAM could
   * hold. Here the backend only authorizes + reserves quota and hands back a
   * resumable upload URL per file; the bytes go browser -> GCS directly, so
   * multi-GB files (up to the firm's plan `maxFileSizeBytes`) are possible.
   *
   * Each file is sent in chunks that can resume (`lib/files/resumableUpload`),
   * and its session is remembered in the browser (`lib/files/uploadSessionStore`)
   * from before the first byte until finalize or a cancel. A file picked again
   * after a reload, or after a failure, asks GCS where the earlier attempt got to and
   * continues from there without a second init, so the quota is reserved once
   * and the name is claimed once.
   *
   * `context` selects the scope ('matter' | 'lawfirm' | 'task' | 'client'); the
   * matching id (matterId/taskId/clientId) and optional `folder` are passed
   * through to both the init and finalize calls.
   */
  private async resumableUpload(
    lawFirmId: string,
    context: 'matter' | 'lawfirm' | 'task' | 'client',
    ids: { matterId?: string; taskId?: string; clientId?: string; folderId?: string; attachmentFolder?: string },
    files: File[],
    onProgress?: UploadProgressCallback,
    signal?: AbortSignal,
    onFinalizing?: () => void
  ): Promise<UploadResponse> {
    if (files.length === 0) {
      return { message: 'No files', bucket: '', count: 0, files: [] };
    }

    const scope = {
      lawFirmId,
      context,
      matterId: ids.matterId,
      taskId: ids.taskId,
      clientId: ids.clientId,
      // A NAME, not a path: the server creates it directly under the scope root
      // if it is absent. Note attachments use it so they land in a real folder
      // that can be browsed, renamed and moved.
      ...(ids.attachmentFolder ? { attachmentFolder: ids.attachmentFolder } : {}),
    };

    // A remembered session names a row the server already claimed in ONE place,
    // so where it lands and who opened it are part of its identity. Keyed on the
    // file alone, picking the same document again in another folder resumed the
    // earlier session and filed it where the user was not looking.
    const destination: UploadDestination = {
      ...scope,
      // Part of the session identity, like every other part of the destination:
      // the same file picked again for a NOTE and for the matter root are two
      // uploads landing in two folders, and resuming one as the other files the
      // document where the user is not looking.
      folderId: ids.folderId ?? (ids.attachmentFolder ? `attach:${ids.attachmentFolder}` : null),
      userId: (await getFirebaseUid()) ?? 'anonymous',
    };

    // The identity a session is remembered under: the destination above plus
    // the file's metadata AND a SHA-256 of its first and last 8 MiB (all of it
    // for a file up to 16 MiB). Metadata alone is not content, so two files
    // agreeing on name, size and last-modified used to share one session and
    // produce a single object holding the front of one document and the back
    // of another, at a size that looks correct. The sample is read from
    // `Blob.slice()` in a worker, never the whole file: these uploads exist
    // because a document can be gigabytes.
    const identities: FileIdentity[] = await Promise.all(files.map(async (file) => ({
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      fingerprint: await fingerprintFile(file),
    })));

    // 1. Take ownership of each session before reading or writing its
    //    descriptor. `localStorage` is shared by every tab on the origin, so two
    //    tabs with the same document picked would otherwise read one descriptor
    //    and PUT into ONE session from the same offset: the bytes interleave,
    //    the object is corrupt, and neither tab is told, because both see 308s
    //    whose Range keeps advancing. A tab that cannot prove it is the owner
    //    opens an independent session and leaves the descriptor alone.
    const claims: UploadOwnership[] = await Promise.all(
      identities.map((identity) => claimUploadSession(uploadSessionKey(destination, identity))),
    );
    const releaseClaims = () => { for (const claim of claims) claim.release(); };

    try {
      return await this.sendResumableBatch({
        lawFirmId, scope, ids, files, identities, claims, destination, onProgress, signal, onFinalizing,
      });
    } finally {
      releaseClaims();
    }
  }

  /**
   * The batch itself, once the destination, identities and tab ownership are
   * settled. Split out only so ownership is released on every exit.
   */
  private async sendResumableBatch(args: ResumableBatch): Promise<UploadResponse> {
    const {
      lawFirmId, scope, ids, files, identities, claims, destination, onProgress, signal, onFinalizing,
    } = args;

    const declare = (f: File) => ({
      name: f.name, size: f.size, contentType: f.type || 'application/octet-stream',
    });

    /** Only the owning tab may read or write a descriptor. */
    const remember = (i: number, session: InitUpload) => {
      if (claims[i].owned) saveUploadSession(destination, identities[i], session);
    };
    const forget = (i: number) => {
      if (claims[i].owned) clearUploadSession(destination, identities[i]);
    };

    // 2. Recall any session still open for a file picked earlier. Those skip
    //    init entirely; only the rest are declared.
    const remembered = files.map((_, i) => (
      claims[i].owned ? loadUploadSession(destination, identities[i]) : null
    ));
    const fresh = files.filter((_, i) => !remembered[i]);

    // Declared in groups the server accepts, but sent and finalized as ONE
    // batch. Nothing is filed until finalize, so a cancel anywhere before it
    // files nothing and releases every session, however many groups the
    // selection spans. A group the server refuses costs only
    // its own files, named in `failures`; the call rejects only when every
    // group is refused, which for a single group is what it always did.
    const freshSessions: Array<InitUpload | null> = [];
    const refusedAtInit = new Map<number, string>();
    let firstRefusal: unknown = null;
    for (let start = 0; start < fresh.length; start += MAX_FILES_PER_UPLOAD_INIT) {
      // Every init reserves quota and claims names, so none is opened after a
      // cancel. The files it would have covered get no session, and the send
      // below sees the cancel and releases what the earlier groups opened.
      if (signal?.aborted) break;
      const group = fresh.slice(start, start + MAX_FILES_PER_UPLOAD_INIT);
      try {
        const init = await this.postFilesJson<{ uploads: InitUpload[] }>(
          `${this.filesBase(lawFirmId)}/upload-init`,
          { ...scope, folderId: ids.folderId, files: group.map(declare) }
        );
        group.forEach((_, i) => freshSessions.push(init.uploads?.[i] ?? null));
      } catch (err) {
        firstRefusal ??= err;
        group.forEach(() => {
          refusedAtInit.set(freshSessions.length, err instanceof Error ? err.message : String(err));
          freshSessions.push(null);
        });
      }
    }
    if (firstRefusal !== null && !freshSessions.some(Boolean) && !remembered.some(Boolean)) {
      throw firstRefusal;
    }

    // Line the sessions back up with the files as picked. The server may open
    // fewer sessions than were asked for (quota, per-file refusal), so a fresh
    // file can come back with none and is skipped rather than PUT to undefined.
    let nextFresh = 0;
    /** Why init opened no session for a picked file, by its position. */
    const notOpened = new Map<number, string>();
    const sessions: Array<InitUpload | null> = files.map((_, i) => {
      if (remembered[i]) return remembered[i];
      const session = freshSessions[nextFresh];
      const refusal = refusedAtInit.get(nextFresh);
      if (refusal !== undefined) notOpened.set(i, refusal);
      nextFresh += 1;
      return session ?? null;
    });

    // Remembered BEFORE any byte goes out, so a reload mid-transfer finds it.
    files.forEach((_, i) => {
      const session = sessions[i];
      if (session && !remembered[i]) remember(i, session);
    });

    // 2. Send each file to its session, aggregating progress by bytes uploaded.
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
    const loaded = new Array(files.length).fill(0);
    const reportProgress = () => {
      if (!onProgress) return;
      const sum = loaded.reduce((a: number, b: number) => a + b, 0);
      onProgress(Math.min(99, Math.round((sum / totalBytes) * 100)));
    };
    const send = (file: File, i: number, session: InitUpload, startOffset: 0 | 'query') =>
      uploadResumable({
        file,
        sessionUrl: session.uploadUrl,
        contentType: session.contentType,
        startOffset,
        // The bar follows TRANSPORT bytes so it moves smoothly inside a chunk,
        // which for a small file is the whole upload. It is monotonic and
        // clamped below 100 until finalize, so it can never claim more than the
        // server has in a way the user could act on.
        onTransportBytes: (bytes) => {
          loaded[i] = bytes;
          reportProgress();
        },
        signal,
      });

    /**
     * The files that could not be uploaded, and why.
     *
     * A per-file failure is recorded rather than thrown. Throwing out of the
     * batch skips finalize, and finalize is the ONLY thing that gives back the
     * quota init reserved: an entry whose object never landed contributes
     * nothing to the actual usage while its declared size still counts toward
     * the release. So a refusal that escaped here left those bytes reserved
     * forever and the next attempt reserved them again, which is how retrying a
     * failed upload could lock a firm out of its own storage.
     */
    const failures: { name: string; error: string; index: number }[] = [];
    /** Which picked files already have an entry, by position: names can repeat. */
    const failedAt = new Set<number>();
    const failed = (i: number, err: unknown) => {
      failedAt.add(i);
      failures.push({ name: files[i].name, error: err instanceof Error ? err.message : String(err), index: i });
    };

    // A file init opened no session for is never sent, so it never lands.
    // Skipped silently, a batch of two reported itself as a clean upload of one.
    files.forEach((_, i) => {
      if (!sessions[i]) failed(i, notOpened.get(i) ?? 'The upload could not be started. Please try again.');
    });

    /**
     * Set when the user cancelled. A cancel is not a failure: it is not listed
     * in `failures`, and the batch stops before finalize, which would settle
     * rows whose objects never landed and turn the cancel into an error.
     */
    let cancelled = false;

    await Promise.all(
      files.map((file, i) => runWithUploadLimit(async () => {
        const session = sessions[i];
        if (!session) return;
        try {
          // A recalled session may already hold some bytes; a new one holds none.
          await send(file, i, session, remembered[i] ? 'query' : 0);
        } catch (err) {
          if (err instanceof UploadCancelledError) {
            cancelled = true;
            return;
          }
          if (!(err instanceof UploadSessionGoneError)) {
            // Every retry spent on a storage error. The session may still be
            // good, so its descriptor stays and the next attempt resumes.
            failed(i, err);
            return;
          }
          // A dead session can never take another byte, so the descriptor is
          // released explicitly rather than left to expire and be resumed into.
          forget(i);
          if (!remembered[i]) {
            failed(i, err);
            return;
          }
          try {
            // The session recalled from an earlier attempt has died in the
            // meantime. Open a fresh one for this file alone rather than
            // surfacing "link expired" for something the user did not do now.
            const replacement = await this.postFilesJson<{ uploads: InitUpload[] }>(
              `${this.filesBase(lawFirmId)}/upload-init`,
              { ...scope, folderId: ids.folderId, files: [declare(file)] }
            );
            const reopened = replacement.uploads?.[0] ?? null;
            // The original stays in place when nothing reopened, so finalize
            // still names the row init claimed and its reservation is released.
            if (!reopened) return;
            sessions[i] = reopened;
            remember(i, reopened);
            await send(file, i, reopened, 0);
          } catch (again) {
            if (again instanceof UploadCancelledError) {
              cancelled = true;
              return;
            }
            failed(i, again);
          }
        }
      }, signal).catch((err) => {
        // The signal also ends the wait for a slot, so a file queued behind
        // two other uploads hears a cancel at once rather than when one frees.
        if (!(err instanceof UploadCancelledError)) throw err;
        cancelled = true;
      }))
    );

    // A cancel that arrived after the last byte landed is still a cancel: no
    // file was aborted, so nothing set `cancelled`, but finalize has not run.
    //
    // The cancel route gives back the quota and deletes the rows every session
    // claimed, so the names are free again at once rather than when the
    // reservations lapse. The descriptors go with the rows: picking the same
    // files again starts over rather than resuming into a row that is gone.
    if (cancelled || signal?.aborted) {
      const opened = sessions.filter((s): s is InitUpload => s !== null);
      files.forEach((_, i) => forget(i));
      this.releaseUploads(lawFirmId, scope, opened);
      throw new UploadCancelledError();
    }

    // Past this point the signal stops nothing. Finalize files what landed, so
    // a cancel control left on screen during it would be one that does nothing.
    onFinalizing?.();

    // 3. Finalize: verify each object landed, reconcile the quota, and stamp the
    // rows that init claimed. The rows are named by id: the browser never builds
    // a storage path, and cannot claim one it was not handed.
    const finalizable = sessions.filter((s): s is InitUpload => s !== null);
    const finalized = await this.postFilesJson<{
      files: UploadedFile[];
      failures?: { objectPath: string | null; error: string }[];
    }>(
      `${this.filesBase(lawFirmId)}/upload-finalize`,
      {
        ...scope,
        // The reservation goes back so finalize can delete it. Left out, it
        // stays held for two hours while the same bytes also count as saved.
        uploads: finalizable.map((s) => ({
          fileId: s.fileId, reservationId: s.reservationId, declaredSize: s.declaredSize, contentType: s.contentType,
        })),
      }
    );

    // Forget ONLY what actually finalized. Clearing every descriptor threw away
    // the resumable session of any file the server reported in `failures`, so a
    // transient per-file failure became a lost upload that had to start over
    // from byte zero. A descriptor left in place is retried; one for a file that
    // finalized would wrongly skip init on the next attempt.
    const finalizedIds = new Set(finalized.files.map((f) => f.fileId));
    files.forEach((_, i) => {
      const session = sessions[i];
      if (!session || finalizedIds.has(session.fileId)) forget(i);
    });

    // Every file sent to finalize and not stamped by it failed THERE: its bytes
    // landed, and the server then refused it (an executable signature, the
    // per-file cap, a row outside this scope). Reading only `files` dropped
    // those without a word, so a refused single file resolved as a success.
    // The server names a refusal by object path; one it cannot place (a row it
    // did not recognise) is known only by being absent from `files`.
    const refusedBecause = new Map(
      (finalized.failures ?? [])
        .filter((f): f is { objectPath: string; error: string } => !!f.objectPath)
        .map((f): [string, string] => [f.objectPath, f.error]),
    );
    files.forEach((_, i) => {
      const session = sessions[i];
      if (!session || failedAt.has(i) || finalizedIds.has(session.fileId)) return;
      failed(i, refusedBecause.get(session.objectPath) ?? 'The file could not be saved. Please try again.');
    });

    // Nothing landed at all, so there is no partial success to report and the
    // caller has to see an error: a single-file upload that stored nothing
    // would otherwise resolve and be reported as done.
    if (finalized.files.length === 0 && failures.length > 0) {
      throw new Error(failures[0].error);
    }

    if (onProgress) onProgress(100);
    return {
      message: 'Files uploaded',
      bucket: '',
      count: finalized.files.length,
      files: finalized.files,
      ...(failures.length > 0 ? { failures } : {}),
    };
  }

  /**
   * Give back what an abandoned upload holds: its quota reservations, and the
   * rows (with any partial objects) init claimed for it.
   *
   * Best effort, and not awaited by the cancel it follows: the user has already
   * stopped, and a reservation this fails to release still lapses on its own.
   * Sent in calls no larger than the route accepts.
   */
  private releaseUploads(
    lawFirmId: string,
    scope: Record<string, unknown>,
    sessions: InitUpload[],
  ): void {
    for (let start = 0; start < sessions.length; start += MAX_FILES_PER_UPLOAD_CANCEL) {
      const uploads = sessions.slice(start, start + MAX_FILES_PER_UPLOAD_CANCEL)
        .map((s) => ({ fileId: s.fileId, reservationId: s.reservationId }));
      this.postFilesJson(`${this.filesBase(lawFirmId)}/upload-cancel`, { ...scope, uploads })
        .catch(() => {});
    }
  }

  /** POST JSON to a backend files endpoint with auth + standard error mapping. */
  private async postFilesJson<T>(url: string, body: unknown): Promise<T> {
    const token = await getFirebaseToken();
    const response = await apiFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Timezone': getUserTimeZone(),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, data);
    return data as T;
  }

  /**
   * Upload files into a scope, optionally into a sub-folder of it.
   *
   * Bytes go browser -> GCS directly (see `resumableUpload`); the backend only
   * authorizes, reserves quota, and hands back the session URLs.
   *
   * `signal` stops the upload until the last byte has landed. `onFinalizing`
   * says when that point has passed and a cancel can no longer take effect.
   */
  async upload(
    lawFirmId: string,
    scope: FileScope,
    files: File[],
    onProgress?: UploadProgressCallback,
    folderId?: string,
    signal?: AbortSignal,
    onFinalizing?: () => void
  ): Promise<UploadResponse> {
    return this.resumableUpload(
      lawFirmId,
      uploadContextFor(scope),
      { ...scopeParams(scope), ...(folderId ? { folderId } : {}) },
      files,
      onProgress,
      signal,
      onFinalizing
    );
  }

  // List files in a matter
  async listMatterFiles(lawFirmId: string, matterId: string): Promise<ListFilesResponse> {
    const token = await getFirebaseToken();

    const response = await apiFetch(`${this.filesBase(lawFirmId)}/list?matterId=${encodeURIComponent(matterId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as ListFilesResponse;
  }

  /**
   * The first page of SEVERAL matters' documents in one request, as
   * matterId -> { files, truncated }.
   *
   * For a page holding a list of matters that each need their documents. The
   * rows are exactly what `listMatterFiles` returns, folder `fileCount` and
   * `folderCount` included, and `truncated` means what it means there.
   *
   * A matter the caller may read but which holds no documents comes back present
   * and empty; a matter they may NOT read is ABSENT from the map, which is the
   * batch equivalent of the 403 the per-matter route answers. Callers must treat
   * a missing key and an empty page the same way rather than assuming every id
   * they asked about is present.
   *
   * The route caps `matterIds` at 100 and answers 400 above it, so a longer list
   * is chunked here. The chunks go out one after another on purpose: the whole
   * reason this endpoint exists is to keep a large list off the API instance's
   * small Postgres connection pool, and firing the chunks together would put the
   * pressure straight back.
   */
  async listMatterFilesBatch(
    lawFirmId: string,
    matterIds: string[]
  ): Promise<Record<string, MatterFilesPage>> {
    const unique = [...new Set((matterIds || []).filter(Boolean))];
    if (unique.length === 0) return {};

    const filesByMatterId: Record<string, MatterFilesPage> = {};
    for (let start = 0; start < unique.length; start += MAX_BATCH_MATTER_IDS) {
      const url = new URL(`${this.filesBase(lawFirmId)}/list-matters`);
      url.searchParams.set('matterIds', unique.slice(start, start + MAX_BATCH_MATTER_IDS).join(','));

      const body = await this.getJson<{ filesByMatterId?: Record<string, MatterFilesPage> }>(url.toString());
      Object.assign(filesByMatterId, body?.filesByMatterId || {});
    }
    return filesByMatterId;
  }

  /**
   * The standalone tasks attached to a client that hold files, each with the
   * number of documents in its tree, ordered by title. Backs the task folders
   * on the client's Files tab.
   */
  async listClientTaskFiles(lawFirmId: string, clientId: string): Promise<ClientTaskFiles[]> {
    const url = new URL(`${this.filesBase(lawFirmId)}/list-client-tasks`);
    url.searchParams.set('clientId', clientId);
    const body = await this.getJson<{ tasks?: ClientTaskFiles[] }>(url.toString());
    return body?.tasks || [];
  }

  /**
   * Share (or unshare) a file or folder with the client portal.
   *
   * `visibleClientIds` restricts the audience on a multi-client matter or task;
   * omitting it shares with every client on the scope, including ones added later.
   */
  async setClientVisibility(params: {
    lawFirmId: string;
    scope: FileScope;
    fileId: string;
    clientVisible: boolean;
    visibleClientIds?: string[];
    /** Notify the client(s) this was shared with. Defaults to true server-side. */
    notifyClient?: boolean;
  }): Promise<{ message: string; fileId: string; clientVisible: boolean }> {
    const { lawFirmId, scope, ...rest } = params;
    const headers = await this.authHeaders({ 'Content-Type': 'application/json' });
    const response = await apiFetch(`${this.filesBase(lawFirmId)}/client-visibility`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ lawFirmId, ...scopeParams(scope), ...rest }),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as { message: string; fileId: string; clientVisible: boolean };
  }

  /**
   * The same change, for a whole selection, in ONE request.
   *
   * `setClientVisibility` above takes a single file, so sharing a selection was
   * one round trip per file against a Postgres pool every other request on the
   * instance shares. This sends the set.
   *
   * NOT ATOMIC. The route applies what it can and names every id it could not in
   * `errors`, keyed by file id, with `failed` listing those same ids. A
   * selection routinely carries ids from a listing that is a moment stale, and
   * one of those must not refuse the rest; the caller rolls back exactly the
   * failures and can offer them for retry. A thrown `ApiError`, by contrast,
   * means the request never applied anything at all.
   *
   * Every file in one call must belong to ONE scope, because the scope is what
   * the server authorizes the whole batch against. A caller whose selection
   * spans scopes groups it and calls this once per group.
   *
   * A selection longer than the route's cap is chunked here rather than refused.
   * The chunks go out one after another, for the same reason the batched listing
   * does it: firing them together would put back the pool pressure this endpoint
   * exists to remove.
   */
  async setClientVisibilityBulk(params: {
    lawFirmId: string;
    scope: FileScope;
    fileIds: string[];
    clientVisible: boolean;
    visibleClientIds?: string[];
    /** Notify the client(s) this was shared with. Defaults to true server-side. */
    notifyClient?: boolean;
  }): Promise<BulkVisibilityResult> {
    const { lawFirmId, scope, fileIds, ...rest } = params;
    const unique = [...new Set((fileIds || []).filter(Boolean))];
    const merged: BulkVisibilityResult = {
      message: 'Bulk visibility update completed',
      requested: 0,
      updated: 0,
      failed: [],
      errors: {},
      clientVisible: params.clientVisible,
    };
    if (unique.length === 0) return merged;

    const headers = await this.authHeaders({ 'Content-Type': 'application/json' });
    for (let start = 0; start < unique.length; start += MAX_BULK_VISIBILITY_FILE_IDS) {
      const chunk = unique.slice(start, start + MAX_BULK_VISIBILITY_FILE_IDS);
      const response = await apiFetch(`${this.filesBase(lawFirmId)}/bulk-client-visibility`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ lawFirmId, ...scopeParams(scope), fileIds: chunk, ...rest }),
      });
      const body = await response.json().catch(() => ({} as any));
      if (!response.ok) throw ApiError.fromResponse(response, body);

      const page = body as BulkVisibilityResult;
      merged.requested += page.requested ?? chunk.length;
      merged.updated += page.updated ?? 0;
      merged.failed.push(...(page.failed || []));
      Object.assign(merged.errors, page.errors || {});
    }
    return merged;
  }


  // Firm-side preview of everything a client can see in their portal Documents
  // (matter + standalone-task + own client-area shares, folder inheritance applied).
  async listClientVisibleDocuments(
    lawFirmId: string,
    clientId: string
  ): Promise<ClientVisibleDocumentsResponse> {
    const token = await getFirebaseToken();
    const url = `${this.apiRoot}/lawfirms/${encodeURIComponent(lawFirmId)}/clients/${encodeURIComponent(clientId)}/portal-files`;

    const response = await apiFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as ClientVisibleDocumentsResponse;
  }

  // List files in law firm general folder
  async listLawFirmFiles(lawFirmId: string): Promise<ListFilesResponse> {
    const token = await getFirebaseToken();

    const response = await apiFetch(`${this.filesBase(lawFirmId)}/list`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as ListFilesResponse;
  }

  /**
   * The signed URL for a file, minted now if the listing didn't carry one.
   *
   * Directory listings return an empty `signedUrl` because a URL is only needed
   * for the one row the user acts on, and one minted at list time is already
   * partway through its TTL by the time it is clicked. Surfaces that receive a
   * URL from elsewhere (message attachments, the client portal's document feed)
   * pass through untouched.
   */
  async ensureSignedUrl(lawFirmId: string, file: Pick<FileInfo, 'signedUrl' | 'id'>): Promise<string> {
    if (file.signedUrl) return file.signedUrl;
    if (!file.id) throw new Error('This file has no record, so it cannot be opened.');
    return this.refreshSignedUrl(lawFirmId, file.id);
  }

  async getDownloadUrl(lawFirmId: string, fileId: string): Promise<string> {
    const headers = await this.authHeaders();
    const params = new URLSearchParams({ lawFirmId, fileId });
    const response = await apiFetch(`${this.filesBase(lawFirmId)}/download-url?${params}`, { headers });
    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return (body as { downloadUrl: string }).downloadUrl;
  }

  // Download a file using its signed URL
  /**
   * Save a stored file to disk.
   *
   * The signed url IS the download: it is authorized, it names the file through
   * its own Content-Disposition, and storage serves it directly. So the browser
   * is handed the link and its download manager streams the bytes to disk.
   *
   * This used to fetch the response and build a Blob first, which put the whole
   * file in tab memory before saving any of it. That is invisible on a contract
   * and fatal on a deposition video: a 3 GB download tried to hold 3 GB.
   *
   * Kept async so every existing caller and its error handling are unchanged.
   */
  async downloadFile(signedUrl: string, filename: string): Promise<void> {
    const link = document.createElement('a');
    link.href = signedUrl;
    // A same-origin hint only. Storage sets the real filename in its own
    // Content-Disposition, which is what a cross-origin download actually uses.
    link.download = filename;
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async downloadFolder(
    lawFirmId: string,
    scope: FileScope,
    folderId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.downloadExport(lawFirmId, scope, { folderId }, signal);
  }

  /**
   * Download a selection as one zip. A folder in the selection is expanded to
   * its whole subtree server-side.
   *
   * Browsers only honour the first of several programmatic downloads fired in a
   * loop, so a multi-item download has to come back as a single archive.
   */
  async downloadZip(
    lawFirmId: string,
    scope: FileScope,
    fileIds: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.downloadExport(lawFirmId, scope, { fileIds }, signal);
  }

  /**
   * Build an archive server-side, wait for it, and hand the browser the link.
   *
   * Three requests, not one response: the archive is built by a worker with no
   * user, so this creates the job under the caller's access, polls it, and
   * downloads the URL the finished job names.
   *
   * ABORTING cancels the job rather than only abandoning the wait. A build that
   * carries on after the person who asked for it has gone charges the firm for
   * storage nobody will fetch and holds a transfer slot on the way. The cancel
   * is fire-and-forget: the caller has already stopped caring, and a failed
   * cancel must not replace their reason for stopping with an error about it.
   *
   * The wait is BOUNDED. A job that never reaches a terminal state would
   * otherwise poll for as long as the tab is open. The reads back off, and a
   * hidden tab skips them: nobody is looking at it, and the deadline still
   * runs.
   */
  private async downloadExport(
    lawFirmId: string,
    scope: FileScope,
    selection: { folderId: string } | { fileIds: string[] },
    signal?: AbortSignal,
  ): Promise<void> {
    const headers = await this.authHeaders({ 'Content-Type': 'application/json' });
    const created = await apiFetch(
      `${this.filesBase(lawFirmId)}/export-jobs?lawFirmId=${encodeURIComponent(lawFirmId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...scopeParams(scope), ...selection }),
        signal,
      },
    );
    const createdBody = await created.json().catch(() => ({} as any));
    if (!created.ok) throw ApiError.fromResponse(created, createdBody);
    const jobId = createdBody.exportJobId as string;

    const deadline = Date.now() + EXPORT_WAIT_LIMIT_MS;
    try {
      for (let poll = 0; ; poll += 1) {
        if (signal?.aborted) throw abortedExport();
        await waitForNextPoll(pollDelay(poll), signal);
        if (signal?.aborted) throw abortedExport();

        if (typeof document !== 'undefined' && document.hidden) {
          if (Date.now() > deadline) {
            throw new Error('The download is taking longer than expected. Please try again.');
          }
          continue;
        }

        const response = await apiFetch(
          `${this.filesBase(lawFirmId)}/export-job?lawFirmId=${encodeURIComponent(lawFirmId)}`
            + `&jobId=${encodeURIComponent(jobId)}`,
          { headers: await this.authHeaders(), signal },
        );
        const body = await response.json().catch(() => ({} as any));
        if (!response.ok) throw ApiError.fromResponse(response, body);
        const job = body.exportJob;
        if (job?.status === 'failed' || job?.status === 'cancelled' || job?.isExpired) {
          throw new Error('The download could not be prepared. Please try again.');
        }
        if (job?.status === 'succeeded' && job.downloadUrl) {
          await this.downloadFile(job.downloadUrl, 'files.zip');
          return;
        }
        if (Date.now() > deadline) {
          throw new Error('The download is taking longer than expected. Please try again.');
        }
      }
    } catch (err) {
      await this.cancelExport(lawFirmId, jobId);
      throw err;
    }
  }

  /** Stop an export nobody is waiting for any more. Never throws. */
  private async cancelExport(lawFirmId: string, jobId: string): Promise<void> {
    try {
      await apiFetch(
        `${this.filesBase(lawFirmId)}/export-job-cancel?lawFirmId=${encodeURIComponent(lawFirmId)}`
          + `&jobId=${encodeURIComponent(jobId)}`,
        { method: 'POST', headers: await this.authHeaders({ 'Content-Type': 'application/json' }) },
      );
    } catch {
      // The caller has already stopped waiting. Reporting a failed cancel here
      // would replace their reason for stopping with an unrelated one.
    }
  }

  /**
   * Delete a file, or a folder and everything under it.
   *
   * One address, not two. There used to be a path plus a relative name as a
   * fallback, because a caller might know only where an item sat; every caller
   * now holds the id it was listed with.
   */
  async deleteItem(
    lawFirmId: string,
    scope: FileScope,
    fileId: string
  ): Promise<{ message: string }> {
    const headers = await this.authHeaders({ 'Content-Type': 'application/json' });
    const response = await apiFetch(
      this.scopedUrl(lawFirmId, 'delete', scope, { fileId }),
      { method: 'DELETE', headers }
    );
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as { message: string };
  }

  /** Create a folder inside a scope, under `parentId` or at its root. */
  async createFolder(
    lawFirmId: string,
    scope: FileScope,
    params: { folderName: string; parentId?: string; folderColor?: string }
  ): Promise<{ message: string }> {
    return this.postFilesJson<{ message: string }>(
      `${this.filesBase(lawFirmId)}/create-folder`,
      this.scopedBody(lawFirmId, scope, params)
    );
  }

  /**
   * Where one document sits: the folders above it, from the scope root down.
   *
   * "Reveal this file" is what needs this. A surface holding only a file id has
   * to move the browser to the folder the document is in before it can flash the
   * row, and a file id says nothing on its own about the folders above it.
   */
  async fileLocation(lawFirmId: string, fileId: string): Promise<{
    scope: 'matter' | 'task' | 'client' | 'firm';
    matterId: string | null;
    taskId: string | null;
    clientId: string | null;
    name: string;
    trail: { id: string; name: string }[];
  }> {
    const params = new URLSearchParams({ lawFirmId, fileId });
    return this.getJson(`${this.filesBase(lawFirmId)}/location?${params}`);
  }

  /**
   * The trail from a scope's root down to and including one FOLDER.
   *
   * A link into the file browser carries the open folder's id and nothing else,
   * because that is what identifies it: two folders in different parts of one
   * matter can share a name. The names the breadcrumb renders are resolved here.
   */
  async folderTrail(lawFirmId: string, folderId: string): Promise<{ id: string; name: string }[]> {
    const location = await this.fileLocation(lawFirmId, folderId);
    return [...location.trail, { id: folderId, name: location.name }];
  }

  /** The immediate children of a folder within a scope (its root when no id). */
  async listFolder(
    lawFirmId: string,
    scope: FileScope,
    folderId?: string
  ): Promise<ListFilesResponse> {
    return this.getJson<ListFilesResponse>(
      this.scopedUrl(lawFirmId, 'list-folder', scope, { folderId })
    );
  }

  /**
   * Rename a file or folder.
   *
   * One column on one row, whatever is beneath it. Renaming a folder used to
   * copy every object under its prefix to a new one and delete the originals,
   * which could stop partway and leave the folder split across two places.
   */
  async rename(
    lawFirmId: string,
    scope: FileScope,
    fileId: string,
    newName: string
  ): Promise<{ message: string }> {
    return this.postFilesJson<{ message: string }>(
      `${this.filesBase(lawFirmId)}/rename`,
      this.scopedBody(lawFirmId, scope, { fileId, newName })
    );
  }

  /**
   * Move a file or folder into another folder within the same scope.
   *
   * `destinationFolderId` omitted means the scope's root.
   */
  async move(
    lawFirmId: string,
    scope: FileScope,
    params: { fileId: string; destinationFolderId?: string | null }
  ): Promise<{ message: string }> {
    return this.postFilesJson<{ message: string }>(
      `${this.filesBase(lawFirmId)}/move`,
      this.scopedBody(lawFirmId, scope, {
        fileId: params.fileId,
        ...(params.destinationFolderId ? { destinationFolderId: params.destinationFolderId } : {}),
      })
    );
  }

  /** Set a folder's colour. */
  async updateFolderColor(
    lawFirmId: string,
    scope: FileScope,
    folderId: string,
    folderColor: string
  ): Promise<{ message: string }> {
    return this.postFilesJson<{ message: string }>(
      `${this.filesBase(lawFirmId)}/update-folder-color`,
      this.scopedBody(lawFirmId, scope, { folderId, folderColor })
    );
  }

  /**
   * Recursive name search within one scope.
   *
   * The scope matters as much as the query: without it the server searches the
   * firm's General Files, so a search run from a task's or a client's file view
   * answers about the wrong documents.
   */
  async search(lawFirmId: string, scope: FileScope, query: string): Promise<ListFilesResponse> {
    return this.getJson<ListFilesResponse>(this.scopedUrl(lawFirmId, 'search', scope, { query }));
  }

  // Get storage usage for a law firm
  async getStorageUsage(lawFirmId: string): Promise<StorageUsageResponse> {
    const headers = await this.authHeaders();
    const response = await apiFetch(`${this.filesBase(lawFirmId)}/usage`, { headers });
    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as StorageUsageResponse;
  }

  // Get a fresh signed URL for a file (e.g. an expired note or task attachment).
  async refreshSignedUrl(lawFirmId: string, fileId: string, matterId?: string): Promise<string> {
    const headers = await this.authHeaders();
    const params = new URLSearchParams({ lawFirmId, fileId });
    if (matterId) params.set('matterId', matterId);
    const response = await apiFetch(`${this.filesBase(lawFirmId)}/refresh-url?${params}`, { headers });
    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return (body as { signedUrl: string }).signedUrl;
  }

  /**
   * Upload attachments for a task. Returns metadata to store on the task.
   *
   * Goes through the same direct-to-storage pair every other document uses.
   * There was a separate multipart route, which held ten files at a hundred
   * megabytes each in the API container; nothing had to be reimplemented to
   * remove it, because `context: 'task'` already resolves to the right folder
   * and stamps the row's `task_id`, which is what puts the file in the task's
   * view rather than the matter's.
   */
  async uploadTaskAttachments(
    lawFirmId: string,
    taskId: string,
    files: File[]
  ): Promise<Array<{ id: string; name: string; size: number; type: string; url: string; objectPath: string }>> {
    const uploaded = await this.resumableUpload(lawFirmId, 'task', { taskId }, files);
    return (uploaded.files ?? []).map((file) => ({
      id: file.fileId,
      name: file.name,
      size: file.size,
      type: file.contentType || 'application/octet-stream',
      url: file.signedUrl,
      objectPath: file.objectPath,
    }));
  }

  /**
   * Upload attachments for a note on a matter, task or client.
   *
   * They land in a real `note-attachments` folder in the scope tree rather than
   * under a bare path segment, so the file browser can rename and move them.
   */
  async uploadNoteAttachments(
    lawFirmId: string,
    ids: { matterId?: string; taskId?: string; clientId?: string },
    files: File[]
  ): Promise<Array<{ id: string; name: string; size: number; type: string; url: string; objectPath: string }>> {
    const uploaded = await this.uploadNoteAttachmentFiles(lawFirmId, ids, files);
    return (uploaded.files ?? []).map((file) => ({
      id: file.fileId,
      name: file.name,
      size: file.size,
      type: file.contentType || 'application/octet-stream',
      url: file.signedUrl,
      objectPath: file.objectPath,
    }));
  }

  /**
   * The upload behind `uploadNoteAttachments`, answering with the whole
   * response: what landed AND the files that did not, which the note composer
   * reports rather than dropping. Takes the cancel signal and the finalizing
   * callback the file manager's upload takes, so the composer can show the same
   * bar and cancel.
   */
  async uploadNoteAttachmentFiles(
    lawFirmId: string,
    ids: { matterId?: string; taskId?: string; clientId?: string },
    files: File[],
    signal?: AbortSignal,
    onFinalizing?: () => void
  ): Promise<UploadResponse> {
    const context = ids.matterId ? 'matter' : ids.taskId ? 'task' : 'client';
    return this.resumableUpload(
      lawFirmId, context, { ...ids, attachmentFolder: 'note-attachments' }, files, undefined, signal, onFinalizing,
    );
  }

  /** Delete a task attachment by its file id. */
  async deleteTaskAttachment(lawFirmId: string, taskId: string, fileId: string): Promise<void> {
    const headers = await this.authHeaders();
    const params = new URLSearchParams({ lawFirmId, taskId, fileId });
    const response = await apiFetch(`${this.filesBase(lawFirmId)}/delete-task-attachment?${params}`, { method: 'DELETE', headers });
    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) throw ApiError.fromResponse(response, body);
  }

  // Create a secure external share link. The recipient opens the returned
  // `link.url` with no login required; access is scoped by the chosen
  // permission, optional expiry, and optional password. Name one item with
  // `fileId`, or a selection of files and folders with `fileIds`; either way the
  // recipient gets one link.
  async createShareLink(
    lawFirmId: string,
    params: ({ fileId: string; fileIds?: never } | { fileIds: string[]; fileId?: never }) & {
      permission?: ShareLinkPermission;
      expiresInHours?: number;
      password?: string | null;
    }
  ): Promise<ShareLink> {
    const headers = await this.authHeaders({ 'Content-Type': 'application/json' });
    const response = await apiFetch(this.shareLinksBase(lawFirmId), {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return (body as { link: ShareLink }).link;
  }

  // List the active (non-revoked) share links for one file or folder, or for
  // any item of a selection, including multi-item links that name them.
  async listShareLinks(lawFirmId: string, fileIds: string | string[]): Promise<ShareLink[]> {
    const headers = await this.authHeaders();
    const url = new URL(this.shareLinksBase(lawFirmId));
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    if (ids.length === 1) url.searchParams.set('fileId', ids[0]);
    else url.searchParams.set('fileIds', ids.join(','));
    const response = await apiFetch(url.toString(), { method: 'GET', headers });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return (body as { links: ShareLink[] }).links ?? [];
  }

  // Revoke a share link by its token so it can no longer be opened.
  async revokeShareLink(lawFirmId: string, token: string): Promise<{ message: string; token: string }> {
    const headers = await this.authHeaders();
    const response = await apiFetch(`${this.shareLinksBase(lawFirmId)}/${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers,
    });
    const body = await response.json().catch(() => ({} as any));
    if (!response.ok) throw ApiError.fromResponse(response, body);
    return body as { message: string; token: string };
  }

  // Format file size for display
  formatFileSize(bytes: number): string {
    return formatFileSizeUtil(bytes);
  }
}

const filesService = new FilesService();

export default filesService;
