/**
 * The worker behind durable signing work.
 *
 * Two operations do not fit in a request: preparation hashes a whole document,
 * and finalization seals two artifacts. Running them inside the request that
 * triggers them puts the work in one process's memory, and Cloud Run stops
 * scheduling CPU once the response is sent, so "return early and finish in the
 * background" does not finish. A killed instance leaves a session half
 * processed with nothing recording that anything is owed.
 *
 * So the work is a ROW, and this is what picks the row up. Three things make
 * that safe, and each of them is the fix for a specific way it goes wrong:
 *
 * THE LEASE. A worker claims a job with a token and an expiry, and every write
 * afterwards re-checks that token. A worker that stalls past its expiry loses
 * the job, and its later writes are refused rather than landing on top of its
 * replacement's. Without this, both workers publish, and the session ends with
 * two artifact sets and two completion emails.
 *
 * THE SLOT. One PDF operation at a time per instance. The container is 512 MiB
 * at concurrency 80, so a drain that claimed jobs as fast as it could find them
 * would run several documents through one budget. The slot is taken BEFORE the
 * claim, so a busy instance does not hold a lease it cannot act on.
 *
 * THE DEADLINE. The drain stops with time to spare rather than being cut off
 * mid-operation, so the last job it starts can finish and the rest stay queued
 * with their attempt counts intact.
 */
import { AppError } from '../../shared/errors/AppError';

const { withTransferSlot } = require('../../shared/utils/transferSlot');
const { trackBackgroundWrite } = require('../../shared/utils/backgroundWrites');
const repo = require('./signatures.repository');

/**
 * How long a claim is good for, and how often it is renewed.
 *
 * The renewal interval is half the lease on purpose: one missed renewal, from a
 * slow query or a paused event loop, must not lose a job that is otherwise
 * making progress.
 */
export const LEASE_SECONDS = Number(process.env.SIGNING_JOB_LEASE_SECONDS) || 60;
const RENEW_MS = Math.floor((LEASE_SECONDS * 1000) / 2);

/**
 * The drain's own budget, well inside Cloud Run's 3600 second request ceiling.
 *
 * It is deliberately NOT the ordinary cron helper's budget. That one is sized
 * for many small per-firm passes; this one holds an open request while a
 * document is sealed, and copying the shorter number here would cut jobs off
 * partway on every run.
 */
export const DRAIN_BUDGET_MS = Number(process.env.SIGNING_JOB_DRAIN_BUDGET_MS) || 25 * 60 * 1000;

/**
 * How long one job may take before the drain refuses to start another.
 *
 * A job started with less than this left would be cut off by the deadline, and
 * a job cut off partway has burned an attempt for nothing.
 */
const JOB_HEADROOM_MS = Number(process.env.SIGNING_JOB_HEADROOM_MS) || 5 * 60 * 1000;

/** Attempts before a failure stops being retried. */
export const MAX_ATTEMPTS = Number(process.env.SIGNING_JOB_MAX_ATTEMPTS) || 6;

/**
 * Run `work` holding this instance's transfer slot.
 *
 * The SAME slot the folder-export drain uses, not a second one of the same
 * shape. Sealing a document and streaming an archive are both bounded per
 * instance for one reason, the 512 MiB container, and two limiters with the
 * same setting do not share a budget: they each take it in full, so an instance
 * doing both is doing twice what either was sized for.
 */
export function withPdfSlot<T>(
  work: () => Promise<T>,
  options: { queueTimeoutMs?: number } = {},
): Promise<T> {
  return withTransferSlot(work, options);
}

/**
 * Refusals that will fail the same way every time.
 *
 * Retrying one of these costs an attempt, a slot and a log line, and cannot
 * succeed: the document is what it is. They settle the job immediately so a
 * person sees the real reason instead of six identical failures.
 */
const PERMANENT_CODES = new Set([
  'PDF_INVALID',
  'PDF_ENCRYPTED',
  'PDF_EXISTING_SIGNATURE',
  'PDF_UNSUPPORTED_FORM',
  'PDF_RESOURCE_LIMIT',
  'FILE_TOO_LARGE',
  'SOURCE_CHANGED',
  'PDF_IDENTITY_INVALID',
  'PDF_IDENTITY_MISMATCH',
  'JOB_KIND_UNKNOWN',
]);

/** Thrown by a handler that cannot succeed, whatever happens next. */
export class PermanentJobFailure extends AppError {
  constructor(message: string, code = 'JOB_PERMANENT_FAILURE') {
    super(message, 422, code);
  }
}

/**
 * Backoff between attempts.
 *
 * Doubling, capped, so a dependency that is briefly unavailable is retried
 * quickly and one that is down for an hour is not hammered.
 */
export function retryDelaySeconds(attempt: number): number {
  const base = 30 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 15 * 60);
}

/** What a handler is given: the job, plus the two things it must not assume. */
export interface JobContext {
  /** Record a durable phase output. False means the lease is gone. */
  checkpoint(phase: string, state: unknown): Promise<boolean>;
  /** Whether this worker still holds the job. Check before publishing. */
  leaseHeld(): boolean;
  /**
   * Run `work` after this job has given its transfer slot back.
   *
   * For steps that are owed once the job has done its part but are not PDF
   * work: completion emails wait on a mail provider, and holding a slot through
   * that wait is what queued other signers past their request deadline. The
   * work runs in this same process, whatever the job's own outcome, because by
   * the time it is registered the step that makes it owed has already landed.
   */
  afterSlot(work: () => Promise<void>): void;
}

export type JobHandler = (job: any, context: JobContext) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/**
 * Register the handler for a job kind.
 *
 * Registration is explicit rather than a switch here, because the two kinds
 * live in different modules and importing both from this one would pull the
 * whole signing graph into every process that runs the drain.
 */
export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

/** Work every drain does after its jobs, registered the same way handlers are. */
const drainSweeps: Array<(options: { deadline: number }) => Promise<unknown>> = [];

/**
 * Register a step every drain runs once its job loop stops.
 *
 * For work that is owed outside any job row: a completed session whose copies
 * were never sent is the case it exists for. The step runs whether the loop
 * emptied the queue or stopped on a busy slot, because neither says anything
 * about it, and a failure in it is logged and never fails the drain.
 */
export function registerDrainSweep(sweep: (options: { deadline: number }) => Promise<unknown>): void {
  if (!drainSweeps.includes(sweep)) drainSweeps.push(sweep);
}

/** The handler for a kind, so a caller can put a replaced one back. */
export function jobHandlerFor(kind: string): JobHandler | undefined {
  return handlers.get(kind);
}

/**
 * Run one job to settlement.
 *
 * The lease is renewed on a timer for as long as the handler runs, and the
 * timer is cleared in a `finally`: a renewal loop left running would keep a
 * job alive that nobody is working on, which is worse than losing it, because
 * nothing else can claim it either.
 */
async function runJob(
  job: any,
  deferred: Array<() => Promise<void>> = [],
): Promise<'succeeded' | 'failed' | 'retry' | 'lost'> {
  let held = true;
  const renew = setInterval(() => {
    repo.renewProcessingLease(job.id, job.leaseToken, LEASE_SECONDS)
      .then((ok: boolean) => { if (!ok) held = false; })
      .catch(() => { /* a missed renewal is not proof the lease is gone */ });
  }, RENEW_MS);
  if (typeof renew.unref === 'function') renew.unref();

  const context: JobContext = {
    async checkpoint(phase: string, state: unknown) {
      const ok = await repo.checkpointProcessingJob(job.id, job.leaseToken, phase, state);
      if (!ok) held = false;
      return ok;
    },
    leaseHeld: () => held,
    afterSlot: (work) => { deferred.push(work); },
  };

  try {
    const handler = handlers.get(job.kind);
    if (!handler) {
      // Not a retryable condition: a kind nobody handles will still have nobody
      // handling it in thirty seconds, and a queued job nothing consumes is
      // invisible work that never completes.
      throw new PermanentJobFailure(`No handler is registered for a "${job.kind}" job.`, 'JOB_KIND_UNKNOWN');
    }
    await handler(job, context);
    const settled = await repo.completeProcessingJob(job.id, job.leaseToken);
    return settled ? 'succeeded' : 'lost';
  } catch (err: any) {
    const code = String(err?.code || 'JOB_FAILED');
    const permanent = err instanceof PermanentJobFailure
      || PERMANENT_CODES.has(code)
      || job.attempt >= MAX_ATTEMPTS;
    const settled = await repo.failProcessingJob(job.id, job.leaseToken, {
      code,
      detail: String(err?.message || err),
      retryInSeconds: permanent ? null : retryDelaySeconds(job.attempt),
    });
    if (!settled) return 'lost';
    if (permanent) {
      console.error(
        `[signing:jobs:dead_letter] ${job.kind} job ${job.id} failed permanently on attempt ${job.attempt}: ${code} (${err?.message || err})`,
      );
    } else {
      console.warn(
        `[signing:jobs] ${job.kind} job ${job.id} attempt ${job.attempt} failed: ${code} (${err?.message || err})`
        + ` [retry in ${retryDelaySeconds(job.attempt)}s]`,
      );
    }
    return permanent ? 'failed' : 'retry';
  } finally {
    clearInterval(renew);
  }
}

/**
 * Claim and run one named job in the caller's own request.
 *
 * This is the fast path for work small enough to finish while someone waits. It
 * goes through the same claim and the same lease as the drain, so the two can
 * never both be inside one job. If the claim fails the job is already someone
 * else's and the caller polls instead.
 */
export async function runJobNow(
  lawFirmId: string,
  jobId: string,
  owner: string,
  options: {
    /**
     * How long to wait for a transfer slot, replacing the slot's default. A
     * value that is not positive means there is no time left to wait at all,
     * so the job is reported `busy` without queueing or claiming.
     */
    queueTimeoutMs?: number;
    /**
     * Take over what the job deferred until after its slot, instead of having it
     * awaited here. Called exactly once, with a runner that never throws.
     *
     * A request passes this so it can answer FIRST and run the deferred steps
     * afterwards: awaited here, a slow mail provider sat between a finished
     * document and the signer's response, and could push it past the request
     * deadline. Omitted, the steps are awaited before this returns, as before.
     */
    deferAfterSlot?: (run: () => Promise<void>) => void;
  } = {},
) {
  if (options.queueTimeoutMs !== undefined && !(Number(options.queueTimeoutMs) > 0)) {
    return 'busy' as const;
  }
  const deferred: Array<() => Promise<void>> = [];
  try {
    return await withPdfSlot(async () => {
      const job = await repo.claimProcessingJobById(lawFirmId, jobId, owner, LEASE_SECONDS);
      if (!job) return 'busy' as const;
      return runJob(job, deferred);
    }, { queueTimeoutMs: options.queueTimeoutMs });
  } catch (err: any) {
    if (err?.code !== 'CONCURRENCY_QUEUE_TIMEOUT') throw err;
    // Every slot on this instance is taken and the queue deadline passed. That
    // is `busy`, which is what the caller already means by it: the job is
    // committed, it is still owed, and the page polls until a worker gets to it.
    //
    // Left to throw, this answered the signer 500. Their consent was committed
    // in the same transaction as the job, so the document was already going to
    // be produced, and they were looking at an error saying it had failed. The
    // obvious next move from there is to sign again.
    console.warn(`[signing] Job ${jobId} could not start: every transfer slot is busy.`);
    return 'busy' as const;
  } finally {
    if (options.deferAfterSlot) options.deferAfterSlot(() => runDeferred(deferred));
    else await runDeferred(deferred);
  }
}

/**
 * Run what a job deferred until after its slot, each step on its own.
 *
 * Never throws: the job is already settled, and a failed email must neither
 * undo that nor stop the next step.
 */
async function runDeferred(deferred: Array<() => Promise<void>>): Promise<void> {
  for (const work of deferred) {
    try {
      // eslint-disable-next-line no-await-in-loop -- in registration order, one at a time
      await work();
    } catch (err: any) {
      console.error('[signing:jobs] Deferred step failed after the job settled:', err?.message || err);
    }
  }
}

export interface DrainReport {
  succeeded: number;
  failed: number;
  retried: number;
  /** Claims that were taken away before they settled. */
  lost: number;
  remaining: number;
  /** True when the drain stopped on its deadline rather than on an empty queue. */
  truncated: boolean;
}

/**
 * Work the queue until it is empty or the budget runs out.
 *
 * The PDF slot is taken BEFORE the claim, so an instance that is already busy
 * waits without holding a lease. A job claimed and then parked behind a slot is
 * a job nobody else can take while nothing is happening to it.
 */
export async function drainSigningJobs(options: {
  owner: string;
  deadline?: number;
  maxJobs?: number;
} ): Promise<DrainReport> {
  const { owner } = options;
  const deadline = options.deadline ?? (Date.now() + DRAIN_BUDGET_MS);
  const maxJobs = options.maxJobs ?? Number.MAX_SAFE_INTEGER;

  const report: DrainReport = {
    succeeded: 0, failed: 0, retried: 0, lost: 0, remaining: 0, truncated: false,
  };

  let handled = 0;
  for (;;) {
    if (handled >= maxJobs) break;
    if (Date.now() + JOB_HEADROOM_MS >= deadline) {
      report.truncated = true;
      break;
    }

    let outcome;
    const deferred: Array<() => Promise<void>> = [];
    try {
      // eslint-disable-next-line no-await-in-loop -- one job at a time is the point
      outcome = await withPdfSlot(async () => {
        const job = await repo.claimProcessingJob(owner, LEASE_SECONDS);
        if (!job) return null;
        return { job, result: await runJob(job, deferred) };
      });
    } catch (err: any) {
      if (err?.code !== 'CONCURRENCY_QUEUE_TIMEOUT') throw err;
      // A request-driven finalize holds this instance's slot. That is the slot
      // working as intended, not a fault: the drain stops and reports what it
      // did not reach, rather than failing the whole run. The jobs it left are
      // still queued with their attempt counts untouched.
      report.truncated = true;
      break;
    } finally {
      // After the slot is released and before the next claim, so the delivery
      // a job owes is never held up behind another job's PDF work.
      // eslint-disable-next-line no-await-in-loop
      await runDeferred(deferred);
    }
    if (!outcome) break;

    handled += 1;
    if (outcome.result === 'succeeded') report.succeeded += 1;
    else if (outcome.result === 'failed') report.failed += 1;
    else if (outcome.result === 'retry') report.retried += 1;
    else report.lost += 1;
  }

  for (const sweep of drainSweeps) {
    if (Date.now() >= deadline) break;
    try {
      // eslint-disable-next-line no-await-in-loop -- in registration order
      await sweep({ deadline });
    } catch (err: any) {
      console.error('[signing:jobs] Drain sweep failed:', err?.message || err);
    }
  }

  report.remaining = await repo.countReadyProcessingJobs();
  return report;
}

/** The one background drain loop this instance may run, while it runs. */
let backgroundDrain: Promise<void> | null = null;
/** Set when a kick arrives during a loop, so the loop takes one more pass. */
let drainRequested = false;

/**
 * Start draining the queue on this instance, without waiting for it.
 *
 * A completion answered `processing` because every transfer slot was busy has
 * committed its job, and until now only the per-minute cron picked it up, one
 * job at a time. After a burst of signers that left the last of them waiting
 * minutes for a document this instance could have produced as soon as a slot
 * freed.
 *
 * Bounded in both directions that matter. It is the ordinary drain, so every
 * job it runs holds a transfer slot like any other: it never adds PDF work
 * beyond what the slot allows. And there is at most ONE loop per instance: a
 * kick that arrives while one is running asks it for another pass rather than
 * starting a second loop, so fifty busy answers cost one drain, not fifty.
 *
 * Never rejects. A failure is logged and the cron, which is unchanged, picks up
 * whatever this did not reach. The returned promise is for tests; callers do
 * not await it.
 */
export function kickSigningDrain(owner: string): Promise<void> {
  drainRequested = true;
  if (backgroundDrain) return backgroundDrain;

  backgroundDrain = (async () => {
    try {
      while (drainRequested) {
        drainRequested = false;
        // eslint-disable-next-line no-await-in-loop -- one loop, by design
        await drainSigningJobs({ owner });
      }
    } catch (err: any) {
      console.error('[signing:jobs] Background signing drain failed:', err?.message || err);
    } finally {
      drainRequested = false;
      backgroundDrain = null;
    }
  })();
  return trackBackgroundWrite(backgroundDrain);
}
