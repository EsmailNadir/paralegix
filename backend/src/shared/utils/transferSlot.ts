/**
 * How many heavy transfers run at once, per instance.
 *
 * Two things in this app move whole documents: signing seals PDFs, and a folder
 * export streams an archive. They are bounded TOGETHER, because they share one
 * container.
 *
 * THIS WAS 1, AND THE REASON NO LONGER HOLDS. It was set when completing a
 * signature ran five whole-document passes through pdf-lib, so two at once
 * genuinely put two documents in one 512 MiB allocation. The signing pipeline
 * appends now: it resolves the page it stamps through bounded windows and lets
 * storage join the parts, so it never holds the document at all.
 *
 * Measured on 2026-09-09 with `scripts/run-signing-benchmark.sh`, inside a real
 * 512 MiB container, over 100 MiB documents. The figure is the memory the
 * signing work adds ON TOP of the idle process:
 *
 *     concurrent    1      2      4      6      8     12     24     48
 *     added         32     33     29     30     32     35     30     39  MiB
 *
 * Forty-eight at once cost 39 MiB. The working set per operation is kilobytes,
 * so concurrency buys almost no memory. Six concurrent 500 MiB documents cost
 * 33 MiB, so document size does not change it either.
 *
 * WHAT BOUNDS IT NOW IS CPU. The container has one vCPU shared with 80
 * concurrent requests, and this work is CPU-bound while it hashes and parses.
 * Three leaves most of the core for ordinary requests while letting a
 * request-driven finalize and the cron drain proceed at the same time, which at
 * 1 they could not: whichever arrived second waited, and the drain reported
 * itself truncated.
 *
 * Note that this does NOT make the drain parallel. `drainSigningJobs` claims and
 * runs one job at a time by design; raising this lets its job overlap a
 * request's, not several drain jobs overlap each other.
 *
 * The cap is per instance, like the document converter's, so total concurrency
 * is this times the instance count.
 *
 * The queue deadline matters as much as the cap. Without it, a backlog stops
 * being a backlog of work and becomes a backlog of held-open leases: every
 * waiter is a worker that already claimed a job and cannot act on it. A caller
 * whose turn never comes is told so and puts the job back.
 *
 * Take the slot BEFORE claiming a job, never after. A job claimed and then
 * parked behind a slot is a job nobody else can take while nothing is happening
 * to it.
 */
const { createLimiter } = require('./runWithConcurrency');

/** Exported so a caller can report the ceiling, and a test can assert it holds. */
export const SLOT_CONCURRENCY = Number(process.env.TRANSFER_SLOT_CONCURRENCY)
  || Number(process.env.SIGNING_PDF_SLOT_CONCURRENCY)
  || 3;

const SLOT_QUEUE_TIMEOUT_MS = Number(process.env.TRANSFER_SLOT_TIMEOUT_MS)
  || Number(process.env.SIGNING_PDF_SLOT_TIMEOUT_MS)
  || 60_000;

const SLOT = createLimiter(SLOT_CONCURRENCY, { queueTimeoutMs: SLOT_QUEUE_TIMEOUT_MS });

export interface TransferSlotOptions {
  /**
   * How long THIS call may wait for a slot, replacing the default above. A
   * caller answering a request passes what is left of the request's deadline,
   * so a backlog becomes a timely "busy" rather than a 504.
   */
  queueTimeoutMs?: number;
}

/** Run `work` holding this instance's transfer slot. */
export function withTransferSlot<T>(
  work: () => Promise<T>,
  options: TransferSlotOptions = {},
): Promise<T> {
  return SLOT(work, options);
}
