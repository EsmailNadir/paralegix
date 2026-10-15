/**
 * How long to wait before the next status read of a job that runs elsewhere.
 *
 * Quick at first, for the job that finishes in a second or two, then settling
 * at one read every ten seconds for the one that takes minutes. A fixed
 * one-second poll is sixty requests a minute from every waiting tab, for a
 * status that changes once.
 */
export const POLL_STEPS_MS = [1000, 2000, 5000] as const;

/** The delay every read after the stepped ones waits. */
export const POLL_MAX_MS = 10_000;

/** The delay before read number `attempt`, counting from zero. */
export function pollDelay(attempt: number): number {
  return POLL_STEPS_MS[attempt] ?? POLL_MAX_MS;
}
