import { and, asc, eq } from 'drizzle-orm';
import { documentRequestUploads, files } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedInsertMany } from '../../shared/database/scopedWrite';

/** Recover only the sessions belonging to this firm, item, caller and action. */
export async function findAction(lawFirmId: string, itemId: string, userId: string, actionKey: string) {
  return tenantQuery(documentRequestUploads, lawFirmId, ({ executor, scope }) => executor
    .select({ receipt: documentRequestUploads, file: files }).from(documentRequestUploads)
    .innerJoin(files, and(eq(files.id, documentRequestUploads.fileId), eq(files.lawFirmId, documentRequestUploads.lawFirmId)))
    .where(and(scope, eq(documentRequestUploads.itemId, itemId), eq(documentRequestUploads.createdBy, userId),
      eq(documentRequestUploads.actionKey, actionKey)))
    .orderBy(asc(documentRequestUploads.position)));
}

/** Persist the batch's recoverable sessions together, before replying to init. */
export async function saveAction(lawFirmId: string, itemId: string, userId: string, actionKey: string,
  requestHash: string, uploads: any[]) {
  return scopedInsertMany(documentRequestUploads, lawFirmId, uploads.map((upload, position) => ({
    itemId, createdBy: userId, actionKey, requestHash, position, fileId: upload.fileId,
    uploadUrl: upload.uploadUrl, reservationId: upload.reservationId || null,
  })));
}
