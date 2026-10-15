const eventBus = require('../../shared/events/eventBus');
const { MATTER_DELETED, TASK_DELETED } = require('../../shared/events/eventTypes');
const tasksRepo = require('./tasks.repository');
const { runWithConcurrency } = require('../../shared/utils/runWithConcurrency');

/**
 * When a matter is deleted, clean up its tasks. The tasks.matter_id FK is
 * ON DELETE CASCADE (`schema.sql:433`), not set-null, so the DB itself removes
 * every matter-scoped task row when the parent `matters` row is deleted; there are no
 * orphaned firm tasks to worry about.
 *
 * Ordering: matters.service deletes the `matters` row (cascading the task rows) when
 * emitting MATTER_DELETED, so the task rows and their GCS attachment paths are
 * gone by the time this handler runs. To clean up those attachments the producer
 * captures the matter's tasks BEFORE the delete and passes them on the event as
 * `tasks`. We use that snapshot when present; otherwise we fall back to a
 * post-cascade `findByMatter` (which returns [] in the normal path, a safe no-op).
 *
 * The legacy MATTER_MEMBERS_UPDATED / MATTER_CLIENTS_UPDATED handlers were removed:
 * task visibility and client lists are now derived from matter_members /
 * matter_clients at read time, so there is nothing to re-sync.
 */
eventBus.on(MATTER_DELETED, async ({ lawFirmId, matterId, matterData, userId: deletedByUserId, tasks: preDeleteTasks }: any) => {
  try {
    const tasks = Array.isArray(preDeleteTasks)
      ? preDeleteTasks
      : await tasksRepo.findByMatter(lawFirmId, matterId);
    if (tasks.length === 0) return;

    // Wait for each task's calendar and notification cleanup, with bounded
    // fan-out so a large matter does not exhaust the shared connection pool.
    // No `files` snapshot on these. The matter's own delete already snapshotted
    // every document under it, INCLUDING the ones tagged with these tasks, and
    // MATTER_DELETED sweeps them. Snapshotting again here would be too late (the
    // cascade has run) and, if it were not, would double-credit the bytes.
    await runWithConcurrency(tasks.map((task: any) => () => eventBus.emitAsync(TASK_DELETED, {
      lawFirmId,
      taskId: task.id,
      entityData: task,
      userId: task.createdBy || deletedByUserId || null,
      recipientUserIds: matterData?.memberUserIds || [],
    })), 3);
    await tasksRepo.batchDelete(lawFirmId, tasks.map((t: any) => t.id));
  } catch (err) {
    console.error('tasks.events: MATTER_DELETED handler failed:', err);
  }
});

// This module only registers listeners; it exports nothing. The empty
// export marks it as a MODULE so its top-level consts are file-scoped
// rather than colliding in the global scope with every other events file.
export {};
