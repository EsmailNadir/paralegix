/**
 * Driving a folder export end to end from a spec.
 *
 * A folder download is no longer a response, so a spec can no longer assert one
 * response and be done. It asks for an export, runs the worker in the same
 * process, and then reads what the worker actually published: the job's own
 * outcome, the archive's bytes out of the bucket, and the filename the minted
 * URL forces on the browser.
 *
 * All four are separate on purpose. A request that was accepted says nothing
 * about whether the archive was built, an archive that exists says nothing about
 * whether anyone can fetch it, and the filename lives in the URL's disposition
 * rather than in any response header. Collapsing them back into one `status`
 * would let a spec assert a 201 and believe it had checked a download.
 */
import { objects, signedUrlCalls } from '../support/inMemoryBucket';
import { testPool } from '../support/db';


export interface ExportResult {
  /** What the request that ASKED for the archive answered with. */
  status: number;
  body: any;
  /** The job id, when one was created. */
  jobId: string | null;
  /** How the worker settled: succeeded, failed, queued, cancelled. */
  jobStatus: string | null;
  failureCode: string | null;
  /** The published archive's bytes, or null when nothing was published. */
  bytes: Buffer | null;
  /** The filename the minted download URL forces, or null when there is none. */
  filename: string | null;
}

const NOT_CREATED = (res: any): ExportResult => ({
  status: res.status,
  body: res.body,
  jobId: null,
  jobStatus: null,
  failureCode: null,
  bytes: null,
  filename: null,
});

/**
 * Ask for an export, run it, and report everything that came out.
 *
 * `base` lets a tenancy spec address another firm's mount, which is the whole
 * point of those cases: the request has to be made under a URL the caller is
 * entitled to use, naming a resource they are not.
 */
export async function exportArchive(
  lawFirmId: string,
  actor: { api: any },
  body: Record<string, unknown>,
  options: { base?: string } = {},
): Promise<ExportResult> {
  const base = options.base ?? `/api/lawfirms/${lawFirmId}/files`;

  const created = await actor.api
    .post(`${base}/export-jobs?lawFirmId=${lawFirmId}`)
    .send(body);
  if (created.status !== 201) return NOT_CREATED(created);

  const jobId = created.body.exportJobId;
  // Required here rather than at module scope. `files.storage.ts` resolves its
  // bucket handle ONCE, when it loads, so a module-scope require would capture
  // the harness's inert stub before the spec had a chance to install a working
  // one, and every archive would fail on a storage call that cannot work.
  // eslint-disable-next-line global-require -- see above
  const { runExportJobNow } = require('../../src/modules/files/zipExportJobs');
  await runExportJobNow(lawFirmId, jobId, 'spec-worker');

  const { rows } = await testPool.query(
    'select status, object_path, failure_code from file_export_jobs where id = $1',
    [jobId],
  );
  const row = rows[0];
  const bytes = row?.object_path
    ? ((objects.get(row.object_path)?.body as Buffer) ?? null)
    : null;

  // Read the job back through the route, because minting the URL is what
  // produces the filename and the route is the only thing that mints one.
  signedUrlCalls.length = 0;
  await actor.api.get(`${base}/export-job?lawFirmId=${lawFirmId}&jobId=${jobId}`);
  const disposition = String(signedUrlCalls.at(-1)?.config?.responseDisposition ?? '');
  const filename = /filename="([^"]*)"/.exec(disposition)?.[1] ?? null;

  return {
    status: created.status,
    body: created.body,
    jobId,
    jobStatus: row?.status ?? null,
    failureCode: row?.failure_code ?? null,
    bytes,
    filename,
  };
}
