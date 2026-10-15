/**
 * The two-step upload: `POST /upload-init` then `POST /upload-finalize`.
 *
 * Large files never pass through the backend. Init authorizes the upload,
 * reserves the declared bytes against the firm's quota and hands the browser a
 * resumable URL per file; the browser PUTs straight to storage; finalize then
 * verifies what actually landed and reconciles the reservation. Between those
 * two requests the server knows nothing, which is what makes finalize the
 * interesting half: everything it is told about the upload arrives from the
 * client, and the only facts it can check for itself are the ones storage
 * reports back.
 *
 * Three of those checks exist because the alternative is somebody else's bytes
 * or somebody else's quota:
 *
 *   - the object must sit inside the scope the caller was authorized for,
 *   - the object must carry THIS caller's `uploadedBy` stamp, so a finalize
 *     cannot adopt a colleague's object and re-point the mirrored row at itself,
 *   - the ACTUAL size is re-checked against the plan's per-file cap, because
 *     init only ever saw a number the client typed and the resumable URL carries
 *     no ceiling of its own.
 *
 * The browser's half is `completeResumableUpload` in `./richBucket`, deliberately
 * outside the routes: an object created by calling an upload route could not
 * express "finalize something another person's session opened".
 */
import {
  objects,
  putObject,
} from '../support/inMemoryBucket';
import {
  createFirm,
  ownerOf,
  memberWith,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  installRichBucket,
  resetRichBucket,
  completeResumableUpload,
  resumableUploadFault,
} from './richBucket';
import { gateMethod } from '../support/gate';
import {
  fileRowById,
  joinMatter,
  rootOf,
  seedFile,
  seedMatter,
  storageReservedBytes,
  storageUsedBytes,
  treeUnder,
} from './fileWorld';

const filesRepo = require('../../src/modules/files/files.repository');

installRichBucket();

let firm: Firm;
let owner: Actor;
/** A second, fully entitled member of the SAME firm and the same matter. */
let colleague: Actor;
let matterId: string;
let root: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

/** The per-file plan ceiling for the fixture firm's plan (enterprise, 10 GB). */
const PLAN_FILE_CAP = 10737418240;

interface DeclaredFile { name: string; size: number; contentType?: string }

const initFor = (actor: Actor, files: DeclaredFile[], extra: Record<string, unknown> = {}) =>
  actor.api.post(`${F()}/upload-init`)
    .send({ context: 'matter', matterId, files, ...extra });

const init = (files: DeclaredFile[], extra: Record<string, unknown> = {}) =>
  initFor(owner, files, extra);

const finalizeFor = (actor: Actor, uploads: unknown[], extra: Record<string, unknown> = {}) =>
  actor.api.post(`${F()}/upload-finalize`)
    .send({ context: 'matter', matterId, uploads, ...extra });

const finalize = (uploads: unknown[], extra: Record<string, unknown> = {}) =>
  finalizeFor(owner, uploads, extra);

/** Row count for one object path: the mirror upserts, so this must stay 1. */
async function mirrorRowCount(objectPath: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from files where law_firm_id = $1 and object_path = $2',
    [firm.id, objectPath],
  );
  return rows[0].n;
}

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  root = await rootOf(firm.id, { matterId });

  colleague = await memberWith(firm.id, ['files.view', 'files.upload', 'files.manageFolders']);
  await joinMatter(firm.id, matterId, colleague.uid);
});

// ---------------------------------------------------------------------------

describe('opening the upload', () => {
  it('refuses an upload-init request with no files', async () => {
    const res = await owner.api.post(`${F()}/upload-init`)
      .send({ context: 'matter', matterId, files: [] });

    expect(res.status).toBe(400);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('refuses a caller without files.upload before reserving quota', async () => {
    const reader = await memberWith(firm.id, ['files.view']);

    const res = await reader.api.post(`${F()}/upload-init`).send({
      context: 'matter', matterId, files: [{ name: 'Nope.pdf', size: 10 }],
    });

    expect(res.status).toBe(403);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('refuses a matter id owned by another firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const foreignMatterId = await seedMatter(otherFirm.id, otherOwner.uid, 'Foreign Matter');

    const res = await owner.api.post(`${F()}/upload-init`).send({
      context: 'matter', matterId: foreignMatterId,
      files: [{ name: 'Foreign.pdf', size: 10 }],
    });

    expect(res.status).toBe(404);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('refuses an unsupported upload context without creating a session', async () => {
    const res = await owner.api.post(`${F()}/upload-init`).send({
      context: 'organization', matterId, files: [{ name: 'Wrong-context.pdf', size: 10 }],
    });

    expect(res.status).toBe(400);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('mints one destination per declared file, named after its own row', async () => {
    const res = await init([
      { name: 'Complaint.pdf', size: 2048, contentType: 'application/pdf' },
      { name: 'Exhibits.pdf', size: 4096, contentType: 'application/pdf' },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.uploads.map((u: any) => u.name)).toEqual(['Complaint.pdf', 'Exhibits.pdf']);
    // The object is named after the row, not after the file. That is what makes
    // a later rename or move free: the bytes never have to be copied anywhere.
    for (const upload of res.body.uploads) {
      expect(upload.objectPath).toBe(`lawfirmids/${firm.id}/objects/${upload.fileId}`);
    }
    expect(res.body.uploads[0].uploadUrl).toEqual(expect.any(String));
  });

  it('reserves the declared bytes before any of them exist', async () => {
    await init([{ name: 'Complaint.pdf', size: 2048 }, { name: 'Exhibits.pdf', size: 4096 }]);

    // The reservation is the whole point of splitting the request in two: the
    // bytes go straight to storage, so a firm at its limit has to be stopped
    // here or not at all. Nothing has been uploaded at this point, so the two
    // rows are claims on names rather than documents, and the bytes are HELD
    // rather than used: the firm has saved nothing yet.
    expect(await storageReservedBytes(firm.id)).toBe(2048 + 4096);
    expect(await storageUsedBytes(firm.id)).toBe(0);
    expect(await treeUnder(firm.id, root)).toEqual([]);
  });

  it('releases the full quota reservation when a storage session cannot be opened', async () => {
    resumableUploadFault.remaining = 1;

    const res = await init([
      { name: 'First.pdf', size: 2048 },
      { name: 'Second.pdf', size: 4096 },
    ]);

    expect(res.status).toBe(503);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await storageUsedBytes(firm.id)).toBe(0);
    expect(resumableUploadFault.remaining).toBe(0);
    // The rows claimed before the failure go with the reservation. Left behind,
    // each would hold its name in the folder for a day until the sweeper found
    // it, and a retry of the same upload would land as "First (1).pdf".
    const { rows } = await testPool.query(
      'select count(*)::int n from files where parent_id = $1', [root],
    );
    expect(rows[0].n).toBe(0);
  });

  it('gives two same-named files in ONE request different names', async () => {
    const res = await init([
      { name: 'Notice.pdf', size: 1024 },
      { name: 'Notice.pdf', size: 2048 },
    ]);

    // Both rows are inserted against a unique index on (parent, name), so the
    // second insert loses and retries with the next free name. Under the old
    // design the resolver probed storage for an occupied path, saw nothing
    // because no bytes existed yet, and handed both files the same destination:
    // the browser PUT both to it, the second replaced the first, and the firm
    // was charged for both.
    expect(res.body.uploads.map((u: any) => u.name)).toEqual(['Notice.pdf', 'Notice (1).pdf']);
    expect(new Set(res.body.uploads.map((u: any) => u.objectPath)).size).toBe(2);
  });

  it('gives two same-named files in two SIMULTANEOUS requests different names', async () => {
    // The case the old design could not win at all: two people, two requests,
    // one filename, no ordering between them. Nothing in the application decides
    // this; the unique index does, which is why it cannot be raced.
    const [a, b] = await Promise.all([
      init([{ name: 'Notice.pdf', size: 1024 }]),
      init([{ name: 'Notice.pdf', size: 2048 }]),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const names = [a.body.uploads[0].name, b.body.uploads[0].name].sort();
    expect(names).toEqual(['Notice (1).pdf', 'Notice.pdf']);
    expect(a.body.uploads[0].objectPath).not.toBe(b.body.uploads[0].objectPath);
  });

  it('keeps traversal-shaped filenames from becoming path segments', async () => {
    const res = await init([
      { name: '../outside.pdf', size: 10 },
      { name: 'nested/other.pdf', size: 20 },
      { name: '..', size: 30 },
    ]);

    expect(res.status).toBe(200);
    for (const upload of res.body.uploads) {
      // The object path is built from the firm and the row id, so a filename
      // cannot reach it at all. The NAME is what the person typed, sanitized.
      expect(upload.objectPath).toBe(`lawfirmids/${firm.id}/objects/${upload.fileId}`);
      expect(upload.name).not.toContain('/');
      expect(upload.name).not.toMatch(/(^|\/)\.\.($|\/)/);
    }
  });

  it('keeps both files when the browser PUTs to the destinations it was given', async () => {
    // The consequence, driven end to end. Comparing the two names proves they
    // differ; only completing and finalizing both proves the firm actually keeps
    // two documents.
    const opened = await init([
      { name: 'Notice.pdf', size: 10 },
      { name: 'Notice.pdf', size: 20 },
    ]);
    for (const u of opened.body.uploads) {
      completeResumableUpload(u.objectPath, { bytes: u.declaredSize });
    }

    const res = await finalize(opened.body.uploads.map((u: any) => ({
      fileId: u.fileId, objectPath: u.objectPath, declaredSize: u.declaredSize,
    })));

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(res.body.failures).toEqual([]);
    expect(await treeUnder(firm.id, root)).toEqual(['Notice (1).pdf', 'Notice.pdf']);
  });

  it('resolves around a name an EARLIER upload already took', async () => {
    const opened = await init([{ name: 'Notice.pdf', size: 1024 }]);
    completeResumableUpload(opened.body.uploads[0].objectPath, { bytes: 1024 });
    await finalize([{ fileId: opened.body.uploads[0].fileId, objectPath: opened.body.uploads[0].objectPath, declaredSize: 1024 }]);

    const second = await init([{ name: 'Notice.pdf', size: 2048 }]);

    expect(second.body.uploads[0].name).toBe('Notice (1).pdf');
  });
});

describe('two uploads racing the same quota', () => {
  it('cannot both reserve past a hard limit, even started at the same instant', async () => {
    // A ceiling two 100-byte declarations cannot both fit under: reserving both
    // would land at 200, ten bytes over a 190-byte cap.
    await testPool.query(
      'update law_firms set storage_quota_bytes = $2, storage_hard_limit = true where id = $1',
      [firm.id, 190],
    );

    // Fired together, not awaited one after another: the check-then-write race
    // this guards against only exists when both requests are in flight against
    // the SAME firm row at once. `reserveStorageUsage` locks the firm row, sums
    // the live reservations and inserts its own in ONE transaction, so that
    // row lock is the arbiter -- no test-side gate is needed to force the
    // overlap, only to fire both requests concurrently and let the database
    // serialize them.
    const [resA, resB] = await Promise.all([
      init([{ name: 'A.pdf', size: 100 }]),
      initFor(colleague, [{ name: 'B.pdf', size: 100 }]),
    ]);

    // Exactly one caller gets to reserve. The reservation is atomic per request,
    // so "both succeeded" would mean the SQL statement stopped being the single
    // source of truth for the limit -- the same overcommit bug the reservation
    // was built to close, just with two real requests instead of a unit test of
    // the SQL.
    expect([resA.status, resB.status].sort()).toEqual([200, 413]);
    expect(await storageReservedBytes(firm.id)).toBe(100);
    expect(await storageUsedBytes(firm.id)).toBe(0);
  });

  it('lets both through when there really is room for both', async () => {
    await testPool.query(
      'update law_firms set storage_quota_bytes = $2, storage_hard_limit = true where id = $1',
      [firm.id, 200],
    );

    const [resA, resB] = await Promise.all([
      init([{ name: 'A.pdf', size: 100 }]),
      initFor(colleague, [{ name: 'B.pdf', size: 100 }]),
    ]);

    // The flip side of the case above: a tight but sufficient limit must not
    // reject a legitimate second uploader just because two requests overlapped.
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(await storageReservedBytes(firm.id)).toBe(200);
  });
});

describe('finalizing an upload of your own', () => {
  it('mirrors the landed object into the files table', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    const res = await finalize([{ fileId, objectPath, declaredSize }]);

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
    expect(res.body.failures).toEqual([]);
    expect(await fileRowById(firm.id, res.body.files[0].fileId))
      .toMatchObject({ name: 'Complaint.pdf', size_bytes: '2048', matter_id: matterId });
  });

  it('leaves the quota at the bytes that actually landed', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    await finalize([{ fileId, objectPath, declaredSize }]);

    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });
});

describe('finalizing with a size that disagrees with the declaration', () => {
  it('gives back the difference when LESS landed than was declared', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 50_000 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 8_000 });

    const res = await finalize([{ fileId, objectPath, declaredSize }]);

    // Over-declaring is how a firm would otherwise be walked to its quota
    // ceiling by uploads that never happened. The reservation is replaced by the
    // real figure rather than merely topped up.
    expect(res.status).toBe(201);
    expect(await storageUsedBytes(firm.id)).toBe(8_000);
  });

  it('charges the real figure when MORE landed than was declared', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 1_000 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 90_000 });

    await finalize([{ fileId, objectPath, declaredSize }]);

    // The declared size is a number the client typed. Trusting it would let a
    // firm store ninety kilobytes and be billed for one.
    expect(await storageUsedBytes(firm.id)).toBe(90_000);
    expect(await fileRowById(firm.id, opened.body.uploads[0].fileId))
      .toMatchObject({ size_bytes: '90000' });
  });

  it('records the size storage reports, not the size the caller claims', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 1_000 }]);
    const { fileId, objectPath } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 4_096 });

    const res = await finalize([{ fileId, objectPath, declaredSize: 1_000, size: 12 }]);

    expect(res.body.files[0].size).toBe(4_096);
  });

  it('deletes an object that lands over the plan per-file ceiling', async () => {
    const opened = await init([{ name: 'Video.mp4', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: PLAN_FILE_CAP + 1 });

    const res = await finalize([{ fileId, objectPath, declaredSize }]);

    // Init only saw the declared 2 KB and the resumable URL has no ceiling of
    // its own, so under-declaring is the whole way past the plan cap. The object
    // is destroyed rather than merely refused: left in the bucket it would still
    // occupy the storage the cap exists to bound.
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(0);
    expect(res.body.failures[0].error).toMatch(/exceeds the .* per-file limit/i);
    expect(objects.has(objectPath)).toBe(false);
    expect((await fileRowById(firm.id, opened.body.uploads[0].fileId)).finalized_at).toBeNull();
  });

  it('does not charge the firm for an object it rejected as oversized', async () => {
    const opened = await init([{ name: 'Video.mp4', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: PLAN_FILE_CAP + 1 });

    await finalize([{ fileId, objectPath, declaredSize }]);

    expect(await storageUsedBytes(firm.id)).toBe(0);
  });

  it('rejects and deletes an object whose BYTES are an executable', async () => {
    const opened = await init([{ name: 'Retainer.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    // "MZ": a Windows executable renamed to .pdf. The name-and-mimetype
    // deny-list at init cannot see this, because at init there are no bytes yet.
    completeResumableUpload(objectPath, { bytes: 2048, head: Buffer.from('MZ\0\0\0\0', 'binary') });

    const res = await finalize([{ fileId, objectPath, declaredSize }]);

    expect(res.body.failures[0].error).toMatch(/Windows executable/i);
    expect(objects.has(objectPath)).toBe(false);
    expect((await fileRowById(firm.id, opened.body.uploads[0].fileId)).finalized_at).toBeNull();
  });

  it('reports an upload that never completed, and releases its reservation', async () => {
    const opened = await init([
      { name: 'Landed.pdf', size: 3_000 },
      { name: 'Abandoned.pdf', size: 7_000 },
    ]);
    const [landed, abandoned] = opened.body.uploads;
    completeResumableUpload(landed.objectPath, { bytes: 3_000 });

    const res = await finalize([
      { fileId: landed.fileId, objectPath: landed.objectPath, declaredSize: landed.declaredSize },
      { fileId: abandoned.fileId, objectPath: abandoned.objectPath, declaredSize: abandoned.declaredSize },
    ]);

    expect(res.body.count).toBe(1);
    expect(res.body.failures).toEqual([
      { objectPath: abandoned.objectPath, error: 'Object was not uploaded' },
    ]);
    // Both files were reserved at init; only one arrived. A release that skipped
    // the abandoned one would strand 7 KB of a firm's quota per failed upload.
    expect(await storageUsedBytes(firm.id)).toBe(3_000);
  });
});

describe('finalizing an upload somebody else started', () => {
  it('refuses to adopt a colleague object', async () => {
    const opened = await initFor(colleague, [{ name: 'Colleague Draft.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    const res = await finalize([{ fileId, objectPath, declaredSize }]);

    // The stamp is what ties an object to the session that opened it. Adopting
    // one re-points the mirrored row's `uploaded_by` at the adopter and counts
    // the same bytes into usage a second time.
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(0);
    expect(res.body.failures).toEqual([
      { objectPath, error: 'Object was not uploaded by you' },
    ]);
  });

  it('leaves the colleague object and its bookkeeping alone', async () => {
    const opened = await initFor(colleague, [{ name: 'Colleague Draft.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    await finalize([{ fileId, objectPath, declaredSize }]);

    // The refusal must not take the bytes with it: the colleague is mid-upload,
    // and their own finalize still has to work.
    expect(objects.has(objectPath)).toBe(true);
    expect((await fileRowById(firm.id, opened.body.uploads[0].fileId)).finalized_at).toBeNull();
  });

  it('lets the person who opened the session finalize it', async () => {
    const opened = await initFor(colleague, [{ name: 'Colleague Draft.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    const res = await finalizeFor(colleague, [{ fileId, objectPath, declaredSize }]);

    // Without this the two refusals above pass equally well against a route that
    // refuses every finalize.
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
    const { rows } = await testPool.query(
      'select uploaded_by from files where law_firm_id = $1 and object_path = $2',
      [firm.id, objectPath],
    );
    expect(rows[0].uploaded_by).toBe(colleague.uid);
  });
});

describe('finalizing the same upload twice', () => {
  it('answers the second call the same way, with one row and one charge', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    const first = await finalize([{ fileId, objectPath, declaredSize }]);
    const second = await finalize([{ fileId, objectPath, declaredSize }]);

    // A retried finalize is ordinary: the client's first response can be lost to
    // a dropped connection while the request itself succeeded.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.count).toBe(1);
    // The mirror upserts on the object path. A second row would list the
    // document twice in the file browser with no way to tell the copies apart.
    expect(await mirrorRowCount(objectPath)).toBe(1);
    // The bytes added are the CHANGE against the stamped row, which the first
    // call already wrote at 2048, and the reservation the second call names is
    // already gone, so deleting it again releases nothing.
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });

  it('is not charged again when the second call declares nothing', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    await finalize([{ fileId, objectPath, declaredSize: 2048 }]);
    await finalize([{ fileId, objectPath }]);

    // The declaration is caller-supplied, so idempotency must not depend on the
    // client repeating it. Omitting `declaredSize` used to reconcile
    // `landed - 0` and add the bytes a second time. Only the change-based
    // charge can keep this at 2048.
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });

  it('does not charge twice when the two calls OVERLAP', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    // Both requests read the row as unfinalized before either stamps it. The
    // sequential case above cannot show this: by the time the second call
    // reads, the first has already written. A client that retries a slow
    // finalize while the first is still in flight is the ordinary way two
    // arrive together.
    const gate = gateMethod(filesRepo, 'finalize');
    const both = Promise.all([
      finalize([{ fileId, objectPath, declaredSize }]),
      finalize([{ fileId, objectPath, declaredSize }]),
    ]);
    await gate.arrived(2);
    gate.open();
    const [a, b] = await both;
    gate.restore();

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });

  it('charges only the difference when an object is replaced at the same path', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });
    await finalize([{ fileId, objectPath, declaredSize: 2048 }]);

    // Same path, bigger object. Counting the change rather than the whole object
    // has to move the figure by the difference, not to 2048 (no charge at all)
    // and not to 7168 (charged twice).
    completeResumableUpload(objectPath, { bytes: 5120 });
    await finalize([{ fileId, objectPath, declaredSize: 5120 }]);

    expect(await storageUsedBytes(firm.id)).toBe(5120);
  });

  it('agrees with the usage recount after a replayed finalize', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });
    await finalize([{ fileId, objectPath, declaredSize: 2048 }]);
    await finalize([{ fileId, objectPath }]);

    const res = await owner.api.get(`${F()}/usage?refresh=1`);

    // The recount walks the firm's prefix and states the truth. It used to be
    // the REPAIR for a drifted figure; now it is a cross-check that the running
    // figure never drifted in the first place, so both numbers are asserted.
    expect(res.status).toBe(200);
    expect(res.body.usedBytes).toBe(2048);
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });
});

// ---------------------------------------------------------------------------

describe('finalizing when the row cannot be stamped', () => {
  it('fails the upload rather than reporting a file nothing lists', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });
    // The row is gone under the request, which is the one way the stamp can
    // fail now that there is no separate mirror to fall out of step.
    await testPool.query('delete from files where id = $1', [fileId]);

    const res = await finalize([{ fileId, objectPath, declaredSize }]);

    // The old dual-write logged the failure and answered 201 with the file in
    // it, so the caller was told about a document no listing could show. The row
    // is the record now, so the upload has to fail.
    expect(res.body.files).toEqual([]);
    expect(res.body.failures).toHaveLength(1);
  });

  it('does not charge the firm for bytes it did not record', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath, declaredSize } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });
    await testPool.query('delete from files where id = $1', [fileId]);

    await finalize([{ fileId, objectPath, declaredSize }]);

    // The reservation is released and nothing is charged: usage tracks the rows,
    // and there is no row.
    expect(await storageUsedBytes(firm.id)).toBe(0);
  });
});

describe('finalizing bytes that were never reserved', () => {
  /**
   * The route once computed a release by summing `declaredSize` over the entries
   * in the REQUEST BODY, a caller-supplied number applied to the firm's usage
   * directly:
   *
   *     delta = landedActual - reservedDeclared
   *
   * An entry naming an in-scope object that was never uploaded lands nothing and
   * declares whatever the caller likes, so the delta went negative and the firm's
   * stored-byte figure fell by an attacker-chosen amount.
   *
   * Nothing a finalize names can lower usage now: in-flight bytes never enter
   * `storage_used_bytes`, finalize only ADDS what landed, and a reservation is
   * a row deleted by id and uploader. These cases assert the FIGURE, not the
   * response, because the route answers 201 with a failure listed either way.
   */
  it('refuses to finalize a row this caller never opened', async () => {
    const real = await seedFile(firm.id, { parentId: root, name: 'Real Document.pdf', bytes: 10_000_000 });
    expect(await storageUsedBytes(firm.id)).toBe(0);

    // A finalize now names a ROW, and the row carries the scope the caller was
    // granted. There is no path to invent: an id that is not this firm's finds
    // nothing, so the whole class of "claim credit for an object that was never
    // uploaded" is answered by the lookup rather than by an accounting bound.
    const res = await finalize([
      { fileId: '00000000-0000-4000-8000-000000000000', declaredSize: 9_000_000 },
    ]);

    // The route reports the miss rather than refusing the request, so a status
    // assertion here would pass against the broken code too.
    // It still has to be named as a failure, or the caller believes it was stored.
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(0);
    expect(res.body.failures).toHaveLength(1);
    expect(res.body.failures[0].error).toMatch(/not an upload of yours/i);
    expect(await storageUsedBytes(firm.id)).toBe(0);
    expect((await fileRowById(firm.id, real.id)).finalized_at).toBeTruthy();
  });

  it('does not credit a firm for twenty phantom rows at once', async () => {
    // The array holds up to twenty entries and the per-entry cap is the plan's
    // file ceiling, so one request could claim far more than any single file.
    const res = await finalize(Array.from({ length: 20 }, () => ({
      fileId: '00000000-0000-4000-8000-000000000000',
      declaredSize: 1_000_000,
    })));

    expect(res.body.failures).toHaveLength(20);
    expect(await storageUsedBytes(firm.id)).toBe(0);
  });

  it('gives an abandoned upload its reserved bytes back', async () => {
    // The other half, and why the settlement is bounded rather than refused: a
    // genuinely abandoned upload must still release its reservation, or a failed
    // browser upload leaks quota.
    const opened = await init([{ name: 'Abandoned.pdf', size: 4096 }]);
    expect(await storageReservedBytes(firm.id)).toBe(4096);

    const res = await finalize([
      {
        fileId: opened.body.uploads[0].fileId,
        objectPath: opened.body.uploads[0].objectPath,
        reservationId: opened.body.uploads[0].reservationId,
      },
    ]);

    expect(res.body.failures).toHaveLength(1);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await storageUsedBytes(firm.id)).toBe(0);
    // The row survives unfinalized. It is a claim on a name that no bytes ever
    // arrived for, and the sweeper collects it.
    expect((await fileRowById(firm.id, opened.body.uploads[0].fileId)).finalized_at).toBeNull();
  });

  it('releases only what is outstanding when the declaration is inflated', async () => {
    // One reservation of 4096, a finalize claiming 9,000,000. The declaration
    // is ignored entirely, so the figure stays at zero rather than going
    // negative.
    const opened = await init([{ name: 'Abandoned.pdf', size: 4096 }]);
    const untouched = await seedFile(firm.id, { parentId: root, name: 'Untouched.pdf', bytes: 5000 });

    await finalize([
      { fileId: opened.body.uploads[0].fileId, objectPath: opened.body.uploads[0].objectPath, declaredSize: 9_000_000 },
    ]);

    expect(await storageUsedBytes(firm.id)).toBe(0);
    // The document that was never part of this is still there, so the figure
    // above is the accounting being right rather than the tree being empty.
    expect(objects.has(untouched.objectPath)).toBe(true);
  });
});
