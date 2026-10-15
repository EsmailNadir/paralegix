/**
 * Frontend mirror of the backend matter-status classification
 * (`backend/src/shared/constants/matterStatus.js`). Keep the two in sync.
 *
 * `matters.status` is constrained by a DB CHECK and a Zod enum on the backend;
 * these lists are the *classification* of that vocabulary: which statuses mean a
 * matter is closed, and which mean it is terminal (closed plus archived).
 */

/** Statuses that count as a "closed" matter. */
export const CLOSED_MATTER_STATUSES: readonly string[] = ["completed", "closed"];

/**
 * Statuses considered terminal/inactive (closed plus archived). A matter in any of
 * these is functionally done, so prompts to close it are suppressed and the
 * "payment ongoing" signal becomes meaningful.
 */
export const TERMINAL_MATTER_STATUSES: readonly string[] = [...CLOSED_MATTER_STATUSES, "archived"];

/** True when a matter's status means it is already done. */
export function isTerminalMatterStatus(status?: string | null): boolean {
  return !!status && TERMINAL_MATTER_STATUSES.includes(status);
}
