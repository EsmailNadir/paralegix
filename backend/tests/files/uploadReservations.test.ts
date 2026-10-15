/**
 * How an upload in flight holds the firm's storage quota.
 *
 * `storage_used_bytes` counts SAVED files only. An upload-init holds its
 * declared bytes as `storage_reservations` rows, one per file, each with an
 * expiry. Admission counts the saved bytes plus every LIVE reservation, so two
 * concurrent uploads still cannot both slip past a hard limit, but an upload
 * that is cancelled, fails or dies with a closed tab stops blocking the firm:
 * an explicit cancel frees it at once, and otherwise the row lapses.
 *
 * The failure this file exists to catch is quiet. A user starts a 5 GB upload,
 * cancels it, and the firm has lost 5 GB of quota with nothing on screen
 * saying why.
 */
import { objects } from '../support/inMemoryBucket';
import {
  createFirm,
  ownerOf,
  memberWith,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { completeResumableUpload, installRichBucket, resetRichBucket } from './richBucket';
import {
  fileRowById,
  joinMatter,
  rootOf,
  seedMatter,
  seedReservation,
  storageReservationRows,
  storageReservedBytes,
  storageUsedBytes,
  treeUnder,
} from './fileWorld';

installRichBucket();

let firm: Firm;
let owner: Actor;
let colleague: Actor;
let matterId: string;
let root: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

interface DeclaredFile { name: string; size: number; contentType?: string }

const initFor = (actor: Actor, files: DeclaredFile[]) =>
  actor.api.post(`${F()}/upload-init`).send({ context: 'matter', matterId, files });
const init = (files: DeclaredFile[]) => initFor(owner, files);

const finalizeFor = (actor: Actor, uploads: unknown[]) =>
  actor.api.post(`${F()}/upload-finalize`).send({ context: 'matter', matterId, uploads });
const finalize = (uploads: unknown[]) => finalizeFor(owner, uploads);

const cancelFor = (actor: Actor, uploads: unknown[], over: Record<string, unknown> = {}) =>
  actor.api.post(`${F()}/upload-cancel`).send({ context: 'matter', matterId, uploads, ...over });
const cancel = (uploads: unknown[]) => cancelFor(owner, uploads);

/** What a finalize or cancel echoes back for one opened upload. */
const echo = (u: any) => ({ fileId: u.fileId, objectPath: u.objectPath, reservationId: u.reservationId });

async function setHardLimit(quotaBytes: number) {
  await testPool.query(
    'update law_firms set storage_quota_bytes = $2, storage_hard_limit = true where id = $1',
    [firm.id, quotaBytes],
  );
}

async function claimedRowCount(): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int n from files where law_firm_id = $1 and kind = 'file'`, [firm.id],
  );
  return rows[0].n;
}

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Quota & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Ames v. Brody');
  root = await rootOf(firm.id, { matterId });

  colleague = await memberWith(firm.id, ['files.view', 'files.upload']);
  await joinMatter(firm.id, matterId, colleague.uid);
});

// ---------------------------------------------------------------------------

describe('opening an upload', () => {
  it('hands every upload its own reservation id, held by the caller', async () => {
    const res = await init([{ name: 'A.pdf', size: 100 }, { name: 'B.pdf', size: 200 }]);

    const ids = res.body.uploads.map((u: any) => u.reservationId);
    expect(ids.every((id: unknown) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    const rows = await storageReservationRows(firm.id);
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(rows.every((r) => r.created_by === owner.uid)).toBe(true);
  });
});

describe('what admission counts', () => {
  it('ignores a reservation past its expiry', async () => {
    await setHardLimit(10_000);
    // A crashed tab left this behind an hour ago. Counted, it would refuse the
    // upload below; it is exactly what the expiry exists to stop blocking.
    await seedReservation(firm.id, colleague.uid, 9_500, { expiresInMs: -60_000 });

    const res = await init([{ name: 'Brief.pdf', size: 1_000 }]);

    expect(res.status).toBe(200);
    // Purged by the admission that found it lapsed.
    expect((await storageReservationRows(firm.id)).map((r) => r.bytes)).toEqual([1_000]);
  });

  it('still refuses an upload a LIVE reservation leaves no room for', async () => {
    await setHardLimit(10_000);
    await seedReservation(firm.id, colleague.uid, 9_500);

    const res = await init([{ name: 'Brief.pdf', size: 1_000 }]);

    // The race guarantee: a colleague's upload in flight is holding that space.
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('STORAGE_LIMIT_EXCEEDED');
    // The message counts the held bytes, or it would claim 10 KB is free.
    expect(res.body.error).toMatch(/Current usage: 9\.28 KB/);
    expect(await claimedRowCount()).toBe(0);
  });

  it('refuses when saved bytes and live reservations together leave no room', async () => {
    await setHardLimit(10_000);
    await testPool.query('update law_firms set storage_used_bytes = 6000 where id = $1', [firm.id]);
    await seedReservation(firm.id, colleague.uid, 3_500);

    expect((await init([{ name: 'Brief.pdf', size: 1_000 }])).status).toBe(413);
    expect((await init([{ name: 'Note.pdf', size: 500 }])).status).toBe(200);
  });
});

describe('finalizing', () => {
  it('charges what landed and deletes the reservation', async () => {
    const opened = await init([{ name: 'Complaint.pdf', size: 2048 }]);
    completeResumableUpload(opened.body.uploads[0].objectPath, { bytes: 3000 });

    const res = await finalize(opened.body.uploads.map(echo));

    expect(res.status).toBe(201);
    expect(await storageUsedBytes(firm.id)).toBe(3000);
    expect(await storageReservationRows(firm.id)).toEqual([]);
  });

  it('still charges an upload whose reservation lapsed before it finished', async () => {
    const opened = await init([{ name: 'Slow.pdf', size: 2048 }]);
    completeResumableUpload(opened.body.uploads[0].objectPath, { bytes: 2048 });
    await testPool.query(
      `update storage_reservations set created_at = now() - interval '5 hours',
              expires_at = now() - interval '1 hour' where law_firm_id = $1`,
      [firm.id],
    );
    await setHardLimit(1_000);

    const res = await finalize(opened.body.uploads.map(echo));

    // Never refused for quota: the bytes are already stored, and refusing would
    // leave a file the firm holds and nothing lists.
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });

  it('does not let one member release another member reservation', async () => {
    const theirs = await initFor(colleague, [{ name: 'Theirs.pdf', size: 4096 }]);
    const mine = await init([{ name: 'Mine.pdf', size: 100 }]);
    completeResumableUpload(mine.body.uploads[0].objectPath, { bytes: 100 });

    await finalize([{ ...echo(mine.body.uploads[0]) },
      { fileId: theirs.body.uploads[0].fileId, reservationId: theirs.body.uploads[0].reservationId }]);

    expect(await storageReservedBytes(firm.id)).toBe(4096);
  });
});

describe('cancelling', () => {
  it('returns the firm to exactly where it was, and frees the name', async () => {
    const before = await storageUsedBytes(firm.id);
    const opened = await init([{ name: 'Retainer.pdf', size: 5_000_000 }]);
    // A partial upload may already have written an object.
    completeResumableUpload(opened.body.uploads[0].objectPath, { bytes: 1_000 });

    const res = await cancel(opened.body.uploads.map(echo));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 1 });
    expect(await storageUsedBytes(firm.id)).toBe(before);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await claimedRowCount()).toBe(0);
    expect(objects.has(opened.body.uploads[0].objectPath)).toBe(false);

    // The name the cancelled row claimed is free again at once, not after the
    // sweeper's 24 hours.
    const retry = await init([{ name: 'Retainer.pdf', size: 1_000 }]);
    expect(retry.body.uploads[0].name).toBe('Retainer.pdf');
  });

  it('cancels an upload whose bytes never started', async () => {
    const opened = await init([{ name: 'A.pdf', size: 100 }, { name: 'B.pdf', size: 200 }]);

    const res = await cancel(opened.body.uploads.map(echo));

    expect(res.body).toEqual({ cancelled: 2 });
    expect(await storageReservationRows(firm.id)).toEqual([]);
    expect(await treeUnder(firm.id, root)).toEqual([]);
  });

  it('never touches a finalized row', async () => {
    const opened = await init([{ name: 'Kept.pdf', size: 2048 }]);
    const upload = opened.body.uploads[0];
    completeResumableUpload(upload.objectPath, { bytes: 2048 });
    await finalize([echo(upload)]);

    const res = await cancel([echo(upload)]);

    expect(res.body).toEqual({ cancelled: 0 });
    expect((await fileRowById(firm.id, upload.fileId)).finalized_at).toBeTruthy();
    expect(objects.has(upload.objectPath)).toBe(true);
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });

  it('does not let another member cancel your upload', async () => {
    const opened = await init([{ name: 'Mine.pdf', size: 4096 }]);
    const upload = opened.body.uploads[0];
    completeResumableUpload(upload.objectPath, { bytes: 10 });

    const res = await cancelFor(colleague, [echo(upload)]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: 0 });
    expect(await storageReservedBytes(firm.id)).toBe(4096);
    expect((await fileRowById(firm.id, upload.fileId))).toBeTruthy();
    expect(objects.has(upload.objectPath)).toBe(true);
  });

  it('does not reach a row outside the scope the request was authorized for', async () => {
    const otherMatter = await seedMatter(firm.id, owner.uid, 'Other Matter');
    const opened = await init([{ name: 'Mine.pdf', size: 4096 }]);
    const upload = opened.body.uploads[0];

    const res = await cancelFor(owner, [{ fileId: upload.fileId }], { matterId: otherMatter });

    expect(res.body).toEqual({ cancelled: 0 });
    expect(await fileRowById(firm.id, upload.fileId)).toBeTruthy();
  });

  it('refuses a caller from another firm outright', async () => {
    const opened = await init([{ name: 'Mine.pdf', size: 4096 }]);
    const away = await createFirm();
    const awayOwner = await ownerOf(away.id);

    const res = await awayOwner.api.post(`${F()}/upload-cancel`)
      .send({ context: 'matter', matterId, uploads: opened.body.uploads.map(echo) });

    expect(res.status).toBe(403);
    expect(await storageReservedBytes(firm.id)).toBe(4096);
    expect(await claimedRowCount()).toBe(1);
  });

  it('refuses a member without files.upload', async () => {
    const reader = await memberWith(firm.id, ['files.view']);
    const opened = await init([{ name: 'Mine.pdf', size: 4096 }]);

    const res = await cancelFor(reader, opened.body.uploads.map(echo));

    expect(res.status).toBe(403);
    expect(await claimedRowCount()).toBe(1);
  });

  it('is harmless to repeat', async () => {
    const opened = await init([{ name: 'A.pdf', size: 100 }]);

    await cancel(opened.body.uploads.map(echo));
    const again = await cancel(opened.body.uploads.map(echo));

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ cancelled: 0 });
  });
});
