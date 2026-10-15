/**
 * What a firm is told it is storing, and whether that number moves with reality.
 *
 * The figure IS the rows now: one indexed sum over the firm's live, finalized
 * files. It used to be two numbers kept in step, a running
 * `law_firms.storage_used_bytes` and a periodic walk of every object under the
 * firm's storage prefix that replaced it. The walk grew with a firm's document
 * count on a page people open constantly, so it was cached for six hours, which
 * meant the figure on screen could be a day stale and nothing said so.
 *
 * The failure this file exists to catch is the quiet one. A number that only
 * ever goes up strands a firm at its ceiling on documents it has already thrown
 * away, and nothing on screen says why: the file browser is empty and the upload
 * button still refuses. A number that counts a NEIGHBOUR's bytes does the same
 * thing for a reason the firm cannot even see.
 *
 * So every figure here is driven through the real routes rather than seeded, and
 * every one is proved to move in BOTH directions. A rival firm's documents are
 * seeded in the same bucket throughout, because "the number is right" against a
 * bucket holding only one firm's files is true of a route that ignores the firm
 * entirely.
 */
import { objects } from '../support/inMemoryBucket';
import {
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { completeResumableUpload, installRichBucket, resetRichBucket } from './richBucket';
import {
  rootOf,
  seedFile,
  seedFolder,
  seedMatter,
  storageReservedBytes,
  storageUsedBytes,
  treeUnder,
} from './fileWorld';

installRichBucket();

let firm: Firm;
let owner: Actor;
let matterId: string;
let matterRoot: string;
let firmRoot: string;

/** A second firm, storing a great deal, in the same bucket. */
let rival: Firm;
let rivalOwner: Actor;
let rivalMatter: string;
let rivalObject: string;
const RIVAL_BYTES = 5_000_000;

const F = () => `/api/lawfirms/${firm.id}/files`;

const usage = () => owner.api.get(`${F()}/usage`);

/** An object placed straight into the bucket, with no row naming it. */
const putStrayObject = (path: string, bytes: number) => {
  objects.set(path, { bytes, contentType: 'application/pdf' } as any);
};

/**
 * One document, uploaded the way the product does it: init claims the row and
 * reserves the declared bytes, the browser PUTs straight to storage, finalize
 * stamps the row and reconciles.
 *
 * Driven end to end rather than seeded, because the reservation this file is
 * about only moves through those two requests.
 */
async function uploadTo(
  actor: Actor,
  context: 'matter' | 'lawfirm',
  name: string,
  size: number,
) {
  const body: Record<string, unknown> = { context, files: [{ name, size }] };
  if (context === 'matter') body.matterId = matterId;

  const opened = await actor.api.post(`${F()}/upload-init`).send(body);
  if (opened.status !== 200) return opened;

  for (const u of opened.body.uploads) {
    completeResumableUpload(u.objectPath, { bytes: u.declaredSize });
  }
  return actor.api.post(`${F()}/upload-finalize`).send({
    ...body,
    files: undefined,
    uploads: opened.body.uploads.map((u: any) => ({
      fileId: u.fileId, declaredSize: u.declaredSize, reservationId: u.reservationId,
    })),
  });
}

const uploadToMatter = (name: string, size: number) => uploadTo(owner, 'matter', name, size);

/** The id the firm would click on, found the way the browser finds it. */
async function fileIdByName(name: string, parentId: string) {
  const listed = await owner.api.get(`${F()}/list-folder?matterId=${matterId}&folderId=${parentId}`);
  const match = (listed.body.files || []).find((f: any) => f.name === name);
  return match?.id ?? null;
}

const deleteById = (fileId: string) => owner.api
  .delete(`${F()}/delete?lawFirmId=${firm.id}&matterId=${matterId}&fileId=${fileId}`);

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Hollis v. Denton');
  matterRoot = await rootOf(firm.id, { matterId });
  firmRoot = await rootOf(firm.id);

  rival = await createFirm({ name: 'Rival LLP' });
  rivalOwner = await ownerOf(rival.id);
  rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Vance v. Orrick');
  const rivalRoot = await rootOf(rival.id, { matterId: rivalMatter });
  const theirs = await seedFile(rival.id, {
    parentId: rivalRoot, name: 'Their Huge Discovery.zip', bytes: RIVAL_BYTES,
  });
  rivalObject = theirs.objectPath;
});

// ---------------------------------------------------------------------------

describe('the figure moves with the files', () => {
  it('reports nothing stored before anything is uploaded', async () => {
    const res = await usage();

    // Asserted first so the rises below are rises from a known floor, and so a
    // route that counted the whole bucket would fail here rather than passing
    // by coincidence later.
    expect(res.status).toBe(200);
    expect(res.body.usedBytes).toBe(0);
    expect(res.body.fileCount).toBe(0);
  });

  it('goes UP by the bytes an upload stored', async () => {
    await uploadToMatter('Complaint.pdf', 2048);

    const res = await usage();

    expect(res.body.usedBytes).toBe(2048);
    expect(res.body.fileCount).toBe(1);
  });

  it('goes back DOWN when the document is deleted', async () => {
    await uploadToMatter('Complaint.pdf', 2048);
    await uploadToMatter('Exhibits.pdf', 4096);
    expect((await usage()).body.usedBytes).toBe(2048 + 4096);

    const deleted = await deleteById((await fileIdByName('Complaint.pdf', matterRoot))!);
    const res = await usage();

    // The whole point. Both figures are read through the same route, one before
    // and one after, so neither can be right by accident.
    expect(deleted.status).toBe(200);
    expect(res.body.usedBytes).toBe(4096);
    expect(res.body.fileCount).toBe(1);
  });

  it('keeps the stored column in step with the sum', async () => {
    await uploadToMatter('Complaint.pdf', 2048);
    await deleteById((await fileIdByName('Complaint.pdf', matterRoot))!);

    // The delta bookkeeping is what the quota gate reads, so it has to land on
    // the same answer the sum over the rows does.
    expect(await storageUsedBytes(firm.id)).toBe(0);
    expect((await usage()).body.usedBytes).toBe(0);
  });

  it('does not credit back bytes twice for one delete', async () => {
    await uploadToMatter('Complaint.pdf', 2048);
    await uploadToMatter('Exhibits.pdf', 4096);
    const doomed = (await fileIdByName('Complaint.pdf', matterRoot))!;

    await deleteById(doomed);
    const second = await deleteById(doomed);

    // The second delete finds nothing and must change nothing. A credit applied
    // on a miss walks the figure below the truth and eventually to zero, which
    // hands the firm unlimited storage.
    expect(second.status).toBe(404);
    expect(await storageUsedBytes(firm.id)).toBe(4096);
  });
});

describe('the outstanding reservation balance', () => {
  /**
   * An upload holds its declared bytes as `storage_reservations` rows until
   * finalize deletes them. A row left standing holds quota the firm is not
   * using until it lapses, and admission counts it against a hard limit.
   *
   * Nothing a user sees would show that, which is why it is asserted here
   * rather than left to the paths that read it.
   */
  it('is zero on a firm that has uploaded nothing', async () => {
    expect(await storageReservedBytes(firm.id)).toBe(0);
  });

  it('returns to zero after an ordinary multipart upload', async () => {
    await uploadToMatter('Complaint.pdf', 2048);

    // The bytes landed, so they are charged as usage and the hold is deleted.
    // Both are asserted, because a finalize that dropped the reservation
    // without charging would zero the balance just as well and lose the firm's
    // bytes.
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await storageUsedBytes(firm.id)).toBe(2048);
  });

  it('returns to zero after a refused upload', async () => {
    const res = await uploadTo(owner, 'matter', 'setup.exe', 1024);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await storageUsedBytes(firm.id)).toBe(0);
  });

  it('does not accumulate across many uploads', async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- the repetition is the point
      await uploadToMatter(`Doc ${i}.pdf`, 1024);
    }

    expect(await storageReservedBytes(firm.id)).toBe(0);
    expect(await storageUsedBytes(firm.id)).toBe(4096);
  });
});

describe('whose bytes are counted', () => {
  it('ignores another firm documents entirely', async () => {
    await uploadToMatter('Complaint.pdf', 2048);

    const res = await usage();

    // The rival is storing five megabytes in the same bucket. A sum that
    // forgot its `law_firm_id` predicate reports 5 002 048 here.
    expect(res.body.usedBytes).toBe(2048);
    expect(objects.get(rivalObject)?.bytes).toBe(RIVAL_BYTES);
  });

  it('reports each firm its own figure', async () => {
    await uploadToMatter('Complaint.pdf', 2048);

    const mine = await usage();
    const theirs = await rivalOwner.api.get(`/api/lawfirms/${rival.id}/files/usage?lawFirmId=${rival.id}`);

    // Both sides, in one test: the rival's own figure proves their documents are
    // real and countable, so the absence above is a scoping decision rather than
    // an empty fixture.
    expect(mine.body.usedBytes).toBe(2048);
    expect(theirs.body.usedBytes).toBe(RIVAL_BYTES);
  });

  it('does not let one firm read another usage', async () => {
    const res = await owner.api.get(`/api/lawfirms/${rival.id}/files/usage?lawFirmId=${rival.id}`);

    expect(res.status).toBe(403);
  });

  it('serves usage to any member of the firm', async () => {
    const plain = await memberWith(firm.id, ['files.view']);
    await uploadToMatter('Complaint.pdf', 2048);

    const res = await plain.api.get(`${F()}/usage?lawFirmId=${firm.id}`);

    // The quota bar is on every file screen, so a read-only member has to see
    // it. Without this the refusal above would pass against a route that
    // refused everyone.
    expect(res.status).toBe(200);
    expect(res.body.usedBytes).toBe(2048);
  });

  it('serves usage to a member whose role never mentions files at all', async () => {
    const narrow = await memberWith(firm.id, ['matters.view']);
    await uploadToMatter('Complaint.pdf', 2048);

    const res = await narrow.api.get(`${F()}/usage?lawFirmId=${firm.id}`);

    // `files.view` is in the baseline every role carries and no role can drop,
    // so a member with a deliberately narrow role still reads the storage bar.
    // Pinned because it looks like a permission leak until you know that; the
    // enforcement boundary for files is the WRITE permissions, checked below.
    expect(res.status).toBe(200);
    expect(res.body.usedBytes).toBe(2048);
  });

  it('still refuses that member an upload', async () => {
    const narrow = await memberWith(firm.id, ['matters.view']);

    const res = await uploadTo(narrow, 'lawfirm', 'Planted.pdf', 1024);

    // The other half of the baseline rule: reading the page is free, writing is
    // not. Without this the case above would read as "the gate does nothing".
    expect(res.status).toBe(403);
    expect(await treeUnder(firm.id, firmRoot)).toEqual([]);
  });
});

describe('what does not count against a firm', () => {
  it('does not count a folder as a file', async () => {
    await seedFolder(firm.id, { parentId: matterRoot, name: 'Discovery' });
    await uploadToMatter('Complaint.pdf', 2048);

    const res = await usage();

    // A folder has no bytes, so it cannot move `usedBytes`. It must not move the
    // COUNT either, which is the number the UI renders as "N files". The old
    // marker object did move it, and the count read one high forever.
    expect(res.body.usedBytes).toBe(2048);
    expect(res.body.fileCount).toBe(1);
  });

  it('does not count an upload that never landed', async () => {
    await uploadToMatter('Complaint.pdf', 2048);
    // `upload-init` claims the row before the bytes exist. This one is claimed
    // and abandoned, exactly as a closed browser tab leaves it.
    await seedFile(firm.id, {
      parentId: matterRoot, name: 'Abandoned.pdf', bytes: 900_000, finalized: false,
    });

    const res = await usage();

    // An unfinalized row is not a document: no listing shows it and the sweeper
    // collects it. Charging for it bills a firm for a write that never finished.
    expect(res.body.usedBytes).toBe(2048);
    expect(res.body.fileCount).toBe(1);
  });

  it('does not bill a firm for the preserved records the system filed', async () => {
    await uploadToMatter('Complaint.pdf', 2048);
    // An executed document and its certificate, filed by the signatures module.
    // No listing reaches these and no route lets the firm delete one.
    putStrayObject(`lawfirmids/${firm.id}/signatures/token-1/executed.pdf`, 900_000);
    putStrayObject(`lawfirmids/${firm.id}/invoices/inv-1/sent.pdf`, 300_000);

    const res = await usage();

    // Charging for these is charging a firm for our own safety net, and a firm
    // over quota could not free the space even if they wanted to.
    expect(res.body.usedBytes).toBe(2048);
  });

  it('does not bill a firm for a signing session scratch copy', async () => {
    await uploadToMatter('Complaint.pdf', 2048);
    putStrayObject(`lawfirmids/${firm.id}/signing-work/token-1/draft.pdf`, 400_000);

    const res = await usage();

    expect(res.body.usedBytes).toBe(2048);
  });

  it('DOES bill a firm for its own general-folder documents', async () => {
    await uploadTo(owner, 'lawfirm', 'Handbook.pdf', 4096);

    const res = await usage();

    // The contrast that makes the exclusions above meaningful: a rule that
    // counted only matter documents would pass those and fail this.
    expect(res.body.usedBytes).toBe(4096);
    expect(await treeUnder(firm.id, firmRoot)).toHaveLength(1);
  });
});

describe('the figure and the objects behind it', () => {
  it('ignores an object that appeared with no row naming it', async () => {
    await uploadToMatter('Complaint.pdf', 2048);

    putStrayObject(`lawfirmids/${firm.id}/objects/${'0'.repeat(8)}-stray.pdf`, 999_999);

    // The rows ARE the usage. An object nothing points at is unreachable through
    // every route the firm has, so billing them for it would be charging for
    // storage they cannot see, cannot open and cannot delete. The old walk
    // counted exactly this, which is how an interrupted upload inflated a firm's
    // figure permanently.
    expect((await usage()).body.usedBytes).toBe(2048);
  });

  it('answers the same on two calls in a row', async () => {
    await uploadToMatter('Complaint.pdf', 2048);

    const first = await usage();
    const second = await usage();

    // There is no cache and nothing to reconcile, so there is no `refresh`
    // parameter and no staleness to report. The figure was cached for six hours
    // because computing it meant listing every object the firm owned.
    expect(first.body.usedBytes).toBe(second.body.usedBytes);
    expect(second.body.stale).toBe(false);
  });

  it('reports the quota and the percentage against it', async () => {
    await uploadToMatter('Complaint.pdf', 2048);

    const res = await usage();

    // The numbers the storage bar renders. `percentUsed` divides by the quota,
    // so a missing quota is a division the UI cannot recover from.
    expect(res.body.limitBytes).toBeGreaterThan(0);
    expect(res.body.percentUsed).toBe(0);
    expect(res.body.usedFormatted).toBe('2 KB');
    expect(res.body.hardLimit).toBe(false);
  });
});
