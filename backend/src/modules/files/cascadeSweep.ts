/**
 * Removing the stored objects of documents a parent delete took with it.
 *
 * Deleting a matter, a task or a client cascades its `files` rows away in the
 * database, but the objects those rows named have no foreign key to anything.
 * The delete path snapshots them first (`filesRepo.scopeSnapshot`) and hands
 * the snapshot here, after the rows are gone.
 *
 * This runs INSIDE the delete request. It used to run in an event listener
 * after the response, and Cloud Run stops scheduling CPU for a process once
 * the response is sent, so the sweep, one awaited delete at a time, did not
 * finish: objects stayed in the bucket and the firm's storage figure stayed
 * charged for documents it no longer had.
 *
 * A crash partway through still leaves the rest in the bucket. Making that
 * durable needs a queue table, which is a schema change of its own.
 */
const { bucket } = require('./files.storage');
const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');

/** Object deletes in flight at once for one parent. */
export const CASCADE_DELETE_CONCURRENCY = 8;

/**
 * Delete every object in a scope snapshot and credit the firm for what went.
 *
 * Only bytes whose delete succeeded are credited. An object already gone is not
 * an error, and it is not credited either: crediting a snapshot's whole total
 * on a repeat would walk the firm's storage figure down past what it holds.
 *
 * Returns the bytes credited.
 */
export async function removeCascadeObjects(what: string, lawFirmId: string, snapshot: any): Promise<number> {
  const objects: Array<{ objectPath: string; chargedBytes?: number }> = snapshot?.objects || [];
  if (objects.length === 0) return 0;

  let freed = 0;
  await runWithConcurrency(objects.map(({ objectPath, chargedBytes }) => async () => {
    try {
      await bucket.file(objectPath).delete();
      freed += Number(chargedBytes || 0);
    } catch (err: any) {
      if (err?.code !== 404) {
        console.error(`files: ${what} object delete failed for`, objectPath, err.message);
      }
    }
  }), CASCADE_DELETE_CONCURRENCY);

  if (freed > 0) {
    await adjustStorageUsageByDelta(lawFirmId, -freed)
      .catch((err: any) => console.error(`files: ${what} usage adjust failed:`, err.message));
  }
  return freed;
}
