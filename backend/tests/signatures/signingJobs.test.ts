/**
 * Durable signing work, and the two workers that must not both finish it.
 *
 * Preparation hashes a whole document and finalization seals two artifacts.
 * Both used to run inside the request that triggered them, which put the work
 * in one process's memory: kill the instance and the session was left half
 * processed with nothing recording that anything was owed. Cloud Run also stops
 * scheduling CPU once a response is sent, so "finish it in the background" does
 * not finish.
 *
 * The work is a row now. What the tests below are actually about is the LEASE,
 * because the failure it prevents is invisible: two workers inside one job both
 * publish, and the session ends up with two artifact sets, two quota charges
 * and two completion emails. Nothing errors. So every test here names a worker
 * that should NOT be able to write, and proves it cannot.
 */
import crypto from 'crypto';
import { objects, putObject } from '../support/inMemoryBucket';
import { minimalPdfBytes } from '../support/minimalPdf';
import { createFirm, ownerOf, type Actor, type Firm } from '../support/setupInProcess';
import { installRichBucket, resetRichBucket } from '../files/richBucket';
import { testPool } from '../support/db';

installRichBucket();

const repo = require('../../src/modules/signatures/signatures.repository');
const {
  drainSigningJobs,
  runJobNow,
  registerJobHandler,
  jobHandlerFor,
  retryDelaySeconds,
  withPdfSlot,
  PermanentJobFailure,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
} = require('../../src/modules/signatures/signingJobs');
const { admitStoredUpload } = require('../../src/modules/signatures/signingSources');

let firm: Firm;
let owner: Actor;

/**
 * The handler `signingSources` registers when it loads.
 *
 * Most tests here replace it to watch the machinery rather than the work. The
 * registry is module state, so it is put back afterwards: a later spec in the
 * same process would otherwise run with a stub, or with none at all.
 */
let realPrepareHandler: any;
beforeAll(() => { realPrepareHandler = jobHandlerFor('prepare'); });

/** An admitted source, which is what a job has to point at. */
async function admittedSource(body = minimalPdfBytes()) {
  const objectPath = `signing-uploads/${firm.id}/${crypto.randomUUID()}/agreement.pdf`;
  putObject(objectPath, { body, contentType: 'application/pdf', custom: { uploadedBy: owner.uid } });
  return admitStoredUpload({
    lawFirmId: firm.id,
    uploadedBy: owner.uid,
    objectPath,
    maxSizeBytes: 20 * 1024 * 1024,
  });
}

/** Move a job's lease into the past, which is what a dead worker leaves behind. */
async function expireLease(jobId: string) {
  await testPool.query(
    `update signature_processing_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
    [jobId],
  );
}

beforeEach(async () => {
  resetRichBucket();
  // The claim is global by design: a drain takes the next ready job whoever owns
  // it. So a job one test leaves queued is a job the next test's drain picks up,
  // and the failure looks like the code under test doing the wrong thing.
  await testPool.query('delete from signature_processing_jobs');
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  registerJobHandler('prepare', realPrepareHandler);
});

describe('committing work', () => {
  it('commits a preparation job with the admission that owes it', async () => {
    // A job enqueued after the response is on its way is lost by a process that
    // dies in between, and the source then sits pending for ever.
    const source = await admittedSource();

    const job = await repo.getProcessingJob(firm.id, source.jobId);

    expect(job.kind).toBe('prepare');
    expect(job.status).toBe('queued');
    expect(job.sourceId).toBe(source.id);
    // Pinned to the generation admission inspected, not to "whatever is there".
    expect(job.inputRevision).toBe(source.objectGeneration);
  });

  it('refuses a SECOND live job for the same logical operation', async () => {
    // Two finalize jobs for one session each seal, publish and notify.
    const source = await admittedSource();

    const again = await repo.enqueueProcessingJob(firm.id, {
      sourceId: source.id, kind: 'prepare', inputRevision: source.objectGeneration,
    });

    expect(again.id).toBe(source.jobId);
    const { rows } = await testPool.query(
      `select count(*)::int as n from signature_processing_jobs where source_id = $1`, [source.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('keeps ONE live finalize job per session', async () => {
    // Two live finalize jobs for one session would each seal, publish and
    // notify, and the session would end with two artifact sets, two quota
    // charges and two completion emails. `session_id` is still nullable, for
    // preparations, so the index coalesces it: Postgres treats two NULLs as
    // distinct, and without the coalesce the key would silently not hold for
    // exactly the rows that carry one.
    const { rows } = await testPool.query(
      `insert into signature_sessions (token, law_firm_id, source_id, status, expires_at)
       values ($1, $2, (select id from signature_sources where law_firm_id = $2 order by created_at limit 1), 'in_progress', now() + interval '30 days')
       returning id, source_id`,
      [crypto.randomBytes(12).toString('hex'), firm.id],
    );

    const commit = () => repo.enqueueProcessingJob(firm.id, {
      sessionId: rows[0].id, sourceId: rows[0].source_id, kind: 'finalize',
    });
    const first = await commit();
    const second = await commit();

    // A finalize job says which session's artifacts it produces AND which
    // document it reads. Both are NOT NULL: a job that cannot answer either
    // question sits in the queue failing for a reason no column states.
    expect(first).toMatchObject({ kind: 'finalize', sourceId: rows[0].source_id });
    expect(second.id).toBe(first.id);
    const { rows: counted } = await testPool.query(
      `select count(*)::int as n from signature_processing_jobs where session_id = $1`,
      [rows[0].id],
    );
    expect(counted[0].n).toBe(1);
  });

  it('REFUSES a job with no source and a finalization with no session', async () => {
    // Each kind names the thing it acts on. `source_id` is NOT NULL, so a job
    // of either kind must name its document; the CHECK adds that a finalization
    // must also name its session.
    await expect(repo.enqueueProcessingJob(firm.id, { kind: 'prepare' }))
      .rejects.toThrow(/Failed query/);
    const source = await admittedSource();
    await expect(repo.enqueueProcessingJob(firm.id, {
      sourceId: source.id, kind: 'finalize',
    })).rejects.toThrow(/Failed query/);
  });

  it('allows a fresh job once the first one settled', async () => {
    // The live-operation index excludes settled rows, so a permanent failure
    // can still be retried deliberately.
    const source = await admittedSource();
    registerJobHandler('prepare', async () => { throw new PermanentJobFailure('no'); });
    await runJobNow(firm.id, source.jobId, 'worker-a');

    const fresh = await repo.enqueueProcessingJob(firm.id, {
      sourceId: source.id, kind: 'prepare', inputRevision: source.objectGeneration,
    });

    expect(fresh.id).not.toBe(source.jobId);
  });
});

describe('the lease', () => {
  it('gives one job to exactly one of two workers', async () => {
    await admittedSource();
    registerJobHandler('prepare', async () => {});

    const first = await repo.claimProcessingJob('worker-a', LEASE_SECONDS);
    const second = await repo.claimProcessingJob('worker-b', LEASE_SECONDS);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('REFUSES a checkpoint from a worker whose lease was taken away', async () => {
    // The failure this prevents. A stalled worker that wakes up and writes on
    // top of its replacement is how one session gets two artifact sets.
    const source = await admittedSource();
    const stalled = await repo.claimProcessingJob('worker-a', LEASE_SECONDS);
    await expireLease(stalled.id);
    const replacement = await repo.claimProcessingJob('worker-b', LEASE_SECONDS);

    const stale = await repo.checkpointProcessingJob(stalled.id, stalled.leaseToken, 'sealed', { a: 1 });
    const live = await repo.checkpointProcessingJob(replacement.id, replacement.leaseToken, 'sealed', { b: 2 });

    expect(stale).toBe(false);
    expect(live).toBe(true);
    expect(replacement.id).toBe(stalled.id);
    expect((await repo.getProcessingJob(firm.id, source.jobId)).phaseState).toEqual({ b: 2 });
  });

  it('REFUSES a completion from a worker whose lease was taken away', async () => {
    await admittedSource();
    const stalled = await repo.claimProcessingJob('worker-a', LEASE_SECONDS);
    await expireLease(stalled.id);
    await repo.claimProcessingJob('worker-b', LEASE_SECONDS);

    expect(await repo.completeProcessingJob(stalled.id, stalled.leaseToken)).toBe(false);
  });

  it('reclaims a job whose worker died holding it', async () => {
    // Without this the job is stuck: `leased` for ever, and no poll returns it.
    await admittedSource();
    const dead = await repo.claimProcessingJob('worker-a', LEASE_SECONDS);
    await expireLease(dead.id);

    const taken = await repo.claimProcessingJob('worker-b', LEASE_SECONDS);

    expect(taken.id).toBe(dead.id);
    expect(taken.leaseToken).not.toBe(dead.leaseToken);
    // The attempt counter rises on the CLAIM, not the failure, so a worker that
    // dies silently cannot retry for ever.
    expect(taken.attempt).toBe(dead.attempt + 1);
  });

  it('renews only while the token still matches', async () => {
    await admittedSource();
    const held = await repo.claimProcessingJob('worker-a', LEASE_SECONDS);

    expect(await repo.renewProcessingLease(held.id, held.leaseToken, LEASE_SECONDS)).toBe(true);
    await expireLease(held.id);
    await repo.claimProcessingJob('worker-b', LEASE_SECONDS);
    expect(await repo.renewProcessingLease(held.id, held.leaseToken, LEASE_SECONDS)).toBe(false);
  });

  it('tells a handler its lease is gone, so it stops before publishing', async () => {
    const source = await admittedSource();
    let sawLease: boolean | null = null;
    registerJobHandler('prepare', async (job: any, context: any) => {
      await expireLease(job.id);
      await repo.claimProcessingJob('worker-b', LEASE_SECONDS);
      await context.checkpoint('half-done', {});
      sawLease = context.leaseHeld();
    });

    await runJobNow(firm.id, source.jobId, 'worker-a');

    expect(sawLease).toBe(false);
  });
});

describe('failing and retrying', () => {
  it('re-queues a retryable failure with a later attempt time', async () => {
    const source = await admittedSource();
    registerJobHandler('prepare', async () => { throw new Error('storage hiccup'); });

    const result = await runJobNow(firm.id, source.jobId, 'worker-a');
    const job = await repo.getProcessingJob(firm.id, source.jobId);

    expect(result).toBe('retry');
    expect(job.status).toBe('queued');
    expect(job.failureCode).toBe('JOB_FAILED');
    expect(new Date(job.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('does NOT retry a refusal that will fail the same way every time', async () => {
    // Retrying an encrypted PDF six times costs six slots and six log lines and
    // cannot succeed. The document is what it is.
    const source = await admittedSource();
    registerJobHandler('prepare', async () => {
      throw Object.assign(new Error('The trailer carries /Encrypt.'), { code: 'PDF_ENCRYPTED' });
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runJobNow(firm.id, source.jobId, 'worker-a');
      const job = await repo.getProcessingJob(firm.id, source.jobId);

      expect(result).toBe('failed');
      expect(job.status).toBe('failed');
      expect(job.failureCode).toBe('PDF_ENCRYPTED');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[signing:jobs:dead_letter]'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('gives up after the attempt ceiling instead of retrying for ever', async () => {
    const source = await admittedSource();
    registerJobHandler('prepare', async () => { throw new Error('still broken'); });

    let last = '';
    for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- attempts are sequential
      await testPool.query(
        `update signature_processing_jobs set next_attempt_at = now() - interval '1 second' where id = $1`,
        [source.jobId],
      );
      // eslint-disable-next-line no-await-in-loop
      last = await runJobNow(firm.id, source.jobId, 'worker-a');
      if (last === 'failed') break;
    }

    expect(last).toBe('failed');
    expect((await repo.getProcessingJob(firm.id, source.jobId)).status).toBe('failed');
  });

  it('keeps failed work for a person to look at', async () => {
    // The row is the only record that anything was ever owed. Deleting it makes
    // a failure indistinguishable from work nobody asked for.
    const source = await admittedSource();
    registerJobHandler('prepare', async () => { throw new PermanentJobFailure('cannot'); });

    await runJobNow(firm.id, source.jobId, 'worker-a');

    const job = await repo.getProcessingJob(firm.id, source.jobId);
    expect(job).not.toBeNull();
    expect(job.failureDetail).toContain('cannot');
  });

  it('backs off further on each attempt, up to a ceiling', async () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(3)).toBe(120);
    // Capped, so a dependency that is down for an hour is not hammered.
    expect(retryDelaySeconds(20)).toBe(900);
  });

  it('fails a job whose kind nothing handles, rather than queueing it for ever', async () => {
    // A queued job nothing consumes is invisible work that never completes.
    const source = await admittedSource();
    registerJobHandler('prepare', undefined as any);

    const result = await runJobNow(firm.id, source.jobId, 'worker-a');

    expect(result).toBe('failed');
    expect((await repo.getProcessingJob(firm.id, source.jobId)).failureCode).toBe('JOB_KIND_UNKNOWN');
  });
});

describe('cancellation', () => {
  it('invalidates a live lease, so the worker inside cannot publish', async () => {
    // Marking an intent is not enough. Clearing the token is what stops a
    // worker that is already halfway through from finishing.
    const source = await admittedSource();
    const working = await repo.claimProcessingJob('worker-a', LEASE_SECONDS);

    const cancelled = await repo.cancelProcessingJobs(firm.id, { sourceId: source.id });

    expect(cancelled).toBe(1);
    expect(await repo.completeProcessingJob(working.id, working.leaseToken)).toBe(false);
    expect((await repo.getProcessingJob(firm.id, source.jobId)).status).toBe('cancelled');
  });

  it('leaves settled work alone', async () => {
    const source = await admittedSource();
    registerJobHandler('prepare', async () => {});
    await runJobNow(firm.id, source.jobId, 'worker-a');

    expect(await repo.cancelProcessingJobs(firm.id, { sourceId: source.id })).toBe(0);
    expect((await repo.getProcessingJob(firm.id, source.jobId)).status).toBe('succeeded');
  });
});

describe('the drain', () => {
  it('works the queue until it is empty', async () => {
    const a = await admittedSource();
    const b = await admittedSource(minimalPdfBytes({ pages: 2 }));
    const ran: string[] = [];
    registerJobHandler('prepare', async (job: any) => { ran.push(job.sourceId); });

    const report = await drainSigningJobs({ owner: 'drain-1' });

    expect(report.succeeded).toBe(2);
    expect(report.remaining).toBe(0);
    expect(report.truncated).toBe(false);
    expect(ran.sort()).toEqual([a.id, b.id].sort());
  });

  it('counts each outcome in its own bucket when one drain meets all four', async () => {
    // The report is what the cron run logs and what an operator reads to tell
    // a dead letter from a hiccup. A drain that folded failures into retries,
    // or counted a job another worker took as a failure, would send someone to
    // chase the wrong problem.
    const ok = await admittedSource();
    const dead = await admittedSource(minimalPdfBytes({ pages: 2 }));
    const flaky = await admittedSource(minimalPdfBytes({ pages: 3 }));
    const stolen = await admittedSource(minimalPdfBytes({ pages: 4 }));
    registerJobHandler('prepare', async (job: any) => {
      if (job.sourceId === dead.id) throw new PermanentJobFailure('cannot be prepared');
      if (job.sourceId === flaky.id) throw new Error('storage hiccup');
      if (job.sourceId === stolen.id) {
        // Another worker now holds the lease, so this worker's completion
        // matches no row. The lease stays live, so the drain cannot reclaim it.
        await testPool.query(
          'update signature_processing_jobs set lease_token = gen_random_uuid() where id = $1',
          [job.id],
        );
      }
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let report;
    try {
      report = await drainSigningJobs({ owner: 'drain-1' });
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(report).toEqual({
      succeeded: 1, failed: 1, retried: 1, lost: 1, remaining: 0, truncated: false,
    });
    const statusOf = async (jobId: string) => (await repo.getProcessingJob(firm.id, jobId)).status;
    expect(await statusOf(ok.jobId)).toBe('succeeded');
    expect(await statusOf(dead.jobId)).toBe('failed');
    expect(await statusOf(flaky.jobId)).toBe('queued');
    expect(await statusOf(stolen.jobId)).toBe('leased');
  });

  it('stops on its deadline with the rest still queued', async () => {
    // A job started with no time left is cut off partway, which burns an
    // attempt for nothing.
    await admittedSource();
    registerJobHandler('prepare', async () => {});

    const report = await drainSigningJobs({ owner: 'drain-1', deadline: Date.now() + 1000 });

    expect(report.truncated).toBe(true);
    expect(report.succeeded).toBe(0);
    expect(report.remaining).toBe(1);
  });

  it('runs no more PDF operations at once than the slot allows', async () => {
    // The container is one vCPU and 512 MiB shared with 80 concurrent requests.
    // An UNBOUNDED number of these is the failure the slot exists to prevent,
    // and it does not error: it starves ordinary traffic of the core.
    //
    // The number is measured, not chosen: three, from
    // `scripts/run-signing-benchmark.sh` inside a real 512 MiB container, where
    // 48 concurrent operations added 39 MiB over the idle process. One vCPU
    // shared with 80 concurrent requests is what bounds it. Three lets a
    // request-driven finalize and the cron drain proceed at once while leaving
    // most of the core for ordinary traffic. Raising it is a CPU decision that
    // needs the same script run again, not an edit here.
    //
    // The limiter then has to HOLD it: more callers than slots must wait, never
    // all run.
    const { SLOT_CONCURRENCY } = require('../../src/shared/utils/transferSlot');
    expect(SLOT_CONCURRENCY).toBe(3);
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      inFlight -= 1;
    };

    const callers = SLOT_CONCURRENCY + 2;
    await Promise.all(Array.from({ length: callers }, () => withPdfSlot(work)));

    expect(peak).toBe(SLOT_CONCURRENCY);
    expect(peak).toBeLessThan(callers);
  });

  it('reports work another worker took, rather than counting it as done', async () => {
    const source = await admittedSource();
    registerJobHandler('prepare', async (job: any) => {
      await expireLease(job.id);
      await repo.claimProcessingJob('worker-b', LEASE_SECONDS);
    });

    const result = await runJobNow(firm.id, source.jobId, 'worker-a');

    expect(result).toBe('lost');
  });

  it('stops rather than failing when the transfer slot is already held', async () => {
    // A request-driven finalize holding the slot is the slot working as
    // intended. An unhandled queue timeout would turn that into a 500 on the
    // scheduler's call and leave the queue looking broken, when in fact every
    // job is still queued with its attempt count untouched.
    const source = await admittedSource();
    registerJobHandler('prepare', async () => {});
    const timedOut = Object.assign(
      new Error('Queued work at index 0 did not start within 60000ms'),
      { code: 'CONCURRENCY_QUEUE_TIMEOUT' },
    );
    const claim = jest.spyOn(repo, 'claimProcessingJob').mockRejectedValue(timedOut);

    try {
      const report = await drainSigningJobs({ owner: 'drain-1' });

      expect(report.truncated).toBe(true);
      expect(report.succeeded).toBe(0);
    } finally {
      claim.mockRestore();
    }

    expect((await repo.getProcessingJob(firm.id, source.jobId)).status).toBe('queued');
  });

  it('says a job is busy rather than claiming one someone else holds', async () => {
    const source = await admittedSource();
    await repo.claimProcessingJob('worker-b', LEASE_SECONDS);

    expect(await runJobNow(firm.id, source.jobId, 'worker-a')).toBe('busy');
  });
});
