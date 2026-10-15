/**
 * What happens when an archive is interrupted partway through building.
 *
 * A folder download used to be an HTTP stream, and this file used to be about
 * the two ways that stream could fail: the storage read dying after the
 * response had already committed to a 200 (so there was no status line left to
 * say the zip was broken), and the client hanging up while the server kept
 * reading from storage.
 *
 * Neither situation exists any more, because the archive is no longer a
 * response. It is a job that writes one object into storage, and the browser
 * fetches that object with a signed URL. But the DEFECTS both cases guarded
 * against survive the move, in a shape that is if anything easier to miss:
 *
 *   - a source read that fails partway must not leave a half-written archive
 *     anything can fetch, because a truncated zip reads as a complete one to
 *     whoever opens it and the missing documents are invisible;
 *   - a build that stops, for a failure or a cancellation, must close the
 *     storage read it had open, because `pipe()` never propagates a destroy
 *     back upstream and an abandoned source is a leaked connection per export.
 *
 * Every case below proves the OBSERVABLE thing rather than a promise settling:
 * whether an object exists in the bucket, whether `liveReadStreams` came back
 * to zero, and for the cross-firm case whether another firm's object was ever
 * TOUCHED (`filePathsAccessed`), not merely absent from an archive that a
 * failure might have stopped short of producing at all.
 */
import {
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects } from '../support/inMemoryBucket';
import {
  installRichBucket,
  resetRichBucket,
  zipEntryNames,
  zipEntrySizes,
  failReadStreamFrom,
  failWriteStreamFrom,
  slowReadStreamFrom,
  liveReadStreams,
  filePathsAccessed,
} from './richBucket';
import { exportArchive, type ExportResult } from './exportWorld';
import {
  rootOf,
  seedFile,
  seedFolder,
  seedMatter,
} from './fileWorld';

installRichBucket();

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

const downloadFolder = (folderId: string, actor: Actor = owner): Promise<ExportResult> =>
  exportArchive(firm.id, actor, { matterId, folderId });

const downloadZip = (fileIds: string[], actor: Actor = owner): Promise<ExportResult> =>
  exportArchive(firm.id, actor, { matterId, fileIds });

/** Every archive object currently in the bucket, whoever wrote it. */
const archiveObjects = () => [...objects.keys()].filter((path) => path.includes('/exports/'));

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });
});

// ---------------------------------------------------------------------------

describe('positive control: a clean export completes normally', () => {
  it('a single selected file arrives as a complete, valid archive', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 2048 });

    const res = await downloadZip([deed.id]);

    expect(res.jobStatus).toBe('succeeded');
    expect(zipEntryNames(res.bytes!)).toEqual(['Deed.pdf']);
    // Every read stream the worker opened was drained and closed: the baseline
    // `liveReadStreams` must return to against the fault-injected cases below.
    expect(liveReadStreams.size).toBe(0);
  });

  it('a multi-file folder arrives as a complete, valid archive', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 1024 });
    await seedFile(firm.id, { parentId: closing.id, name: 'Settlement.pdf', bytes: 512 });

    const res = await downloadFolder(closing.id);

    expect(res.jobStatus).toBe('succeeded');
    expect(zipEntryNames(res.bytes!)).toEqual(['Deed.pdf', 'Settlement.pdf']);
    expect(liveReadStreams.size).toBe(0);
  });
});

describe('a storage read failing partway through', () => {
  it('leaves no archive for a selection whose only source dies mid-read', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 4096 });
    failReadStreamFrom.set(deed.objectPath, 'GCS read failed mid-stream');

    const res = await downloadZip([deed.id]);

    // The job is the only record either way, so this is where "the download
    // failed" now lives. What must NOT happen is the half-written archive
    // staying in storage: the row would not point at it, but the object would
    // be there, billed, and fetchable by anything that learned its path.
    expect(res.jobStatus).toBe('queued');
    expect(res.bytes).toBeNull();
    expect(res.filename).toBeNull();
    expect(archiveObjects()).toEqual([]);
  });

  it('leaves no archive when a folder fails after some entries are already written', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const first = await seedFile(firm.id, { parentId: closing.id, name: 'A-First.pdf', bytes: 4096 });
    await seedFile(firm.id, { parentId: closing.id, name: 'B-Second.pdf', bytes: 1024 });
    failReadStreamFrom.set(first.objectPath, 'GCS read failed mid-stream');

    const res = await downloadFolder(closing.id);

    // The sharper half of the pair. A zip that already holds one valid entry
    // and stops is exactly the artifact that reads as complete, so "partial is
    // discarded" has to hold after real bytes have been written, not only
    // before the first one.
    expect(res.jobStatus).toBe('queued');
    expect(res.bytes).toBeNull();
    expect(archiveObjects()).toEqual([]);
  });

  it('destroys the failed read stream rather than leaking it', async () => {
    const deed = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 4096 });
    failReadStreamFrom.set(deed.objectPath, 'GCS read failed mid-stream');

    await downloadZip([deed.id]);

    expect(liveReadStreams.size).toBe(0);
  });

  it('closes the source it was reading when the archive write itself fails', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const big = await seedFile(firm.id, { parentId: closing.id, name: 'Big.pdf', bytes: 65536 });
    // Slow, so the read is genuinely IN FLIGHT when the write dies. Against an
    // instantly-drained source the teardown would have nothing left to close
    // and the assertion below would hold whether or not the code did anything.
    slowReadStreamFrom.add(big.objectPath);

    const created = await owner.api
      .post(`${F()}/export-jobs?lawFirmId=${firm.id}`)
      .send({ matterId, folderId: closing.id });
    // eslint-disable-next-line global-require -- see exportWorld for why this is not hoisted
    const { exportObjectPath, runExportJobNow } = require('../../src/modules/files/zipExportJobs');
    failWriteStreamFrom.set(exportObjectPath(firm.id, created.body.exportJobId), 'GCS write refused');

    const outcome = await runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');

    // Not 'lost': the lease was never taken away, the storage write failed. A
    // job that reported 'lost' here would be silently dropped instead of
    // retried.
    expect(outcome).toBe('retry');
    expect(liveReadStreams.size).toBe(0);
    expect(archiveObjects()).toEqual([]);
  });

  it('keeps the queue healthy: the next export still runs', async () => {
    const doomed = await seedFile(firm.id, { parentId: matterRoot, name: 'Doomed.pdf', bytes: 4096 });
    failReadStreamFrom.set(doomed.objectPath, 'GCS read failed mid-stream');
    await downloadZip([doomed.id]);

    // A failure that took the transfer slot with it, or left the archiver in a
    // state the next job inherited, would show up here and nowhere else.
    const fine = await seedFile(firm.id, { parentId: matterRoot, name: 'Fine.pdf', bytes: 512 });
    const res = await downloadZip([fine.id]);

    expect(res.jobStatus).toBe('succeeded');
    expect(zipEntryNames(res.bytes!)).toEqual(['Fine.pdf']);
  });
});

describe('the requester cancelling mid-build', () => {
  it('closes the storage read and publishes nothing', async () => {
    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    const big = await seedFile(firm.id, { parentId: closing.id, name: 'Big.pdf', bytes: 65536 });
    slowReadStreamFrom.add(big.objectPath);

    const created = await owner.api
      .post(`${F()}/export-jobs?lawFirmId=${firm.id}`)
      .send({ matterId, folderId: closing.id });
    expect(created.status).toBe(201);

    // eslint-disable-next-line global-require -- see exportWorld for why this is not hoisted
    const { runExportJobNow } = require('../../src/modules/files/zipExportJobs');
    const running = runExportJobNow(firm.id, created.body.exportJobId, 'worker-1');
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    const cancelled = await owner.api
      .post(`${F()}/export-job-cancel?lawFirmId=${firm.id}&jobId=${created.body.exportJobId}`)
      .send({});
    expect(cancelled.status).toBe(200);

    expect(await running).toBe('lost');
    expect(archiveObjects()).toEqual([]);
    // The reason this is asserted separately from the object: `pipe()` never
    // propagates a destroy back upstream, so tearing down the archiver alone
    // leaves the source still reading from storage. That leak is silent.
    expect(liveReadStreams.size).toBe(0);

    // And the server is still able to do the next one: a cancellation that took
    // the transfer slot with it would strand every export after it.
    const next = await downloadFolder(closing.id);
    expect(next.jobStatus).toBe('succeeded');
  });
});

describe('cross-firm isolation under interruption', () => {
  it('never touches another firm\'s colliding-named file, even when one of the caller\'s own files fails mid-archive', async () => {
    // Firm B has its own "Closing/Deed.pdf": same relative name, different
    // firm, different size. If entry construction ever fell back to a name-keyed
    // index, or if a fault partway through made the code reach past its own
    // scope, this is where it would show.
    const other = await createFirm({ name: 'Rival LLP' });
    const otherOwner = await ownerOf(other.id);
    const otherMatterId = await seedMatter(other.id, otherOwner.uid, 'Vance v. Orrick');
    const otherRoot = await rootOf(other.id, { matterId: otherMatterId });
    const theirClosing = await seedFolder(other.id, { parentId: otherRoot, name: 'Closing' });
    const theirDeed = await seedFile(other.id, { parentId: theirClosing.id, name: 'Deed.pdf', bytes: 9999 });

    const closing = await seedFolder(firm.id, { parentId: matterRoot, name: 'Closing' });
    await seedFile(firm.id, { parentId: closing.id, name: 'Deed.pdf', bytes: 111 });
    const other2 = await seedFile(firm.id, { parentId: closing.id, name: 'Other.pdf', bytes: 222 });
    // The fault lands on OUR OWN second file, not the colliding one, proving
    // isolation holds even while the archive build is actively failing, not just
    // in the easy case where nothing goes wrong.
    failReadStreamFrom.set(other2.objectPath, 'GCS read failed mid-stream');

    await downloadFolder(closing.id);

    expect(filePathsAccessed).not.toContain(theirDeed.objectPath);
    expect(filePathsAccessed.every((p) => p.startsWith(`lawfirmids/${firm.id}/`))).toBe(true);
  });

  it('a clean archive contains only the caller\'s own version of a colliding-named file', async () => {
    const other = await createFirm({ name: 'Rival LLP' });
    const otherOwner = await ownerOf(other.id);
    const otherMatterId = await seedMatter(other.id, otherOwner.uid, 'Vance v. Orrick');
    const otherRoot = await rootOf(other.id, { matterId: otherMatterId });
    const theirs = await seedFile(other.id, { parentId: otherRoot, name: 'Deed.pdf', bytes: 9999 });

    const mine = await seedFile(firm.id, { parentId: matterRoot, name: 'Deed.pdf', bytes: 111 });

    const res = await downloadZip([mine.id]);

    expect(res.jobStatus).toBe('succeeded');
    expect(zipEntryNames(res.bytes!)).toEqual(['Deed.pdf']);
    expect(zipEntrySizes(res.bytes!).get('Deed.pdf')).toBe(111);
    expect(filePathsAccessed).not.toContain(theirs.objectPath);
  });
});
