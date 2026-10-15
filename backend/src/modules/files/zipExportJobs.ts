/**
 * Folder archives, as durable work rather than as a response.
 *
 * A folder download used to be an HTTP body: the request opened a read stream
 * per document and piped all of them into one response. Three things came with
 * that, and each is a defect nobody can see from the outside.
 *
 * The archive's cost was unbounded. Every document in the subtree got a storage
 * connection at once, so a matter with twenty thousand documents opened twenty
 * thousand of them, on the instance that also seals PDFs.
 *
 * Nothing recorded that an archive was owed. An instance killed partway through
 * left a truncated zip that reads as a complete one to whoever opens it, and no
 * row anywhere said a download had failed.
 *
 * And the whole subtree had to be listed before the first byte could be
 * written, so memory tracked the customer's document count rather than the
 * request.
 *
 * A row in `file_export_jobs` fixes all three. What makes it SAFE is the same
 * three things the signing queue relies on, for the same reasons.
 *
 * THE LEASE. A worker claims a job with a token and an expiry, and every write
 * afterwards re-checks that token. A worker that stalls past its expiry loses
 * the job, and its later writes are refused rather than landing on top of its
 * replacement's. Without this both workers publish, the firm is charged for two
 * transfers of one folder, and the row points at one of the two archives.
 *
 * THE SLOT. One heavy transfer at a time per instance, SHARED with signing:
 * both move whole documents through the same 512 MiB, so budgeting them
 * separately puts two documents through one allocation. Taken BEFORE the claim,
 * so a busy instance does not hold a lease it cannot act on.
 *
 * THE DEADLINE. The drain stops with time to spare rather than being cut off
 * mid-archive, so the last job it starts can finish and the rest stay queued
 * with their attempt counts intact.
 */
import { AppError } from '../../shared/errors/AppError';
import { formatBytes } from '../../shared/utils/storageUsage';
import { withTransferSlot } from '../../shared/utils/transferSlot';

const crypto = require('crypto');

const filesRepo = require('./files.repository');
const exportRepo = require('./exportJobs.repository');
const { bucket } = require('./files.storage');

/** How long a claim is good for, and how often it is renewed. */
export const EXPORT_LEASE_SECONDS = Number(process.env.FILES_EXPORT_LEASE_SECONDS) || 120;
const RENEW_MS = Math.floor((EXPORT_LEASE_SECONDS * 1000) / 2);

/** The drain's own budget, well inside Cloud Run's request ceiling. */
export const EXPORT_DRAIN_BUDGET_MS = Number(process.env.FILES_EXPORT_DRAIN_BUDGET_MS)
  || 25 * 60 * 1000;

/**
 * How long one archive may take before the drain refuses to start another.
 *
 * A job started with less than this left is cut off by the deadline, and a job
 * cut off partway has burned an attempt and a transfer for nothing.
 */
const JOB_HEADROOM_MS = Number(process.env.FILES_EXPORT_HEADROOM_MS) || 5 * 60 * 1000;

/**
 * The most one archive may add up to. 20 GiB.
 *
 * Not a memory number: the archive is stored, not deflated, and streamed one
 * entry at a time. It is a TIME number. The drain runs inside one cron request
 * with a 25-minute budget, and a job that cannot finish inside it retries from
 * entry zero until its attempts run out, re-transferring the selection each
 * time. 20 GiB at a modest 30 MB/s is about eleven minutes.
 */
export const EXPORT_MAX_BYTES = Number(process.env.FILES_EXPORT_MAX_BYTES) || 20 * 1024 ** 3;

/** Attempts before a failure stops being retried. */
export const MAX_EXPORT_ATTEMPTS = Number(process.env.FILES_EXPORT_MAX_ATTEMPTS) || 5;

/**
 * How long a finished archive stays fetchable.
 *
 * It is a COPY of documents the firm already has, so keeping it is pure storage
 * cost against a link somebody either used within the hour or abandoned.
 */
const EXPORT_TTL_MS = Number(process.env.FILES_EXPORT_TTL_MS) || 24 * 60 * 60 * 1000;

/** How long a minted download URL lasts. Long enough to start a large download. */
export const EXPORT_URL_TTL_MS = Number(process.env.FILES_EXPORT_URL_TTL_MS) || 60 * 60 * 1000;

/** The selection marker for "everything under the root", as opposed to a set. */
const WHOLE_SUBTREE = 'subtree';

/**
 * Refusals that will fail the same way every time.
 *
 * Retrying one of these costs an attempt, a transfer slot and a log line and
 * cannot succeed: the folder is what it is. They settle the job immediately so
 * a person sees the real reason instead of five identical failures.
 */
const PERMANENT_CODES = new Set([
  'EXPORT_ROOT_MISSING',
  'EXPORT_EMPTY',
]);

/** Thrown by an archive that cannot succeed, whatever happens next. */
export class PermanentExportFailure extends AppError {
  constructor(message: string, code = 'EXPORT_PERMANENT_FAILURE') {
    super(message, 422, code);
  }
}

/** Refused at enqueue: the selection adds up past `EXPORT_MAX_BYTES`. */
export class ExportTooLarge extends AppError {
  constructor(bytes: number) {
    super(
      `That selection is ${formatBytes(bytes)}; the most one download may hold is ${formatBytes(EXPORT_MAX_BYTES)}.`,
      413,
      'EXPORT_TOO_LARGE',
    );
  }
}

/**
 * Thrown when the job stopped being ours partway through.
 *
 * Not a failure of the archive: the archive was fine, and somebody else is
 * either doing it or has cancelled it. It is thrown rather than returned so
 * every loop between here and the publish unwinds without writing anything.
 */
class LeaseLost extends Error {
  constructor() {
    super('The export lease was taken away');
  }
}

/**
 * Backoff between attempts.
 *
 * Doubling, capped, so storage that is briefly unavailable is retried quickly
 * and storage that is down for an hour is not hammered.
 */
export function retryDelaySeconds(attempt: number): number {
  const base = 30 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 15 * 60);
}

/**
 * Where one attempt at a job's archive lands.
 *
 * Under the firm's own prefix so deleting the firm removes it, and under a
 * SYSTEM segment so it is outside the browsable tree, outside the firm's quota
 * and outside every listing: it is a copy the system made, not a document the
 * firm uploaded.
 *
 * The ATTEMPT is part of the name. A worker that lost its lease and the worker
 * that replaced it must never share an object: the loser's cleanup would
 * otherwise remove the archive the winner just published.
 */
export function exportObjectPath(lawFirmId: string, jobId: string, attempt: number): string {
  return `lawfirmids/${lawFirmId}/exports/${jobId}-${Math.max(1, Number(attempt) || 1)}.zip`;
}

/**
 * The rows per manifest page.
 *
 * Read per job rather than at import, so the value can be lowered for a test
 * that has to prove pages are consumed one at a time without depending on when
 * this module happened to load.
 */
function pageSize(): number {
  return Number(process.env.FILES_EXPORT_PAGE_SIZE) || filesRepo.SUBTREE_DEFAULT_PAGE_SIZE;
}

/**
 * The digest that makes two requests for the same selection one job.
 *
 * A whole-subtree export is identified by its root alone. A selection is
 * identified by its ids, sorted, so the same four documents ticked in a
 * different order do not archive twice.
 */
function selectionDigestFor(fileIds: string[] | null | undefined): string {
  const ids = (fileIds || []).filter(Boolean).map(String).sort();
  if (ids.length === 0) return WHOLE_SUBTREE;
  return crypto.createHash('sha256').update(ids.join(',')).digest('hex');
}

/**
 * The zip entry name for a row: its path within the archive.
 *
 * Built from the parent chain rather than from the object name, because the
 * object is named after the row id and says nothing about where the file sits.
 * `baseId` is the folder the archive is rooted at, so entries come out relative
 * to it.
 */
async function entryNameFor(lawFirmId: string, row: any, baseId: string): Promise<string> {
  const chain = await filesRepo.ancestors(lawFirmId, row.id);
  const fromBase = chain.slice(chain.findIndex((a: any) => a.id === baseId) + 1);
  return [...fromBase.map((a: any) => a.name), row.name].join('/');
}

/**
 * Commit an export.
 *
 * The caller has already resolved the scope and filtered the selection down to
 * what THIS requester may read, which is what the archive's contents are
 * authorized against: the job carries the person's access at the moment they
 * asked, not the firm's at the moment the worker runs.
 *
 * The selection's size is summed HERE, before any job exists, because this is
 * the only point where refusing costs nothing. A job admitted past the ceiling
 * would burn every attempt re-transferring the folder before failing.
 */
export async function requestExport(input: {
  lawFirmId: string;
  requestedBy: string;
  rootFileId: string;
  sourceFileIds?: string[] | null;
}) {
  const bytes = await filesRepo.selectionBytes(
    input.lawFirmId,
    input.sourceFileIds?.length ? input.sourceFileIds : [input.rootFileId],
  );
  if (bytes > EXPORT_MAX_BYTES) throw new ExportTooLarge(bytes);

  return exportRepo.enqueueExportJob(input.lawFirmId, {
    rootFileId: input.rootFileId,
    requestedBy: input.requestedBy,
    selectionDigest: selectionDigestFor(input.sourceFileIds),
    sourceFileIds: input.sourceFileIds || [],
    ttlMs: EXPORT_TTL_MS,
  });
}

/**
 * Every file the job covers, one page of rows at a time.
 *
 * `onPage` runs before each page is handed over, which is where the worker both
 * saves progress and finds out whether the job is still its own. Pairing them is
 * deliberate: the statement that records progress is the same one that answers
 * whether progress is still wanted, so there is no window where a cancelled job
 * keeps archiving because nobody asked.
 *
 * Nothing accumulates rows. The subtree walk holds one page; the selection walk
 * holds one page plus the object paths already written, which is what stops a
 * selection naming both a folder and a file inside it from archiving that file
 * twice.
 */
async function* enumerateEntries(
  job: any,
  root: any,
  onPage: () => Promise<void>,
): AsyncGenerator<{ name: string; objectPath: string }> {
  const sources = await exportRepo.listExportJobSources(job.lawFirmId, job.id);

  if (sources.length === 0) {
    for await (const page of filesRepo.iterateSubtree(job.lawFirmId, root.id, { pageSize: pageSize() })) {
      await onPage();
      for (const row of page) {
        if (row.kind !== 'file' || !row.objectPath) continue;
        yield { name: row.relativePath, objectPath: row.objectPath };
      }
    }
    return;
  }

  const written = new Set<string>();
  for (const id of sources) {
    // eslint-disable-next-line no-await-in-loop -- one lookup per selected item
    const row = await filesRepo.findById(job.lawFirmId, id);
    if (!row) continue;

    if (row.kind === 'file') {
      // eslint-disable-next-line no-await-in-loop -- one page boundary per selected file
      await onPage();
      if (!row.objectPath || written.has(row.objectPath)) continue;
      written.add(row.objectPath);
      // eslint-disable-next-line no-await-in-loop -- one chain read per selected file
      yield { name: await entryNameFor(job.lawFirmId, row, root.id), objectPath: row.objectPath };
      continue;
    }

    // One upward read for the SELECTED folder, then the walk supplies every
    // path below it. Resolving each document's chain separately cost one
    // recursive query per file in the selection.
    // eslint-disable-next-line no-await-in-loop -- one chain read per selected folder
    const folderPath = await entryNameFor(job.lawFirmId, row, root.id);
    // eslint-disable-next-line no-await-in-loop -- one subtree walk per selected folder
    for await (const page of filesRepo.iterateSubtree(job.lawFirmId, row.id, { pageSize: pageSize() })) {
      await onPage();
      for (const child of page) {
        if (child.kind !== 'file' || !child.objectPath) continue;
        if (written.has(child.objectPath)) continue;
        written.add(child.objectPath);
        yield { name: `${folderPath}/${child.relativePath}`, objectPath: child.objectPath };
      }
    }
  }
}

/**
 * Append one source and wait for the archiver to finish with it.
 *
 * The wait is what bounds the transfer. `archive.append` queues, so appending
 * every source in a loop opens every source's storage connection at once, which
 * is the unbounded read this whole module replaces. One entry in flight means
 * one connection open, whatever the folder holds.
 */
function appendEntry(
  archive: any,
  name: string,
  size: number | null,
  source: NodeJS.ReadableStream,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      archive.removeListener('entry', onEntry);
      archive.removeListener('error', onError);
      if (err) reject(err); else resolve();
    };
    const onEntry = (entry: any) => { if (entry?.name === name) done(); };
    const onError = (err: Error) => done(err);

    archive.on('entry', onEntry);
    archive.on('error', onError);
    // A source read that fails is not forwarded by `pipe`, so without this the
    // failure is an unhandled 'error' event on an EventEmitter, which throws
    // and takes the process down instead of failing this one archive.
    source.on('error', (err: Error) => archive.emit('error', err));
    // The size lets the entry be written without a data descriptor, which is
    // what keeps a single source larger than 4 GiB describable in ZIP64.
    archive.append(source, size === null ? { name } : { name, size });
  });
}

/**
 * Remove an archive nobody will be told about. Best effort by design.
 *
 * `generation` pins the delete to the version this worker wrote, so a delete
 * that arrives late cannot remove whatever has since been written at the path.
 */
async function discardArchive(objectPath: string, generation?: string | null): Promise<void> {
  try {
    await bucket.file(objectPath).delete(generation ? { ifGenerationMatch: generation } : undefined);
  } catch (err: any) {
    // 404: already gone. 412: not the version this worker wrote, so not its to
    // remove.
    if (Number(err?.code) !== 404 && Number(err?.code) !== 412) {
      console.warn(`[files:export] could not discard ${objectPath}: ${err?.message || err}`);
    }
  }
}

interface ArchiveOutput {
  objectPath: string;
  objectGeneration: string;
  entryCount: number;
  sizeBytes: number;
}

/**
 * Build the archive and leave it in storage, unpublished.
 *
 * Nothing points at the object when this returns. That is deliberate: publishing
 * is one token-checked statement, so an archive built by a worker that lost its
 * lease is discarded rather than becoming a second copy nobody asked for.
 */
async function buildArchive(job: any, context: {
  checkpoint: (phase: string, state: unknown) => Promise<boolean>;
}): Promise<ArchiveOutput> {
  const root = await filesRepo.findById(job.lawFirmId, job.rootFileId);
  if (!root || root.kind !== 'folder') {
    throw new PermanentExportFailure(
      'The folder this download was for no longer exists.',
      'EXPORT_ROOT_MISSING',
    );
  }

  const objectPath = exportObjectPath(job.lawFirmId, job.id, job.attempt);

  // Stored, not deflated. Every document type a firm uploads (PDF, DOCX,
  // images, video) is already compressed, so deflate spends the container's one
  // CPU to shrink nothing and makes a large archive CPU-bound rather than
  // network-bound. ZIP64 headers are written as soon as the archive needs them
  // (past 65,535 entries or 4 GiB), and not before, so an ordinary archive
  // stays readable by tools that predate ZIP64.
  // Required here rather than at the top: only the export drain builds an
  // archive, and loading archiver at boot costs every instance memory for it.
  const archiver = require('archiver');
  const archive = archiver('zip', { store: true });
  const upload = bucket.file(objectPath).createWriteStream({
    // Resumable, in 16 MiB chunks: the client library retries a failed chunk on
    // its own and holds one chunk, rather than restarting a multi-gigabyte
    // transfer from byte zero on a single connection reset.
    resumable: true,
    chunkSize: 16 * 1024 * 1024,
    metadata: {
      contentType: 'application/zip',
      metadata: { exportJobId: job.id, lawFirmId: job.lawFirmId, requestedBy: job.requestedBy },
    },
  });

  let streamError: Error | null = null;
  const transferred = new Promise<void>((resolve) => {
    upload.on('error', (err: Error) => {
      streamError = streamError || err;
      // Forwarded onto the archive as well as recorded. Without this, a storage
      // write that fails while a source is being read leaves the append waiting
      // for an entry that can never complete, and the job sits holding its lease
      // until the lease expires rather than failing.
      archive.emit('error', err);
      resolve();
    });
    upload.on('finish', () => resolve());
  });
  archive.on('error', (err: Error) => { streamError = streamError || err; });
  archive.pipe(upload);

  let entryCount = 0;
  // The source currently being read, so a failure can close it. `pipe()` never
  // propagates a destroy back UPSTREAM to the stream feeding it, so destroying
  // the archiver alone leaves a source that is still mid-read holding its
  // storage connection open: a leaked handle per failed export.
  let inFlight: any = null;
  try {
    const onPage = async () => {
      if (!await context.checkpoint('archiving', { entryCount })) throw new LeaseLost();
    };

    for await (const entry of enumerateEntries(job, root, onPage)) {
      const handle = bucket.file(entry.objectPath);
      // The generation is read here and then carried on the read handle, so
      // every byte in the archive comes from ONE version of the source. Without
      // it, a document replaced while the archive is being built contributes
      // part of the old file and part of the new, and the archive says nothing.
      let generation: string | null = null;
      let size: number | null = null;
      try {
        const [metadata] = await handle.getMetadata();
        generation = metadata?.generation === undefined || metadata?.generation === null
          ? null : String(metadata.generation);
        size = metadata?.size === undefined || metadata?.size === null
          ? null : Number(metadata.size);
      } catch (err: any) {
        // A document deleted between the listing and the read is not a reason
        // to fail the whole archive: the folder simply no longer holds it.
        if (Number(err?.code) === 404) continue;
        throw err;
      }

      const source = (generation
        ? bucket.file(entry.objectPath, { generation })
        : handle).createReadStream();
      inFlight = source;
      await appendEntry(archive, entry.name, size, source);
      inFlight = null;
      entryCount += 1;
    }

    if (entryCount === 0) {
      throw new PermanentExportFailure(
        'There is nothing in this folder to download.',
        'EXPORT_EMPTY',
      );
    }

    // The last chance to stop before the archive costs a finalize and a flush.
    if (!await context.checkpoint('finalizing', { entryCount })) throw new LeaseLost();

    await archive.finalize();
    await transferred;
    if (streamError) throw streamError;
  } catch (err) {
    if (inFlight && !inFlight.destroyed) inFlight.destroy(err as Error);
    archive.destroy(err as Error);
    upload.destroy(err as Error);
    // Unpinned: nothing landed under this attempt's name yet, or what landed is
    // this attempt's own partial write.
    await discardArchive(objectPath);
    throw err;
  }

  const [metadata] = await bucket.file(objectPath).getMetadata();
  return {
    objectPath,
    objectGeneration: String(metadata.generation ?? ''),
    entryCount,
    sizeBytes: Number(metadata.size ?? 0),
  };
}

/**
 * Run one job to settlement.
 *
 * The lease is renewed on a timer for as long as the archive runs, and the
 * timer is cleared in a `finally`: a renewal loop left running would keep a job
 * alive that nobody is working on, which is worse than losing it, because
 * nothing else can claim it either.
 */
async function runJob(job: any): Promise<'succeeded' | 'failed' | 'retry' | 'lost'> {
  const renew = setInterval(() => {
    exportRepo.renewExportLease(job.id, job.leaseToken, EXPORT_LEASE_SECONDS)
      .catch(() => { /* a missed renewal is not proof the lease is gone */ });
  }, RENEW_MS);
  if (typeof renew.unref === 'function') renew.unref();

  const context = {
    checkpoint: (phase: string, state: unknown) =>
      exportRepo.checkpointExportJob(job.id, job.leaseToken, phase, state),
  };

  try {
    const output = await buildArchive(job, context);
    const published = await exportRepo.publishExportJob(job.id, job.leaseToken, output);
    if (!published) {
      // The lease went between the last checkpoint and here. The archive is
      // real and complete and nobody asked for it, so it is removed rather than
      // left to be swept: an object nothing points at is a charge nobody can
      // explain. Pinned to the version this worker wrote.
      await discardArchive(output.objectPath, output.objectGeneration);
      return 'lost';
    }
    return 'succeeded';
  } catch (err: any) {
    if (err instanceof LeaseLost) return 'lost';

    const code = String(err?.code || 'EXPORT_FAILED');
    const permanent = err instanceof PermanentExportFailure
      || PERMANENT_CODES.has(code)
      || job.attempt >= MAX_EXPORT_ATTEMPTS;
    const settled = await exportRepo.failExportJob(job.id, job.leaseToken, {
      code,
      detail: String(err?.message || err),
      retryInSeconds: permanent ? null : retryDelaySeconds(job.attempt),
    });
    if (!settled) return 'lost';
    console.warn(
      `[files:export] job ${job.id} attempt ${job.attempt} failed: ${code} (${err?.message || err})`
      + `${permanent ? ' [permanent]' : ` [retry in ${retryDelaySeconds(job.attempt)}s]`}`,
    );
    return permanent ? 'failed' : 'retry';
  } finally {
    clearInterval(renew);
  }
}

/**
 * Claim and run one named job, if it is free.
 *
 * Goes through the same claim and the same lease as the drain, so the two can
 * never both be inside one job. `busy` means somebody else already holds it,
 * which is not an error: the caller polls.
 */
export async function runExportJobNow(lawFirmId: string, jobId: string, owner: string) {
  return withTransferSlot(async () => {
    const job = await exportRepo.claimExportJobById(lawFirmId, jobId, owner, EXPORT_LEASE_SECONDS);
    if (!job) return 'busy' as const;
    return runJob(job);
  });
}

export interface ExportDrainReport {
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
 * The transfer slot is taken BEFORE the claim, so an instance that is already
 * moving a document waits without holding a lease. A job claimed and then
 * parked behind a slot is a job nobody else can take while nothing is happening
 * to it.
 */
export async function drainExportJobs(options: {
  owner: string;
  deadline?: number;
  maxJobs?: number;
}): Promise<ExportDrainReport> {
  const { owner } = options;
  const deadline = options.deadline ?? (Date.now() + EXPORT_DRAIN_BUDGET_MS);
  const maxJobs = options.maxJobs ?? Number.MAX_SAFE_INTEGER;

  const report: ExportDrainReport = {
    succeeded: 0, failed: 0, retried: 0, lost: 0, remaining: 0, truncated: false,
  };

  let handled = 0;
  for (;;) {
    if (handled >= maxJobs) break;
    if (Date.now() + JOB_HEADROOM_MS >= deadline) {
      report.truncated = true;
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- one archive at a time is the point
    const outcome = await withTransferSlot(async () => {
      const job = await exportRepo.claimExportJob(owner, EXPORT_LEASE_SECONDS);
      if (!job) return null;
      return { job, result: await runJob(job) };
    });
    if (!outcome) break;

    handled += 1;
    if (outcome.result === 'succeeded') report.succeeded += 1;
    else if (outcome.result === 'failed') report.failed += 1;
    else if (outcome.result === 'retry') report.retried += 1;
    else report.lost += 1;
  }

  report.remaining = await exportRepo.countReadyExportJobs();
  return report;
}

/**
 * Remove archives whose TTL has run out.
 *
 * The row survives, so a client still polling is told the export expired rather
 * than handed a URL that resolves to nothing. Clearing the path is what makes
 * those two answers different.
 */
export async function sweepExpiredExports(options: { limit?: number } = {}): Promise<number> {
  const jobs = await exportRepo.expiredExportObjects(options.limit ?? 200);
  let swept = 0;
  for (const job of jobs) {
    // eslint-disable-next-line no-await-in-loop -- one object at a time, off the request path
    await discardArchive(job.objectPath as string);
    // eslint-disable-next-line no-await-in-loop -- paired with the delete above
    if (await exportRepo.clearExportObject(job.id)) swept += 1;
  }
  return swept;
}

/**
 * The archive build and the discard, reachable from a spec.
 *
 * A lease race needs two workers to finish their archives before either
 * publishes, which `runJob` cannot be paused to express.
 */
export const __test = { buildArchive, discardArchive };

/**
 * A short-lived URL for a finished archive, pinned to the version the job
 * published.
 *
 * Each attempt writes its own path, and the generation pins the URL further to
 * the exact bytes the job published rather than whatever sits at the path now.
 */
export async function mintExportDownloadUrl(
  job: any,
  archiveName: string,
): Promise<{ url: string; expiresAt: string } | null> {
  if (!job?.objectPath || !job?.objectGeneration) return null;
  const expires = Date.now() + EXPORT_URL_TTL_MS;
  const [url] = await bucket.file(job.objectPath, { generation: job.objectGeneration })
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires,
      responseDisposition: `attachment; filename="${archiveName}"`,
    });
  return { url, expiresAt: new Date(expires).toISOString() };
}
