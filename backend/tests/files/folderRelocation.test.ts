/**
 * Renaming and moving a folder.
 *
 * This used to be the most dangerous operation in the files module. Storage
 * cannot rename, so a folder rename listed every object under its prefix, copied
 * each one to the new prefix, verified the copy, deleted the source, re-pointed
 * the mirrored row, and repeated for every page. It could stop partway and leave
 * the folder split across two locations, it refused any folder past the scan
 * ceiling outright, and it patched only two of the nine tables that stored the
 * old path.
 *
 * It is one UPDATE now. These cases pin what that buys:
 *
 *   - the subtree is untouched, at any size,
 *   - a cycle is impossible,
 *   - a name collision is refused by the database rather than by a check that
 *     two callers could both pass,
 *   - and everything referencing the file by id keeps working, because nothing
 *     about the file changed except one column.
 */
import {
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import {
  fileRowById,
  joinMatter,
  pathOf,
  rootOf,
  seedFile,
  seedFolder,
  seedMatter,
  treeUnder,
} from './fileWorld';

installInMemoryBucket();

const filesRepo = require('../../src/modules/files/files.repository');

let firm: Firm;
let owner: Actor;
let matterId: string;
let root: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

const rename = (fileId: string, newName: string) =>
  owner.api.post(`${F()}/rename`).send({ fileId, newName, matterId });

const move = (fileId: string, destinationFolderId?: string) =>
  owner.api.post(`${F()}/move`).send({ fileId, destinationFolderId, matterId });

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Relocation LLP' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
  root = await rootOf(firm.id, { matterId });
});

describe('renaming a folder', () => {
  it('renames it without touching anything inside', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    const signed = await seedFolder(firm.id, { parentId: contracts.id, name: 'Signed' });
    const doc = await seedFile(firm.id, { parentId: signed.id, name: 'retainer.pdf' });
    const before = await fileRowById(firm.id, doc.id);

    const res = await rename(contracts.id, 'Agreements');

    expect(res.status).toBe(200);
    expect(await pathOf(firm.id, doc.id)).toBe('Agreements/Signed/retainer.pdf');
    // The document's own row is byte for byte what it was: the rename moved one
    // column on one ancestor. Under the old design every object beneath the
    // folder was copied to a new path and the original deleted.
    const after = await fileRowById(firm.id, doc.id);
    expect(after).toEqual(before);
    expect(objects.has(doc.objectPath)).toBe(true);
  });

  it('renames a folder of five thousand documents without a single storage call', async () => {
    const big = await seedFolder(firm.id, { parentId: root, name: 'Discovery' });
    await testPool.query(
      `insert into files (law_firm_id, kind, name, parent_id, scope, matter_id, object_path, finalized_at)
       select $1::uuid, 'file', 'page-' || g, $2::uuid, 'matter', $3::uuid,
              'lawfirmids/' || $4 || '/objects/' || gen_random_uuid(), now()
         from generate_series(1, 5000) g`,
      [firm.id, big.id, matterId, firm.id],
    );
    objects.clear();

    const res = await rename(big.id, 'Production');

    // The old walk refused this outright past its scan ceiling, and below it
    // copied and deleted five thousand objects one page at a time.
    expect(res.status).toBe(200);
    expect(objects.size).toBe(0);
    const { rows } = await testPool.query(
      'select count(*)::int n from files where parent_id = $1', [big.id],
    );
    expect(rows[0].n).toBe(5000);
  });

  it('refuses a name a sibling already has, and changes nothing', async () => {
    await seedFolder(firm.id, { parentId: root, name: 'Pleadings' });
    const mine = await seedFolder(firm.id, { parentId: root, name: 'Drafts' });

    const res = await rename(mine.id, 'Pleadings');

    // The unique index decides. A check-then-write could be passed by two
    // callers at once, and the loser used to overwrite the winner's folder
    // marker, taking its colour and its client share state with it.
    expect(res.status).toBe(409);
    expect((await fileRowById(firm.id, mine.id)).name).toBe('Drafts');
  });

  it('allows the same name in a different folder', async () => {
    const a = await seedFolder(firm.id, { parentId: root, name: 'A' });
    const b = await seedFolder(firm.id, { parentId: root, name: 'B' });
    await seedFolder(firm.id, { parentId: a.id, name: 'Exhibits' });
    const other = await seedFolder(firm.id, { parentId: b.id, name: 'Temp' });

    // The pair that makes the refusal above meaningful: the constraint is scoped
    // to one parent, not to the matter.
    expect((await rename(other.id, 'Exhibits')).status).toBe(200);
  });

  it('renames a file the same way', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'draft.pdf' });

    const res = await rename(doc.id, 'final.pdf');

    expect(res.status).toBe(200);
    expect((await fileRowById(firm.id, doc.id)).name).toBe('final.pdf');
    // The object never moves, which is the whole reason a rename is free.
    expect((await fileRowById(firm.id, doc.id)).object_path).toBe(doc.objectPath);
  });
});

describe('moving a folder', () => {
  it('re-parents it and leaves its subtree in place', async () => {
    const from = await seedFolder(firm.id, { parentId: root, name: 'Inbox' });
    const to = await seedFolder(firm.id, { parentId: root, name: 'Filed' });
    const doc = await seedFile(firm.id, { parentId: from.id, name: 'notice.pdf' });

    const res = await move(from.id, to.id);

    expect(res.status).toBe(200);
    expect(await pathOf(firm.id, doc.id)).toBe('Filed/Inbox/notice.pdf');
  });

  it('refuses to move a folder into itself', async () => {
    const a = await seedFolder(firm.id, { parentId: root, name: 'A' });
    const b = await seedFolder(firm.id, { parentId: a.id, name: 'B' });

    // A cycle detaches the subtree from the root entirely: nothing lists it, and
    // every recursive read below it stops terminating at a root.
    expect((await move(a.id, b.id)).status).toBe(409);
    expect((await move(a.id, a.id)).status).toBe(409);
    expect(await pathOf(firm.id, b.id)).toBe('A/B');
  });

  it('moves something back to the top level', async () => {
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Holding' });
    const doc = await seedFile(firm.id, { parentId: folder.id, name: 'stray.pdf' });

    const res = await move(doc.id);

    expect(res.status).toBe(200);
    expect(await pathOf(firm.id, doc.id)).toBe('stray.pdf');
  });

  it('refuses to move onto a name the destination already holds', async () => {
    const from = await seedFolder(firm.id, { parentId: root, name: 'From' });
    const to = await seedFolder(firm.id, { parentId: root, name: 'To' });
    await seedFile(firm.id, { parentId: to.id, name: 'clash.pdf' });
    const mine = await seedFile(firm.id, { parentId: from.id, name: 'clash.pdf' });

    const res = await move(mine.id, to.id);

    // Refused whole rather than silently overwriting. The old copy-then-delete
    // had a create-only precondition for exactly this, and this is the same
    // guarantee as a constraint instead.
    expect(res.status).toBe(409);
    expect(await pathOf(firm.id, mine.id)).toBe('From/clash.pdf');
  });
});

describe('what a rename no longer breaks', () => {
  it('leaves a share link pointing at the same document', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'engagement.pdf' });
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/file-share-links`)
      .send({ fileId: doc.id, expiresInHours: 24 });
    expect(created.status).toBe(201);

    await rename(doc.id, 'engagement-signed.pdf');

    // The link stores a file id. Under the old design it stored a path, and the
    // rename had to walk every link under the prefix and rewrite it; a link the
    // walk missed resolved to a path that a later upload could reuse, serving a
    // recipient a document nobody granted them.
    const landing = await owner.api.get(`/api/share/${created.body.link.token}`);
    expect(landing.status).toBe(200);
  });

  it('leaves a client access record pointing at the same document', async () => {
    const client = await createPersonClient(firm.id, { name: 'Ada Ellis' });
    const doc = await seedFile(firm.id, { parentId: root, name: 'statement.pdf' });
    await owner.api.patch(`${F()}/client-visibility`)
      .send({ fileId: doc.id, matterId, clientVisible: true, notifyClient: true });

    await rename(doc.id, 'statement-final.pdf');

    // The share notification buffer keys on the file id, so the queued digest
    // still names a real document. It used to key on the path, and a rename
    // orphaned every pending notification and reset the client "new" badge.
    const { rows } = await testPool.query(
      'select file_id from file_client_access where law_firm_id = $1', [firm.id],
    );
    for (const row of rows) {
      expect(await filesRepo.findById(firm.id, row.file_id)).not.toBeNull();
    }
  });

  it('keeps a folder share reaching everything inside it after the folder moves', async () => {
    const client = await createPersonClient(firm.id, { name: 'Ada Ellis' });
    const shared = await seedFolder(firm.id, { parentId: root, name: 'Shared' });
    const inner = await seedFile(firm.id, { parentId: shared.id, name: 'update.pdf' });
    await owner.api.patch(`${F()}/client-visibility`)
      .send({ fileId: shared.id, matterId, clientVisible: true, notifyClient: false });
    const elsewhere = await seedFolder(firm.id, { parentId: root, name: 'Elsewhere' });

    await move(shared.id, elsewhere.id);

    // Visibility is inherited down the tree, so moving the shared folder carries
    // the share with it. The old model stored the share on a marker object and
    // matched files by path prefix, so a move rewrote every one of those paths.
    expect(await filesRepo.visibleToClient(firm.id, inner.id, client.id)).toBe(true);
  });
});

describe('who may relocate', () => {
  it('refuses a member of another firm', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Private' });

    const res = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/files/rename`)
      .send({ fileId: folder.id, newName: 'Theirs', matterId });

    // The first case for any route: a caller from another firm. The row lookup
    // is scoped to the caller's firm, so this resolves to nothing.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await fileRowById(firm.id, folder.id)).name).toBe('Private');
  });

  it('refuses a firm member who is not on the matter', async () => {
    const outsider = await memberWith(firm.id, ['files.view', 'files.manageFolders']);
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Privileged' });

    const res = await outsider.api.post(`${F()}/rename`)
      .send({ fileId: folder.id, newName: 'Renamed', matterId });

    // The ethical wall. A member walled off from the matter cannot reach its
    // documents even by naming one directly.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await fileRowById(firm.id, folder.id)).name).toBe('Privileged');
  });
});

describe('the tree a relocation produces', () => {
  it('reads the same before and after a no-op move', async () => {
    const a = await seedFolder(firm.id, { parentId: root, name: 'A' });
    await seedFile(firm.id, { parentId: a.id, name: 'one.pdf' });
    await seedFile(firm.id, { parentId: root, name: 'two.pdf' });
    const before = await treeUnder(firm.id, root);

    const b = await seedFolder(firm.id, { parentId: root, name: 'B' });
    await move(a.id, b.id);
    await move(a.id, root);

    // Round-tripping a folder has to land exactly where it started. A walk that
    // half-completed in either direction would show up here as a changed tree.
    expect(await treeUnder(firm.id, root)).toEqual([...before, 'B'].sort());
  });
});
