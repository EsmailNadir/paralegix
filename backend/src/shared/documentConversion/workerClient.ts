/**
 * How the API reaches the private document worker: where it is, how long a
 * signed URL handed to it lives, how long the API waits, and the identity token
 * Cloud Run requires on every call. Shared by LibreOffice conversion
 * (`converter.ts`) and PDF export (`pdfRenderer.ts`).
 */
import { admin } from '../database/firebase';

export const WORKER_TIMEOUT_MS = Number(process.env.DOCUMENT_WORKER_TIMEOUT_MS) || 55_000;
export const URL_TTL_MS = Number(process.env.DOCUMENT_WORKER_URL_TTL_MS) || 90_000;

/** Scratch objects staged for the worker live under this prefix. */
export const CONVERSION_ROOT = 'document-conversion';

export function bucket() {
  return admin.storage().bucket(process.env.GCS_BUCKET || 'lawfirms');
}

export function workerUrl() {
  const url = process.env.DOCUMENT_WORKER_URL;
  if (!url) {
    const error: any = new Error('Document conversion worker is not configured.');
    error.statusCode = 503;
    throw error;
  }
  return url.replace(/\/$/, '');
}

export async function getIdentityToken(audience: string) {
  if (process.env.DOCUMENT_WORKER_ID_TOKEN) return process.env.DOCUMENT_WORKER_ID_TOKEN;
  const response = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!response.ok) throw new Error('Unable to obtain the document worker identity token.');
  return response.text();
}
