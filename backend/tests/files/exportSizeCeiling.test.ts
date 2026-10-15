/**
 * An export's byte ceiling, checked before any job exists.
 *
 * The archive is streamed one entry at a time, so size is not a memory problem.
 * It is a TIME problem: the drain runs inside one cron request, and a job that
 * cannot finish inside that budget retries from entry zero until its attempts
 * run out, re-transferring the whole selection each time. Refusing at enqueue
 * is the only point where that costs nothing.
 *
 * The ceiling is lowered for this file so a fixture can sit on either side of
 * it without describing twenty gigabytes.
 */
process.env.FILES_EXPORT_MAX_BYTES = '1000';

import {
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { testPool } from '../support/db';
import { installRichBucket, resetRichBucket } from './richBucket';
import { rootOf, seedFile, seedFolder, seedMatter } from './fileWorld';

installRichBucket();

const CEILING = 1000;

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;

const createJob = (body: Record<string, unknown>) => owner.api
  .post(`/api/lawfirms/${firm.id}/files/export-jobs?lawFirmId=${firm.id}`)
  .send(body);

const jobCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from file_export_jobs where law_firm_id = $1', [firm.id],
  );
  return rows[0].n;
};

beforeEach(async () => {
  resetRichBucket();
  firm = await createFirm({ name: 'Ceiling LLP' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hale v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });
});

describe('export byte ceiling', () => {
  it('reads its ceiling from the environment', () => {
    const { EXPORT_MAX_BYTES } = require('../../src/modules/files/zipExportJobs');
    expect(EXPORT_MAX_BYTES).toBe(CEILING);
  });

  it('refuses a folder whose documents add up past the ceiling, before any job exists', async () => {
    const big = await seedFolder(firm.id, { parentId: matterRoot, name: 'Discovery' });
    await seedFile(firm.id, { parentId: big.id, name: 'a.bin', bytes: CEILING });
    await seedFile(firm.id, { parentId: big.id, name: 'b.bin', bytes: 1 });

    const res = await createJob({ matterId, folderId: big.id });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('EXPORT_TOO_LARGE');
    expect(await jobCount()).toBe(0);
  });

  it('accepts a folder exactly at the ceiling', async () => {
    const edge = await seedFolder(firm.id, { parentId: matterRoot, name: 'Edge' });
    await seedFile(firm.id, { parentId: edge.id, name: 'a.bin', bytes: CEILING });

    const res = await createJob({ matterId, folderId: edge.id });

    expect(res.status).toBe(201);
    expect(await jobCount()).toBe(1);
  });

  it('refuses a selection whose files and folders add up past the ceiling', async () => {
    const folder = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: folder.id, name: 'Deed.pdf', bytes: 600 });
    const loose = await seedFile(firm.id, { parentId: matterRoot, name: 'Loose.pdf', bytes: 401 });

    const res = await createJob({ matterId, fileIds: [folder.id, loose.id] });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('EXPORT_TOO_LARGE');
    expect(await jobCount()).toBe(0);
  });

  it('counts a document once when it is selected alongside the folder that holds it', async () => {
    // The archive writes it once, so it must be charged against the ceiling
    // once. Counted twice, a selection well inside the ceiling is refused.
    const folder = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const deed = await seedFile(firm.id, { parentId: folder.id, name: 'Deed.pdf', bytes: 600 });

    const res = await createJob({ matterId, fileIds: [folder.id, deed.id] });

    expect(res.status).toBe(201);
  });

  it('does not count a document that was deleted', async () => {
    const folder = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: folder.id, name: 'Keep.pdf', bytes: 600 });
    const gone = await seedFile(firm.id, { parentId: folder.id, name: 'Gone.pdf', bytes: 600 });
    await testPool.query('update files set deleted_at = now() where id = $1', [gone.id]);

    expect((await createJob({ matterId, folderId: folder.id })).status).toBe(201);
    expect((await createJob({ matterId, fileIds: [folder.id] })).status).toBe(201);
  });
});
