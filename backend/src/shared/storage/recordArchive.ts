const { runWithConcurrency } = require('../utils/runWithConcurrency');

/**
 * GCS operations in flight at once within a single object page.
 *
 * `forEachObjectPage` hands callers pages of up to 1000 objects, and these loops
 * used to `Promise.all` the whole page — with the folder-move path pairing every
 * GCS op with a Postgres write, so one move could put a thousand concurrent
 * operations and a thousand connection checkouts in flight. A bound in the low
 * tens preserves nearly all the throughput (these are latency-bound network
 * calls) while leaving the pool and the socket budget for everyone else.
 */
const GCS_PAGE_CONCURRENCY = Number(process.env.GCS_PAGE_CONCURRENCY) || 24;
'use strict';

/**
 * Storage for records the firm must still be able to produce years later, kept
 * outside the document tree they browse.
 *
 * Some things a firm sends out are evidence of what happened, not working
 * documents: the PDF a client actually signed, the certificate describing how
 * they signed it, the invoice as it was emailed. Filing those in an ordinary
 * folder makes them a file like any other, one delete away from gone, and leaves
 * no answer to "what exactly did we send them?" once the underlying rows have
 * moved on.
 *
 * Archived records live under `lawfirmids/{firmId}/{segment}/{recordId}/`, where
 * `segment` is one of ARCHIVE_SEGMENTS. Those segments are SIBLINGS of `general/`,
 * `clients/`, `tasks/` and the per-matter uuid folders, never children, so no
 * listing in the file browser walks them and no folder delete sweeps them up. On
 * top of that:
 *
 *   - the write routes refuse to delete, rename or move anything matching
 *     `isProtectedArchivePath` (files.storage.js)
 *   - the storage quota skips them: the firm never asked for a preserved copy,
 *     and could not free the space even if they wanted to
 *   - deleting the FIRM still removes everything, which is what erasure requires
 *
 * The point of centralising the path shape here is that the writers and the
 * guards must never disagree. A guard enforced against a slightly different
 * prefix than the one being written to protects nothing, and nothing announces
 * it: deletes keep returning 200 and the gap only surfaces the day the record is
 * needed.
 */

const { forEachObjectPage } = require('./listObjects');

/** Top-level segments reserved for preserved records. */
export const ARCHIVE_SEGMENTS = ['signatures', 'invoices'];

/**
 * Top-level segments holding copies the system makes for its own use.
 *
 * An open signing session needs a scratch PDF per participant to accumulate
 * their marks into, a folder export writes one zip of documents the firm
 * already owns, and filling or previewing a template writes the produced
 * document somewhere the browser can fetch it from. Those are the system's
 * copies rather than the firm's: no
 * listing shows them and no route lets the firm remove one, so they are excluded
 * from the quota for exactly the reason the archives are. Charging a firm twice
 * for a folder because they downloaded it is the specific mistake this prevents.
 * Unlike an archive they are transient, so they are NOT delete-protected: the
 * session or job that owns them sweeps them when it finishes, and a TTL sweep
 * catches whatever that misses.
 *
 * They sit under the firm prefix (rather than at the bucket root, where they
 * began) so that deleting the firm removes them along with everything else. A
 * path carrying no firm id cannot be swept by a firm-scoped erasure.
 */
export const WORKING_SEGMENTS = ['signing-work', 'exports', 'template-renders', 'invoice-outgoing'];

const PROTECTED_RE = new RegExp(`^lawfirmids/[^/]+/(?:${ARCHIVE_SEGMENTS.join('|')})/`);

const SYSTEM_RE = new RegExp(
  `^lawfirmids/[^/]+/(?:${[...ARCHIVE_SEGMENTS, ...WORKING_SEGMENTS].join('|')})/`
);

/**
 * Resolved on first use rather than at import.
 *
 * `isProtectedArchivePath` is pure string logic and runs on every file delete, so
 * answering a question about a string must not depend on cloud credentials being
 * loadable.
 */
function bucket() {
  const { admin } = require('../database/firebase');
  return admin.storage().bucket(process.env.GCS_BUCKET);
}

/** Where one artifact of one record lives. */
export function archivePath(lawFirmId: string, segment: any, recordId: any, artifact: any) {
  return `lawfirmids/${lawFirmId}/${segment}/${recordId}/${artifact}`;
}

/** The prefix holding every artifact of one record. */
export function archivePrefix(lawFirmId: string, segment: any, recordId: any) {
  return `lawfirmids/${lawFirmId}/${segment}/${recordId}/`;
}

/** Whether an object path belongs to a preserved-record archive. */
export function isProtectedArchivePath(objectPath: any) {
  return PROTECTED_RE.test(String(objectPath || ''));
}

/**
 * Whether an object exists because the system put it there, not the firm.
 *
 * The quota question and the delete question have different answers, so they get
 * different predicates. Everything here is excluded from the firm's usage (they
 * did not ask for it and could not free it), but only the archives are refused
 * by the delete/rename/move guards.
 */
export function isSystemObjectPath(objectPath: any) {
  return SYSTEM_RE.test(String(objectPath || ''));
}

/**
 * Store an artifact, best-effort. Returns whether it landed.
 *
 * Archiving must never fail the operation that produced the bytes. A signer has
 * already signed; an invoice has already reached the client's inbox. Reporting a
 * storage problem by failing that request would undo nothing and confuse
 * everyone, so the failure is logged and the next read backfills instead.
 *
 * `overwrite: false` makes the write create-only (`ifGenerationMatch: 0`), which
 * is what a preserved record wants: the first bytes stored under a path are the
 * record, and a later write is either a redundant retry or a mistake. Losing that
 * race is reported as success, because the outcome the caller wanted (an archived
 * artifact at this path) is exactly what is there.
 */
export async function putArtifact(objectPath: any, buffer: any, metadata = {}, { overwrite = true } = {}) {
  if (!objectPath || !buffer?.length) return false;
  try {
    await bucket().file(objectPath).save(buffer, {
      ...(overwrite ? {} : { preconditionOpts: { ifGenerationMatch: 0 } }),
      metadata: {
        contentType: 'application/pdf',
        cacheControl: 'no-store, max-age=0',
        metadata,
      },
    });
    return true;
  } catch (err: any) {
    if (!overwrite && isPreconditionFailed(err)) {
      // Someone archived this record first. Their copy is the record.
      return true;
    }
    console.error('[archive] Failed to store', objectPath, err.message);
    return false;
  }
}

/** Custom-metadata key naming the exact bytes an archived artifact holds. */
export const ARCHIVE_CONTENT_HASH = 'archiveContentHash';

/**
 * What a create-only archive copy did.
 *
 * `conflict` is the outcome that has to exist. A 412 says only that something
 * is already at the path; it does not say it is the same record. When it is a
 * different attempt's bytes, reporting success would leave the caller believing
 * its own artifact is preserved while the archive holds someone else's.
 */
export type ArchiveCopyResult = 'created' | 'matched' | 'conflict';

/**
 * Copy an already-stored artifact into the archive, create-only.
 *
 * The bytes never enter this process: storage joins the objects server side.
 * That is the difference that matters once an executed document is larger than
 * the container, and it is why this takes a reference and a digest rather than
 * a buffer.
 *
 * The source generation is pinned, so an object replaced between sealing and
 * archiving fails rather than preserving bytes nobody verified. The digest is
 * stamped on the destination, which is what lets a later attempt tell its own
 * copy from a rival's.
 */
export async function copyArtifact(options: {
  source: { objectPath: string; generation?: string | null };
  destPath: string;
  /** SHA-256 of the artifact, which is its identity. */
  contentHash: string;
  metadata?: Record<string, string>;
}): Promise<ArchiveCopyResult> {
  const { source, destPath, contentHash } = options;
  const handle = bucket().file(source.objectPath, source.generation
    ? { generation: String(source.generation) } : undefined);
  try {
    await handle.copy(bucket().file(destPath), {
      preconditionOpts: { ifGenerationMatch: 0 },
      contentType: 'application/pdf',
      cacheControl: 'no-store, max-age=0',
      metadata: { ...(options.metadata || {}), [ARCHIVE_CONTENT_HASH]: contentHash },
    });
    return 'created';
  } catch (err: any) {
    if (!isPreconditionFailed(err)) throw err;
    // Something is already there. Whose it is decides whether this is done.
    const [meta] = await bucket().file(destPath).getMetadata();
    const incumbent = meta?.metadata?.[ARCHIVE_CONTENT_HASH] || (meta?.metadata as any)?.metadata?.[ARCHIVE_CONTENT_HASH];
    if (incumbent && String(incumbent) === contentHash) return 'matched';
    console.error(
      '[archive] Create-only copy lost to different bytes at', destPath,
      `(archived ${incumbent || 'unstamped'}, this attempt ${contentHash})`,
    );
    return 'conflict';
  }
}

/** Whether a GCS error means "the object is not there", as opposed to a failed read. */
function isNotFound(err: any) {
  return Number(err?.code) === 404 || Number(err?.response?.status) === 404;
}

/** Whether a create-only write lost the race to an object that already exists. */
function isPreconditionFailed(err: any) {
  const code = Number(err?.code) || Number(err?.response?.status);
  return code === 412 || code === 409;
}

/**
 * Archived bytes, or null when nothing has been archived at that path.
 *
 * THROWS on any failure that is not a missing object. The distinction matters
 * more than it looks: callers treat null as "never archived" and fall back to
 * rebuilding or to a mutable copy, so collapsing a transient read failure into
 * null makes a blip indistinguishable from an empty archive and lets the
 * fallback overwrite a preserved record that was there all along.
 */
export async function getArtifact(objectPath: any) {
  if (!objectPath) return null;
  try {
    const [buffer] = await bucket().file(objectPath).download();
    return buffer?.length ? buffer : null;
  } catch (err: any) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Whether an artifact exists and how large it is, without reading it.
 *
 * For a caller that is about to hand out a signed url rather than the bytes.
 * Downloading the object to learn its size would put it in the process, which
 * is the cost the signed url exists to avoid.
 *
 * Null means "not archived", the same distinction `getArtifact` draws: any other
 * failure throws, so a transient blip cannot be read as an empty archive.
 */
export async function statArtifact(objectPath: any): Promise<{ size: number } | null> {
  if (!objectPath) return null;
  try {
    const [meta] = await bucket().file(objectPath).getMetadata();
    const size = Number(meta?.size || 0);
    return size > 0 ? { size } : null;
  } catch (err: any) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * A short-lived read url for one archived artifact.
 *
 * Here rather than through the files module's `signObject`, because that module
 * builds its bucket at module scope and so initializes Firebase on import.
 * Pulling it into the billing graph made a pure late-fee arithmetic test load
 * cloud credentials, which is the same reason `bucket()` above is a function.
 *
 * The caller is responsible for authorizing FIRST. A signed url is a bearer
 * credential: minted before the check it is a way to read a record the caller
 * may not see.
 */
export async function signArtifact(
  objectPath: any,
  { contentType = 'application/pdf', fileName = 'document.pdf', ttlMs = 60 * 60 * 1000 } = {},
): Promise<string> {
  const [url] = await bucket().file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + ttlMs,
    responseDisposition: `attachment; filename="${String(fileName).replace(/[^a-zA-Z0-9 ._-]/g, '_')}"`,
  });
  return url;
}

/**
 * Everything archived under a record's prefix, oldest first.
 *
 * Returns `{ name, objectPath, sizeBytes, createdAt }` per artifact. A record
 * with nothing archived yields an empty array rather than throwing, since the
 * common case for older records is simply that they predate the archive.
 */
export async function listArtifacts(prefix: any) {
  if (!prefix) return [];
  try {
    const [files] = await bucket().getFiles({ prefix });
    return files
      .map((file: any) => ({
        name: file.name.slice(prefix.length),
        objectPath: file.name,
        sizeBytes: Number(file.metadata?.size || 0),
        createdAt: file.metadata?.timeCreated || null,
      }))
      .filter((entry: any) => entry.name && !entry.name.includes('/'))
      .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } catch (err: any) {
    console.error('[archive] Failed to list', prefix, err.message);
    return [];
  }
}

/**
 * Remove everything under a prefix. Best-effort, like the writers: a sweep that
 * fails leaves objects the next sweep will find, which is strictly better than
 * failing the operation that triggered it.
 *
 * Returns the number of objects deleted.
 */
export async function deletePrefix(prefix: any) {
  if (!prefix) return 0;
  let deleted = 0;
  try {
    await forEachObjectPage(bucket(), prefix, async (files: any) => {
      await runWithConcurrency(files.map((file: any) => () => file.delete().then(
        () => { deleted += 1; },
        (err: any) => console.error('[archive] Failed to delete', file.name, err.message)
      )), GCS_PAGE_CONCURRENCY);
    });
  } catch (err: any) {
    console.error('[archive] Failed to sweep', prefix, err.message);
  }
  return deleted;
}
