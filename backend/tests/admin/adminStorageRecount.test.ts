/**
 * The storage recount, and the plan-usage sweep that reads what it wrote.
 *
 * `POST /lawfirms/:lawFirmId/storage/recount` is the repair tool for the one
 * number in the product that drifts on its own. An upload reserves bytes before
 * the write and releases them after a delete, so a process that dies between the
 * two leaves the firm's `storage_used_bytes` above what they are really holding.
 * The firm then hits a quota it is not using, or drifts the other way and
 * uploads past one it should have hit.
 *
 * The recount reads the file ROWS. It used to page the firm's whole storage
 * prefix and add up the objects, which counted things nobody could see: an
 * object left behind by an interrupted upload inflated a firm's figure
 * permanently, and the walk needed its own list of which prefixes were the
 * system's own so it did not bill a firm for our safety net. So the cases below
 * are about which rows count, not which paths do.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  type CallerAgent,
  type Firm,
} from '../support/setupInProcess';
import { platformAdmin } from '../support/rows';
import {
  rootOf, seedFile, seedFolder, seedMatter, seedReservation, storageReservationRows,
} from '../files/fileWorld';

let firmA: Firm;
let firmB: Firm;
let admin: CallerAgent;

/** Storage quota of the `enterprise` tier, which `createFirm` assigns. */
const ENTERPRISE_QUOTA_BYTES = 53687091200;

const storageRow = async (id: string) => {
  const { rows } = await testPool.query(
    `select storage_used_bytes, storage_file_count, storage_usage_recounted_at,
            settings ? 'storage' as has_storage_settings
       from law_firms where id = $1`,
    [id],
  );
  return rows[0];
};

/** Pre-seed a drifted figure, which is the state this route exists to repair. */
async function setDriftedUsage(lawFirmId: string, usedBytes: number): Promise<void> {
  await testPool.query(
    `update law_firms set storage_used_bytes = $2::bigint where id = $1`,
    [lawFirmId, usedBytes],
  );
}

/** One document in a firm's General Files. */
async function generalDoc(firm: Firm, name: string, bytes: number, opts: { finalized?: boolean } = {}) {
  const root = await rootOf(firm.id);
  return seedFile(firm.id, { parentId: root, name, bytes, finalized: opts.finalized });
}

const recount = (firmId: string) => admin.post(`/api/admin/lawfirms/${firmId}/storage/recount`);

beforeEach(async () => {
  firmA = await createFirm({ name: 'Storage Firm Alpha' });
  firmB = await createFirm({ name: 'Storage Firm Beta' });
  admin = (await platformAdmin('Storage Admin')).api;

  await drainEvents();
});

describe('recomputing a firm stored bytes', () => {
  it('replaces a drifted figure with the sum of what the firm actually holds', async () => {
    await generalDoc(firmA, 'contract.pdf', 4_000);
    await generalDoc(firmA, 'exhibit.png', 250);
    await generalDoc(firmA, 'intake.docx', 1_750);
    await setDriftedUsage(firmA.id, 9_999_999);

    const res = await recount(firmA.id);

    expect(res.status).toBe(200);
    expect(res.body.usedBytes).toBe(6_000);
    expect(res.body.fileCount).toBe(3);

    const row = await storageRow(firmA.id);
    // `storage_used_bytes` is what the upload gate reads between recounts, and
    // it is the only place this number is kept.
    expect(Number(row.storage_used_bytes)).toBe(6_000);
    expect(Number(row.storage_file_count)).toBe(3);
    expect(row.storage_usage_recounted_at).not.toBeNull();
    // The recount must NOT resurrect the retired `settings->'storage'` blob.
    //
    // Usage, quota and the hard-limit flag were mirrored there for readers that
    // predated the typed columns, and every write path paid for a jsonb merge to
    // maintain a copy nothing authoritative read. Migration 0192 gave the last
    // holdout (`warnAtPercent`) a column of its own and then deleted the key.
    //
    // This assertion is the one that goes red if someone reintroduces the
    // mirror, which is a tempting "fix" whenever a figure looks like it lives in
    // two places and only one was updated. It does not live in two places any
    // more.
    expect(row.has_storage_settings).toBe(false);
  });

  it('counts documents wherever in the tree they sit', async () => {
    const matterId = await seedMatter(firmA.id, (await ownerOf(firmA.id)).uid, 'Hale v. Denton');
    const matterRoot = await rootOf(firmA.id, { matterId });
    const folder = await seedFolder(firmA.id, { parentId: matterRoot, name: 'Discovery' });
    await seedFile(firmA.id, { parentId: folder.id, name: 'buried.pdf', bytes: 900 });
    await generalDoc(firmA, 'top.pdf', 100);

    const res = await recount(firmA.id);

    // One indexed sum over the firm's rows, so depth costs nothing. The old
    // walk paged the whole storage prefix and a firm with a hundred thousand
    // documents paid for every one of them on every recount.
    expect(res.body.usedBytes).toBe(1_000);
    expect(res.body.fileCount).toBe(2);
  });

  it('counts only the firm it was asked about', async () => {
    await generalDoc(firmA, 'mine.pdf', 1_000);
    await generalDoc(firmB, 'theirs.pdf', 8_000);
    await generalDoc(firmB, 'theirs-2.pdf', 8_000);

    const res = await recount(firmA.id);

    // Billing one firm for another's documents is the loudest way this can go
    // wrong. Firm B's own figure must also be untouched: the recount writes only
    // the firm it was asked about.
    expect(res.body.usedBytes).toBe(1_000);
    expect(Number((await storageRow(firmB.id)).storage_used_bytes)).toBe(0);
  });

  it('does not count folders as files', async () => {
    const root = await rootOf(firmA.id);
    const folder = await seedFolder(firmA.id, { parentId: root, name: 'Contracts' });
    await seedFolder(firmA.id, { parentId: folder.id, name: 'Signed' });
    await generalDoc(firmA, 'real.pdf', 2_048);

    const res = await recount(firmA.id);

    // The bytes cannot show this: a folder has none either way. The file COUNT
    // is the only thing that moves, and it is what the console displays beside
    // the usage bar.
    expect(res.body.fileCount).toBe(1);
    expect(res.body.usedBytes).toBe(2_048);
  });

  it('does not count an upload that never finished', async () => {
    await generalDoc(firmA, 'real.pdf', 1_000);
    await generalDoc(firmA, 'abandoned.pdf', 900_000, { finalized: false });

    const res = await recount(firmA.id);

    // `upload-init` claims a row before the bytes exist, so a closed browser tab
    // leaves one behind. The old walk counted its object and inflated the firm's
    // figure permanently, which is a large part of the drift this route exists
    // to repair.
    expect(res.body.usedBytes).toBe(1_000);
    expect(res.body.fileCount).toBe(1);
  });

  it('does not count a document the firm deleted', async () => {
    const filesRepo = require('../../src/modules/files/files.repository');
    await generalDoc(firmA, 'kept.pdf', 1_000);
    const binned = await generalDoc(firmA, 'binned.pdf', 5_000);
    await filesRepo.softDeleteSubtree(firmA.id, binned.id, null);

    const res = await recount(firmA.id);

    // A deleted document keeps its row and its bytes for the retention window,
    // so a firm can change their mind. They stop paying for it at the delete,
    // not at the destruction: nobody should pay for their own trash.
    expect(res.body.usedBytes).toBe(1_000);
    expect(res.body.fileCount).toBe(1);
  });

  it('reports zero for a firm holding nothing', async () => {
    await setDriftedUsage(firmA.id, 4_096);

    const res = await recount(firmA.id);

    // The drift is as often stale reservations on a firm that deleted
    // everything, and a recount that skipped the write when it found nothing
    // would leave exactly that firm stuck.
    expect(res.body.usedBytes).toBe(0);
    expect(Number((await storageRow(firmA.id)).storage_used_bytes)).toBe(0);
  });
});

describe('recounting with uploads in flight', () => {
  it('purges lapsed reservations and keeps live ones', async () => {
    const owner = await ownerOf(firmA.id);
    await seedReservation(firmA.id, owner.uid, 7_000, { expiresInMs: -60_000 });
    const live = await seedReservation(firmA.id, owner.uid, 3_000);
    // Another firm's lapsed row is not this recount's to touch.
    const ownerB = await ownerOf(firmB.id);
    const theirs = await seedReservation(firmB.id, ownerB.uid, 5_000, { expiresInMs: -60_000 });

    const res = await recount(firmA.id);

    expect(res.status).toBe(200);
    // The live row belongs to an upload still running, whose bytes the
    // recounted figure cannot include yet; dropping it would let a concurrent
    // upload past the limit.
    expect((await storageReservationRows(firmA.id)).map((r) => r.id)).toEqual([live]);
    expect((await storageReservationRows(firmB.id)).map((r) => r.id)).toEqual([theirs]);
  });

  it('does not count held bytes as used', async () => {
    const owner = await ownerOf(firmA.id);
    await generalDoc(firmA, 'contract.pdf', 4_000);
    await seedReservation(firmA.id, owner.uid, 3_000);

    const res = await recount(firmA.id);

    expect(res.body.usedBytes).toBe(4_000);
    expect(Number((await storageRow(firmA.id)).storage_used_bytes)).toBe(4_000);
  });
});

describe('the plan-usage sweep reads the recounted figure', () => {
  it('reports the number the recount wrote, not the one it replaced', async () => {
    await generalDoc(firmA, 'a.pdf', 3_000);
    await generalDoc(firmA, 'b.pdf', 3_000);
    await setDriftedUsage(firmA.id, 123_456_789);

    await recount(firmA.id);
    const res = await admin.get('/api/admin/plan-usage');

    const row = res.body.firms.find((f: any) => f.lawFirmId === firmA.id);
    // The two surfaces read different columns, and the sweep is where an admin
    // decides whether a firm needs an upgrade. If it kept serving the stale
    // figure, the repair would look like it had done nothing.
    expect(row.usage.storage.currentBytes).toBe(6_000);
    expect(row.usage.storage.limitBytes).toBe(ENTERPRISE_QUOTA_BYTES);
    expect(row.overLimit).toBe(false);
  });

  it('stops flagging a firm as over limit once the recount clears the drift', async () => {
    await generalDoc(firmA, 'small.pdf', 1_024);
    await setDriftedUsage(firmA.id, ENTERPRISE_QUOTA_BYTES + 1);

    const before = await admin.get('/api/admin/plan-usage');
    expect(before.body.firms.find((f: any) => f.lawFirmId === firmA.id).overLimit).toBe(true);

    await recount(firmA.id);
    const after = await admin.get('/api/admin/plan-usage');

    // Asserting the flag BEFORE as well as after. Without the first half this
    // passes on a sweep that never flags anything.
    expect(after.body.firms.find((f: any) => f.lawFirmId === firmA.id).overLimit).toBe(false);
    expect(after.body.firms.find((f: any) => f.lawFirmId === firmB.id).overLimit).toBe(false);
  });
});
