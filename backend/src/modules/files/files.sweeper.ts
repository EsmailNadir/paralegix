/**
 * Destroy what a delete left behind, once its retention window has cleared.
 *
 * A delete is soft: the row keeps its id and its object, and only `deleted_at`
 * is set. That is what makes a delete recoverable, what keeps a legal hold
 * holding something, and what lets a share link answer "no longer available"
 * instead of 404-ing on a token nobody recognises. This is the other half:
 * without it a firm's storage bill grows forever on documents they threw away
 * a year ago.
 *
 * Two kinds of row are collected, and the difference matters:
 *
 *   - A DELETED document, once its retention window has passed. The firm asked
 *     for this and has had a month to change their mind.
 *   - An UNFINALIZED row, once it is too old to be a live upload. `upload-init`
 *     claims a row before the bytes exist, so a browser tab closed mid-upload
 *     leaves one behind. It is invisible to every listing and charged to
 *     nobody, but it holds a name in its folder.
 *
 * A row under a live legal hold is never collected, whatever its age; see
 * `listSweepable`.
 *
 * The OBJECT goes first, then the row. The other order leaves an object nothing
 * names, which nothing would ever find again. This order can leave a row whose
 * object is already gone, which the next pass simply retries: `ignoreNotFound`
 * makes a second delete of the same object a no-op.
 */
const filesRepo = require('./files.repository');
const { bucket } = require('./files.storage');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');

/** How long a deleted document is kept before it is destroyed. */
const RETENTION_DAYS = Number(process.env.FILES_RETENTION_DAYS) || 30;

/**
 * How long a claimed-but-unfinished upload is kept.
 *
 * Comfortably longer than any real upload: a resumable session for a large
 * document over a slow connection can legitimately run for hours, and
 * collecting one still in flight would delete the object the browser is
 * currently writing to.
 */
const UNFINALIZED_HOURS = Number(process.env.FILES_UNFINALIZED_HOURS) || 24;

/** Rows destroyed per pass. Bounded so one pass cannot run unboundedly long. */
const SWEEP_LIMIT = Number(process.env.FILES_SWEEP_LIMIT) || 500;

/**
 * Object deletes in flight at once. One at a time made a pass as long as its
 * row count times a storage round trip; all at once is five hundred sockets
 * from one container.
 */
const DELETE_CONCURRENCY = 8;

export async function sweepDestroyedFiles({
  retentionDays = RETENTION_DAYS,
  unfinalizedHours = UNFINALIZED_HOURS,
  limit = SWEEP_LIMIT,
} = {}) {
  const rows = await filesRepo.listSweepable({ retentionDays, unfinalizedHours, limit });
  if (rows.length === 0) {
    const foldersDestroyed = await collectEmptyDeletedFolders(retentionDays);
    return { examined: 0, destroyed: 0, objectsRemoved: 0, foldersDestroyed };
  }

  const destroyable: string[] = [];
  let objectsRemoved = 0;

  const settled = await runWithConcurrency(rows.map((row: any) => async () => {
    try {
      await bucket.file(row.objectPath).delete();
      return { id: row.id, removed: true };
    } catch (err: any) {
      if (err?.code === 404) {
        // Already gone: a previous pass removed the object and failed before
        // the row. Collecting the row now is exactly the retry.
        return { id: row.id, removed: false };
      }
      // Anything else is left for the next pass. A row whose object could not
      // be removed must keep its row, or the object becomes unreachable.
      console.error('[files.sweeper] object delete failed for', row.objectPath, err.message);
      return null;
    }
  }), DELETE_CONCURRENCY);

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled' || !outcome.value) continue;
    destroyable.push(outcome.value.id);
    if (outcome.value.removed) objectsRemoved += 1;
  }

  const destroyed = await filesRepo.hardDelete(destroyable);
  const foldersDestroyed = await collectEmptyDeletedFolders(retentionDays);
  return { examined: rows.length, destroyed, objectsRemoved, foldersDestroyed };
}

/**
 * Deleted folders go once their contents have. Each pass takes the folders with
 * nothing beneath them, which frees their parents for the next pass, so this
 * repeats until a pass takes nothing. Bounded by the depth of the tree.
 */
async function collectEmptyDeletedFolders(retentionDays: number) {
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one level of the tree per pass
    const n = await filesRepo.hardDeleteEmptyDeletedFolders({ retentionDays });
    if (n === 0) return total;
    total += n;
  }
}
