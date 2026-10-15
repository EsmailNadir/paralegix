/**
 * Task rules that are not about presentation. How a task's status and priority
 * *render* lives in `@/constants/statusMeta` alongside every other status
 * vocabulary in the app.
 */

/**
 * How far back an "overdue" view reaches, in days before today.
 *
 * Mirrors `DIGEST_OVERDUE_FLOOR_DAYS` in
 * `backend/src/modules/notifications/digest/digest.repository.js`. The daily
 * digest counts and lists overdue work only back to that floor, and its
 * "+N more" links open the tasks list; if the list reached further back it would
 * show a long tail of abandoned work the email deliberately excluded, so a
 * "+6 more" link would land on a page with far more than six extra rows. The two
 * values are one decision and must move together.
 */
export const OVERDUE_FLOOR_DAYS = 30;

/** Shape of the task fields the timer rules read. */
type TaskTimerSource = {
  matterId?: string | null;
  matterName?: string | null;
  clientIds?: string[] | null;
  clientNames?: string[] | null;
};

/**
 * Where a timer started straight from a task bills, and what the running timer
 * is labelled with: the task's matter, else its one client, else nothing.
 *
 * Time bills to exactly one matter or one client, so a task needs an unambiguous
 * one. A task with no matter and no single client has no target: starting a timer
 * on it would run with nothing behind it and only surface the problem after the
 * time had accrued. Those tasks go through Log Time instead, whose modal can ask
 * where the time belongs while keeping the link back to the task.
 *
 * The label is the matter or client name the task carries beside its ids, so
 * naming the timer needs no firm-wide matter or client list. A missing name
 * leaves `label` null and the caller falls back to the task title.
 *
 * Shared by the tasks grid and the task detail page so both gate and label on
 * the same rule.
 */
export const taskTimerTarget = (
  task: TaskTimerSource,
): { matterId: string | null; clientId: string | null; label: string | null } | null => {
  if (task.matterId) {
    return { matterId: task.matterId, clientId: null, label: task.matterName || null };
  }
  if (task.clientIds?.length === 1) {
    return { matterId: null, clientId: task.clientIds[0], label: task.clientNames?.[0] || null };
  }
  return null;
};

/** Whether a timer can be started straight from a task; see `taskTimerTarget`. */
export const canStartTimerForTask = (task: TaskTimerSource): boolean => taskTimerTarget(task) !== null;

/** Why Start Timer is unavailable on a task without a target, pointing at the fallback. */
export const NO_TIMER_TARGET_HINT = "No matter or single client to bill against. Use Log time to pick one.";
