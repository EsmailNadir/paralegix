/**
 * Times an async database read and logs the ones that miss their budget.
 *
 * Exists because the reads whose cost grows with a firm's HISTORY rather than
 * with the page — the billing report aggregates above all — are invisible until
 * someone complains. A log line carrying the firm id is what turns "the reports
 * feel slow" into a number a decision can be made on.
 *
 * Deliberately not a metrics pipeline: this app has no metrics backend, and the
 * question being answered ("is this over budget, and on which firms") is answered
 * by structured log lines just as well.
 */

/**
 * Milliseconds past which a read is worth a log line.
 *
 * Set at the response budget rather than at "slow", so a line appearing means the
 * budget was missed — not that a query was merely unhurried.
 */
export const SLOW_READ_MS = Number(process.env.SLOW_READ_LOG_MS || 1000);

/**
 * Run `run`, returning its result untouched, and log if it took too long.
 *
 * @param {string} label - stable identifier for the read, e.g. 'billing.report.byMatter'.
 * `context` is logged alongside the duration; include `lawFirmId`.
 */
export async function timedRead<T>(
  label: string,
  context: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    return await run();
  } finally {
    // In `finally` so a read that fails slowly is logged too: a query that times
    // out is exactly the one worth knowing about.
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs >= SLOW_READ_MS) {
      console.warn('[slow-read]', JSON.stringify({
        label,
        durationMs: Math.round(durationMs),
        ...context,
      }));
    }
  }
}
