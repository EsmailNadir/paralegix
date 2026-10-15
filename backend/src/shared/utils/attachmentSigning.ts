const { runWithConcurrency } = require('./runWithConcurrency');

/** Attachments signed at once. Local crypto, so this bounds CPU and the event loop. */
const ATTACHMENT_SIGN_CONCURRENCY = Number(process.env.ATTACHMENT_SIGN_CONCURRENCY) || 8;

'use strict';

/**
 * Re-sign stored attachments on read.
 *
 * GCS v4 signed URLs max out at a 7-day expiry, so a URL persisted at upload time
 * dies after a week and the stored link breaks. Instead we keep the `objectPath`
 * on the record and regenerate a fresh short-lived signed URL whenever the
 * attachment is served. Signing a v4 URL with the service-account key is a LOCAL
 * cryptographic operation (no GCS API call / no billable storage op), so this is
 * cheap to do per read. An attachment with no `objectPath` has nothing to sign
 * from, so it is returned unchanged.
 */

const { admin } = require('../database/firebase');
const { dispositionFor } = require('./attachmentDisposition');

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const bucket = admin.storage().bucket(BUCKET_NAME);
const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour (matches files module)

export async function resignAttachment(a: any) {
  if (!a || !a.objectPath) return a;
  try {
    const opts = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
      // Force dangerous active-content (html/svg/xml) to download so a signed
      // attachment URL can't render script in our origin.
      responseDisposition: dispositionFor(a.mimeType || a.mimetype, a.name),
    };
    const [url] = await bucket.file(a.objectPath).getSignedUrl(opts);
    return { ...a, url };
  } catch (err) {
    // Keep the stored URL as a fallback if signing fails; don't break the read.
    console.error('[attachmentSigning] re-sign failed for', a.objectPath, (err as Error).message);
    return a;
  }
}

/** Re-sign an array of attachments (returns a new array; input unchanged). */
export async function resignAttachments(attachments: any) {
  if (!Array.isArray(attachments) || attachments.length === 0) return attachments || [];
  // Bounded at the helper rather than at each caller: messaging pages, portal
  // reads, and task/note reads all fan out messages x attachments through here,
  // so capping once covers every one of them. Signing is local crypto, which
  // means the pressure is CPU and the event loop rather than the network.
  const settled = await runWithConcurrency(
    attachments.map((a: any) => () => resignAttachment(a)),
    ATTACHMENT_SIGN_CONCURRENCY,
  );
  return settled.map((r: any, i: number) => (r.status === 'fulfilled' ? r.value : attachments[i]));
}

/**
 * Re-sign the `.attachments` array on each item of a list (or a single object),
 * mutating each item in place. Convenience for read paths that return records
 * carrying an attachments array (tasks, notes, …).
 */
export async function resignAttachmentsOn(itemOrItems: any) {
  const list = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
  await Promise.all(list.map(async (it) => {
    if (it && Array.isArray(it.attachments) && it.attachments.length) {
      it.attachments = await resignAttachments(it.attachments);
    }
  }));
  return itemOrItems;
}

/**
 * Drop the persisted `url` from attachments before they're written to a row.
 * The signed URL is regenerated on read from `objectPath`, so storing it just
 * persists a soon-expired (and access-granting) URL in the DB. Only stripped
 * when an `objectPath` exists to re-sign from.
 */
export function stripAttachmentUrls(attachments: any) {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map((a: any) => {
    if (a && a.objectPath && a.url !== undefined) {
      const { url, ...rest } = a;
      return rest;
    }
    return a;
  });
}

/**
 * Delete the stored objects behind a set of attachments.
 *
 * Used where a record's attachments stop being reachable but the record itself
 * is retained (a soft-deleted message keeps its row as a legal record, while
 * every read path already strips its attachments). Those bytes are then visible
 * to nobody and removable by nobody, yet still counted against the firm's
 * storage quota, so they are deleted outright rather than left to accumulate.
 *
 * Returns the total size of what was actually deleted, for the caller to
 * subtract from the firm's tracked usage. The size is the one STORAGE reports,
 * never the `size` on the attachment, which the sender wrote. An object that is
 * already gone, or whose delete fails, contributes nothing, so usage never
 * drops below the truth; the periodic recount reconciles the rest. The delete
 * is pinned to the generation whose size was read, so two concurrent deletes of
 * one object subtract it once.
 *
 * `mayDelete` lets the caller keep an object something else still needs (a
 * second message naming the same path). Each path is considered once, however
 * many times the list repeats it.
 */
export async function deleteAttachmentObjects(
  attachments: any,
  { mayDelete }: { mayDelete?: (objectPath: string) => Promise<boolean> | boolean } = {},
) {
  if (!Array.isArray(attachments) || attachments.length === 0) return 0;

  const paths = [...new Set(attachments
    .map((a: any) => (a && typeof a.objectPath === 'string' ? a.objectPath : ''))
    .filter(Boolean))] as string[];

  const sizes = await Promise.all(paths.map(async (objectPath) => {
    try {
      if (mayDelete && !(await mayDelete(objectPath))) return 0;
      const handle = bucket.file(objectPath);
      const [meta] = await handle.getMetadata();
      await handle.delete(meta.generation ? { ifGenerationMatch: meta.generation } : {});
      return Number(meta.size) || 0;
    } catch (err: any) {
      if (Number(err?.code) !== 404) {
        console.error('[attachmentSigning] delete failed for', objectPath, (err as Error).message);
      }
      return 0;
    }
  }));

  return sizes.reduce((sum, n) => sum + n, 0);
}
