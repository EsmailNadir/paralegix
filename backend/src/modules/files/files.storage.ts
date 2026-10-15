/**
 * The storage primitives every files route builds on: the bucket handle, the
 * upload policy, the signed-URL rules, and the guards that stand between a
 * request and destroying something.
 *
 * Nothing here knows about Express. The route files compose these; see
 * `files.scope.js` for who is allowed to address which prefix.
 */

const { admin } = require('../../shared/database/firebase');
const { AppError, ForbiddenError, ValidationError } = require('../../shared/errors/AppError');
const {
  setStorageUsageBytes,
  formatBytes,
} = require('../../shared/utils/storageUsage');
const { retryOnTransient } = require('../../shared/utils/retryTransient');
const tasksRepo = require('../tasks/tasks.repository');
const mattersRepo = require('../matters/matters.repository');
const filesRepo = require('./files.repository');
const shareLinksRepo = require('./shareLinks.repository');
const { isProtectedArchivePath, isSystemObjectPath } = require('../../shared/storage/recordArchive');
const { forEachObjectPage: pageObjects, NO_CEILING } = require('../../shared/storage/listObjects');
const { resolveUniquePath } = require('../../shared/storage/uniquePath');
const { findExecutableSignature } = require('../../shared/utils/uploadPolicy');

// Resolve bucket (use env or fallback to 'lawfirms')
export const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
export const bucket = admin.storage().bucket(BUCKET_NAME);

// Ceiling on how many paths one /download-zip request may name. Folders in the
// selection are expanded into storage listings, so the work per request is
// otherwise unbounded.
//
// Sized to sit above any selection a person can actually make: "select all" in
// the files view resolves against every row on screen in the current folder, and
// that listing is not server-paged, so the ceiling has to clear a genuinely large
// folder rather than a page of one. It exists to reject a crafted request naming
// a hundred thousand paths, not to cap real downloads.
export const MAX_ZIP_SELECTION = 5000;

// --- Signed-URL TTLs (centralized; all V4 read URLs) ---
const MINUTE = 1000 * 60;
const HOUR = MINUTE * 60;
// Listing URLs are short-lived: the user may never click them and `/refresh-url`
// re-issues on demand.
export const SIGNED_URL_TTL_LIST = 30 * MINUTE;
// Default TTL for direct returns after upload, `/view`-less direct returns,
// `/refresh-url`, and `/list-folder`.
export const SIGNED_URL_TTL_DEFAULT = 1 * HOUR;
// Attachment uploads (note/task) used to bake 7-day URLs into stored
// records (task `attachments` arrays, note bodies). That is a week-long bearer
// token bypassing all permission checks. Shortened to 1 hour; the frontend has a
// `/refresh-url` path for re-issuance.
export const SIGNED_URL_TTL_ATTACHMENT = 1 * HOUR;

/**
 * Content-type / extension policy.
 *
 * We do NOT hard-reject uploads (that risks breaking legitimate existing flows).
 * Instead we classify a small set of clearly-dangerous "active content" types
 * (HTML, SVG, XHTML, etc.) that browsers will execute script from when served
 * inline. Those are always served as `attachment` so they can never be rendered
 * in the app origin as an XSS vector. Everything else (pdf, images, office docs,
 * plain media) keeps its existing inline behavior.
 */
const DANGEROUS_INLINE_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml', // can carry inline scripts / XSLT
  'text/xml',
  'application/xhtml',
]);

const DANGEROUS_INLINE_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'mhtml', 'mht',
]);

function getExtension(name: any) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a file (by mimetype + filename) is safe to serve with
 * `Content-Disposition: inline`. Dangerous active-content types are forced to
 * download. PDFs/images/etc. remain inline so previews keep working.
 */
function isInlineSafe(contentType: any, fileName: any) {
  const mime = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (DANGEROUS_INLINE_MIME_TYPES.has(mime)) return false;
  if (DANGEROUS_INLINE_EXTENSIONS.has(getExtension(fileName))) return false;
  return true;
}

/**
 * Builds the `responseDisposition` for a signed read URL. Dangerous types are
 * forced to `attachment`; everything else stays `inline` so the in-app preview
 * (images/pdf/video/audio rendered straight from the signed URL) is preserved.
 */
export function dispositionFor(contentType: any, fileName: any) {
  const kind = isInlineSafe(contentType, fileName) ? 'inline' : 'attachment';
  return fileName ? `${kind}; filename="${fileName}"` : kind;
}

/**
 * Upload content-type / extension DENY-LIST.
 *
 * We deliberately do NOT use a strict allow-list (that risks rejecting
 * legitimate, rarely-seen office/CAD/archive types). Instead:
 *   - A small set of clearly-executable / dangerous types is REJECTED outright
 *     at upload time (the user is told why). These have no business in a
 *     document store and are the highest-risk for drive-by execution.
 *   - The existing `DANGEROUS_INLINE_*` set (HTML/SVG/XML) is NOT rejected (those
 *     can be legitimate documents) but is force-downloaded via `dispositionFor`.
 *
 * The bytes are checked too: `rejectUploadIfDangerous` sniffs the leading bytes
 * for an executable signature, so renaming `evil.exe` to `evil.pdf` is caught.
 * Malware scanning of otherwise-legitimate container formats (a weaponized PDF)
 * remains out of scope; it needs an async pipeline.
 */
const BLOCKED_UPLOAD_MIME_TYPES = new Set([
  'application/x-msdownload',        // .exe/.dll
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sh',
  'application/x-csh',
  'application/x-bat',
  'application/bat',
  'application/x-msi',
  'application/java-archive',        // .jar (runnable)
  'application/x-java-archive',
  'application/x-php',
  'application/x-httpd-php',
  'application/hta',
  'application/x-ms-installer',
]);

// NOTE: `js`, `pl`, and `cgi` were intentionally REMOVED from this set. They are
// common, legitimate document-store contents (a `.js` config a client sends,
// source-code evidence in a matter, a `.cgi`/`.pl` script as a stored artifact)
// and the deny-list keys on the lying extension/mimetype anyway, so
// hard-rejecting them surprised real workflows without meaningfully reducing
// risk: such files are never executed by the app and are force-downloaded, never
// served inline. True OS executables and Windows/shell script types stay blocked.
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'scr', 'msi', 'msp', 'cpl',
  'bat', 'cmd', 'sh', 'bash', 'csh', 'ps1', 'psm1', 'vbs', 'vbe', 'jse',
  'wsf', 'wsh', 'hta', 'jar', 'jnlp', 'php', 'phtml', 'php3', 'php4', 'php5',
  'pht', 'asp', 'aspx', 'jsp', 'app', 'dmg', 'deb', 'rpm',
]);

/**
 * Returns null if the upload is allowed, or an Error (status 415) to reject it.
 * Rejection is by mimetype OR extension. An attacker can't bypass by lying about
 * one when the other is dangerous.
 */
export function rejectUploadIfDangerous(file: any) {
  const mime = String(file?.mimetype || '').toLowerCase().split(';')[0].trim();
  const ext = getExtension(file?.originalname || '');
  if (BLOCKED_UPLOAD_MIME_TYPES.has(mime) || (ext && BLOCKED_UPLOAD_EXTENSIONS.has(ext))) {
    const err: any = new Error(
      `File type not allowed: "${file?.originalname || 'upload'}" ` +
      `(${mime || 'unknown type'}). Executable and script files cannot be uploaded.`
    );
    err.status = 415;
    err.code = 'FILE_TYPE_NOT_ALLOWED';
    return err;
  }
  // Defense against a faked name/mimetype: reject if the actual bytes are an
  // executable, regardless of what the upload claims to be.
  const signature = findExecutableSignature(file?.buffer);
  if (signature) {
    const err: any = new Error(
      `File type not allowed: "${file?.originalname || 'upload'}" appears to be a ${signature}. ` +
      'Executable files cannot be uploaded.'
    );
    err.status = 415;
    err.code = 'FILE_TYPE_NOT_ALLOWED';
    return err;
  }
  return null;
}

/**
 * Reject path components that could escape or corrupt a logical folder path:
 * `..`, leading/trailing slashes producing empty segments, or empty input.
 * Returns true when the value is a safe relative path fragment.
 */
export function isSafePathComponent(value: any) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/')) return false;
  if (value.includes('\\')) return false;
  const segments = value.split('/');
  for (const seg of segments) {
    // Allow a single trailing `.folder` marker segment, but never empty or `..`.
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Throws a 400 when `value` is present but not a safe relative path fragment. */
export function assertSafePathComponent(value: any, label: any) {
  if (value && !isSafePathComponent(value)) {
    throw new ValidationError(`Invalid ${label}`);
  }
}

export function hasResolvedPermission(req: any, permission: any) {
  if (req.member?.isOwner) return true;
  return Array.isArray(req.member?.resolvedPermissions) && req.member.resolvedPermissions.includes(permission);
}

// --- GCS custom-metadata readers (GCS lowercases custom keys, so accept both) ---

/**
 * A folder's own name, read back out of its `.folder` marker path
 * (`…/Contracts/.folder` → `Contracts`).
 *
 * The mirrored `files` row for a folder stores that name, not the marker's
 * filename, so any re-point of the row has to supply it. Letting the default take
 * the path's basename would rename every folder in the table to `.folder`.
 */
function folderNameFromMarkerPath(markerPath: any) {
  const segments = String(markerPath).split('/').filter(Boolean);
  return segments.length >= 2 ? segments[segments.length - 2] : null;
}

export { formatBytes };

/**
 * Keep external share links in step with the file they describe.
 *
 * A share link stores an object path and mints a signed URL for whatever is at
 * that path when the recipient opens it, so a link that outlives its file is not
 * merely broken: uploads only uniquify against objects that currently EXIST, so
 * once a file is deleted its path is free again, and the next upload of the same
 * name into the same folder lands on exactly the path an old, still-live link
 * points at. The recipient would then be served a document nobody granted them.
 *
 * Destroying a file therefore revokes its links, and relocating one carries them
 * along (the link is a promise about a document, not about a location).
 *
 * All four are best-effort: the storage operation has already happened by the
 * time they run, and failing the request afterwards would report a problem the
 * caller cannot act on. A revoke that misses leaves a link resolving to a
 * now-empty path, which `resolveDownload` reports as gone.
 */
export async function revokeShareLinksForFile(lawFirmId: string, fileIds: any) {
  const ids = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [fileIds].filter(Boolean);
  if (ids.length === 0) return;
  try {
    await shareLinksRepo.revokeForFiles(lawFirmId, ids);
  } catch (err: any) {
    console.error('files.storage: share-link revoke failed for', ids.length, 'file(s)', err.message);
  }
}

/**
 * Refuse to destroy or relocate a preserved record.
 *
 * The archive holds executed documents, their certificates of completion, and
 * invoices as they were sent. Nothing in the UI can reach it (no listing walks
 * those prefixes), so this only ever fires on a hand-crafted request, but the
 * whole point of the archive is that the record is still there years later, and a
 * path that is merely hard to reach is not the same as one that is protected.
 * Deleting the firm still removes it, which is what erasure requires.
 */
export function assertNotArchivedRecord(row: any, verb: any) {
  // A preserved record lives outside the browsable tree, under its own prefix.
  // A row in the tree can still point at one, so the check is on the object.
  if (isProtectedArchivePath(row?.objectPath || row)) {
    throw new ForbiddenError(
      `This is a preserved record and cannot be ${verb}. Use the copy filed in your documents instead.`
    );
  }
}

/**
 * Refuse to destroy or relocate a file belonging to a matter under legal hold.
 *
 * Putting a matter under legal hold already blocks deleting the MATTER, but that
 * was the whole of it: every document inside it stayed freely deletable. A
 * litigation hold is mostly about the documents, so a firm could place a matter
 * on hold, believe its evidence was preserved, and still lose it to an ordinary
 * file delete.
 *
 * Unlike the per-file hold that used to sit on `files` (which nothing in the app
 * ever set, and so had no way to be lifted; migration 0221 dropped it), this
 * reads the matter's own hold, which the matter screen can toggle back off. The
 * protection is therefore reversible by the people responsible for it.
 *
 * Non-matter files (General Files, client and task folders, messaging) carry no
 * matter, so they are unaffected. Uploading to a held matter stays allowed:
 * a hold preserves what exists, it does not freeze the file going forward.
 */
export async function assertMatterNotUnderLegalHold(lawFirmId: string, row: any, verb: any) {
  const matterId = row?.matterId;
  if (!matterId) return;

  const matter = await mattersRepo.findByIdRaw(lawFirmId, matterId);
  if (matter?.legalHold) {
    throw new ForbiddenError(
      `This matter is under legal hold, so its documents cannot be ${verb}. `
      + 'Lift the hold on the matter first.'
    );
  }
}

// Binds this module's bucket to the shared prefix pager, so folder rename/move
// and the rest walk their source prefix through the same paging (and the same
// loud ceiling) the portal's document scans use. Options pass through, so a
// caller that must reach the end of a prefix can still say so.
export const forEachObjectPage = (prefix: any, onPage: any, options: any) => pageObjects(bucket, prefix, onPage, options);

/** Mint a signed read URL for one object path with the correct disposition. */
export async function signObject(objectPath: any, contentType: any, displayName: any, ttl = SIGNED_URL_TTL_LIST) {
  const [url] = await bucket.file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + ttl,
    responseDisposition: dispositionFor(contentType, displayName),
  });
  return url;
}

/**
 * Strip what a name may not carry, and keep everything else.
 *
 * The object path no longer contains the name, so this is not path safety any
 * more. A name is rendered in a listing, put in a download's
 * Content-Disposition header, and written as a zip entry, so what has to go is
 * the path separators and the control characters. Spaces, accents and
 * punctuation stay: the old sanitizer replaced everything outside
 * `[a-zA-Z0-9._-]`, which turned `Exhibit A.pdf` into `Exhibit_A.pdf` because
 * the name had to survive being part of a URL.
 *
 * `.` and `..` are prefixed rather than kept. Neither can escape anything now,
 * but both are read as navigation by a zip extractor and by whatever the reader
 * unpacks a download with.
 *
 * Length is NOT capped here. A name too long for the column is refused at insert
 * with a sentence the uploader can act on; silently truncating it would store a
 * document under a name nobody chose.
 */
export function safeDisplayName(originalName: any) {
  const cleaned = String(originalName || 'upload.bin')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
    .replace(/[/\\\u0000-\u001f\u007f]/g, '_')
    .trim();
  if (cleaned.length === 0) return 'upload.bin';
  return cleaned === '.' || cleaned === '..' ? `_${cleaned}` : cleaned;
}

/** Whether a `copy()` lost its `ifGenerationMatch: 0` race to an object that already exists. */
function isCopyPreconditionFailure(err: any) {
  const code = Number(err?.code) || Number(err?.response?.status);
  return code === 412 || code === 409;
}
