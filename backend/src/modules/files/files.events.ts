const eventBus = require('../../shared/events/eventBus');
const {
  CLIENT_DELETED,
  LAWFIRM_DELETED,
  FILE_SHARED,
} = require('../../shared/events/eventTypes');
const { bucket } = require('./files.storage');
const { adjustStorageUsageByDelta } = require('../../shared/utils/storageUsage');
const { BASE_FOLDER } = require('./files.context');
const { forEachObjectPage, NO_CEILING } = require('../../shared/storage/listObjects');
const shareNotifications = require('./shareNotifications.service');

/**
 * Delete every object under a storage prefix, for the bytes that never had a
 * file row: a client's direct-thread attachments, and everything a deleted firm
 * ever stored. Both are outside the browsable tree, so there is no row to
 * cascade and nothing else would ever reach them.
 *
 * Counted the same way as the sweep above, and idempotent for the same reason: a
 * redelivery lists an empty prefix and credits nothing.
 */
async function sweepPrefix(what: string, lawFirmId: string, prefix: string, { charged }: any) {
  let freed = 0;
  await forEachObjectPage(bucket, prefix, async (page: any[]) => {
    for (const file of page) {
      const size = Number(file.metadata?.size || 0);
      try {
        // eslint-disable-next-line no-await-in-loop -- one delete per object
        await file.delete();
        freed += size;
      } catch (err: any) {
        if (err?.code !== 404) {
          console.error(`files.events: ${what} prefix delete failed for`, file.name, err.message);
        }
      }
    }
  }, { ceiling: NO_CEILING });

  // A deleted FIRM gets no adjustment: the row that would carry the figure is
  // gone with it, so the update would be a no-op against a missing row.
  if (charged && freed > 0) {
    await adjustStorageUsageByDelta(lawFirmId, -freed)
      .catch((err: any) => console.error(`files.events: ${what} usage adjust failed:`, err.message));
  }
}

/**
 * A deleted client, plus the attachments from their direct message thread.
 *
 * The thread's attachments are the one set with no file row behind them: they
 * live under a conversation prefix that no listing shows and no route can
 * delete, so nothing else would ever reach them. `userId` is the client's portal
 * uid, which is what the conversation folder is keyed on; a client who never had
 * portal access has none and so has no thread to sweep.
 */
eventBus.on(CLIENT_DELETED, async ({ lawFirmId, userId }: any) => {
  // The client's own documents were removed by the delete request itself
  // (`files/cascadeSweep.ts`). What is left here is the conversation prefix,
  // which has no rows to snapshot.
  if (!userId) return;
  const conversationPrefix = `${BASE_FOLDER}/${lawFirmId}/messaging/${lawFirmId}_${userId}/`;
  try {
    await sweepPrefix('CLIENT_DELETED', lawFirmId, conversationPrefix, { charged: true });
  } catch (err: any) {
    console.error('files.events: CLIENT_DELETED conversation sweep failed:', err.message);
  }
});

/**
 * A deleted firm. Every file row goes with the `law_firms` cascade, so this only
 * removes the bytes. No usage adjustment: the firm row that would carry the
 * figure is gone too.
 */
eventBus.on(LAWFIRM_DELETED, async ({ lawFirmId }: any) => {
  try {
    await sweepPrefix('LAWFIRM_DELETED', lawFirmId, `${BASE_FOLDER}/${lawFirmId}/`, { charged: false });
  } catch (err: any) {
    console.error('files.events: LAWFIRM_DELETED handler failed:', err.message);
  }
});

/**
 * A document (or folder) was shared with one or more clients. Buffer the share
 * and let the debounce coalesce a per-client digest (in-app bell + email), so a
 * burst of shares becomes one notification instead of one per file.
 */
eventBus.on(FILE_SHARED, async (payload: any) => {
  try {
    await shareNotifications.onFileShared(payload);
  } catch (err: any) {
    console.error('files.events: FILE_SHARED handler failed:', err.message);
  }
});

// Recover any digests left buffered by a previous process (restart between a
// share being enqueued and its debounce firing).
shareNotifications.startupSweep();

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
