/**
 * Where the Word-first library keeps its bytes, and the few storage operations
 * it performs. Every object lives under the firm's own prefix
 * (`lawfirmids/{firm}/word-templates/`), and every write is charged to the
 * firm's storage usage by its size change, as the existing templates module
 * does, because these objects sit in the same bucket the quota describes.
 *
 * Uploads arrive through the shared direct-upload pair: the browser PUTs to a
 * scratch path under `word-template-uploads/{firm}/{user}/`, and a route settles
 * that object before reading it. The scratch path is deleted once a request
 * has made something permanent from it.
 */
import { randomUUID } from 'crypto';
import { AppError, ValidationError } from '../../shared/errors/AppError';
import { adjustStorageUsageByDelta } from '../../shared/utils/storageUsage';

const { admin } = require('../../shared/database/firebase');

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';

export function bucket() {
  return admin.storage().bucket(BUCKET_NAME);
}

/** Largest .docx or .pdf the library accepts or reads back (JJ's limit). */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Largest editor image (JJ's limit). */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
/** How long an editor image preview link stays valid (JJ's one hour). */
const ASSET_URL_TTL_MS = 60 * 60 * 1000;

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_CONTENT_TYPE = 'application/pdf';

const firmRoot = (lawFirmId: string) => `lawfirmids/${lawFirmId}/word-templates`;

export function htmlObjectPath(lawFirmId: string, templateId: string) {
  return `${firmRoot(lawFirmId)}/${templateId}.html`;
}

/**
 * A template's source file. `version` gives a re-upload a fresh path that can
 * never collide with the current one, so the swap can write first, repoint the
 * row second and delete the old object last: no step destroys the only copy.
 */
export function sourceObjectPath(lawFirmId: string, templateId: string, ext: 'docx' | 'pdf', version?: string) {
  return `${firmRoot(lawFirmId)}/${templateId}${version ? `-${version}` : ''}.${ext}`;
}

export function assetObjectPath(lawFirmId: string, templateId: string, assetId: string, ext: string) {
  return `${firmRoot(lawFirmId)}/${templateId}/assets/${assetId}.${ext}`;
}

/** Scratch space for one export render, removed once its bytes are sent. */
export function exportRenderPath(lawFirmId: string) {
  return `${firmRoot(lawFirmId)}/exports/${randomUUID()}.pdf`;
}

/** Every scratch upload this caller may settle in this firm. */
export function uploadPrefix(lawFirmId: string, userId: string) {
  return `word-template-uploads/${lawFirmId}/${userId}/`;
}

export function newUploadPath(lawFirmId: string, userId: string, purpose: string, ext: string, templateId?: string) {
  const scope = templateId ? `${templateId}/` : '';
  return `${uploadPrefix(lawFirmId, userId)}${scope}${randomUUID()}/${purpose}.${ext}`;
}

/**
 * Refuse an object path the caller did not open in this firm. The path comes
 * from the request, so without this a caller could settle and read another
 * firm's (or another person's) upload.
 */
export function assertOwnUpload(lawFirmId: string, userId: string, objectPath: string, templateId?: string) {
  const prefix = uploadPrefix(lawFirmId, userId) + (templateId ? `${templateId}/` : '');
  const rest = objectPath.startsWith(prefix) ? objectPath.slice(prefix.length) : null;
  if (rest === null || rest.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new ValidationError('That upload does not belong to this template.');
  }
}

async function objectSize(path: string): Promise<number> {
  try {
    const [meta] = await bucket().file(path).getMetadata();
    return Number(meta?.size || 0);
  } catch {
    return 0;
  }
}

async function chargeDelta(lawFirmId: string, delta: number) {
  if (!delta) return;
  try {
    await adjustStorageUsageByDelta(lawFirmId, delta);
  } catch (error: any) {
    // Accounting never fails the write it describes; a recount repairs drift.
    console.error('[word-templates] storage usage accounting failed:', error.message);
  }
}

/** Write an object under the firm and charge the firm for the size change. */
export async function saveObject(lawFirmId: string, path: string, body: Buffer, contentType: string) {
  const previous = await objectSize(path);
  await bucket().file(path).save(body, { resumable: false, metadata: { contentType } });
  await chargeDelta(lawFirmId, body.length - previous);
}

/** Copy a settled upload into the firm's template tree, charging the firm. */
export async function copyObject(lawFirmId: string, from: string, to: string, sizeBytes: number, contentType: string) {
  const previous = await objectSize(to);
  await bucket().file(from).copy(bucket().file(to), { contentType });
  await chargeDelta(lawFirmId, sizeBytes - previous);
}

/**
 * Remove objects the firm no longer needs, crediting the firm. Best effort: a
 * failed delete leaves an orphan, never a broken template.
 */
export async function deleteObjects(lawFirmId: string, paths: Array<string | null | undefined>) {
  await Promise.all(paths.filter((p): p is string => Boolean(p)).map(async (path) => {
    const size = await objectSize(path);
    try {
      await bucket().file(path).delete();
      await chargeDelta(lawFirmId, -size);
    } catch (error: any) {
      if (error?.code !== 404) console.error('[word-templates] could not delete', path, error?.message);
    }
  }));
}

/** Delete a scratch upload (never charged to the firm). Best effort. */
export async function discardUpload(path: string) {
  await bucket().file(path).delete().catch(() => {});
}

/**
 * Read a stored object whole, refusing one over `maxBytes` from its metadata
 * before a byte is downloaded.
 */
export async function readObject(path: string, maxBytes = MAX_SOURCE_BYTES): Promise<Buffer> {
  const size = await objectSize(path);
  if (size > maxBytes) {
    throw new AppError(`This file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`, 413, 'TEMPLATE_OBJECT_TOO_LARGE');
  }
  const [buffer] = await bucket().file(path).download();
  return buffer as Buffer;
}

/** A short-lived read link for an editor image. Null if it cannot be signed. */
export async function signAssetUrl(path: string): Promise<string | null> {
  try {
    const [url] = await bucket().file(path).getSignedUrl({
      version: 'v4', action: 'read', expires: Date.now() + ASSET_URL_TTL_MS,
    });
    return url;
  } catch {
    // A broken preview must not take down the editor load.
    return null;
  }
}
