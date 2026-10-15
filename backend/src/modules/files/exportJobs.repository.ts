/**
 * The export queue's table access.
 *
 * Every write here re-checks the LEASE TOKEN, and that is the whole point of the
 * file. A worker that stalls past its expiry loses the job, and when it wakes up
 * its writes have to be refused rather than landing on top of its replacement's.
 * Without the token check both workers finish, the firm is charged for two
 * transfers of the same folder, and the row ends up pointing at one of the two
 * archives with nothing recording that the other exists.
 *
 * The attempt counter increments on the CLAIM, not on the failure. A worker that
 * dies without reporting anything would otherwise be retried forever, which is
 * the shape a poison job takes: it never fails, it just never finishes.
 */
const { infrastructureRootSql, infrastructureSql } = require('../../shared/database/infrastructureQuery');
const { isUuid } = require('../../shared/utils/isUuid');

async function run(executor: any, text: string, params: unknown[] = []) {
  return executor
    ? infrastructureSql(executor, text, params)
    : infrastructureRootSql(text, params);
}

export interface ExportJob {
  id: string;
  lawFirmId: string;
  rootFileId: string;
  requestedBy: string;
  selectionDigest: string;
  status: 'queued' | 'leased' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  objectPath: string | null;
  /** A GCS generation stays a string: 64 bits does not survive a JS number. */
  objectGeneration: string | null;
  entryCount: number | null;
  sizeBytes: number | null;
  phase: string | null;
  phaseState: unknown;
  failureCode: string | null;
  failureDetail: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const iso = (value: any) => (value instanceof Date ? value.toISOString() : value || null);

function mapJob(row: any): ExportJob | null {
  if (!row) return null;
  return {
    id: row.id,
    lawFirmId: row.law_firm_id,
    rootFileId: row.root_file_id,
    requestedBy: row.requested_by,
    selectionDigest: row.selection_digest,
    status: row.status,
    attempt: Number(row.attempt || 0),
    nextAttemptAt: iso(row.next_attempt_at),
    leaseOwner: row.lease_owner || null,
    leaseToken: row.lease_token || null,
    leaseExpiresAt: iso(row.lease_expires_at),
    objectPath: row.object_path || null,
    objectGeneration: row.object_generation === null || row.object_generation === undefined
      ? null : String(row.object_generation),
    entryCount: row.entry_count === null || row.entry_count === undefined
      ? null : Number(row.entry_count),
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined
      ? null : Number(row.size_bytes),
    phase: row.phase || null,
    phaseState: row.phase_state ?? null,
    failureCode: row.failure_code || null,
    failureDetail: row.failure_detail || null,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Commit an export, or return the one already committed for this selection.
 *
 * The conflict target is the live-selection index, so two clicks on the same
 * Download return one job. A second job would archive the same folder again,
 * charge the transfer twice, and leave two objects where one is ever fetched.
 *
 * The sources are inserted in the SAME transaction as the job that owns them: a
 * job whose selection rows never landed is a job that archives the whole folder
 * instead of the four documents somebody ticked.
 */
export async function enqueueExportJob(lawFirmId: string, input: {
  rootFileId: string;
  requestedBy: string;
  selectionDigest: string;
  sourceFileIds?: string[];
  ttlMs: number;
}, executor: any = null): Promise<ExportJob | null> {
  const { rows } = await run(executor,
    `insert into file_export_jobs
       (law_firm_id, root_file_id, requested_by, selection_digest, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5::double precision))
     on conflict do nothing
     returning *`,
    [lawFirmId, input.rootFileId, input.requestedBy, input.selectionDigest, input.ttlMs / 1000],
  );

  if (!rows[0]) {
    const { rows: existing } = await run(executor,
      `select * from file_export_jobs
        where law_firm_id = $1 and requested_by = $2 and root_file_id = $3
          and selection_digest = $4 and status in ('queued', 'leased')
        limit 1`,
      [lawFirmId, input.requestedBy, input.rootFileId, input.selectionDigest],
    );
    return mapJob(existing[0]);
  }

  const sources = (input.sourceFileIds || []).filter(isUuid);
  if (sources.length) {
    await run(executor,
      `insert into file_export_job_sources (law_firm_id, job_id, file_id)
       select $1, $2, unnest($3::uuid[])
       on conflict do nothing`,
      [lawFirmId, rows[0].id, sources],
    );
  }
  return mapJob(rows[0]);
}

/** The files a multi-select export named. Empty means the whole subtree. */
export async function listExportJobSources(lawFirmId: string, jobId: string): Promise<string[]> {
  if (!isUuid(lawFirmId) || !isUuid(jobId)) return [];
  const { rows } = await run(null,
    `select file_id from file_export_job_sources
      where law_firm_id = $1 and job_id = $2
      order by file_id`,
    [lawFirmId, jobId],
  );
  return rows.map((row: any) => row.file_id);
}

/**
 * Take the next job that is ready, with a lease.
 *
 * `for update skip locked` is what lets several instances poll this table
 * without serializing on it: a row another worker is claiming is skipped rather
 * than waited for. A job whose lease has expired is claimable again, which is
 * how work escapes a worker that died holding it.
 */
export async function claimExportJob(owner: string, leaseSeconds: number): Promise<ExportJob | null> {
  const { rows } = await run(null,
    `update file_export_jobs j
        set status = 'leased',
            lease_owner = $1,
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => $2::double precision),
            attempt = j.attempt + 1
      where j.id = (
        select id from file_export_jobs
         where (status = 'queued' and next_attempt_at <= now())
            or (status = 'leased' and lease_expires_at < now())
         order by next_attempt_at
         limit 1
         for update skip locked
      )
      returning *`,
    [owner, leaseSeconds],
  );
  return mapJob(rows[0]);
}

/**
 * Claim ONE named job, if it is free.
 *
 * Returns null when another worker already holds it, which is not an error: the
 * caller reports the export as in progress and the client polls.
 */
export async function claimExportJobById(
  lawFirmId: string,
  jobId: any,
  owner: string,
  leaseSeconds: number,
): Promise<ExportJob | null> {
  if (!isUuid(lawFirmId) || !isUuid(jobId)) return null;
  const { rows } = await run(null,
    `update file_export_jobs
        set status = 'leased',
            lease_owner = $3,
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + make_interval(secs => $4::double precision),
            attempt = attempt + 1
      where law_firm_id = $1 and id = $2
        and (status = 'queued' or (status = 'leased' and lease_expires_at < now()))
      returning *`,
    [lawFirmId, jobId, owner, leaseSeconds],
  );
  return mapJob(rows[0]);
}

/**
 * Extend a lease, if it is still ours.
 *
 * False means the job was taken away. A worker that keeps going after that is
 * doing work nobody will accept.
 */
export async function renewExportLease(jobId: string, leaseToken: string, leaseSeconds: number) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const { rowCount } = await run(null,
    `update file_export_jobs
        set lease_expires_at = now() + make_interval(secs => $3::double precision)
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken, leaseSeconds],
  );
  return rowCount > 0;
}

/**
 * Record how far the archive has got, if the lease is still ours.
 *
 * Called once per manifest page, which makes it the cheap place a running
 * worker learns it has been cancelled or replaced: the same statement that
 * saves progress answers whether progress is still wanted.
 */
export async function checkpointExportJob(
  jobId: string,
  leaseToken: string,
  phase: string,
  phaseState: unknown,
) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const { rowCount } = await run(null,
    `update file_export_jobs
        set phase = $3, phase_state = $4
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken, phase, JSON.stringify(phaseState ?? null)],
  );
  return rowCount > 0;
}

/**
 * Point the row at a finished archive, if the lease is still ours.
 *
 * The generation is recorded beside the path so a URL minted for this archive
 * serves exactly the bytes that were published, whatever is written later.
 */
export async function publishExportJob(jobId: string, leaseToken: string, output: {
  objectPath: string;
  objectGeneration: string;
  entryCount: number;
  sizeBytes: number;
}) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const { rowCount } = await run(null,
    `update file_export_jobs
        set status = 'succeeded',
            object_path = $3, object_generation = $4,
            entry_count = $5, size_bytes = $6,
            lease_token = null, lease_owner = null, lease_expires_at = null,
            failure_code = null, failure_detail = null
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken, output.objectPath, output.objectGeneration,
      output.entryCount, output.sizeBytes],
  );
  return rowCount > 0;
}

/**
 * Record a failure, if the lease is still ours.
 *
 * A retryable failure goes back to `queued` with a later `next_attempt_at`; a
 * permanent one is `failed` and stays for a person to look at. Failed work is
 * kept rather than deleted, because the row is the only record that an archive
 * was ever owed.
 */
export async function failExportJob(jobId: string, leaseToken: string, failure: {
  code: string;
  detail?: string;
  retryInSeconds?: number | null;
}) {
  if (!isUuid(jobId) || !isUuid(leaseToken)) return false;
  const retry = failure.retryInSeconds;
  const { rowCount } = await run(null,
    `update file_export_jobs
        set status = case when $3::double precision is null then 'failed' else 'queued' end,
            next_attempt_at = case
              when $3::double precision is null then next_attempt_at
              else now() + make_interval(secs => $3::double precision) end,
            lease_token = null, lease_owner = null, lease_expires_at = null,
            failure_code = $4, failure_detail = $5
      where id = $1 and lease_token = $2 and status = 'leased'`,
    [jobId, leaseToken, retry ?? null, failure.code, (failure.detail || '').slice(0, 500)],
  );
  return rowCount > 0;
}

/**
 * Stop a live export.
 *
 * Clearing the lease token is the operative part, not the status: it is what
 * stops a worker already inside the archive from publishing when it finishes.
 * Marking an intent that the worker never reads would leave the archive built,
 * paid for and pointed at.
 */
export async function cancelExportJobs(lawFirmId: string, scope: {
  jobId?: string | null;
  requestedBy?: string | null;
}) {
  const jobId = scope.jobId && isUuid(scope.jobId) ? scope.jobId : null;
  const { rowCount } = await run(null,
    `update file_export_jobs
        set status = 'cancelled', lease_token = null, lease_owner = null, lease_expires_at = null
      where law_firm_id = $1
        and status in ('queued', 'leased')
        and ($2::uuid is null or id = $2)
        and ($3::text is null or requested_by = $3)`,
    [lawFirmId, jobId, scope.requestedBy || null],
  );
  return rowCount;
}

export async function getExportJob(lawFirmId: string, id: any): Promise<ExportJob | null> {
  if (!isUuid(lawFirmId) || !isUuid(id)) return null;
  const { rows } = await run(null,
    `select * from file_export_jobs where law_firm_id = $1 and id = $2 limit 1`,
    [lawFirmId, id],
  );
  return mapJob(rows[0]);
}

/** How many exports are waiting, for the drain's own report. */
export async function countReadyExportJobs(): Promise<number> {
  const { rows } = await run(null,
    `select count(*)::int as n from file_export_jobs
      where (status = 'queued' and next_attempt_at <= now())
         or (status = 'leased' and lease_expires_at < now())`,
  );
  return rows[0]?.n || 0;
}

/** Archives whose TTL has run out and whose bytes are still in the bucket. */
export async function expiredExportObjects(limit: number): Promise<ExportJob[]> {
  const { rows } = await run(null,
    `select * from file_export_jobs
      where object_path is not null and expires_at <= now()
      order by expires_at
      limit $1`,
    [Math.max(1, Math.floor(limit))],
  );
  return rows.map(mapJob).filter(Boolean) as ExportJob[];
}

/**
 * Forget an archive this row pointed at.
 *
 * Unconditional on the lease: the job is already settled, and the sweeper is
 * not competing with a worker for it. Clearing the path is what makes the
 * status route answer "expired" instead of minting a URL for bytes that are no
 * longer in the bucket.
 */
export async function clearExportObject(jobId: string) {
  if (!isUuid(jobId)) return false;
  const { rowCount } = await run(null,
    `update file_export_jobs
        set object_path = null, object_generation = null
      where id = $1 and object_path is not null`,
    [jobId],
  );
  return rowCount > 0;
}
