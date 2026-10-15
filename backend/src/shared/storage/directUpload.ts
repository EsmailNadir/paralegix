/**
 * Opening and settling an upload that never passes through this process.
 *
 * The browser PUTs to a resumable session URL minted here, so the bytes go
 * straight to storage. This module centralizes the admission checks so every
 * caller verifies the bytes that actually landed, rather than trusting the
 * declarations supplied when the session was opened.
 *
 * It deliberately owns only admission and verification. Quota, destination
 * naming and the domain row are the caller's: those genuinely differ per route,
 * and folding them in here would need a `context` union and a branch per caller,
 * which is the duplication this replaces with extra steps.
 *
 * Two things belong at settle rather than at open, and both are the same reason.
 * A resumable session URL carries no size ceiling and no content-type
 * enforcement of its own, so the size and the type declared at open are claims
 * by the caller. What storage actually recorded is what gets served.
 */
import { admin } from '../database/firebase';
import { AppError } from '../errors/AppError';
import {
  findExecutableSignature,
  rejectUploadIfDangerous,
} from '../utils/uploadPolicy';
import {
  adjustStorageUsageByDelta,
  releaseStorageReservations,
  reserveStorageUsage,
  storageLimitError,
} from '../utils/storageUsage';

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';

/**
 * Bytes read back to identify the content.
 *
 * A ranged read, not a download. Reading the whole object to check its first
 * bytes would put the file back in this process and undo the point of the
 * upload going direct.
 */
const SNIFF_BYTES = 8;

function bucket() {
  return admin.storage().bucket(BUCKET_NAME);
}

/**
 * An upload was refused, at open or at settle.
 *
 * 415 for a type refusal and 413 for a size refusal. Both are the caller's
 * request being wrong, never a fault.
 */
export class DirectUploadRejected extends AppError {
  constructor(message: string, statusCode = 415, code = 'UPLOAD_REJECTED') {
    super(message, statusCode, code);
  }
}

export interface BeginDirectUploadOptions {
  /** Where the bytes land. The caller owns naming; this never invents a path. */
  objectPath: string;
  /** Declared by the caller, and recorded on the object. Verified at settle. */
  contentType: string;
  /** Who opened it. Stamped on the object so settle can check the same caller. */
  uploadedBy: string;
  /** Largest object this destination accepts. Enforced again at settle. */
  maxBytes: number;
  /**
   * What to tell the person when their file is over `maxBytes`, given its size.
   * For a destination whose limit has a reason worth stating (a conversion, not
   * the upload itself); the default names only the number.
   */
  tooLargeMessage?: (sizeBytes: number) => string;
  /** Exact content types this destination accepts. Omit to allow ordinary files. */
  allowedContentTypes?: string[];
  /**
   * The name the user chose. Required, because it is what the dangerous
   * extension deny-list reads. It used to default to the object path's last
   * segment, which is not the user's name: several destinations name the object
   * themselves ("source", an avatar, a uuid), so the check read an extension the
   * file never had and never saw the caller's own.
   */
  fileName: string;
  /** What the caller says it will send. A claim, refused early when over cap. */
  declaredSize?: number;
  /** Browser origin, so the resumable session accepts the cross-origin PUT. */
  origin?: string;
  /** Extra object metadata the caller wants recorded. */
  metadata?: Record<string, string>;
}

export interface OpenedDirectUpload {
  uploadUrl: string;
  objectPath: string;
  contentType: string;
}

/** Normalize a content type for comparison: no parameters, no case, no space. */
function normalizeType(value: unknown): string {
  return String(value || '').toLowerCase().split(';')[0].trim();
}

function assertTypeAllowed(contentType: string, allowed: string[] | undefined, fileName: string) {
  const type = normalizeType(contentType);
  if (allowed && !allowed.map(normalizeType).includes(type)) {
    throw new DirectUploadRejected(
      `File type not allowed: "${fileName}" (${type || 'unknown type'}).`,
      415,
      'FILE_TYPE_NOT_ALLOWED',
    );
  }
  // Applies whether or not the caller narrowed the list. An empty allow list
  // means "any ordinary document", never "any bytes at all".
  const dangerous = rejectUploadIfDangerous({ mimetype: type, originalname: fileName } as any);
  if (dangerous) {
    throw new DirectUploadRejected(dangerous.message, 415, 'FILE_TYPE_NOT_ALLOWED');
  }
}

/**
 * Mint a resumable session the browser uploads to directly.
 *
 * Refuses on type here, and on the DECLARED size, which is only a claim: it
 * saves a wasted round trip when the caller is honest and does nothing when the
 * caller is not. `settleDirectUpload` is what actually enforces the cap.
 */
export async function beginDirectUpload(
  options: BeginDirectUploadOptions,
): Promise<OpenedDirectUpload> {
  const {
    objectPath, contentType, uploadedBy, maxBytes, tooLargeMessage,
    allowedContentTypes, fileName,
    declaredSize, origin, metadata,
  } = options;

  if (!objectPath) throw new DirectUploadRejected('An upload needs a destination.', 400, 'VALIDATION');
  if (!uploadedBy) throw new DirectUploadRejected('An upload needs a caller.', 400, 'VALIDATION');
  if (!fileName) throw new DirectUploadRejected('An upload needs a file name.', 400, 'VALIDATION');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('beginDirectUpload: maxBytes must be a positive number');
  }

  assertTypeAllowed(contentType, allowedContentTypes, fileName);

  if (Number.isFinite(declaredSize) && Number(declaredSize) > maxBytes) {
    throw new DirectUploadRejected(
      tooLargeMessage
        ? tooLargeMessage(Number(declaredSize))
        : `That file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit for this upload.`,
      413,
      'FILE_TOO_LARGE',
    );
  }

  const [uploadUrl] = await bucket().file(objectPath).createResumableUpload({
    origin,
    metadata: {
      contentType: normalizeType(contentType) || 'application/octet-stream',
      // The stamp is the authorization carried on the object itself. Settle
      // checks it, so a caller cannot adopt an object opened by someone else at
      // the same destination.
      metadata: { ...metadata, uploadedBy: String(uploadedBy) },
    },
  });

  return { uploadUrl, objectPath, contentType: normalizeType(contentType) };
}

export interface SettleDirectUploadOptions {
  objectPath: string;
  /** The caller settling it. Must match the stamp `beginDirectUpload` wrote. */
  uploadedBy: string;
  maxBytes: number;
  /** As at open: the refusal worded for this destination. */
  tooLargeMessage?: (sizeBytes: number) => string;
  allowedContentTypes?: string[];
  /** The name the user chose. Required, for the same reason as at open. */
  fileName: string;
}

export interface SettledDirectUpload {
  objectPath: string;
  size: number;
  contentType: string;
  /** Storage generation pinned by callers that copy the admitted source. */
  generation: string;
}

/** Remove an object that failed admission, so a refusal stores nothing. */
async function discard(objectPath: string) {
  await bucket().file(objectPath).delete().catch((err: any) => {
    // Best effort: the refusal is what matters, and a leftover object is
    // collected by the unfinalized sweep. Logged because a rejected object left
    // readable is worth noticing.
    console.error('directUpload: could not delete a rejected object', objectPath, err?.message);
  });
}

/**
 * Verify what landed, and refuse it if it is not what was allowed.
 *
 * Everything here is checked against what STORAGE recorded rather than what the
 * caller declared, because the session URL enforces neither size nor type.
 */
export async function settleDirectUpload(
  options: SettleDirectUploadOptions,
): Promise<SettledDirectUpload> {
  const { objectPath, uploadedBy, maxBytes, tooLargeMessage, allowedContentTypes, fileName } = options;
  if (!fileName) throw new DirectUploadRejected('An upload needs a file name.', 400, 'VALIDATION');
  const handle = bucket().file(objectPath);

  const [exists] = await handle.exists();
  if (!exists) {
    throw new DirectUploadRejected('That upload did not finish.', 400, 'UPLOAD_INCOMPLETE');
  }

  const [meta] = await handle.getMetadata();

  // Absence is permissive, for objects written before the stamp existed. A
  // stamp that is present and different is refused: same destination, different
  // caller, which would otherwise let one person settle another's bytes.
  if (meta.metadata?.uploadedBy && String(meta.metadata.uploadedBy) !== String(uploadedBy)) {
    throw new DirectUploadRejected('That object was not uploaded by you.', 403, 'UPLOAD_NOT_YOURS');
  }

  const size = Number(meta.size || 0);
  const contentType = normalizeType(meta.contentType) || 'application/octet-stream';

  if (size > maxBytes) {
    await discard(objectPath);
    throw new DirectUploadRejected(
      tooLargeMessage
        ? tooLargeMessage(size)
        : `That file is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit for this upload.`,
      413,
      'FILE_TOO_LARGE',
    );
  }

  if (allowedContentTypes && !allowedContentTypes.map(normalizeType).includes(contentType)) {
    await discard(objectPath);
    throw new DirectUploadRejected(
      `File type not allowed: "${fileName}" (${contentType}).`,
      415,
      'FILE_TYPE_NOT_ALLOWED',
    );
  }

  // The magic-byte sniff the multipart path ran on the request buffer, moved to
  // a ranged read. A failed read is NOT treated as a pass: a check that is
  // skipped whenever storage hiccups is a check an attacker can arrange to skip.
  let head: Buffer | null = null;
  try {
    const [buf] = await handle.download({ start: 0, end: SNIFF_BYTES - 1 });
    head = buf as Buffer;
  } catch (err: any) {
    await discard(objectPath);
    throw new DirectUploadRejected(
      'That upload could not be verified. Please try again.',
      400,
      'UPLOAD_UNVERIFIED',
    );
  }

  const signature = findExecutableSignature(head);
  if (signature) {
    await discard(objectPath);
    throw new DirectUploadRejected(
      `File type not allowed: "${fileName}" appears to be a ${signature}.`,
      415,
      'FILE_TYPE_NOT_ALLOWED',
    );
  }

  return { objectPath, size, contentType, generation: String(meta.generation ?? '') };
}

/**
 * The custom metadata key written once an object has passed admission.
 *
 * Its presence is what a later consumer (a message send) reads to know the
 * object went through `settleDirectUpload` or an equivalent server-side copy,
 * rather than being PUT to a session and never verified.
 */
export const FINALIZED_STAMP = 'finalizedAt';

/**
 * Record on the object that it passed admission, once.
 *
 * Resolves true when THIS call wrote the stamp and false when an earlier one
 * already had, so a caller charges an object's bytes against quota only the
 * first time it is finalized. The write is conditional on the metadata
 * generation that was read, so two finalizes racing on one object cannot both
 * see it unstamped and both charge it.
 *
 * `stamp` adds further keys (the name the user chose, for one). The existing
 * custom metadata is carried over explicitly, so the uploader stamp survives
 * whether storage merges or replaces the bag.
 */
export async function stampDirectUploadFinalized(
  objectPath: string,
  stamp: Record<string, string> = {},
): Promise<boolean> {
  const handle = bucket().file(objectPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- one retry after a lost race
    const [meta] = await handle.getMetadata();
    const custom = meta.metadata || {};
    if (custom[FINALIZED_STAMP]) return false;
    const precondition = meta.metageneration === undefined || meta.metageneration === null
      ? undefined
      : { ifMetagenerationMatch: meta.metageneration };
    try {
      // eslint-disable-next-line no-await-in-loop -- one retry after a lost race
      await handle.setMetadata(
        { metadata: { ...custom, ...stamp, [FINALIZED_STAMP]: new Date().toISOString() } },
        precondition as any,
      );
      return true;
    } catch (err: any) {
      // 412: something changed the metadata between the read and the write.
      // Read again; if it was another finalize, this one charges nothing.
      if (Number(err?.code) !== 412) throw err;
    }
  }
  throw new DirectUploadRejected('That upload could not be verified. Please try again.', 409, 'UPLOAD_CONFLICT');
}

export interface FinalizedUploadRecord {
  size: number;
  contentType: string;
  /** Who storage says opened the upload, or '' when the object carries no stamp. */
  uploadedBy: string;
  /** The name recorded at finalize, or '' when none was. */
  originalName: string;
  finalized: boolean;
}

/**
 * What storage recorded about an object, for a consumer deciding whether to
 * trust it. Resolves null when there is no object at the path.
 */
export async function readFinalizedUpload(objectPath: string): Promise<FinalizedUploadRecord | null> {
  let meta: any;
  try {
    [meta] = await bucket().file(objectPath).getMetadata();
  } catch (err: any) {
    if (Number(err?.code) === 404) return null;
    throw err;
  }
  const custom = meta?.metadata || {};
  return {
    size: Number(meta?.size || 0),
    contentType: normalizeType(meta?.contentType) || 'application/octet-stream',
    uploadedBy: String(custom.uploadedBy || ''),
    originalName: String(custom.originalName || ''),
    finalized: Boolean(custom[FINALIZED_STAMP]),
  };
}

/* ------------------------------------------------------------------------- *
 * Batches
 *
 * Several routes attach SEVERAL files at once and charge them against the
 * firm's storage quota. Quota is what makes a batch different from a loop over
 * the single-file helpers: every declared size is reserved before any session is
 * minted, so a firm at its limit is refused before a byte moves.
 *
 * A reservation is a `storage_reservations` row per file that lapses on its own
 * (see STORAGE_RESERVATION_TTL_MS), never part of `storage_used_bytes`. Settling
 * charges what landed and deletes the rows; discarding (an explicit cancel)
 * deletes them early. Either way an upload that is abandoned without a word
 * stops holding the firm's quota when its rows lapse.
 * ------------------------------------------------------------------------- */

export interface DeclaredUpload {
  fileName: string;
  contentType: string;
  /** What the caller says it will send. Reserved against quota, verified later. */
  size: number;
}

export interface BeginDirectUploadBatchOptions {
  lawFirmId: string;
  uploadedBy: string;
  files: DeclaredUpload[];
  /** Largest single file this destination accepts. */
  maxBytes: number;
  allowedContentTypes?: string[];
  /** Most files one request may carry. Caller-controlled arrays need a ceiling. */
  maxFiles?: number;
  /** Where each file lands. The caller owns naming; this never invents a path. */
  resolvePath: (file: DeclaredUpload, index: number) => string;
  origin?: string;
  metadata?: Record<string, string>;
}

export interface OpenedBatch {
  uploads: Array<OpenedDirectUpload & { fileName: string; declaredSize: number; reservationId: string }>;
  /** The declared total the reservations hold. Informational only. */
  reservedBytes: number;
}

/**
 * Reserve quota for a batch, then open one session per file.
 *
 * Admission runs on every file BEFORE the reservation, so a batch containing
 * one forbidden type is refused without touching the firm's quota at all.
 *
 * Each object is stamped with its own reservation id as well as its uploader.
 * `discardDirectUploadBatch` reads both back, which is how it knows an object
 * belongs to an upload that is still in flight rather than one already settled.
 */
export async function beginDirectUploadBatch(
  options: BeginDirectUploadBatchOptions,
): Promise<OpenedBatch> {
  const {
    lawFirmId, uploadedBy, files, maxBytes, allowedContentTypes,
    maxFiles = 20, resolvePath, origin, metadata,
  } = options;

  if (!Array.isArray(files) || files.length === 0) {
    throw new DirectUploadRejected('No files were selected.', 400, 'VALIDATION');
  }
  if (files.length > maxFiles) {
    throw new DirectUploadRejected(`Attach at most ${maxFiles} files at once.`, 400, 'TOO_MANY_FILES');
  }

  // Every file is admitted first. Reserving quota and then refusing a file
  // would mean unwinding a reservation for a request that was never valid.
  files.forEach((file) => {
    const size = Number(file?.size);
    if (!file?.fileName || !String(file.fileName).trim()) {
      throw new DirectUploadRejected('Each file needs a name.', 400, 'VALIDATION');
    }
    if (!Number.isFinite(size) || size < 0) {
      throw new DirectUploadRejected(`Invalid size for "${file.fileName}".`, 400, 'VALIDATION');
    }
    if (size > maxBytes) {
      throw new DirectUploadRejected(
        `"${file.fileName}" is larger than the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`,
        413,
        'FILE_TOO_LARGE',
      );
    }
    assertTypeAllowed(file.contentType, allowedContentTypes, file.fileName);
  });

  const sizes = files.map((f) => Math.max(0, Number(f.size) || 0));
  const reservedBytes = sizes.reduce((sum, n) => sum + n, 0);
  const reservation = await reserveStorageUsage({ lawFirmId, createdBy: uploadedBy, sizes });
  if (!reservation.reserved) {
    throw storageLimitError({
      currentUsage: reservation.usedBytes + reservation.heldBytes,
      incomingSize: reservedBytes,
      quotaBytes: reservation.quotaBytes,
    });
  }
  const { reservationIds } = reservation;

  try {
    const uploads = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      // eslint-disable-next-line no-await-in-loop -- one session per file, in order
      const opened = await beginDirectUpload({
        objectPath: resolvePath(file, i),
        contentType: file.contentType,
        uploadedBy,
        maxBytes,
        allowedContentTypes,
        fileName: file.fileName,
        origin,
        metadata: { ...metadata, reservationId: reservationIds[i] },
      });
      uploads.push({
        ...opened,
        fileName: file.fileName,
        declaredSize: sizes[i],
        reservationId: reservationIds[i],
      });
    }
    return { uploads, reservedBytes };
  } catch (err) {
    // A partial batch must not hold the firm's quota for files it will never
    // be able to upload.
    try {
      await releaseStorageReservations({ lawFirmId, createdBy: uploadedBy, reservationIds });
    } catch (releaseErr: any) {
      console.error('directUpload: batch reservation release failed', releaseErr?.message);
    }
    throw err;
  }
}

export interface SettleDirectUploadBatchOptions<T> {
  lawFirmId: string;
  uploadedBy: string;
  /**
   * What `beginDirectUploadBatch` handed out, echoed back by the client. The
   * name is required: `settleDirectUpload` checks it against the dangerous
   * extension deny-list, and an object path is opaque, so there is nothing else
   * to read it from. The reservation id is what gets deleted once the upload is
   * settled; omitted, the reservation simply lapses.
   */
  uploads: Array<{ objectPath: string; fileName: string; reservationId?: string | null }>;
  maxBytes: number;
  allowedContentTypes?: string[];
  /**
   * Record the domain row for one settled file. Its failure fails that file.
   *
   * A result may carry `chargedBytes`: what recording it actually added to the
   * firm's usage. A caller that stamps a row knows whether those bytes were
   * already counted by an earlier finalize, and reports the difference, so a
   * retried finalize is charged nothing. The field is removed from the result
   * before it is returned. Without it the file is charged for what landed.
   */
  onSettled: (settled: SettledDirectUpload, index: number) => Promise<T & { chargedBytes?: number }>;
}

export interface SettledBatch<T> {
  results: T[];
  failures: Array<{ objectPath: string; fileName?: string; error: string }>;
  savedBytes: number;
}

/** Delete the reservations some uploads name, logging rather than throwing. */
async function releaseNamed(
  lawFirmId: string,
  uploadedBy: string,
  uploads: Array<{ reservationId?: string | null }>,
): Promise<string[]> {
  try {
    return await releaseStorageReservations({
      lawFirmId,
      createdBy: uploadedBy,
      reservationIds: (uploads || []).map((u) => u?.reservationId),
    });
  } catch (err: any) {
    // The rows lapse on their own, so a failed delete costs the firm the hold
    // for a while, never the bytes.
    console.error('directUpload: reservation release failed', err?.message);
    return [];
  }
}

/**
 * Verify each uploaded object, record it, charge it, and delete the
 * reservations the uploads name.
 *
 * A file that fails admission or recording does NOT fail the batch: the others
 * are kept and it is reported. That mirrors the multipart path, where one
 * rejected attachment never discarded the rest of a message.
 *
 * Usage is charged for what LANDED rather than what was declared, because the
 * two differ routinely: an abandoned upload lands nothing, and a resumable
 * session has no size ceiling of its own so a file can land larger than it said.
 * Nothing is refused for quota here: the bytes are already stored.
 *
 * The reservations are deleted scoped to the caller, so naming another
 * uploader's reservation releases nothing, and an id that is already gone is a
 * no-op, which keeps a retried finalize free.
 */
export async function settleDirectUploadBatch<T>(
  options: SettleDirectUploadBatchOptions<T>,
): Promise<SettledBatch<T>> {
  const {
    lawFirmId, uploadedBy, uploads, maxBytes, allowedContentTypes, onSettled,
  } = options;

  const results: T[] = [];
  const failures: SettledBatch<T>['failures'] = [];
  let savedBytes = 0;

  // The reservations go FIRST, before any object is verified. A cancel deletes
  // an object only when it is the call that releases a still-live reservation,
  // so claiming them here means a cancel racing this finalize finds nothing to
  // release and leaves alone the bytes this finalize is about to hand back. The
  // cost is a moment where the landed bytes are neither held nor charged, which
  // at worst admits another upload a little early.
  await releaseNamed(lawFirmId, uploadedBy, uploads);

  try {
    for (let i = 0; i < uploads.length; i += 1) {
      const upload = uploads[i];
      try {
        // eslint-disable-next-line no-await-in-loop -- one object at a time bounds the work
        const settled = await settleDirectUpload({
          objectPath: upload.objectPath,
          uploadedBy,
          maxBytes,
          allowedContentTypes,
          fileName: upload.fileName,
        });
        // eslint-disable-next-line no-await-in-loop -- the row follows its object
        const recorded = await onSettled(settled, i);
        if (recorded && typeof recorded === 'object' && 'chargedBytes' in recorded) {
          const { chargedBytes, ...rest } = recorded;
          results.push(rest as T);
          savedBytes += Number.isFinite(Number(chargedBytes)) ? Number(chargedBytes) : settled.size;
        } else {
          results.push(recorded);
          savedBytes += settled.size;
        }
      } catch (err: any) {
        failures.push({
          objectPath: upload.objectPath,
          fileName: upload.fileName,
          error: err?.message || 'That upload could not be saved.',
        });
      }
    }
  } finally {
    // Whatever happened above, charge what landed. A negative figure is a
    // re-stamped document that got smaller.
    if (savedBytes !== 0) {
      try {
        await adjustStorageUsageByDelta(lawFirmId, savedBytes);
      } catch (err: any) {
        console.error('directUpload: batch usage charge failed', err?.message);
      }
    }
  }

  return { results, failures, savedBytes };
}

export interface DiscardDirectUploadBatchOptions {
  lawFirmId: string;
  uploadedBy: string;
  /** What `beginDirectUploadBatch` handed out, echoed back by the client. */
  uploads: Array<{ objectPath?: string | null; reservationId?: string | null }>;
  /**
   * Whether an object may be deleted, answered by the caller for the checks
   * only it can make: that the path is under the prefix it authorized, and that
   * nothing saved refers to the object. Omit to release the reservations and
   * leave every object alone.
   */
  mayDeleteObject?: (objectPath: string) => Promise<boolean> | boolean;
}

/**
 * Cancel uploads opened by `beginDirectUploadBatch`: free their quota now
 * rather than when their reservations lapse, and remove whatever partial bytes
 * they left.
 *
 * An object is deleted only when ALL of these hold, and any one failing leaves
 * it alone:
 *
 *   - its reservation was still live and this call deleted it. Settling deletes
 *     the reservation, so a settled upload never qualifies;
 *   - storage records THIS caller as the uploader, and the same reservation id
 *     the request names, so a caller cannot pair a live reservation of theirs
 *     with somebody else's object;
 *   - the caller's `mayDeleteObject` agrees.
 *
 * Resolves to how many reservations were released.
 */
export async function discardDirectUploadBatch(
  options: DiscardDirectUploadBatchOptions,
): Promise<{ cancelled: number }> {
  const { lawFirmId, uploadedBy, uploads, mayDeleteObject } = options;
  const list = Array.isArray(uploads) ? uploads : [];
  const released = new Set(await releaseStorageReservations({
    lawFirmId, createdBy: uploadedBy, reservationIds: list.map((u) => u?.reservationId),
  }));

  if (mayDeleteObject) {
    for (const upload of list) {
      const objectPath = String(upload?.objectPath || '');
      const reservationId = String(upload?.reservationId || '');
      if (!objectPath || !released.has(reservationId)) continue;
      const handle = bucket().file(objectPath);
      // eslint-disable-next-line no-await-in-loop -- bounded by the batch cap
      const [meta] = await handle.getMetadata().catch(() => [null]);
      // No object means the browser never wrote a byte, which is fine.
      if (!meta) continue;
      const custom = meta.metadata || {};
      if (String(custom.uploadedBy || '') !== String(uploadedBy)) continue;
      if (String(custom.reservationId || '') !== reservationId) continue;
      // eslint-disable-next-line no-await-in-loop -- the caller's check may query
      if (!(await mayDeleteObject(objectPath))) continue;
      // eslint-disable-next-line no-await-in-loop -- bounded by the batch cap
      await discard(objectPath);
    }
  }

  return { cancelled: released.size };
}
