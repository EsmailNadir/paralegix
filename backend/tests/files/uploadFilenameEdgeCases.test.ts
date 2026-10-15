/**
 * Filename and path input edges on the upload routes: Unicode normalization,
 * maximum name length, and whether a finalize request can reach a document
 * outside the scope it was authorized for.
 *
 * `..` traversal (both in a filename and in the `folder` field), leading
 * slashes, backslashes and duplicate-name dedup ("(1)", "(2)", ...) have direct
 * coverage in `resumableUploads.test.ts` and are not repeated here.
 */
import { objects } from '../support/inMemoryBucket';
import {
  createFirm,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installRichBucket, resetRichBucket, completeResumableUpload } from './richBucket';
import {
  fileRowById,
  rootOf,
  seedFile,
  seedFolder,
  seedMatter,
  storageReservedBytes,
  treeUnder,
} from './fileWorld';

installRichBucket();

let firm: Firm;
let owner: Actor;
let matterId: string;
let otherMatterId: string;
let root: string;
let otherRoot: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

/**
 * One document through the real two-step upload: init claims the row and
 * reserves the bytes, the browser PUTs, finalize stamps the row. Returns the
 * finalize response.
 */
async function upload(name: string, size: number) {
  const opened = await owner.api.post(`${F()}/upload-init`)
    .send({ context: 'matter', matterId, files: [{ name, size }] });
  if (opened.status !== 200) return opened;

  for (const u of opened.body.uploads) {
    completeResumableUpload(u.objectPath, { bytes: u.declaredSize });
  }
  return owner.api.post(`${F()}/upload-finalize`).send({
    context: 'matter',
    matterId,
    uploads: opened.body.uploads.map((u: any) => ({
      fileId: u.fileId, declaredSize: u.declaredSize,
    })),
  });
}

interface DeclaredFile { name: string; size: number; contentType?: string }

const initFor = (actor: Actor, matter: string, files: DeclaredFile[], extra: Record<string, unknown> = {}) =>
  actor.api.post(`${F()}/upload-init`)
    .send({ context: 'matter', matterId: matter, files, ...extra });

const finalizeFor = (actor: Actor, matter: string, uploads: unknown[], extra: Record<string, unknown> = {}) =>
  actor.api.post(`${F()}/upload-finalize`)
    .send({ context: 'matter', matterId: matter, uploads, ...extra });

beforeEach(async () => {
  resetRichBucket();

  firm = await createFirm({ name: 'Kestrel & Vance' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Odom v. Feld');
  otherMatterId = await seedMatter(firm.id, owner.uid, 'Ruiz Estate');
  root = await rootOf(firm.id, { matterId });
  otherRoot = await rootOf(firm.id, { matterId: otherMatterId });
});

// ---------------------------------------------------------------------------

describe('Unicode normalization in a filename', () => {
  it('does not silently collide a decomposed and a precomposed form of the same visible name', async () => {
    // "café" precomposed: c, a, f, U+00E9 (é as one code point).
    const precomposed = 'café.pdf';
    // "café" decomposed (NFD): c, a, f, e, U+0301 (combining acute accent).
    // Renders identically to the human eye; a byte-for-byte different string.
    const decomposed = 'café.pdf';
    expect(precomposed).not.toBe(decomposed);
    expect(precomposed.normalize('NFC')).toBe(decomposed.normalize('NFC'));

    const first = await upload(precomposed, 10);
    const second = await upload(decomposed, 20);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // Two rows, two objects, neither overwriting the other. The names may or may
    // not end up identical after sanitizing; if they do, the second is given a
    // "(1)" suffix by the unique index, which is the same treatment any genuine
    // duplicate gets. What must never happen is one document replacing another.
    const tree = await treeUnder(firm.id, root);
    expect(tree).toHaveLength(2);
    expect(tree[0]).not.toBe(tree[1]);
    const a = first.body.files[0];
    const b = second.body.files[0];
    expect(a.objectPath).not.toBe(b.objectPath);
    expect(objects.get(a.objectPath)?.bytes).toBe(10);
    expect(objects.get(b.objectPath)?.bytes).toBe(20);
  });
});

describe('an extremely long filename or folder path', () => {
  it('rejects an oversized filename with a clean 400 instead of claiming a row', async () => {
    // Comfortably past the storage provider's 1024-byte object-name ceiling.
    const hugeName = `${'a'.repeat(1100)}.pdf`;

    const res = await owner.api.post(`${F()}/upload-init`)
      .send({ context: 'matter', matterId, files: [{ name: hugeName, size: 10 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
    // Nothing was written: a clean refusal, not a claimed row with no bytes.
    expect(await treeUnder(firm.id, root)).toEqual([]);
  });

  it('refuses a folder path naming folders that do not exist', async () => {
    const deepFolder = Array.from({ length: 60 }, (unused, i) => `subfolder-number-${i}`).join('/');

    const res = await owner.api.post(`${F()}/upload-init`)
      .send({ context: 'matter', matterId, folder: deepFolder, files: [{ name: 'Notice.pdf', size: 1024 }] });

    // A path is walked to the row it names, one level at a time. It used to be
    // a prefix, so any depth was accepted and the folders came into existence by
    // being written to. Depth is no longer the question; existence is.
    expect(res.status).toBe(404);
    // No quota was left reserved behind a request that never opened a session.
    expect(await storageReservedBytes(firm.id)).toBe(0);
  });

  it('refuses a name past the length a filesystem allows', async () => {
    const res = await owner.api.post(`${F()}/upload-init`)
      .send({ context: 'matter', matterId, files: [{ name: `${'a'.repeat(256)}.pdf`, size: 10 }] });

    // 255 characters, the same limit the column carries as a CHECK. One over is
    // refused; the ordinary name below is the boundary from the other side.
    expect(res.status).toBe(400);
    expect(await treeUnder(firm.id, root)).toEqual([]);
  });

  it('still accepts an ordinary filename (positive control)', async () => {
    const res = await upload('Notice.pdf', 10);

    expect(res.status).toBe(201);
    expect(await treeUnder(firm.id, root)).toEqual(['Notice.pdf']);
  });
});

describe('finalize cannot reach outside the scope it was authorized for', () => {
  it('refuses a finalize whose matterId claim does not match where the row lives', async () => {
    // The caller is a genuine member of BOTH matters, so this is not a
    // membership bypass. It is a check that the ROW decides which matter a
    // document belongs to, rather than a claim the client repeats at finalize.
    const opened = await initFor(owner, matterId, [{ name: 'Complaint.pdf', size: 2048 }]);
    expect(opened.status).toBe(200);
    const { fileId, objectPath } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    const res = await finalizeFor(owner, otherMatterId, [{ fileId, declaredSize: 2048 }]);

    expect(res.status).toBe(201); // the route succeeds; the individual item fails
    expect(res.body.count).toBe(0);
    expect(res.body.failures).toEqual([{ objectPath, error: 'Not in this context' }]);

    // The row stayed where it was created, unstamped. Finalizing cannot move a
    // row between matters, so the risk here is the response: without the check
    // the caller is handed a signed download URL for the document.
    const row = await fileRowById(firm.id, fileId);
    expect(row.matter_id).toBe(matterId);
    expect(row.finalized_at).toBeNull();
    expect(await treeUnder(firm.id, otherRoot)).toEqual([]);
  });

  it('positive control: finalizing with the SAME matterId the row was opened under succeeds', async () => {
    const opened = await initFor(owner, matterId, [{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    const res = await finalizeFor(owner, matterId, [{ fileId, declaredSize: 2048 }]);

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
    const row = await fileRowById(firm.id, fileId);
    expect(row.matter_id).toBe(matterId);
    expect(row.finalized_at).not.toBeNull();
  });

  it('refuses the same way for a matter the caller is not even a member of', async () => {
    const strangerMatter = await seedMatter(firm.id, null, 'Walled off');

    const opened = await initFor(owner, matterId, [{ name: 'Complaint.pdf', size: 2048 }]);
    const { fileId, objectPath } = opened.body.uploads[0];
    completeResumableUpload(objectPath, { bytes: 2048 });

    const res = await finalizeFor(owner, strangerMatter, [{ fileId, declaredSize: 2048 }]);

    // Membership on strangerMatter fails first, inside resolveFileScope, before
    // the scope comparison above is even reached.
    expect(res.status).toBe(403);
    expect((await fileRowById(firm.id, fileId)).finalized_at).toBeNull();
  });

  it('refuses a row belonging to another firm outright', async () => {
    const rival = await createFirm({ name: 'Rival LLP' });
    const rivalOwner = await ownerOf(rival.id);
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');
    const theirRoot = await rootOf(rival.id, { matterId: rivalMatter });
    const filesRepo = require('../../src/modules/files/files.repository');
    const theirs = await filesRepo.createFile(rival.id, {
      parentId: theirRoot, name: 'Theirs.pdf', mimeType: 'application/pdf',
    });

    const res = await finalizeFor(owner, matterId, [{ fileId: theirs.id, declaredSize: 2048 }]);

    // The first case for any route: a real id from another firm. The lookup is
    // firm-scoped, so it resolves to nothing at all.
    expect(res.body.count).toBe(0);
    expect(res.body.failures[0].error).toBe('Not an upload of yours');
    const { rows } = await testPool.query(
      'select finalized_at from files where id = $1', [theirs.id],
    );
    expect(rows[0].finalized_at).toBeNull();
  });
});

describe('naming the destination folder by id', () => {
  it('uploads into the folder the caller names', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });

    const opened = await owner.api.post(`${F()}/upload-init`).send({
      context: 'matter', matterId, folderId: contracts.id, files: [{ name: 'Retainer.pdf', size: 10 }],
    });
    expect(opened.status).toBe(200);
    completeResumableUpload(opened.body.uploads[0].objectPath, { bytes: 10 });
    await finalizeFor(owner, matterId, [{ fileId: opened.body.uploads[0].fileId, declaredSize: 10 }]);

    // The browser lists a folder, so it holds the id. It used to send the folder
    // as a relative path, which had to be walked back to a row on every upload.
    expect(await treeUnder(firm.id, root)).toEqual(['Contracts', 'Contracts/Retainer.pdf']);
  });

  it('refuses a folder in another matter of the same firm', async () => {
    const theirFolder = await seedFolder(firm.id, { parentId: otherRoot, name: 'Theirs' });

    const res = await owner.api.post(`${F()}/upload-init`).send({
      context: 'matter', matterId, folderId: theirFolder.id, files: [{ name: 'Planted.pdf', size: 10 }],
    });

    // The caller is on both matters, so this is not a membership case. The
    // request names one matter and a folder in another, and without the scope
    // check the document would be filed into the matter the caller never named.
    expect(res.status).toBe(404);
    expect(await treeUnder(firm.id, otherRoot)).toEqual(['Theirs']);
  });

  it('refuses a document where a folder belongs', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'not-a-folder.pdf' });

    const res = await owner.api.post(`${F()}/upload-init`).send({
      context: 'matter', matterId, folderId: doc.id, files: [{ name: 'Planted.pdf', size: 10 }],
    });

    expect(res.status).toBe(404);
  });

  it('refuses a folder belonging to another firm', async () => {
    const rival = await createFirm({ name: 'Rival LLP' });
    const rivalOwner = await ownerOf(rival.id);
    const rivalMatter = await seedMatter(rival.id, rivalOwner.uid, 'Theirs');
    const rivalRoot = await rootOf(rival.id, { matterId: rivalMatter });
    const theirs = await seedFolder(rival.id, { parentId: rivalRoot, name: 'Theirs' });

    const res = await owner.api.post(`${F()}/upload-init`).send({
      context: 'matter', matterId, folderId: theirs.id, files: [{ name: 'Planted.pdf', size: 10 }],
    });

    // The first case for any route. The lookup is scoped to the caller's firm.
    expect(res.status).toBe(404);
  });
});
