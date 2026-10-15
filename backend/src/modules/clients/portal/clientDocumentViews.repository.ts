import {
  and,
  eq,
  inArray,
  isNotNull,
  sql,
} from 'drizzle-orm';
import { fileClientAccess } from '../../../shared/database/drizzle/schema';
import { tenantQuery } from '../../../shared/database/queryContext';
import { scopedUpsert } from '../../../shared/database/scopedWrite';

/**
 * Tracks which client-visible documents a portal client has already opened, so
 * the Documents view can badge never-opened shares as "New". Keyed by `files`
 * row id in `file_client_access`. That row is also written when a file is shared
 * or its share notification goes out, so the row existing is not an open: only
 * `first_seen_at` is.
 */

/**
 * The subset of `fileIds` this client has opened, in one query for the whole
 * listing.
 */
export async function getSeenFileIds(lawFirmId: string, clientUserId: string, fileIds: string[]) {
  if (!lawFirmId || !clientUserId || !fileIds.length) return new Set<string>();
  const rows = await tenantQuery(fileClientAccess, lawFirmId, ({ executor, scope }) => executor
    .select({ fileId: fileClientAccess.fileId })
    .from(fileClientAccess)
    .where(and(
      scope,
      eq(fileClientAccess.clientUserId, clientUserId),
      inArray(fileClientAccess.fileId, fileIds),
      isNotNull(fileClientAccess.firstSeenAt),
    )));
  return new Set<string>(rows.map((r: { fileId: string }) => r.fileId));
}

/**
 * Record that a client has opened a document (first-seen only; idempotent). Best
 * effort - a failure here must never block a download.
 */
export async function recordView(lawFirmId: string, clientUserId: string, fileId: any) {
  if (!lawFirmId || !clientUserId || !fileId) return;
  try {
    await scopedUpsert(
      fileClientAccess,
      lawFirmId,
      { clientUserId, fileId, firstSeenAt: new Date() },
      [fileClientAccess.lawFirmId, fileClientAccess.clientUserId, fileClientAccess.fileId],
      { firstSeenAt: sql`coalesce(${fileClientAccess.firstSeenAt}, now())` },
    );
  } catch (err: any) {
    console.error('clientDocumentViews.recordView failed for', fileId, err.message);
  }
}

