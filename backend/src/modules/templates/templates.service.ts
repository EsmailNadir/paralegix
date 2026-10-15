import { isNotNull } from 'drizzle-orm';
import { templates } from '../../shared/database/drizzle/schema';
import { systemQuery, withDrizzleTransaction } from '../../shared/database/queryContext';
const crypto = require('crypto');
const path = require('path');

const templatesRepo = require('./templates.repository');
const templateFoldersRepo = require('./folders/templateFolders.repository');
const placementsRepo = require('./templateFieldPlacements.repository');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { parseDocxPlaceholders, fillDocxTemplate } = require('./docx.service');
const { fillOverlayTemplate } = require('./overlayFill.service');
const { withTemplateFillSlot, withTemplateExportSlot, withPersonRenderCap } = require('./templateFillSlot');
import { renderHtmlToStoredPdf } from '../../shared/documentConversion/pdfRenderer';
import { EXPORT_HTML_MAX_BYTES } from '../../shared/documentConversion/htmlPdf';
import { isConversionBusy } from '../../shared/documentConversion/scratchSource';
const { admin } = require('../../shared/database/firebase');
const { sanitizeTemplateHtml } = require('../../shared/utils/htmlSanitizer');
const { forEachObjectPage, NO_CEILING } = require('../../shared/storage/listObjects');
const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
const { ts } = require('./templateTime');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');

const DOCX_STORAGE_PREFIX = 'lawfirmids';
const SIGNED_URL_TTL_MS = 1000 * 60 * 60 * 24 * 7;
/**
 * Asset preview URLs signed at once. A template built from a PDF import can
 * carry an embedded image per page, and v4 signing is a local cryptographic
 * operation, so the multiplier is assets-per-template against CPU and the event
 * loop rather than against any remote service.
 */
const ASSET_SIGN_CONCURRENCY = Number(process.env.ASSET_SIGN_CONCURRENCY) || 8;
const IMAGE_TAG_RE = /<img\b[^>]*data-template-object-image=(?:"true"|'true')[^>]*>/gi;

// Shared by both the docx and overlay fill paths' non-native output formats
// (each has one format that skips conversion entirely: docx for docx
// templates, pdf for overlay templates).
const FORMAT_CONTENT_TYPES: any = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
};

function docxStoragePath(lawFirmId: string, templateId: string) {
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/templates/${templateId}.docx`;
}

function htmlStoragePath(lawFirmId: string, templateId: string) {
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/templates/${templateId}.html`;
}

// Kept in step with the frontend's TEMPLATE_ACCEPTED_EXTENSIONS
// (templateEditorDom.ts) and the same list the signatures module accepts for
// document conversion (signatures.validation.ts / signing.routes.ts).
const OVERLAY_ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.odt', '.rtf', '.txt'];

function overlaySourceStoragePath(lawFirmId: string, templateId: string, ext: any) {
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/templates/${templateId}/overlay-source${ext}`;
}

function overlayPdfStoragePath(lawFirmId: string, templateId: string) {
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/templates/${templateId}/overlay.pdf`;
}

// Template HTML is stored as a GCS object rather than inline in the database
// row. PDF imports emit a <span> per character, so a multi-page template's
// HTML can easily reach tens of megabytes. Storing it in GCS keeps the relational
// table lean and avoids large payload bottlenecks on database queries.
async function saveTemplateHtmlToStorage(lawFirmId: string, templateId: string, html: any) {
  const objectPath = htmlStoragePath(lawFirmId, templateId);
  try {
    await saveTemplateObject(lawFirmId, objectPath, Buffer.from(html ?? '', 'utf8'), {
      resumable: false,
      metadata: { contentType: 'text/html; charset=utf-8' },
    });
  } catch (error: any) {
    console.error('[templates] Failed to save template HTML to storage:', error.message);
    throw new AppError(
      'Could not save the template content to storage. Please try again in a moment.',
      502,
      'TEMPLATE_HTML_STORAGE_FAILED',
    );
  }
  return objectPath;
}

async function loadTemplateHtmlFromStorage(objectPath: any) {
  const [buffer] = await getBucket().file(objectPath).download();
  return buffer.toString('utf8');
}

// A template's body lives in GCS, keyed by `htmlStoragePath`. The row carries
// the path, not the markup.
async function hydrateTemplateHtml(doc: any) {
  if (doc && doc.htmlStoragePath) {
    try {
      doc.html = await loadTemplateHtmlFromStorage(doc.htmlStoragePath);
    } catch (error: any) {
      console.error('[templates] Failed to load template HTML from storage:', error.message);
    }
  }
  return doc;
}

function templateAssetStoragePath(lawFirmId: string, templateId: string, assetId: any, mimeType: any, originalName: any) {
  const ext = guessExtensionFromMimeType(mimeType, originalName);
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/templates/${templateId}/assets/${assetId}.${ext}`;
}

/**
 * The folder every overlay placement image of ONE template lives in. Both the
 * upload (which builds the path) and every reader of a stored path (save,
 * fill, delete) go through this, so the two cannot drift apart.
 */
function overlayPlacementImagePrefix(lawFirmId: string, templateId: string) {
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/templates/${templateId}/placement-images/`;
}

function overlayPlacementImageStoragePath(lawFirmId: string, templateId: string, imageId: any, mimeType: any, originalName: any) {
  const ext = guessExtensionFromMimeType(mimeType, originalName);
  return `${overlayPlacementImagePrefix(lawFirmId, templateId)}${imageId}.${ext}`;
}

/**
 * Whether an image path the client sent (or an older row stored) names an
 * object this template uploaded. The path is caller-controlled, and the fill
 * reads it and a later save deletes it, so anything else is a read or delete of
 * another template's or another firm's object. Only one plain file name may
 * follow the prefix: no further folders, no `.`/`..` segments, no backslashes.
 */
function isOwnPlacementImagePath(lawFirmId: string, templateId: string, objectPath: unknown) {
  if (typeof objectPath !== 'string') return false;
  const prefix = overlayPlacementImagePrefix(lawFirmId, templateId);
  if (!objectPath.startsWith(prefix)) return false;
  const fileName = objectPath.slice(prefix.length);
  return fileName.length > 0
    && !fileName.includes('/')
    && !fileName.includes('\\')
    && fileName !== '.'
    && fileName !== '..';
}

// Resolve the bucket the same way every other storage module does
// (process.env.GCS_BUCKET || 'lawfirms'). Relying on the firebase-init default
// instead would target the wrong bucket whenever GCS_BUCKET is unset, since that
// default historically read 'lawfirm'. This caused template asset/HTML uploads to
// fail while the rest of the app (which passes this name explicitly) worked.
const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';

function getBucket() {
  return admin.storage().bucket(BUCKET_NAME);
}

// ── storage accounting ───────────────────────────────────────────────
//
// Template objects (HTML bodies, DOCX sources, inline images) live in the same
// bucket and under the same firm prefix as everything the files module tracks,
// so they have to be charged against the firm's storage usage. They previously
// were not, which under-reported a firm's real footprint by the whole weight of
// its template library and let a firm bank unlimited 50 MB DOCX uploads against
// a quota that never moved.
//
// Writes charge the DELTA against whatever already occupied the path, because
// every template edit rewrites the same object — charging the full size each
// time would inflate usage without bound. Unlike a file upload, a template save
// is not quota-REJECTED: an edit that fails midway would strand the template
// with its assets uploaded and its body unsaved, so a firm over its quota can
// still edit templates and sees the overage on the next upload instead.

async function objectSizeBytes(file: any) {
  try {
    const [metadata] = await file.getMetadata();
    return Number(metadata?.size || 0);
  } catch {
    return 0; // object doesn't exist yet (first write) or metadata is unreadable
  }
}

async function chargeStorageDelta(lawFirmId: string, deltaBytes: any) {
  if (!lawFirmId || !deltaBytes) return;
  try {
    await adjustStorageUsageByDelta(lawFirmId, deltaBytes);
  } catch (error: any) {
    // Accounting must never fail the template write it is describing; a drift is
    // reconciled by the admin storage recount.
    console.error('[templates] Storage usage accounting failed:', error.message);
  }
}

/** Save a template object and charge the firm for the size change. */
async function saveTemplateObject(lawFirmId: string, objectPath: any, body: any, saveOptions: any) {
  const file = getBucket().file(objectPath);
  const previousBytes = await objectSizeBytes(file);
  await file.save(body, saveOptions);
  await chargeStorageDelta(lawFirmId, Buffer.byteLength(body) - previousBytes);
}

/**
 * Copy a stored object into the template tree and charge the size change.
 *
 * Server side, so the bytes never enter this process. That is the difference
 * between an overlay upload holding its converted PDF and holding nothing, and
 * it is why this takes a reference rather than a buffer.
 *
 * The SOURCE generation is pinned. Between the conversion reporting a result and
 * this copy running, whatever wrote that object could write it again, and an
 * unpinned copy would take the new bytes under a decision made about the old
 * ones. The size is passed in for the same reason the pin exists: it describes
 * the version that was checked.
 */
async function copyTemplateObject(
  lawFirmId: string,
  sourceObjectPath: string,
  objectPath: string,
  { sizeBytes, contentType, sourceGeneration, metadata }:
    { sizeBytes: number; contentType: string; sourceGeneration?: string | null; metadata?: Record<string, string> },
) {
  const destination = getBucket().file(objectPath);
  const previousBytes = await objectSizeBytes(destination);
  await getBucket().file(sourceObjectPath).copy(destination, {
    ...(sourceGeneration ? { sourceGeneration } : {}),
    contentType,
    ...(metadata ? { metadata } : {}),
  });
  await chargeStorageDelta(lawFirmId, Number(sizeBytes || 0) - previousBytes);
}

// ── renders (what a fill or a preview produces) ──────────────────────
//
// Both endpoints used to answer with the whole document as the response body, so
// the transform's output was resident twice: once as the buffer that produced it
// and once as the body being written out. They write the produced document to
// storage instead and hand the browser a link, which is also what puts the
// transfer in the browser's own download manager rather than in an open request
// on a 512 MiB instance.

/** Top-level segment holding the documents a fill or a preview produced. */
const RENDER_SEGMENT = 'template-renders';

/**
 * How long a render URL is good for.
 *
 * Nothing revokes a signed URL that has already been handed out, so its lifetime
 * IS the whole of its revocation story and the shortest workable window is the
 * right one. Fifteen minutes is what a large document needs to start, transfer
 * and survive one pause in a download manager, and it matches the files module's
 * own download links. A page whose link ran out asks for another, through the
 * same permission check that produced the first.
 */
const TEMPLATE_RENDER_URL_TTL_MS = Number(process.env.TEMPLATE_RENDER_URL_TTL_MS)
  || 15 * 60 * 1000;

/**
 * How long a render OBJECT survives before the housekeeping sweep collects it.
 *
 * Comfortably longer than the URL, so a sweep can never cut a transfer that is
 * still running under a link that has not expired.
 */
const TEMPLATE_RENDER_TTL_MS = Number(process.env.TEMPLATE_RENDER_TTL_MS)
  || 24 * 60 * 60 * 1000;

/** Render deletions in flight at once within one page of a listing. */
const RENDER_SWEEP_CONCURRENCY = Number(process.env.GCS_PAGE_CONCURRENCY) || 24;

/** Every render belonging to one firm. */
function firmRenderPrefix(lawFirmId: string) {
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/${RENDER_SEGMENT}/`;
}

/** Every render belonging to one template. */
function templateRenderPrefix(lawFirmId: string, templateId: string) {
  return `${firmRenderPrefix(lawFirmId)}${templateId}/`;
}

/**
 * Where one person's latest render of one template lives.
 *
 * Keyed on the template, the person and the kind rather than given a fresh id
 * per request, so the set is BOUNDED: one object per person per template per
 * kind, replaced by their next render, removed when the template is deleted and
 * removed with the firm. A fresh id per request would leave one object behind
 * per download, forever, for a document nobody will open twice.
 *
 * The consequence worth stating is that rendering again invalidates the URL
 * issued for the previous render, because that URL names a generation which no
 * longer exists. That is the correct reading of a pinned URL rather than a
 * defect: its holder was authorized for those bytes, and those bytes are gone.
 */
function renderObjectPath(lawFirmId: string, templateId: string, userId: any, kind: string, ext: any) {
  const caller = String(userId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${templateRenderPrefix(lawFirmId, templateId)}${caller}/${kind}.${ext}`;
}

/**
 * A name safe to put in a Content-Disposition.
 *
 * Deliberately the same expression the response header used, because the user
 * has to see the document save under the name they saw before. It is also still
 * a security boundary: the storage provider builds a header from this value, and
 * a quote or a newline splits that header exactly as it split the old one.
 */
function safeDispositionName(value: any, fallback: string) {
  return String(value || '').replace(/[^a-zA-Z0-9 ._-]/g, '_').trim().slice(0, 120) || fallback;
}

/**
 * A read URL for one stored object, bound to the version that is there now.
 *
 * The generation goes on the HANDLE, which is what puts it in the signed query
 * string; reading it into the response alone would report a version the URL does
 * not actually hold anyone to. Without it, a document replaced between the
 * caller being authorized and the browser fetching is served under a decision
 * made about other bytes, and nothing reports it.
 *
 * The URL is a bearer credential: it is never logged, and the caller authorizes
 * BEFORE reaching here. Everything below assumes that has already happened.
 */
async function signStoredDocument(
  objectPath: string,
  { fileName, disposition, contentType }: { fileName: string; disposition: 'inline' | 'attachment'; contentType: string },
) {
  const [metadata] = await getBucket().file(objectPath).getMetadata();
  const generation = String(metadata?.generation ?? '');
  if (!generation) {
    throw new AppError(
      'Could not read this template from storage. Please try again in a moment.',
      502,
      'TEMPLATE_OBJECT_DOWNLOAD_FAILED',
    );
  }

  const expires = Date.now() + TEMPLATE_RENDER_URL_TTL_MS;
  const [url] = await getBucket().file(objectPath, { generation }).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires,
    responseDisposition: `${disposition}; filename="${fileName}"`,
  });

  return {
    url,
    fileName,
    contentType: metadata?.contentType || contentType,
    sizeBytes: Number(metadata?.size || 0),
    generation,
    urlExpiresAt: new Date(expires).toISOString(),
  };
}

/**
 * Sign a template's own stored object, mapping a storage failure the way the
 * download it replaces did: the row can outlive the object, and a firm asking to
 * look at a template should be told storage is unavailable rather than shown an
 * internal error.
 */
async function signTemplateObject(
  objectPath: string,
  options: { fileName: string; disposition: 'inline' | 'attachment'; contentType: string },
) {
  try {
    return await signStoredDocument(objectPath, options);
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    console.error('[templates] Failed to sign a template object:', error.message);
    throw new AppError(
      'Could not read this template from storage. Please try again in a moment.',
      502,
      'TEMPLATE_OBJECT_DOWNLOAD_FAILED',
    );
  }
}

/** Store what a transform produced, then hand back a link to it. */
async function publishRender({
  lawFirmId, templateId, userId, kind, ext, buffer, contentType, fileName, disposition,
}: any) {
  const objectPath = renderObjectPath(lawFirmId, templateId, userId, kind, ext);
  // Not through `saveTemplateObject`: a render sits under a system segment
  // (shared/storage/recordArchive), outside the firm's quota, by the same rule
  // that keeps an export zip out of it. The firm never asked for this copy and
  // has no route that would let them remove one.
  await getBucket().file(objectPath).save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: 'no-store, max-age=0',
      metadata: { templateId, renderKind: kind, renderedBy: String(userId || '') },
    },
  });
  return signStoredDocument(objectPath, { fileName, disposition, contentType });
}

/**
 * Where a filled document waits for the converter.
 *
 * A fresh name per fill, unlike `renderObjectPath`: one person may have two
 * fills of the same template in flight, and a shared name would let the second
 * overwrite the first's input before it was converted. Under the render prefix,
 * so a lost cleanup is collected by `sweepExpiredRenders` and by deleting the
 * template, like any other render.
 */
function stagedRenderPath(lawFirmId: string, templateId: string, userId: any, ext: string) {
  const caller = String(userId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${templateRenderPrefix(lawFirmId, templateId)}${caller}/staged-${crypto.randomUUID()}.${ext}`;
}

/**
 * Publish a render that is already in storage, such as a converter's output,
 * by a server-side copy, so its bytes never pass through this process.
 * Stamped as `publishRender` stamps a render it writes itself.
 */
async function publishStoredRender({
  lawFirmId, templateId, userId, kind, ext, sourcePath, sourceGeneration, contentType, fileName, disposition,
}: any) {
  const objectPath = renderObjectPath(lawFirmId, templateId, userId, kind, ext);
  // Pinned to the version the converter reported, through the handle, which is
  // where the storage client reads a copy's source generation from.
  const source = getBucket().file(sourcePath, sourceGeneration ? { generation: sourceGeneration } : undefined);
  await source.copy(getBucket().file(objectPath), {
    contentType,
    cacheControl: 'no-store, max-age=0',
    metadata: { templateId, renderKind: kind, renderedBy: String(userId || '') },
  });
  return signStoredDocument(objectPath, { fileName, disposition, contentType });
}

/**
 * Remove renders under a prefix, optionally only those a predicate picks.
 *
 * Best-effort, like every other storage sweep here: a render that will not
 * delete is storage the next pass collects, and failing the request that
 * triggered this would report housekeeping as a template failure.
 */
async function deleteRenders(prefix: string, shouldDelete: (file: any) => boolean = () => true) {
  let deleted = 0;
  try {
    await forEachObjectPage(getBucket(), prefix, async (files: any[]) => {
      const doomed = files.filter(shouldDelete);
      await runWithConcurrency(doomed.map((file: any) => () => file.delete().then(
        () => { deleted += 1; },
        (error: any) => console.error('[templates] Failed to delete render', file.name, error.message),
      )), RENDER_SWEEP_CONCURRENCY);
    }, { ceiling: NO_CEILING });
  } catch (error: any) {
    console.error('[templates] Render sweep failed for', prefix, error.message);
  }
  return deleted;
}

function escapeRegExp(value: any) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function guessExtensionFromMimeType(mimeType = '', originalName = '') {
  const normalizedMime = String(mimeType).toLowerCase();
  if (normalizedMime.includes('png')) return 'png';
  if (normalizedMime.includes('webp')) return 'webp';
  if (normalizedMime.includes('jpeg') || normalizedMime.includes('jpg')) return 'jpg';
  if (normalizedMime.includes('gif')) return 'gif';
  if (normalizedMime.includes('svg')) return 'svg';

  const originalExt = path.extname(originalName || '').replace(/^\./, '').trim();
  return originalExt || 'bin';
}

function decodeDataUrl(dataUrl: any) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) {
    throw new ValidationError('Invalid template image data URL.');
  }

  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = match[2] === ';base64';
  const payload = match[3] || '';

  let buffer;
  if (isBase64) {
    buffer = Buffer.from(payload, 'base64');
  } else {
    try {
      buffer = Buffer.from(decodeURIComponent(payload), 'utf8');
    } catch {
      // Malformed percent-encoding throws URIError; surface it as a 400, not a 500.
      throw new ValidationError('Invalid template image data URL.');
    }
  }

  return { mimeType, buffer };
}

function getTagAttribute(tag: any, attributeName: any) {
  const match = new RegExp(`${escapeRegExp(attributeName)}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? '') : null;
}

function setTagAttribute(tag: any, attributeName: any, value: any) {
  const attrPattern = new RegExp(`\\s${escapeRegExp(attributeName)}=(?:"[^"]*"|'[^']*')`, 'i');
  const serialized = ` ${attributeName}="${String(value).replace(/"/g, '&quot;')}"`;
  if (attrPattern.test(tag)) {
    return tag.replace(attrPattern, serialized);
  }
  return tag.replace(/\/?>$/, `${serialized}$&`);
}

function removeTagAttribute(tag: any, attributeName: any) {
  const attrPattern = new RegExp(`\\s${escapeRegExp(attributeName)}=(?:"[^"]*"|'[^']*')`, 'ig');
  return tag.replace(attrPattern, '');
}

function toNullableNumber(value: any) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

async function createSignedPreviewUrl(objectPath: any, fileName: any) {
  // The filename originates from a client-settable HTML attribute; strip anything
  // that could smuggle extra Content-Disposition directives into the header.
  const safeFileName = String(fileName || 'template-asset')
    .replace(/[^a-zA-Z0-9 ._-]/g, '_')
    .slice(0, 120) || 'template-asset';
  const [signedUrl] = await getBucket().file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
    responseDisposition: `inline; filename="${safeFileName}"`,
  });
  return signedUrl;
}

async function attachAssetPreviewUrls(assets: any[] = []) {
  const list = assets || [];
  const settled = await runWithConcurrency(list.map((asset) => async () => {
    try {
      return {
        ...asset,
        previewUrl: await createSignedPreviewUrl(asset.objectPath, asset.fileName),
      };
    } catch (error: any) {
      console.error('[templates] Failed to generate asset preview URL:', error.message);
      return {
        ...asset,
        previewUrl: null,
      };
    }
  }), ASSET_SIGN_CONCURRENCY);
  // Signing failures are already absorbed above into a null `previewUrl`, so a
  // rejected entry can only be an unexpected throw; fall back to the asset
  // without a preview rather than dropping it from the template. Input order is
  // preserved, which the rendered document relies on.
  return settled.map((result: any, i: any) => (
    result.status === 'fulfilled' ? result.value : { ...list[i], previewUrl: null }
  ));
}

async function uploadTemplateAsset({
  lawFirmId,
  templateId,
  assetId,
  dataUrl,
  fileName,
  width,
  height,
  source,
}: any) {
  const { mimeType, buffer } = decodeDataUrl(dataUrl);
  // SVG can carry active content (scripts); exclude it from template assets, which
  // are raster images, matching the files/signing dangerous-content hardening.
  if (String(mimeType).toLowerCase().includes('svg')) {
    throw new ValidationError('SVG images are not allowed as template assets.');
  }
  const objectPath = templateAssetStoragePath(lawFirmId, templateId, assetId, mimeType, fileName);

  try {
    await saveTemplateObject(lawFirmId, objectPath, buffer, {
      resumable: false,
      metadata: {
        contentType: mimeType,
        metadata: {
          lawFirmId,
          templateId,
          assetId,
          type: 'template-asset',
        },
      },
    });
  } catch (error: any) {
    console.error('[templates] Failed to upload template image:', error.message);
    throw new AppError(
      `Could not upload an image in this template${fileName ? ` ("${fileName}")` : ''}. Please try again.`,
      502,
      'TEMPLATE_ASSET_UPLOAD_FAILED',
    );
  }

  return {
    id: assetId,
    objectPath,
    mimeType,
    fileName: fileName || `template-asset.${guessExtensionFromMimeType(mimeType, fileName)}`,
    width: width ?? null,
    height: height ?? null,
    source: source || null,
  };
}

async function deleteTemplateAsset(lawFirmId: string, objectPath: any) {
  if (!objectPath) return;
  const file = getBucket().file(objectPath);
  try {
    // Size has to be read before the delete, or there is nothing left to credit.
    const freedBytes = await objectSizeBytes(file);
    await file.delete();
    await chargeStorageDelta(lawFirmId, -freedBytes);
  } catch (error: any) {
    console.error('[templates] Failed to delete template asset:', error.message);
  }
}

async function normalizeTemplateHtmlAssets({
  lawFirmId,
  templateId,
  html,
  existingAssets = [],
}: any) {
  if (!html) {
    return { html: html || '', assets: existingAssets || [], removedAssetPaths: [] };
  }

  // Strip scripts, event handlers, and dangerous URL schemes before the HTML is
  // persisted or scanned for image assets. This keeps the rich formatting and
  // data-* attributes the editor relies on (including data:image sources, which
  // the asset extraction below uploads to GCS) while removing the stored-XSS
  // payloads that would otherwise run when the template is previewed.
  html = sanitizeTemplateHtml(html);

  const existingAssetMap = new Map((existingAssets || []).map((asset: any) => [asset.id, asset]));
  const nextAssetsMap = new Map();
  const retainedAssetIds = new Set();
  const replacements = [];

  for (const match of html.matchAll(IMAGE_TAG_RE)) {
    const tag = match[0];
    const start = match.index ?? 0;
    const end = start + tag.length;

    const src = getTagAttribute(tag, 'src');
    const currentAssetId = getTagAttribute(tag, 'data-template-asset-id');
    const fileName = getTagAttribute(tag, 'data-template-file-name') || null;
    const width = toNullableNumber(getTagAttribute(tag, 'data-template-intrinsic-width'));
    const height = toNullableNumber(getTagAttribute(tag, 'data-template-intrinsic-height'));
    const source = getTagAttribute(tag, 'data-template-source') || null;

    let updatedTag = tag;

    if (src && /^data:image\//i.test(src)) {
      const assetId = currentAssetId || crypto.randomUUID();
      const uploadedAsset = await uploadTemplateAsset({
        lawFirmId,
        templateId,
        assetId,
        dataUrl: src,
        fileName,
        width,
        height,
        source,
      });
      nextAssetsMap.set(assetId, uploadedAsset);
      retainedAssetIds.add(assetId);
      updatedTag = setTagAttribute(updatedTag, 'data-template-asset-id', assetId);
      updatedTag = removeTagAttribute(updatedTag, 'src');
    } else if (currentAssetId && existingAssetMap.has(currentAssetId)) {
      retainedAssetIds.add(currentAssetId);
      nextAssetsMap.set(currentAssetId, existingAssetMap.get(currentAssetId));
      updatedTag = removeTagAttribute(updatedTag, 'src');
    }

    replacements.push({ start, end, value: updatedTag });
  }

  let normalizedHtml = html;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    normalizedHtml = `${normalizedHtml.slice(0, replacement.start)}${replacement.value}${normalizedHtml.slice(replacement.end)}`;
  }

  // De-referenced assets are reported to the caller for deletion AFTER the row
  // update commits. Deleting here would destroy objects the currently-stored
  // HTML still references if the save fails partway (e.g. a GCS blip on the
  // HTML upload), leaving the "unchanged" template with dead image links.
  const removedAssetPaths = (existingAssets || [])
    .filter((asset: any) => !retainedAssetIds.has(asset.id))
    .map((asset: any) => asset.objectPath);

  return {
    html: normalizedHtml,
    assets: Array.from(nextAssetsMap.values()),
    removedAssetPaths,
  };
}

async function deleteRemovedAssets(lawFirmId: string, removedAssetPaths: any[] = []) {
  for (const objectPath of removedAssetPaths) {
    await deleteTemplateAsset(lawFirmId, objectPath);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function formatTemplate(d: any) {
  return {
    id: d.id,
    name: d.name,
    type: d.type || 'html',
    fields: d.fields,
    repeaters: d.repeaters || [],
    folderId: d.folderId || null,
    createdAt: ts(d.createdAt),
  };
}

function formatTemplateWithContent(d: any) {
  const base: any = formatTemplate(d);
  if (d.html) base.html = d.html;
  if (base.type === 'docx') base.docxStoragePath = d.docxStoragePath || null;
  if (base.type === 'overlay') {
    base.overlaySourceObjectPath = d.overlaySourceObjectPath || null;
    base.overlayPdfObjectPath = d.overlayPdfObjectPath || null;
    // Signed, short-lived URL the overlay editor fetches the PDF from
    // (react-pdf needs an actual fetchable URL, not just the object path).
    // Only present when the caller already resolved one (getTemplate or direct
    // upload finalization); absent elsewhere, e.g. the list view.
    if (d.overlayPdfUrl) base.overlayPdfUrl = d.overlayPdfUrl;
  }
  if (Array.isArray(d.assets)) base.assets = d.assets;
  return base;
}

function formatHydratedTemplate(d: any, assets: any) {
  return {
    ...formatTemplateWithContent(d),
    assets,
  };
}

// ── list ─────────────────────────────────────────────────────────────

export async function listTemplates({ lawFirmId }: any) {
  const docs = await templatesRepo.listByLawFirm(lawFirmId);
  const templates = docs.map(formatTemplate);
  return { templates, totalTemplates: templates.length };
}

// ── get ──────────────────────────────────────────────────────────────

export async function getTemplate({ lawFirmId, templateId }: any) {
  const doc = await templatesRepo.findById(lawFirmId, templateId);
  if (!doc) throw new NotFoundError('Template');

  await hydrateTemplateHtml(doc);
  if ((doc.type || 'html') === 'overlay' && doc.overlayPdfObjectPath) {
    try {
      doc.overlayPdfUrl = await createSignedPreviewUrl(doc.overlayPdfObjectPath, `${doc.name || 'template'}.pdf`);
    } catch (error: any) {
      console.error('[templates] Failed to generate overlay PDF preview URL:', error.message);
    }
  }
  const assets = await attachAssetPreviewUrls(doc.assets || []);
  return { template: formatHydratedTemplate(doc, assets) };
}

// ── create (html) ────────────────────────────────────────────────────

/**
 * Delete a draft template row after a create failed partway through.
 *
 * All three create paths have to insert the row BEFORE they write the body,
 * because every stored object is keyed on the template's own id. That makes
 * each step after the insert a chance to fail with a row already committed: a
 * rejected SVG, a 502 from a storage write, a failed PDF conversion. Without
 * this, the caller receives the error while the firm's template list gains a
 * named, empty, unopenable entry that nothing cleans up and that they cannot
 * tell from a real template until they open it.
 *
 * Failures here are swallowed on purpose. The caller must receive the ORIGINAL
 * error, which is the one that tells them what to fix; a rollback that failed
 * in turn would replace a useful 400 with an unrelated 500.
 *
 * Storage objects written before the failure are not removed. The GC sweep
 * further down this file already reconciles objects that no live row
 * references, which is the mechanism this leans on.
 */
async function discardDraftTemplate(lawFirmId: string, templateId: string) {
  await templatesRepo.delete(lawFirmId, templateId).catch(() => undefined);
}

export async function createTemplate({ lawFirmId, name, html, fields, repeaters, folderId }: any) {
  if (folderId) {
    const folder = await templateFoldersRepo.findById(lawFirmId, folderId);
    if (!folder) throw new NotFoundError('Folder');
  }

  const draftData: any = { name, type: 'html', html: '', fields, folderId: folderId || null, assets: [] };
  if (repeaters && repeaters.length > 0) draftData.repeaters = repeaters;

  const created = await templatesRepo.create(lawFirmId, draftData);
  try {
    const normalized = await normalizeTemplateHtmlAssets({
      lawFirmId,
      templateId: created.id,
      html,
      existingAssets: [],
    });

    const htmlStoragePath = await saveTemplateHtmlToStorage(lawFirmId, created.id, normalized.html);
    const updated = await templatesRepo.update(lawFirmId, created.id, {
      html: '',
      htmlStoragePath,
      assets: normalized.assets,
    });
    const hydratedAssets = await attachAssetPreviewUrls(normalized.assets);
    const template = formatHydratedTemplate({ ...created, ...updated, html: normalized.html }, hydratedAssets);

    return { message: 'Template created successfully', templateId: created.id, template };
  } catch (err) {
    await discardDraftTemplate(lawFirmId, created.id);
    throw err;
  }
}

// ── create (docx) ────────────────────────────────────────────────────

export async function createDocxTemplate({ lawFirmId, name, docxBuffer, html, folderId }: any) {
  if (folderId) {
    const folder = await templateFoldersRepo.findById(lawFirmId, folderId);
    if (!folder) throw new NotFoundError('Folder');
  }

  const { fields, repeaters } = parseDocxPlaceholders(docxBuffer);

  const data: any = {
    name,
    type: 'docx',
    fields: buildFlatFieldList(fields, repeaters),
    folderId: folderId || null,
    assets: [],
  };
  if (repeaters.length > 0) data.repeaters = repeaters;

  const created = await templatesRepo.create(lawFirmId, data);
  try {
    const storagePath = docxStoragePath(lawFirmId, created.id);
    await saveTemplateObject(lawFirmId, storagePath, docxBuffer, {
      resumable: false,
      metadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    });

    const updateData: any = { docxStoragePath: storagePath };
    let storedHtml;
    if (html !== undefined) {
      const normalized = await normalizeTemplateHtmlAssets({
        lawFirmId,
        templateId: created.id,
        html,
        existingAssets: [],
      });
      updateData.htmlStoragePath = await saveTemplateHtmlToStorage(lawFirmId, created.id, normalized.html);
      updateData.assets = normalized.assets;
      storedHtml = normalized.html;
    }

    const updated = await templatesRepo.update(lawFirmId, created.id, updateData);
    const merged = { ...created, ...updated };
    if (storedHtml !== undefined) merged.html = storedHtml;
    const hydratedAssets = await attachAssetPreviewUrls(merged.assets || []);
    return {
      message: 'DOCX template created successfully',
      templateId: created.id,
      template: formatHydratedTemplate(merged, hydratedAssets),
    };
  } catch (err) {
    await discardDraftTemplate(lawFirmId, created.id);
    throw err;
  }
}

// ── create (overlay) ─────────────────────────────────────────────────
//
// Document Overlay templates upload any of the same 6 formats the other
// creation flows accept, converted once to PDF (the canvas the overlay
// editor renders and the fill path stamps onto). No placeholder parsing
// happens here; fields/repeaters start empty and are populated by
// savePlacements() once the user places boxes in the editor.

function overlayExtension(originalFileName: any) {
  const ext = path.extname(String(originalFileName || '')).toLowerCase();
  return OVERLAY_ACCEPTED_EXTENSIONS.includes(ext) ? ext : null;
}

/**
 * Creates an overlay template from an object that has already landed in storage.
 *
 * The browser uploads to a temporary, caller-stamped path. This copies that
 * exact generation into the template's permanent prefix without materializing
 * the source in the API process.
 */
export async function createOverlayTemplateFromStored({
  lawFirmId,
  name,
  sourceObjectPath,
  sourceSize,
  sourceGeneration,
  originalFileName,
  originalMimeType,
  folderId,
}: any) {
  const ext = overlayExtension(originalFileName);
  if (!ext) {
    throw new ValidationError(`Unsupported file. Accepted formats: ${OVERLAY_ACCEPTED_EXTENSIONS.join(', ')}`);
  }

  if (folderId) {
    const folder = await templateFoldersRepo.findById(lawFirmId, folderId);
    if (!folder) throw new NotFoundError('Folder');
  }

  const created = await templatesRepo.create(lawFirmId, {
    name,
    type: 'overlay',
    fields: [],
    repeaters: [],
    folderId: folderId || null,
    assets: [],
  });

  try {
    const isPdf = ext === '.pdf';
    const sourcePath = overlaySourceStoragePath(lawFirmId, created.id, ext);
    await copyTemplateObject(lawFirmId, sourceObjectPath, sourcePath, {
      sizeBytes: sourceSize,
      contentType: isPdf ? 'application/pdf' : (originalMimeType || 'application/octet-stream'),
      sourceGeneration,
    });

    let pdfPath = sourcePath;
    if (!isPdf) {
      const { convertStoredDocument } = require('../signatures/signatures.service');
      let converted;
      try {
        converted = await convertStoredDocument({
          sourceObjectPath: sourcePath,
          outputFormat: 'pdf',
          inputFilename: originalFileName || `source${ext}`,
          sourceBytes: sourceSize,
        });
      } catch (error: any) {
        // A busy converter never started on this document, so it is a 503 the
        // client may retry, not a document that will not convert.
        if (isConversionBusy(error)) throw error;
        console.error('[templates] Overlay upload conversion to PDF failed:', error.message);
        throw new AppError(
          'Could not convert this document to PDF for the overlay editor. Please try again, or upload a PDF directly.',
          502,
          'TEMPLATE_OVERLAY_CONVERSION_FAILED',
        );
      }

      pdfPath = overlayPdfStoragePath(lawFirmId, created.id);
      try {
        await copyTemplateObject(lawFirmId, converted.objectPath, pdfPath, {
          sizeBytes: converted.size,
          contentType: 'application/pdf',
          sourceGeneration: converted.generation,
        });
      } finally {
        await converted.cleanup().catch(() => {});
      }
    }

    const updated = await templatesRepo.update(lawFirmId, created.id, {
      overlaySourceObjectPath: sourcePath,
      overlayPdfObjectPath: pdfPath,
    });
    const merged = { ...created, ...updated };

    let overlayPdfUrl = null;
    try {
      overlayPdfUrl = await createSignedPreviewUrl(pdfPath, `${name || 'template'}.pdf`);
    } catch (error: any) {
      console.error('[templates] Failed to generate overlay PDF preview URL:', error.message);
    }

    return {
      message: 'Overlay template created successfully',
      templateId: created.id,
      template: formatTemplateWithContent({ ...merged, overlayPdfUrl }),
    };
  } catch (err) {
    await discardDraftTemplate(lawFirmId, created.id);
    throw err;
  }
}

// ── field placements (Document Overlay templates) ──────────────────────

/**
 * Upload one image for an 'image'-type overlay placement. Stored under the
 * template's own storage prefix (so listReferencedObjectPaths/gcSweep see it)
 * but outside templates.assets, since overlay images stamp straight from
 * their own objectPath rather than being embedded in an html body. Uploading
 * doesn't attach the image to any placement row by itself: the editor still
 * has to include the returned imageObjectPath in its next savePlacements
 * call, same two-step flow uploadTemplateAsset's html-editor callers use.
 */
/**
 * Finalize a placement image that already landed in a caller-stamped temporary
 * storage path. The permanent copy stays inside storage, so the API only
 * handles the small JSON admission request rather than the image bytes.
 */
export async function uploadPlacementImageFromStored({
  lawFirmId, templateId, sourceObjectPath, sourceSize, sourceGeneration, mimeType, fileName,
}: any) {
  const doc = await templatesRepo.findById(lawFirmId, templateId);
  if (!doc) throw new NotFoundError('Template');
  if ((doc.type || 'html') !== 'overlay') {
    throw new ValidationError('Only Document Overlay templates support image placements');
  }

  const normalizedMime = String(mimeType || '').toLowerCase();
  if (!normalizedMime.includes('png') && !normalizedMime.includes('jpeg') && !normalizedMime.includes('jpg')) {
    throw new ValidationError('Only PNG or JPEG images are allowed.');
  }

  const imageId = crypto.randomUUID();
  const objectPath = overlayPlacementImageStoragePath(lawFirmId, templateId, imageId, mimeType, fileName);
  try {
    await copyTemplateObject(lawFirmId, sourceObjectPath, objectPath, {
      sizeBytes: sourceSize,
      contentType: mimeType,
      sourceGeneration,
      metadata: { lawFirmId, templateId, imageId, type: 'template-overlay-placement-image' },
    });
  } catch (error: any) {
    console.error('[templates] Failed to copy overlay placement image:', error.message);
    throw new AppError(
      `Could not upload the image${fileName ? ` ("${fileName}")` : ''}. Please try again.`,
      502,
      'TEMPLATE_PLACEMENT_IMAGE_UPLOAD_FAILED',
    );
  }

  let imagePreviewUrl = null;
  try {
    imagePreviewUrl = await createSignedPreviewUrl(objectPath, fileName);
  } catch (error: any) {
    console.error('[templates] Failed to generate placement image preview URL:', error.message);
  }

  return {
    message: 'Image uploaded successfully',
    imageObjectPath: objectPath,
    imageMimeType: mimeType,
    imagePreviewUrl,
  };
}

function formatPlacement(p: any) {
  return {
    id: p.id,
    fieldName: p.fieldName,
    fieldType: p.fieldType || 'text',
    page: p.page,
    xPercent: p.xPercent,
    yPercent: p.yPercent,
    widthPercent: p.widthPercent,
    heightPercent: p.heightPercent,
    repeaterName: p.repeaterName ?? null,
    repeaterRowIndex: p.repeaterRowIndex ?? null,
    sortOrder: p.sortOrder ?? 0,
    textContent: p.fieldType === 'textbox' ? null : p.textContent ?? null,
    imageObjectPath: p.imageObjectPath ?? null,
    imageMimeType: p.imageMimeType ?? null,
    fontSize: p.fontSize ?? null,
    fontFamily: p.fontFamily || 'times',
    bold: Boolean(p.bold),
    italic: Boolean(p.italic),
    color: p.color || '#000000',
    textAlign: p.textAlign || 'left',
    bulletList: p.fieldType === 'textbox' ? false : Boolean(p.bulletList),
    richText: p.richText ?? null,
  };
}

// Signs a preview URL onto every 'image'-type placement so the overlay
// editor can render the uploaded image after a reload, mirroring
// attachAssetPreviewUrls' per-request signing for the html editor's assets.
async function attachPlacementImagePreviewUrls(placements: any[]) {
  const settled = await runWithConcurrency(placements.map((placement) => async () => {
    if (placement.fieldType !== 'image' || !placement.imageObjectPath) return placement;
    try {
      return { ...placement, imagePreviewUrl: await createSignedPreviewUrl(placement.imageObjectPath, placement.fieldName) };
    } catch (error: any) {
      console.error('[templates] Failed to generate placement image preview URL:', error.message);
      return { ...placement, imagePreviewUrl: null };
    }
  }), ASSET_SIGN_CONCURRENCY);
  return settled.map((result: any, i: any) => (
    result.status === 'fulfilled' ? result.value : placements[i]
  ));
}

function uniqueOrdered(list: any[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export async function listPlacements({ lawFirmId, templateId }: any) {
  const doc = await templatesRepo.findById(lawFirmId, templateId);
  if (!doc) throw new NotFoundError('Template');

  const placements = await placementsRepo.listByTemplate(lawFirmId, templateId);
  return { placements: await attachPlacementImagePreviewUrls(placements.map(formatPlacement)) };
}

/**
 * Replace a template's full placement set in one transaction and keep
 * templates.fields/templates.repeaters in sync from the same payload:
 *  - templates.fields: every non-repeater, value-bound placement's
 *    field_name (flat list, same meaning as html/docx templates today).
 *    'textbox'/'image' placements are excluded: their content is literal
 *    (richText / imageObjectPath), so there is no value for a
 *    filler to supply and they must never appear as a fillable merge field.
 *  - templates.repeaters: one entry per distinct repeaterName, `fields`
 *    derived from the placements referencing it (never trusted from the
 *    client, so it can't drift from the placements table) plus the
 *    overlay-only anchorPage/anchorYPercent/rowHeightPercent/rowCount the
 *    client supplies. Box geometry itself lives only in
 *    template_field_placements, never duplicated into the jsonb. A
 *    repeater's 'textbox' columns are excluded from `fields` the same way
 *    they're excluded from templates.fields above (they're author-fixed
 *    content, not per-row data a filler supplies), but unlike a standalone
 *    textbox, a repeater's IS allowed to exist: it may reference a sibling
 *    column's value inline via a rich-text field chip.
 */
export async function savePlacements({ lawFirmId, templateId, placements, repeaters }: any) {
  const doc = await templatesRepo.findById(lawFirmId, templateId);
  if (!doc) throw new NotFoundError('Template');
  if ((doc.type || 'html') !== 'overlay') {
    throw new ValidationError('Only Document Overlay templates support field placements');
  }

  const placementList = Array.isArray(placements) ? placements : [];
  const repeaterMetaList = Array.isArray(repeaters) ? repeaters : [];
  const repeaterMetaNames = new Set(repeaterMetaList.map((r: any) => r.name));
  const rowHeightByRepeater = new Map<string, number>(
    repeaterMetaList.map((r: any) => [r.name, Number(r.rowHeightPercent)]),
  );

  const flatFields: string[] = [];
  const fieldsByRepeater = new Map<string, string[]>();
  const columnCountByRepeater = new Map<string, number>();
  // A text box is not a value itself, but a field chip inside one is: the
  // filler has to be asked for it or the chip stamps as nothing. A chip in a
  // repeater column that names a sibling column resolves from the row, so
  // it stays a repeater field; any other chip can only resolve from the
  // document-level values and is listed there, after the placed fields.
  const chipFields: { fieldName: string; repeaterName: string | null }[] = [];

  for (const placement of placementList) {
    const isImage = placement.fieldType === 'image';
    const isTextbox = placement.fieldType === 'textbox';
    if (placement.imageObjectPath && !isOwnPlacementImagePath(lawFirmId, templateId, placement.imageObjectPath)) {
      throw new ValidationError(
        `Image placement "${placement.fieldName}" must use an image uploaded to this template. Upload the image again.`,
      );
    }
    if (placement.repeaterName) {
      if (isImage) {
        throw new ValidationError('Image placements cannot be part of a repeater column');
      }
      if (!repeaterMetaNames.has(placement.repeaterName)) {
        throw new ValidationError(`Placement references unknown repeater "${placement.repeaterName}"`);
      }
      // Row height is the gap between rows, so a taller column prints over the
      // row below it on every filled copy. The editor clamps this live; the
      // save has to hold the same line for any other caller.
      const rowHeight = rowHeightByRepeater.get(placement.repeaterName);
      if (rowHeight != null && Number(placement.heightPercent) > rowHeight + 1e-9) {
        throw new ValidationError(
          `Column "${placement.fieldName}" is taller than the row height of repeater "${placement.repeaterName}"`,
        );
      }
      columnCountByRepeater.set(placement.repeaterName, (columnCountByRepeater.get(placement.repeaterName) || 0) + 1);
      if (!isTextbox) {
        const list = fieldsByRepeater.get(placement.repeaterName) || [];
        list.push(placement.fieldName);
        fieldsByRepeater.set(placement.repeaterName, list);
      }
    } else if (!isImage && !isTextbox) {
      flatFields.push(placement.fieldName);
    }
    if (isTextbox) {
      for (const block of placement.richText || []) {
        for (const run of block.runs || []) {
          if (run.fieldName) chipFields.push({ fieldName: run.fieldName, repeaterName: placement.repeaterName || null });
        }
      }
    }
  }

  for (const chip of chipFields) {
    const siblings = chip.repeaterName ? fieldsByRepeater.get(chip.repeaterName) || [] : [];
    if (!siblings.includes(chip.fieldName)) flatFields.push(chip.fieldName);
  }

  const repeaterEntries = repeaterMetaList.map((meta: any) => {
    const fields = uniqueOrdered(fieldsByRepeater.get(meta.name) || []);
    if (!columnCountByRepeater.get(meta.name)) {
      throw new ValidationError(`Repeater "${meta.name}" has no field placements`);
    }
    return {
      name: meta.name,
      fields,
      anchorPage: meta.anchorPage,
      anchorYPercent: meta.anchorYPercent,
      rowHeightPercent: meta.rowHeightPercent,
      rowCount: meta.rowCount,
    };
  });

  const fields = uniqueOrdered(flatFields);

  const nextImagePaths = new Set(
    placementList.filter((p: any) => p.fieldType === 'image' && p.imageObjectPath).map((p: any) => p.imageObjectPath),
  );

  const { savedPlacements, removedImagePaths } = await withDrizzleTransaction(async (transaction: any) => {
    // The save is delete-then-insert. Without a shared lock, two overlapping
    // saves each delete before the other commits and BOTH inserts survive, so
    // the template stamps two layouts on top of each other. Locking the template
    // row first makes the second save wait, and its delete then sees (and
    // removes) the first save's rows.
    // No row means the template was deleted after the existence check above;
    // inserting placements for it would fail the foreign key as a 500.
    const locked = await templatesRepo.lockForUpdate(lawFirmId, templateId, transaction);
    if (!locked) throw new NotFoundError('Template');

    // Read under the lock, so the images found here are the ones this replace
    // actually removes. An image dropped from this save (deleted, or its type
    // changed away from 'image') has to be cleaned up or it orphans in GCS with
    // nothing left pointing at it.
    const previousPlacements = await placementsRepo.listByTemplate(lawFirmId, templateId, transaction);
    const removed = previousPlacements
      .filter((p: any) => p.fieldType === 'image' && p.imageObjectPath && !nextImagePaths.has(p.imageObjectPath))
      .map((p: any) => p.imageObjectPath);

    const saved = await placementsRepo.replaceForTemplate(lawFirmId, templateId, placementList, transaction);
    await templatesRepo.update(lawFirmId, templateId, { fields, repeaters: repeaterEntries }, transaction);
    return { savedPlacements: saved, removedImagePaths: removed };
  });

  // Deleted only after the transaction commits, matching deleteRemovedAssets'
  // own reasoning: deleting first would destroy objects a failed save's
  // still-live rows point at. A stored path outside this template's own image
  // folder (a row written before the save-time check above) is never deleted:
  // it may be another template's or another firm's object.
  const ownRemovedImagePaths = removedImagePaths.filter((objectPath: string) => {
    if (isOwnPlacementImagePath(lawFirmId, templateId, objectPath)) return true;
    console.warn('[templates] Not deleting a placement image outside the template image folder:', { lawFirmId, templateId, objectPath });
    return false;
  });
  await deleteRemovedAssets(lawFirmId, ownRemovedImagePaths);

  return {
    message: 'Template layout updated successfully',
    placements: await attachPlacementImagePreviewUrls(savedPlacements.map(formatPlacement)),
    repeaters: repeaterEntries,
    fields,
  };
}

// ── update (html + editable docx html) ───────────────────────────────

export async function updateTemplate({ lawFirmId, templateId, name, html, fields, repeaters, folderId }: any) {
  const existing = await templatesRepo.findById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Template');

  if (folderId) {
    const folder = await templateFoldersRepo.findById(lawFirmId, folderId);
    if (!folder) throw new NotFoundError('Folder');
  }

  const updateData: Record<string, any> = {};
  if (name !== undefined) updateData.name = name;
  if (fields !== undefined) updateData.fields = fields;
  if (repeaters !== undefined) updateData.repeaters = repeaters;
  if (folderId !== undefined) updateData.folderId = folderId || null;

  let storedHtml;
  let removedAssetPaths = [];
  if (html !== undefined) {
    const normalized = await normalizeTemplateHtmlAssets({
      lawFirmId,
      templateId,
      html,
      existingAssets: existing.assets || [],
    });
    updateData.htmlStoragePath = await saveTemplateHtmlToStorage(lawFirmId, templateId, normalized.html);
    updateData.assets = normalized.assets;
    storedHtml = normalized.html;
    removedAssetPaths = normalized.removedAssetPaths;
  }

  const updated = await templatesRepo.update(lawFirmId, templateId, updateData);
  await deleteRemovedAssets(lawFirmId, removedAssetPaths);
  const merged = { ...existing, ...updated };
  if (storedHtml !== undefined) merged.html = storedHtml;
  else await hydrateTemplateHtml(merged);
  const hydratedAssets = await attachAssetPreviewUrls(merged.assets || []);

  return {
    message: 'Template updated successfully',
    template: formatHydratedTemplate(merged, hydratedAssets),
  };
}

// ── update (docx re-upload) ────────────────────────────────────────────

export async function updateDocxTemplate({ lawFirmId, templateId, name, docxBuffer, html, folderId }: any) {
  const existing = await templatesRepo.findById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Template');
  if ((existing.type || 'html') !== 'docx') throw new ValidationError('Template is not a DOCX template');

  if (folderId) {
    const folder = await templateFoldersRepo.findById(lawFirmId, folderId);
    if (!folder) throw new NotFoundError('Folder');
  }

  const updateData: Record<string, any> = {};
  if (name !== undefined) updateData.name = name;
  if (folderId !== undefined) updateData.folderId = folderId || null;

  if (docxBuffer) {
    const { fields, repeaters } = parseDocxPlaceholders(docxBuffer);
    updateData.fields = buildFlatFieldList(fields, repeaters);
    updateData.repeaters = repeaters.length > 0 ? repeaters : [];

    const storagePath = docxStoragePath(lawFirmId, templateId);
    await saveTemplateObject(lawFirmId, storagePath, docxBuffer, {
      resumable: false,
      metadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    });
    updateData.docxStoragePath = storagePath;
  }

  let storedHtml;
  let removedAssetPaths = [];
  if (html !== undefined) {
    const normalized = await normalizeTemplateHtmlAssets({
      lawFirmId,
      templateId,
      html,
      existingAssets: existing.assets || [],
    });
    updateData.htmlStoragePath = await saveTemplateHtmlToStorage(lawFirmId, templateId, normalized.html);
    updateData.assets = normalized.assets;
    storedHtml = normalized.html;
    removedAssetPaths = normalized.removedAssetPaths;
  }

  const updated = await templatesRepo.update(lawFirmId, templateId, updateData);
  await deleteRemovedAssets(lawFirmId, removedAssetPaths);
  const merged = { ...existing, ...updated };
  if (storedHtml !== undefined) merged.html = storedHtml;
  else await hydrateTemplateHtml(merged);
  const hydratedAssets = await attachAssetPreviewUrls(merged.assets || []);

  return {
    message: 'DOCX template updated successfully',
    template: formatHydratedTemplate(merged, hydratedAssets),
  };
}

// ── fill (docx / overlay) ───────────────────────────────────────────────

/**
 * Produce the filled document's bytes.
 *
 * Kept separate from `fillTemplate` because this half genuinely cannot be
 * removed: docxtemplater rewrites a DOCX and pdf-lib stamps a PDF, and both need
 * the whole file. What `fillTemplate` adds is where the RESULT goes, which is
 * storage rather than a response body.
 */
async function renderFilledTemplate({ lawFirmId, templateId, values, repeaterValues, format }: any) {
  const doc = await templatesRepo.findById(lawFirmId, templateId);
  if (!doc) throw new NotFoundError('Template');
  const type = doc.type || 'html';
  if (type !== 'docx' && type !== 'overlay') {
    throw new ValidationError('Only DOCX and Document Overlay templates can be filled server-side');
  }

  if (type === 'docx') {
    const storagePath = doc.docxStoragePath;
    if (!storagePath) throw new ValidationError('Template DOCX file not found');

    const docxBuffer = await readBounded(storagePath, TEMPLATE_MAX_BYTES, 'template document');
    const filledDocx = fillDocxTemplate(docxBuffer, values, repeaterValues);

    if (format === 'docx') {
      return {
        buffer: filledDocx,
        contentType: FORMAT_CONTENT_TYPES.docx,
        ext: 'docx',
      };
    }

    // Converted by `fillTemplate`, outside the fill slot. See there.
    return {
      buffer: filledDocx,
      contentType: FORMAT_CONTENT_TYPES[format] || 'application/pdf',
      ext: format || 'pdf',
      convert: { outputFormat: format || 'pdf', inputFilename: 'template.docx', sourceExt: 'docx' },
    };
  }

  // type === 'overlay': stamp values onto the source PDF with pdf-lib instead
  // of docxtemplater's text-reflow. Takes the exact same values/repeaterValues
  // input as the docx branch above (already-resolved field values the caller
  // sends), plus the template's saved placements/repeaters for "where do they go".
  const pdfPath = doc.overlayPdfObjectPath;
  if (!pdfPath) throw new ValidationError('Template overlay PDF not found');

  const pdfBuffer = await readBounded(pdfPath, TEMPLATE_MAX_BYTES, 'template document');
  const placements = await placementsRepo.listByTemplate(lawFirmId, templateId);

  // 'image'-type placements stamp from their own uploaded bytes rather than a
  // resolved value, so those bytes have to be fetched here (overlayFill
  // itself has no GCS access) before the stamp runs. Only one file per
  // distinct objectPath even if reused across multiple placements.
  //
  // A stored path outside this template's own image folder is skipped, never
  // read: the save refuses one now, but a row written before that check could
  // still name another firm's object, and the fill would hand its bytes back
  // stamped into the document. The placement then renders empty.
  const imageObjectPaths: string[] = [...new Set(
    placements.filter((p: any) => p.fieldType === 'image' && p.imageObjectPath).map((p: any) => p.imageObjectPath),
  )].filter((objectPath: any) => {
    if (isOwnPlacementImagePath(lawFirmId, templateId, objectPath)) return true;
    console.warn('[templates] Skipping a placement image outside the template image folder:', { lawFirmId, templateId, objectPath });
    return false;
  }) as string[];
  // ONE AT A TIME, with a running total. Fetching them in parallel makes the
  // peak the number of placements times the per-image cap, which is the shape
  // that turns a template with twenty images into a container restart.
  const imageBuffers: Record<string, any> = {};
  let imageBytes = 0;
  for (const objectPath of imageObjectPaths) {
    try {
      // The total is checked against the object's METADATA, before the read.
      // Checking after would mean the image that breaks the budget is the one
      // already in memory, which is the case the budget exists to prevent.
      // eslint-disable-next-line no-await-in-loop -- the point is not to overlap
      const size = await storedSize(objectPath);
      if (imageBytes + size > TEMPLATE_IMAGE_TOTAL_MAX_BYTES) {
        throw new AppError(
          `The images on this template exceed the ${Math.round(TEMPLATE_IMAGE_TOTAL_MAX_BYTES / (1024 * 1024))} MB total limit.`,
          413,
          'TEMPLATE_IMAGES_TOO_LARGE',
        );
      }
      // eslint-disable-next-line no-await-in-loop -- the point is not to overlap
      const buffer = await readBounded(objectPath, TEMPLATE_IMAGE_MAX_BYTES, 'placement image');
      imageBytes += buffer.length;
      imageBuffers[objectPath] = buffer;
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      console.error('[templates] Failed to download overlay placement image:', error.message);
    }
  }

  // Fields whose text did not fully print: characters no bundled font has
  // come out as "?", and the person is told which fields to check.
  const incompleteFields: Array<{ fieldName: string; characters: string[] }> = [];
  const flattenedPdf = await fillOverlayTemplate({
    pdfBuffer,
    placements,
    repeaters: doc.repeaters || [],
    values,
    repeaterValues,
    imageBuffers,
    onIncompleteField: (fieldName: string, characters: string[]) => incompleteFields.push({ fieldName, characters }),
  });

  if (format === 'pdf' || !format) {
    return { buffer: flattenedPdf, contentType: FORMAT_CONTENT_TYPES.pdf, ext: 'pdf', incompleteFields };
  }

  return {
    buffer: flattenedPdf,
    contentType: FORMAT_CONTENT_TYPES[format] || 'application/pdf',
    ext: format,
    incompleteFields,
    convert: { outputFormat: format, inputFilename: 'template.pdf', sourceExt: 'pdf' },
  };
}

/**
 * Fill a template and hand back a link to the result.
 *
 * The response used to BE the document. Every fill therefore held the filled
 * bytes twice, once as the buffer the transform produced and once as the body
 * being written out, on the instance that is also converting and sealing other
 * people's documents. The transform still happens here, because it has to; what
 * leaves is the second copy and the open request the transfer used to occupy.
 *
 * The URL is minted only after `renderFilledTemplate` has resolved the template
 * under THIS caller's firm. Signing first and checking afterwards answers the
 * same status codes and hands a stranger a read credential.
 */
export async function fillTemplate({
  lawFirmId, templateId, values, repeaterValues, format, userId, fileName, disposition,
}: any) {
  // Anything but the two known values is treated as a download. The schema
  // already rejects the rest; this is what keeps the guarantee if a second
  // caller ever reaches this function without passing through it.
  const chosen = disposition === 'inline' ? 'inline' : 'attachment';

  // The slot covers the read, the transform AND the write to storage, because
  // the filled buffer is held in memory until storage has it. The person's cap
  // is checked first and spans every phase, so a render past it is refused
  // rather than queued.
  //
  // Whether it also covers a conversion depends on where conversion runs.
  //
  // On the worker (`DOCUMENT_CONVERTER=worker`) it does NOT: a fill that needs
  // one parks the filled document in storage, leaves the slot, and waits for
  // the converter's own limiter holding no bytes. Held across the conversion,
  // two fills waiting on one converter took both slots, and a fill needing no
  // conversion queued behind them until it was refused.
  //
  // In this process (local mode) it DOES, and the filled buffer goes straight
  // to the converter. `convertLocally` takes a Buffer, so a staged copy would be
  // downloaded right back: a storage round trip that frees no memory. And a
  // fill waiting on the converter holds its document either way, so releasing
  // the slot would leave the number of filled documents queued for the
  // converter bounded only by the per-person cap, outside the
  // TEMPLATE_FILL_CONCURRENCY budget in `templateFillSlot.ts`. Held, the peak
  // stays that many documents, conversion included. The cost is that a fill
  // needing no conversion can wait behind fills that do.
  const rendered = await withPersonRenderCap(userId, async () => {
    const stage: any = await withTemplateFillSlot(async () => {
      const {
        buffer, contentType, ext, incompleteFields, convert,
      } = await renderFilledTemplate({
        lawFirmId, templateId, values, repeaterValues, format,
      });
      const target = {
        ext,
        contentType,
        // `attachment` by default, as the header said: somebody pressed Download.
        // Preview asks for `inline`, because a tab that downloads is not a preview.
        fileName: `${safeDispositionName(fileName, 'filled-template')}.${ext}`,
        disposition: chosen,
        // A DOCX fill is laid out by LibreOffice, which substitutes fonts itself,
        // so only the overlay stamp has anything to report here.
        incompleteFields: incompleteFields || [],
      };

      const { convertDocument, convertsOnWorker } = require('../signatures/signatures.service');
      if (!convert || !convertsOnWorker()) {
        const output = convert
          ? await convertDocument(buffer, convert.outputFormat, convert.inputFilename)
          : buffer;
        const published = await publishRender({
          lawFirmId, templateId, userId, kind: 'fill', buffer: output, ...target,
        });
        return { signed: published, incompleteFields: target.incompleteFields };
      }

      const stagedPath = stagedRenderPath(lawFirmId, templateId, userId, convert.sourceExt);
      await getBucket().file(stagedPath).save(buffer, {
        resumable: false,
        metadata: { contentType: 'application/octet-stream', cacheControl: 'no-store, max-age=0' },
      });
      // Only the path and the size leave the slot; the buffer does not.
      return { stagedPath, sourceBytes: buffer.length, convert, target };
    });
    if (stage.signed) return stage;

    const { stagedPath, sourceBytes, convert, target } = stage;
    try {
      const { convertStoredDocument } = require('../signatures/signatures.service');
      const converted = await convertStoredDocument({
        sourceObjectPath: stagedPath,
        outputFormat: convert.outputFormat,
        inputFilename: convert.inputFilename,
        sourceBytes,
      });
      try {
        const published = await publishStoredRender({
          lawFirmId,
          templateId,
          userId,
          kind: 'fill',
          sourcePath: converted.objectPath,
          sourceGeneration: converted.generation,
          ...target,
        });
        return { signed: published, incompleteFields: target.incompleteFields };
      } finally {
        await converted.cleanup().catch(() => {});
      }
    } finally {
      // The daily render sweep is the backstop if this delete is lost.
      await getBucket().file(stagedPath).delete().catch(() => {});
    }
  });

  const { signed } = rendered;
  return {
    downloadUrl: signed.url,
    disposition: chosen,
    fileName: signed.fileName,
    contentType: signed.contentType,
    sizeBytes: signed.sizeBytes,
    generation: signed.generation,
    urlExpiresAt: signed.urlExpiresAt,
    incompleteFields: rendered.incompleteFields,
  };
}

/**
 * Render a filled HTML template to PDF and hand back a link to it.
 *
 * The browser substitutes the values into the template markup, as its preview
 * already does, and sends the result. Chromium renders it: on the document
 * worker when the API is switched to it, in this process on a developer machine
 * (`shared/documentConversion/pdfRenderer.ts`).
 *
 * The template is resolved under THIS caller's firm before anything is staged
 * or signed, and its own stored images are the only ones the render is given.
 * The PDF lands in the caller's render slot for this template, like a fill, so
 * the next export replaces it and the render sweep collects it.
 */
export async function exportTemplatePdf({
  lawFirmId, templateId, userId, html, fileName, disposition,
}: any) {
  if (Buffer.byteLength(String(html || ''), 'utf8') > EXPORT_HTML_MAX_BYTES) {
    throw new AppError(
      'This document is too large to export. Try removing large images or splitting it into multiple templates.',
      413,
      'TEMPLATE_EXPORT_TOO_LARGE',
    );
  }

  const doc = await templatesRepo.findById(lawFirmId, templateId);
  if (!doc) throw new NotFoundError('Template');
  if (!doc.htmlStoragePath) {
    throw new ValidationError('Only templates built in the editor can be exported this way');
  }

  const assets = (Array.isArray(doc.assets) ? doc.assets : [])
    .filter((asset: any) => typeof asset?.id === 'string' && typeof asset?.objectPath === 'string')
    .map((asset: any) => ({ id: asset.id, objectPath: asset.objectPath }));
  const objectPath = renderObjectPath(lawFirmId, templateId, userId, 'export', 'pdf');
  const chosen = disposition === 'inline' ? 'inline' : 'attachment';

  const { skippedAssets } = await withPersonRenderCap(userId, () => withTemplateExportSlot(
    () => renderHtmlToStoredPdf({ html, assets, outputObjectPath: objectPath }),
  ));

  let signed;
  try {
    signed = await signStoredDocument(objectPath, {
      fileName: `${safeDispositionName(fileName, 'document')}.pdf`,
      disposition: chosen,
      contentType: 'application/pdf',
    });
  } catch (error: any) {
    // The renderer answered without an object at the path: a worker that
    // reported success and wrote nothing. Say so rather than hand out a link
    // to a PDF that is not there.
    console.error('[templates] Export produced no PDF:', error.message);
    throw new AppError('The PDF could not be generated. Please try again.', 502, 'TEMPLATE_EXPORT_MISSING_OUTPUT');
  }

  return {
    downloadUrl: signed.url,
    disposition: chosen,
    fileName: signed.fileName,
    contentType: signed.contentType,
    sizeBytes: signed.sizeBytes,
    generation: signed.generation,
    urlExpiresAt: signed.urlExpiresAt,
    // Template images the PDF had to go without (unreachable, not an image, or
    // over a size ceiling). The PDF is still produced; the person is told.
    skippedImages: skippedAssets,
  };
}

/**
 * The largest template document this process will pull in to fill.
 *
 * Filling is a genuine TRANSFORM: docxtemplater and pdf-lib both need the whole
 * file. So the cost cannot be removed, only bounded, and it has to be bounded
 * BEFORE the read rather than after it. `convertDocument` checks its own
 * ceiling on a buffer it already holds, which is a check that has already spent
 * the memory it was meant to protect.
 */
const TEMPLATE_MAX_BYTES = Number(process.env.TEMPLATE_MAX_BYTES) || 25 * 1024 * 1024;

/** One placement image, and every placement image on one template together. */
const TEMPLATE_IMAGE_MAX_BYTES = Number(process.env.TEMPLATE_IMAGE_MAX_BYTES) || 10 * 1024 * 1024;
const TEMPLATE_IMAGE_TOTAL_MAX_BYTES = Number(process.env.TEMPLATE_IMAGE_TOTAL_MAX_BYTES)
  || 25 * 1024 * 1024;

/**
 * Read a stored object, refusing one that is too large to hold.
 *
 * The size comes from the object's metadata, so an oversized file is refused
 * without ever being read. Checking `buffer.length` afterwards would mean the
 * container had already carried it.
 */
async function storedSize(objectPath: string): Promise<number> {
  const [meta] = await getBucket().file(objectPath).getMetadata();
  return Number(meta.size || 0);
}

/** The stored size of an object, refused as 413 when it is over `maxBytes`. */
async function boundedSize(objectPath: string, maxBytes: number, description: string) {
  const size = await storedSize(objectPath);
  if (size > maxBytes) {
    throw new AppError(
      `This ${description} is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit for filling a template.`,
      413,
      'TEMPLATE_OBJECT_TOO_LARGE',
    );
  }
  return size;
}

async function readBounded(objectPath: string, maxBytes: number, description: string) {
  await boundedSize(objectPath, maxBytes, description);
  const [buffer] = await getBucket().file(objectPath).download();
  return buffer;
}

// ── preview (docx / overlay) ─────────────────────────────────────────
//
// HTML templates are previewed by the client from the HTML it already has, so
// only the two document-backed types are served here, both as PDF. The two are
// not the same amount of work, and the difference is what this code is about.
//
// An overlay template's stored PDF IS the preview. It is the canvas its editor
// draws on, and nothing transforms it, so the whole job is to sign the object
// where it already sits. Reading it in order to write it back out put a whole
// document in this process for no transform at all.
//
// A DOCX template genuinely has to be converted, so its preview is a render:
// produced here, written under the firm's render segment, and handed out as a
// link. It is not cached under the firm's templates prefix, where gcSweep would
// read it as an orphan and where it would be charged against a quota for a copy
// that exists only to be looked at.

/** A storage failure reading a template, as the 502 the client is shown. */
function templateReadFailed(error: any, description: any) {
  if (error instanceof AppError) return error;
  console.error(`[templates] Failed to download ${description}:`, error.message);
  return new AppError(
    'Could not read this template from storage. Please try again in a moment.',
    502,
    'TEMPLATE_OBJECT_DOWNLOAD_FAILED',
  );
}

async function downloadTemplateObject(objectPath: any, description: any) {
  try {
    return await readBounded(objectPath, TEMPLATE_MAX_BYTES, description);
  } catch (error: any) {
    throw templateReadFailed(error, description);
  }
}

/**
 * A failed preview conversion, as the error the client is shown.
 *
 * A busy refusal from the converter's queue passes through as its own 503
 * with a `Retry-After`: nothing was converted, and the same request works once
 * the queue drains. Anything else is the converter failing on this document.
 */
function previewConversionFailed(error: any) {
  if (isConversionBusy(error)) return error;
  console.error('[templates] DOCX preview conversion failed:', error.message);
  return new AppError(
    'Could not render this DOCX template for preview. Please try again in a moment.',
    502,
    'TEMPLATE_PREVIEW_CONVERSION_FAILED',
  );
}

export async function previewTemplate({ lawFirmId, templateId, userId }: any) {
  // First, and before anything is signed. The lookup is scoped to the caller's
  // firm, so another firm's template is not found rather than being handed out
  // under a URL that needs no credential to use.
  const doc = await templatesRepo.findById(lawFirmId, templateId);
  if (!doc) throw new NotFoundError('Template');

  const type = doc.type || 'html';
  // The same sanitizing the `Content-Disposition` header did, on the same
  // input: the template name is user-supplied and reaches a header either way.
  const fileName = safeDispositionName(`${doc.name || 'template'}.pdf`, 'template.pdf');

  if (type === 'overlay') {
    if (!doc.overlayPdfObjectPath) {
      throw new ValidationError('This template has no document to preview.');
    }
    const signed = await signTemplateObject(doc.overlayPdfObjectPath, {
      fileName,
      disposition: 'inline',
      contentType: FORMAT_CONTENT_TYPES.pdf,
    });
    return {
      previewUrl: signed.url,
      fileName: signed.fileName,
      contentType: signed.contentType,
      sizeBytes: signed.sizeBytes,
      generation: signed.generation,
      urlExpiresAt: signed.urlExpiresAt,
    };
  }

  if (type === 'docx') {
    if (!doc.docxStoragePath) {
      throw new ValidationError('This template has no document to preview.');
    }
    const {
      convertDocument, convertStoredDocument, convertsOnWorker,
    } = require('../signatures/signatures.service');
    const inputFilename = `${doc.name || 'template'}.docx`;

    // On the worker the stored DOCX is converted where it sits: the worker
    // reads it by URL and writes the PDF back to storage, so neither document
    // enters this process. With nothing held, the fill slot (which bounds
    // documents in memory) is not taken at all, so a preview waiting on the
    // converter cannot keep a fill that needs no conversion out of its slot.
    // The per-person cap still spans it.
    //
    // In this process the DOCX and the converted PDF are both held in memory
    // from the read until the upload finishes, so that path stays behind the
    // fill slot for the whole of it, conversion included, for the same reason
    // a local-mode fill does (see `fillTemplate`).
    const previewOnWorker = async () => {
      let sourceBytes;
      try {
        sourceBytes = await boundedSize(doc.docxStoragePath, TEMPLATE_MAX_BYTES, 'template DOCX');
      } catch (error: any) {
        throw templateReadFailed(error, 'template DOCX');
      }
      let converted;
      try {
        converted = await convertStoredDocument({
          sourceObjectPath: doc.docxStoragePath,
          outputFormat: 'pdf',
          inputFilename,
          sourceBytes,
        });
      } catch (error: any) {
        throw previewConversionFailed(error);
      }
      try {
        return await publishStoredRender({
          lawFirmId,
          templateId,
          userId,
          kind: 'preview',
          ext: 'pdf',
          sourcePath: converted.objectPath,
          sourceGeneration: converted.generation,
          contentType: FORMAT_CONTENT_TYPES.pdf,
          fileName,
          disposition: 'inline',
        });
      } finally {
        await converted.cleanup().catch(() => {});
      }
    };

    const previewInProcess = () => withTemplateFillSlot(async () => {
      const docxBuffer = await downloadTemplateObject(doc.docxStoragePath, 'template DOCX');

      let pdfBuffer;
      try {
        pdfBuffer = await convertDocument(docxBuffer, 'pdf', inputFilename);
      } catch (error: any) {
        throw previewConversionFailed(error);
      }

      return publishRender({
        lawFirmId,
        templateId,
        userId,
        kind: 'preview',
        ext: 'pdf',
        buffer: pdfBuffer,
        contentType: FORMAT_CONTENT_TYPES.pdf,
        fileName,
        // `inline`, as the header said: a preview opens in the viewer.
        disposition: 'inline',
      });
    });

    const signed = await withPersonRenderCap(
      userId,
      convertsOnWorker() ? previewOnWorker : previewInProcess,
    );
    return {
      previewUrl: signed.url,
      fileName: signed.fileName,
      contentType: signed.contentType,
      sizeBytes: signed.sizeBytes,
      generation: signed.generation,
      urlExpiresAt: signed.urlExpiresAt,
    };
  }

  throw new ValidationError('Only DOCX and Document Overlay templates have a document preview');
}

// ── delete ───────────────────────────────────────────────────────────

export async function deleteTemplate({ lawFirmId, templateId }: any) {
  const existing = await templatesRepo.findById(lawFirmId, templateId);
  if (!existing) throw new NotFoundError('Template');

  if ((existing.type || 'html') === 'docx' && existing.docxStoragePath) {
    await deleteTemplateAsset(lawFirmId, existing.docxStoragePath);
  }

  if ((existing.type || 'html') === 'overlay') {
    if (existing.overlayPdfObjectPath) {
      await deleteTemplateAsset(lawFirmId, existing.overlayPdfObjectPath);
    }
    // The source and PDF objects are the same path when the upload was
    // already a PDF; only delete the source separately when it isn't.
    if (existing.overlaySourceObjectPath && existing.overlaySourceObjectPath !== existing.overlayPdfObjectPath) {
      await deleteTemplateAsset(lawFirmId, existing.overlaySourceObjectPath);
    }
  }

  if (existing.htmlStoragePath) {
    await deleteTemplateAsset(lawFirmId, existing.htmlStoragePath);
  }

  for (const asset of existing.assets || []) {
    await deleteTemplateAsset(lawFirmId, asset.objectPath);
  }

  // The renders go with the template. Nothing in the app can reach one once the
  // row is gone, and no listing shows them, so a render left behind is storage
  // the firm keeps paying for with nothing left to explain it.
  await deleteRenders(templateRenderPrefix(lawFirmId, templateId));

  await templatesRepo.delete(lawFirmId, templateId);
  return { message: 'Template deleted successfully', templateId };
}

// ── GC sweep (orphaned GCS object reconciliation) ────────────────────
//
// deleteTemplate / deleteTemplateAsset are best-effort and swallow GCS
// failures, so storage objects under lawfirmids/{firm}/templates/ can be left
// behind with no live template row referencing them. This sweep lists the GCS
// objects under a firm's templates prefix and deletes the ones not referenced
// by any live row, reconciling those orphans.
//
// Safety:
//  - dryRun (default true) never deletes; it only reports what would be removed.
//  - An object is deleted ONLY when its full path is absent from the set of
//    paths referenced by live rows (html/docx/asset objectPaths). An object
//    referenced by any live row is never touched.

function templatesPrefix(lawFirmId: string) {
  return `${DOCX_STORAGE_PREFIX}/${lawFirmId}/templates/`;
}

export async function gcSweepLawFirm(lawFirmId: string, { dryRun = true }: any = {}) {
  const referenced = await templatesRepo.listReferencedObjectPaths(lawFirmId);

  // Streamed a page at a time rather than materialized in one listing, and
  // exhaustive: the sweep's whole claim is that anything it did not name is
  // still referenced, so a scan that stopped early would leave orphans behind
  // while reporting a clean firm. Only the orphan paths are collected, and those
  // are bounded by how many objects actually leaked.
  const orphans: any[] = [];
  let scanned = 0;
  await forEachObjectPage(getBucket(), templatesPrefix(lawFirmId), (files: any) => {
    scanned += files.length;
    for (const file of files) {
      if (!referenced.has(file.name)) orphans.push(file.name);
    }
  }, { ceiling: NO_CEILING });

  let deleted = 0;
  const errors = [];
  if (!dryRun && orphans.length > 0) {
    // Re-fetch the referenced set right before deleting: a template saved while
    // the listing above was running uploads its objects to GCS before the row
    // update that references them, so the pre-listing snapshot would classify
    // those live objects as orphans. The re-check closes that window.
    const referencedNow = await templatesRepo.listReferencedObjectPaths(lawFirmId);
    for (const objectPath of orphans) {
      if (referencedNow.has(objectPath)) continue;
      try {
        // Credit the freed bytes back: an orphan was charged to the firm when it
        // was written, so a sweep that only deleted would leave usage overstated.
        // Deleted here rather than through `deleteTemplateAsset` because that
        // helper swallows failures, which would report every orphan as deleted.
        const file = getBucket().file(objectPath);
        // eslint-disable-next-line no-await-in-loop
        const freedBytes = await objectSizeBytes(file);
        // eslint-disable-next-line no-await-in-loop
        await file.delete();
        // eslint-disable-next-line no-await-in-loop
        await chargeStorageDelta(lawFirmId, -freedBytes);
        deleted += 1;
      } catch (error: any) {
        console.error('[templates gc] Failed to delete orphan', objectPath, error.message);
        errors.push({ objectPath, message: error.message });
      }
    }
  }

  return {
    lawFirmId,
    dryRun,
    scanned,
    referenced: referenced.size,
    orphans,
    orphanCount: orphans.length,
    deleted,
    errors,
  };
}

/** Every firm that currently has at least one template row. */
async function firmIdsWithTemplates(): Promise<{ lawFirmId: string }[]> {
  return systemQuery('scheduler', (executor) => executor
    .selectDistinct({ lawFirmId: templates.lawFirmId })
    .from(templates)
    .where(isNotNull(templates.lawFirmId)));
}

/**
 * Collect renders that have outlived the links pointing at them.
 *
 * `deleteTemplate` already takes a template's renders with it, so this catches
 * the rest: a person who filled a template once and will not come back, and a
 * row removed by anything that did not go through the delete path. The age comes
 * from the object's own `timeCreated`, so an object written since the last pass
 * is left alone rather than cut mid-download.
 *
 * Returns how many objects were removed. Never throws: it is one entry in a
 * housekeeping pass and must not stop the ones after it.
 */
export async function sweepExpiredRenders({ olderThanMs = TEMPLATE_RENDER_TTL_MS }: any = {}) {
  const cutoff = Date.now() - olderThanMs;
  let deleted = 0;
  let firms: { lawFirmId: string }[] = [];
  try {
    firms = await firmIdsWithTemplates();
  } catch (error: any) {
    console.error('[templates gc] Could not list firms for the render sweep:', error.message);
    return 0;
  }

  for (const { lawFirmId } of firms) {
    // eslint-disable-next-line no-await-in-loop -- one firm's prefix at a time
    deleted += await deleteRenders(firmRenderPrefix(lawFirmId), (file: any) => {
      const written = Date.parse(file.metadata?.timeCreated || file.metadata?.updated || '');
      return Number.isFinite(written) && written < cutoff;
    });
  }
  return deleted;
}

// Sweep every firm that currently has at least one template row. Returns a
// per-firm result array. Defaults to dry-run.
export async function gcSweep({ dryRun = true }: any = {}) {
  const rows = await firmIdsWithTemplates();

  const results = [];
  for (const { lawFirmId } of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await gcSweepLawFirm(lawFirmId, { dryRun }));
    } catch (error: any) {
      console.error('[templates gc] Sweep failed for firm', lawFirmId, error.message);
      results.push({ lawFirmId, dryRun, error: error.message });
    }
  }
  return results;
}

// ── util ─────────────────────────────────────────────────────────────

function buildFlatFieldList(fields: any, repeaters: any) {
  const all = [...fields];
  for (const r of repeaters) {
    for (const f of r.fields) {
      all.push(`${r.name}.${f}`);
    }
  }
  return all;
}
