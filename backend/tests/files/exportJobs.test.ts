/**
 * Folder archives as durable, fenced work.
 *
 * A folder download used to be a response: the request opened a read stream per
 * document and piped all of them into one HTTP body. Nothing recorded that an
 * archive was owed, so an instance that died partway left a truncated zip that
 * reads as a complete one, and the archive's cost landed on the instance that
 * also seals PDFs.
 *
 * The archive is a row now, and every test here is about a worker that must NOT
 * be able to write. That is the failure worth testing: two workers inside one
 * job both finish, the firm is charged for two transfers of the same folder, and
 * nothing errors. The lease token is the only thing standing between those two
 * outcomes, so each case below names a write that has to be refused and proves
 * it is.
 *
 * The paging case is the other invisible one. An archive built from a fully
 * materialized manifest produces exactly the same zip as one built a page at a
 * time, so asserting the archive's contents cannot tell them apart. It is
 * asserted by INTERLEAVING instead: work has to happen between pages.
 */
process.env.FILES_EXPORT_PAGE_SIZE = '2';

import { randomUUID } from 'crypto';

import {
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { testPool } from '../support/db';
import { objects, putObject, signedUrlCalls } from '../support/inMemoryBucket';
import {
  installRichBucket,
  resetRichBucket,
  richBucket,
  failReadStreamFrom,
  liveReadStreams,
  slowReadStreamFrom,
  zipEntryNames,
  zipEntryCompressionMethods,
} from './richBucket';
import { joinMatter, rootOf, seedFile, seedFolder, seedMatter, seedTask } from './fileWorld';

installRichBucket();

const filesRepo = require('../../src/modules/files/files.repository');
const {
  requestExport,
  runExportJobNow,
  drainExportJobs,
  sweepExpiredExports,
  retryDelaySeconds,
  PermanentExportFailure,
  EXPORT_LEASE_SECONDS,
  MAX_EXPORT_ATTEMPTS,
  __test,
} = require('../../src/modules/files/zipExportJobs');
const exportRepo = require('../../src/modules/files/exportJobs.repository');

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

const createJob = (body: Record<string, unknown>, actor: Actor = owner) => actor.api
  .post(`${F()}/export-jobs?lawFirmId=${firm.id}`)
  .send(body);

const readJob = (jobId: string, actor: Actor = owner) => actor.api
  .get(`${F()}/export-job?lawFirmId=${firm.id}&jobId=${jobId}`);

const cancelJob = (jobId: string, actor: Actor = owner) => actor.api
  .post(`${F()}/export-job-cancel?lawFirmId=${firm.id}&jobId=${jobId}`)
  .send({});

/** The job row as stored, so a spec can read what the worker actually wrote. */
async function jobRow(jobId: string) {
  const { rows } = await testPool.query(
    `select status, attempt, lease_token, lease_owner, object_path, object_generation,
            entry_count, size_bytes, failure_code, next_attempt_at, expires_at
       from file_export_jobs where id = $1`,
    [jobId],
  );
  return rows[0];
}

/** Build a claimed job's archive the way `runJob` does, without publishing it. */
const buildFor = (job: any) => __test.buildArchive(job, {
  checkpoint: (phase: string, state: unknown) =>
    exportRepo.checkpointExportJob(job.id, job.leaseToken, phase, state),
});

/** The archive bytes the worker published, read straight from storage. */
async function publishedArchive(jobId: string): Promise<Buffer> {
  const row = await jobRow(jobId);
  expect(row.object_path).toBeTruthy();
  const stored = objects.get(row.object_path);
  expect(stored).toBeTruthy();
  return stored!.body as Buffer;
}

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });
});

// ---------------------------------------------------------------------------
// The archive itself
// ---------------------------------------------------------------------------

describe('a published archive', () => {
  it('carries the folder tree as relative entry paths, stored rather than deflated', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const signed = await seedFolder(firm.id, { parentId: closing.id, name: 'Signed' });
    await seedFile(firm.id, { parentId: signed.id, name: 'Final Deed.pdf', bytes: 32 });

    const created = await createJob({ matterId, folderId: closing.id });
    expect(created.status).toBe(201);

    const outcome = await runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');
    expect(outcome).toBe('succeeded');

    const archive = await publishedArchive(created.body.exportJobId);
    expect(zipEntryNames(archive)).toEqual(['Deed.pdf', 'Signed/Final Deed.pdf']);
    // Every document type a firm uploads is already compressed, so deflate
    // spends the container's one CPU to shrink nothing.
    expect([...zipEntryCompressionMethods(archive).values()]).toEqual([0, 0]);

    const row = await jobRow(created.body.exportJobId);
    expect(row.status).toBe('succeeded');
    expect(Number(row.entry_count)).toBe(2);
    expect(Number(row.size_bytes)).toBe(archive.length);
  });

  it('reads each source pinned to the version it enumerated', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const deed = await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });

    const handles: Array<[string, any]> = [];
    const realFile = richBucket.file;
    const spy = jest.spyOn(richBucket, 'file').mockImplementation((path: string, options?: any) => {
      handles.push([path, options]);
      return (realFile as any)(path, options);
    });

    const created = await createJob({ matterId, folderId: closing.id });
    await runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');
    spy.mockRestore();

    // Every read of a source went through a handle carrying that object's
    // generation. Without the pin, a document replaced while the archive was
    // being built lands in it beside entries from the previous version, and the
    // archive is a mix of two documents with nothing saying so.
    const reads = handles.filter(([path]) => path === deed.objectPath);
    expect(reads.length).toBeGreaterThan(0);
    const pinned = reads.filter(([, options]) => options?.generation);
    expect(pinned.length).toBeGreaterThan(0);
    expect(String(pinned.at(-1)![1].generation)).toBe(objects.get(deed.objectPath)!.generation);
  });

  it('holds at most one source read open at a time', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']) {
      // eslint-disable-next-line no-await-in-loop -- fixture order matters for the entry names
      await seedFile(firm.id, { parentId: closing.id, name, bytes: 16 });
    }

    let peak = 0;
    const sample = setInterval(() => { peak = Math.max(peak, liveReadStreams.size); }, 1);
    const created = await createJob({ matterId, folderId: closing.id });
    await runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');
    clearInterval(sample);

    // The old route appended every object's read stream to the archiver in one
    // loop, so a folder with ten thousand documents opened ten thousand storage
    // connections and the archive's cost grew with the folder.
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('writes the archive as a resumable upload in bounded chunks', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });

    const writes: any[] = [];
    const realFile = richBucket.file;
    const spy = jest.spyOn(richBucket, 'file').mockImplementation((path: string, options?: any) => {
      const handle: any = (realFile as any)(path, options);
      if (path.includes('/exports/')) {
        const realWrite = handle.createWriteStream;
        handle.createWriteStream = (opts: any) => { writes.push(opts); return realWrite(opts); };
      }
      return handle;
    });

    const created = await createJob({ matterId, folderId: closing.id });
    const outcome = await runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');
    spy.mockRestore();

    // A single-shot upload restarts a multi-gigabyte transfer from byte zero on
    // one connection reset. A resumable one retries the chunk it lost, and holds
    // one chunk in memory rather than whatever the client library buffers.
    expect(outcome).toBe('succeeded');
    expect(writes).toHaveLength(1);
    expect(writes[0].resumable).toBe(true);
    expect(writes[0].chunkSize).toBeGreaterThan(0);
    expect(writes[0].chunkSize).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

describe('a manifest spanning several pages', () => {
  it('never holds more than one page of rows at a time', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const names = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf'];
    for (const name of names) {
      // eslint-disable-next-line no-await-in-loop -- deterministic sibling order
      await seedFile(firm.id, { parentId: closing.id, name, bytes: 16 });
    }

    // Two timelines, merged: when the walk handed over a page, and when the
    // worker first touched each source object. The archive is byte-identical
    // whether the manifest was paged or materialized, so ORDER is the only
    // thing that tells them apart.
    const openedSources = new Set<string>();
    const opensBeforeEachPage: number[] = [];
    const realFile = richBucket.file;
    jest.spyOn(richBucket, 'file').mockImplementation((path: string, options?: any) => {
      if (path.includes('/objects/')) openedSources.add(path);
      return (realFile as any)(path, options);
    });

    const realIterate = filesRepo.iterateSubtree.bind(filesRepo);
    filesRepo.iterateSubtree = async function* spy(...args: unknown[]) {
      for await (const page of realIterate(...args)) {
        opensBeforeEachPage.push(openedSources.size);
        expect(page.length).toBeLessThanOrEqual(2);
        yield page;
      }
    };

    try {
      const created = await createJob({ matterId, folderId: closing.id });
      const outcome = await runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');
      expect(outcome).toBe('succeeded');
      expect(zipEntryNames(await publishedArchive(created.body.exportJobId))).toEqual(names);
    } finally {
      filesRepo.iterateSubtree = realIterate;
    }

    // Three pages of two. A job that drained the walk into a manifest first
    // would show [0, 0, 0]: no source is opened until every page is already in
    // memory, which is the allocation this design exists to remove.
    expect(opensBeforeEachPage).toEqual([0, 2, 4]);
  });
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

describe('two workers inside one job', () => {
  it('refuses the first worker every write once its lease has expired', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;

    const first = await exportRepo.claimExportJob('worker-1', EXPORT_LEASE_SECONDS);
    expect(first.id).toBe(jobId);
    // The counter moves on the CLAIM, not on the failure. A worker that dies
    // without reporting anything would otherwise be retried forever.
    expect(first.attempt).toBe(1);

    // The first worker stalls past its expiry. Nothing about it knows that.
    await testPool.query(
      "update file_export_jobs set lease_expires_at = now() - interval '1 minute' where id = $1",
      [jobId],
    );

    const second = await exportRepo.claimExportJob('worker-2', EXPORT_LEASE_SECONDS);
    expect(second.id).toBe(jobId);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.attempt).toBe(2);

    // Now the first worker wakes up and tries to finish. Every write it can
    // make has to be refused: a checkpoint would rewind the new worker's
    // progress, and a publish would leave the row pointing at an archive the
    // second worker is about to overwrite while the firm pays for both.
    expect(await exportRepo.renewExportLease(jobId, first.leaseToken, EXPORT_LEASE_SECONDS)).toBe(false);
    expect(await exportRepo.checkpointExportJob(jobId, first.leaseToken, 'archiving', { entryCount: 1 })).toBe(false);
    expect(await exportRepo.publishExportJob(jobId, first.leaseToken, {
      objectPath: 'lawfirmids/x/exports/stale.zip',
      objectGeneration: '1',
      entryCount: 1,
      sizeBytes: 10,
    })).toBe(false);
    expect(await exportRepo.failExportJob(jobId, first.leaseToken, { code: 'BOOM', retryInSeconds: null })).toBe(false);

    // And the row still belongs to the second worker, unchanged by any of it.
    const row = await jobRow(jobId);
    expect(row.status).toBe('leased');
    expect(row.lease_owner).toBe('worker-2');
    expect(row.object_path).toBeNull();
  });

  it('reports a lost claim rather than a success when the lease goes mid-job', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;

    // Take the job away while the worker is inside it, the way a stalled
    // worker's replacement does.
    const realIterate = filesRepo.iterateSubtree.bind(filesRepo);
    filesRepo.iterateSubtree = async function* steal(...args: unknown[]) {
      await testPool.query(
        "update file_export_jobs set lease_token = gen_random_uuid(), lease_owner = 'worker-2' where id = $1",
        [jobId],
      );
      yield* realIterate(...args);
    };

    let outcome: string;
    try {
      outcome = await runExportJobNow(firm.id, jobId, 'worker-1');
    } finally {
      filesRepo.iterateSubtree = realIterate;
    }

    expect(outcome).toBe('lost');
    const row = await jobRow(jobId);
    expect(row.object_path).toBeNull();
    expect(row.status).toBe('leased');
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancelling an export', () => {
  it('stops a worker already inside the archive from publishing', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const slow = await seedFile(firm.id, { parentId: closing.id, name: 'Big.pdf', bytes: 4096 });
    await seedFile(firm.id, { parentId: closing.id, name: 'Also Big.pdf', bytes: 4096 });
    slowReadStreamFrom.add(slow.objectPath);

    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;

    const running = runExportJobNow(firm.id, jobId, 'worker-1');
    // Cancel while the first entry is still dripping through the archiver.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    const cancelled = await cancelJob(jobId);
    expect(cancelled.status).toBe(200);

    const outcome = await running;
    expect(outcome).toBe('lost');

    // Cancellation clears the token rather than recording an intent. That is
    // what makes it act on a worker that is already running: the publish it is
    // about to attempt no longer matches anything.
    const row = await jobRow(jobId);
    expect(row.status).toBe('cancelled');
    expect(row.lease_token).toBeNull();
    expect(row.object_path).toBeNull();

    // Nothing was left behind in storage either, and the requester is never
    // handed a URL for a cancelled export.
    const paths = [...objects.keys()].filter((p) => p.includes('/exports/'));
    expect(paths).toEqual([]);
    const read = await readJob(jobId);
    expect(read.body.exportJob.status).toBe('cancelled');
    expect(read.body.exportJob.downloadUrl).toBeUndefined();
  });

  it('discards an archive it finished but was not allowed to publish', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;

    // The lease changes hands AFTER the worker's last chance to notice, so the
    // archive is complete and in storage before the publish is refused. Left
    // alone it is an object nothing points at and nobody can explain, on a bill
    // the firm did not ask for.
    const realCheckpoint = exportRepo.checkpointExportJob;
    exportRepo.checkpointExportJob = async (...args: any[]) => {
      const held = await realCheckpoint(...args);
      if (args[2] === 'finalizing') {
        await testPool.query(
          'update file_export_jobs set lease_token = gen_random_uuid() where id = $1',
          [jobId],
        );
      }
      return held;
    };

    let outcome: string;
    try {
      outcome = await runExportJobNow(firm.id, jobId, 'worker-1');
    } finally {
      exportRepo.checkpointExportJob = realCheckpoint;
    }

    expect(outcome).toBe('lost');
    expect((await jobRow(jobId)).object_path).toBeNull();
    expect([...objects.keys()].filter((p) => p.includes('/exports/'))).toEqual([]);
  });

  it('a worker whose lease was taken cannot delete the archive its replacement published', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;

    // Attempt 1 builds a complete archive, then stalls past its lease.
    const first = await exportRepo.claimExportJobById(firm.id, jobId, 'worker-1', EXPORT_LEASE_SECONDS);
    const firstOutput = await buildFor(first);
    await testPool.query(
      "update file_export_jobs set lease_expires_at = now() - interval '1 minute' where id = $1",
      [jobId],
    );

    // Attempt 2 claims the job, builds its own archive and publishes it.
    const second = await exportRepo.claimExportJobById(firm.id, jobId, 'worker-2', EXPORT_LEASE_SECONDS);
    expect(second.attempt).toBe(2);
    const secondOutput = await buildFor(second);
    expect(await exportRepo.publishExportJob(jobId, second.leaseToken, secondOutput)).toBe(true);

    // The stale worker wakes, is refused the publish, and cleans up after itself
    // exactly the way `runJob` does.
    expect(await exportRepo.publishExportJob(jobId, first.leaseToken, firstOutput)).toBe(false);
    await __test.discardArchive(firstOutput.objectPath, firstOutput.objectGeneration);

    // Two attempts never share an object, so the loser's cleanup cannot reach
    // the winner's archive, and the row still points at bytes that exist.
    expect(firstOutput.objectPath).not.toBe(secondOutput.objectPath);
    const row = await jobRow(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.object_path).toBe(secondOutput.objectPath);
    expect(objects.get(secondOutput.objectPath)?.generation).toBe(secondOutput.objectGeneration);
    expect(objects.has(firstOutput.objectPath)).toBe(false);
  });

  it('a discard pinned to its own generation leaves a newer object at that path alone', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const job = await exportRepo.claimExportJobById(
      firm.id, created.body.exportJobId, 'worker-1', EXPORT_LEASE_SECONDS,
    );
    const output = await buildFor(job);

    // Something else wrote the path after this worker did. The worker's
    // cleanup names the version it wrote, so it is not this object to remove.
    putObject(output.objectPath, { bytes: 10, contentType: 'application/zip' });
    const newer = objects.get(output.objectPath)!.generation;
    expect(newer).not.toBe(output.objectGeneration);

    await __test.discardArchive(output.objectPath, output.objectGeneration);

    expect(objects.get(output.objectPath)?.generation).toBe(newer);
  });
});

// ---------------------------------------------------------------------------
// Failure, retry and refusal
// ---------------------------------------------------------------------------

describe('a failed archive', () => {
  it('publishes nothing and queues a retry when a source read fails partway', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const doomed = await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 2048 });
    failReadStreamFrom.set(doomed.objectPath, 'Storage read failed');

    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;

    const outcome = await runExportJobNow(firm.id, jobId, 'worker-1');
    expect(outcome).toBe('retry');

    const row = await jobRow(jobId);
    expect(row.status).toBe('queued');
    // A half-written archive must never be reachable. It reads as a complete
    // zip to whoever opens it, and the missing documents are invisible.
    expect(row.object_path).toBeNull();
    expect([...objects.keys()].filter((p) => p.includes('/exports/'))).toEqual([]);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    const read = await readJob(jobId);
    expect(read.body.exportJob.downloadUrl).toBeUndefined();
  });

  it('settles a refusal that cannot succeed instead of retrying it', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;

    // The folder is deleted by the time the worker reaches it. Retrying that
    // costs an attempt, a transfer slot and a log line and cannot ever succeed.
    // A soft delete rather than a hard one, because a hard delete cascades the
    // job row away with the folder and there is nothing left to refuse.
    await testPool.query('update files set deleted_at = now() where id = $1', [closing.id]);

    const outcome = await runExportJobNow(firm.id, jobId, 'worker-1');
    expect(outcome).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('EXPORT_ROOT_MISSING');
  });

  it('backs off further on each attempt, up to a ceiling', () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(99)).toBe(15 * 60);
    expect(MAX_EXPORT_ATTEMPTS).toBeGreaterThan(1);
    expect(new PermanentExportFailure('nope').statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// The download URL
// ---------------------------------------------------------------------------

describe('the finished archive URL', () => {
  it('is minted pinned to the generation the job published', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;
    await runExportJobNow(firm.id, jobId, 'worker-1');

    const row = await jobRow(jobId);
    signedUrlCalls.length = 0;
    const read = await readJob(jobId);

    expect(read.status).toBe(200);
    expect(read.body.exportJob.status).toBe('succeeded');
    expect(read.body.exportJob.downloadUrl).toContain(`generation=${row.object_generation}`);
    // The row must not leak where the object lives: the URL is the only handle
    // anyone gets, and it expires.
    expect(read.body.exportJob.objectPath).toBeUndefined();

    const call = signedUrlCalls.at(-1)!;
    expect(call.generation).toBe(row.object_generation);
    expect(String(call.config.responseDisposition)).toContain('attachment');
  });

  it('is refused to a firm member who did not request the export', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;
    await runExportJobNow(firm.id, jobId, 'worker-1');

    // A colleague on the same matter. The archive was built under the
    // REQUESTER's access, at the moment they asked, so it is theirs to fetch.
    const colleague = await memberWith(firm.id, []);
    await joinMatter(firm.id, matterId, colleague.uid);

    const read = await readJob(jobId, colleague);
    expect(read.status).toBe(404);
    expect(read.body.exportJob).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe('another firm', () => {
  it('cannot request an export of a folder it does not own', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });

    const other = await createFirm({ name: 'Marsh LLP' });
    const intruder = await ownerOf(other.id);

    // Firm B's owner, naming firm A's folder under firm B's own scope. The
    // folder really exists, which is the point: a refusal here has to come from
    // the scope check, not from the id being unknown.
    const refused = await intruder.api
      .post(`/api/lawfirms/${other.id}/files/export-jobs?lawFirmId=${other.id}`)
      .send({ folderId: closing.id });
    expect(refused.status).toBe(404);

    const { rows } = await testPool.query('select count(*)::int as n from file_export_jobs');
    expect(rows[0].n).toBe(0);
  });

  it('cannot read a job belonging to another firm', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });

    const other = await createFirm({ name: 'Marsh LLP' });
    const intruder = await ownerOf(other.id);
    const refused = await intruder.api
      .get(`/api/lawfirms/${other.id}/files/export-job?lawFirmId=${other.id}&jobId=${created.body.exportJobId}`);
    expect(refused.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Idempotency, the drain and the sweep
// ---------------------------------------------------------------------------

describe('the queue', () => {
  it('returns the live job rather than archiving the same folder twice', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });

    const first = await createJob({ matterId, folderId: closing.id });
    const second = await createJob({ matterId, folderId: closing.id });

    expect(second.body.exportJobId).toBe(first.body.exportJobId);
    const { rows } = await testPool.query('select count(*)::int as n from file_export_jobs');
    expect(rows[0].n).toBe(1);
  });

  it('works the queue down and reports what is left', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const other = await seedFolder(firm.id, { parentId: matterRoot, name: 'Discovery' });
    await seedFile(firm.id, { parentId: other.id, name: 'Notes.pdf', bytes: 64 });

    await createJob({ matterId, folderId: closing.id });
    await createJob({ matterId, folderId: other.id });

    const report = await drainExportJobs({ owner: 'drain-1' });
    expect(report.succeeded).toBe(2);
    expect(report.remaining).toBe(0);
  });

  it('sweeps an expired archive and stops handing out its URL', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const created = await createJob({ matterId, folderId: closing.id });
    const jobId = created.body.exportJobId;
    await runExportJobNow(firm.id, jobId, 'worker-1');

    const before = await jobRow(jobId);
    expect(objects.has(before.object_path)).toBe(true);

    await testPool.query(
      "update file_export_jobs set expires_at = now() - interval '1 hour' where id = $1",
      [jobId],
    );
    expect(await sweepExpiredExports({ limit: 10 })).toBe(1);

    // The bytes are gone and the row no longer points at them, so a client
    // still polling gets "expired" rather than a URL that resolves to nothing.
    expect(objects.has(before.object_path)).toBe(false);
    const read = await readJob(jobId);
    expect(read.body.exportJob.downloadUrl).toBeUndefined();
    expect(read.body.exportJob.isExpired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

describe('a multi-select export', () => {
  it('expands a selected folder and drops ids the scope does not own', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 64 });
    const loose = await seedFile(firm.id, { parentId: matterRoot, name: 'Settlement.pdf', bytes: 64 });

    // A document in a matter this scope is not addressing. The rows decide what
    // is in scope, so it is dropped rather than archived.
    const otherMatter = await seedMatter(firm.id, owner.uid, 'Unrelated');
    const otherRoot = await rootOf(firm.id, { matterId: otherMatter });
    const foreign = await seedFile(firm.id, { parentId: otherRoot, name: 'Secret.pdf', bytes: 64 });

    const created = await createJob({
      matterId, fileIds: [closing.id, loose.id, foreign.id],
    });
    expect(created.status).toBe(201);
    await runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');

    expect(zipEntryNames(await publishedArchive(created.body.exportJobId)))
      .toEqual(['Closing/Deed.pdf', 'Settlement.pdf']);
  });

  it('refuses a selection with nothing in it', async () => {
    const created = await createJob({ matterId, fileIds: [] });
    expect(created.status).toBe(400);
  });

  it('does not export a file from a different task', async () => {
    const allowedTask = await seedTask(firm.id, { title: 'Allowed task' });
    const otherTask = await seedTask(firm.id, { title: 'Other task' });
    const restrictedRoot = await rootOf(firm.id, { taskId: otherTask });
    const secret = await seedFile(firm.id, {
      parentId: restrictedRoot, name: 'Secret.pdf', taskId: otherTask,
    });

    const created = await createJob({ taskId: allowedTask, fileIds: [secret.id] });

    expect(created.status).toBe(404);
  });

  it('resolves a selection with one query rather than one lookup per item', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture rows
      ids.push((await seedFile(firm.id, { parentId: matterRoot, name: `f${i}.bin`, bytes: 8 })).id);
    }

    const byId = jest.spyOn(filesRepo, 'findById');
    let created: any;
    let lookups = -1;
    try {
      created = await createJob({ matterId, fileIds: ids });
      lookups = byId.mock.calls.length;
    } finally {
      byId.mockRestore();
    }

    // A 5,000-item selection was 5,000 sequential round trips inside one request.
    expect(created.status).toBe(201);
    expect(lookups).toBe(0);
    const { rows } = await testPool.query(
      'select count(*)::int as n from file_export_job_sources where job_id = $1',
      [created.body.exportJobId],
    );
    expect(rows[0].n).toBe(25);
  });

  it('refuses a selection larger than the ceiling', async () => {
    const created = await createJob({
      matterId, fileIds: Array.from({ length: 5001 }, () => randomUUID()),
    });
    expect(created.status).toBe(400);
  });
});
