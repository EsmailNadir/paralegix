/**
 * Creating, deleting, colouring and sharing, through the real routes.
 *
 * Renaming and moving have their own file (`folderRelocation.test.ts`), because
 * what they buy is worth stating on its own. What is left here is everything
 * else a person can do to the tree, and the two questions each of those raises:
 * did the right thing change, and did anything else.
 *
 * A delete is a soft delete now. The rows and their objects survive a retention
 * window so a delete is recoverable and a legal hold still has something to
 * hold, and the sweeper destroys both afterwards. The firm stops being charged
 * immediately, because nobody should pay for their own trash.
 */
import {
  createFirm,
  createPersonClient,
  createPortalUser,
  drainEvents,
  memberWith,
  ownerOf,
  testPool,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import {
  fileRowById,
  joinMatter,
  rootOf,
  seedFile,
  seedFolder,
  seedMatter,
  seedTask,
  setStorageUsed,
  storageUsedBytes,
  treeUnder,
} from './fileWorld';

installInMemoryBucket();

const filesRepo = require('../../src/modules/files/files.repository');

let firm: Firm;
let owner: Actor;
let matterId: string;
let root: string;

const F = () => `/api/lawfirms/${firm.id}/files`;

const linkRow = async (token: string) => {
  const { rows } = await testPool.query(
    'select revoked_at is not null as revoked from file_share_links where token = $1',
    [token],
  );
  return rows[0];
};

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Mutations LLP' });
  owner = await ownerOf(firm.id);
  matterId = await seedMatter(firm.id, owner.uid, 'Ellis v. Hart');
  root = await rootOf(firm.id, { matterId });
});

describe('creating a folder', () => {
  const create = (body: Record<string, unknown>) =>
    owner.api.post(`${F()}/create-folder`).send({ matterId, ...body });

  it('writes a folder row and no object at all', async () => {
    const res = await create({ folderName: 'Contracts' });

    expect(res.status).toBe(201);
    const row = await fileRowById(firm.id, res.body.folderId);
    expect(row).toMatchObject({ name: 'Contracts', kind: 'folder', object_path: null });
    // A folder used to be an empty `.folder` marker object whose metadata
    // carried its colour and share state, so losing the marker turned the folder
    // into a file and orphaned its subtree.
    expect(objects.size).toBe(0);
  });

  it('nests a folder under its parent', async () => {
    const parent = await create({ folderName: 'Contracts' });

    const child = await create({ folderName: 'Signed', parentId: parent.body.folderId });

    expect(child.status).toBe(201);
    expect((await fileRowById(firm.id, child.body.folderId)).parent_id).toBe(parent.body.folderId);
  });

  it('refuses a name already taken at that level', async () => {
    await create({ folderName: 'Contracts' });

    const res = await create({ folderName: 'Contracts' });

    // Decided by the unique index rather than by a prior existence check. Two
    // callers used to both pass that check, and the second marker replaced the
    // first, taking its colour and its client share state with it.
    expect(res.status).toBe(409);
  });

  it('leaves the existing folder untouched when it refuses', async () => {
    const first = await create({ folderName: 'Contracts', folderColor: '#0ea5e9' });

    await create({ folderName: 'Contracts', folderColor: '#c2410c' });

    expect((await fileRowById(firm.id, first.body.folderId)).folder_color).toBe('#0ea5e9');
  });

  it('allows the same name in two different parents', async () => {
    const a = await create({ folderName: 'A' });
    const b = await create({ folderName: 'B' });

    // The pair that makes the refusal above meaningful: the constraint is scoped
    // to one parent, not to the matter.
    expect((await create({ folderName: 'Exhibits', parentId: a.body.folderId })).status).toBe(201);
    expect((await create({ folderName: 'Exhibits', parentId: b.body.folderId })).status).toBe(201);
  });

  it('refuses a folder in a matter the caller is not on', async () => {
    const outsider = await memberWith(firm.id, ['files.view', 'files.manageFolders']);

    const res = await outsider.api.post(`${F()}/create-folder`).send({ matterId, folderName: 'Injected' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('deleting', () => {
  const del = (fileId: string) => owner.api.delete(`${F()}/delete?matterId=${matterId}&fileId=${fileId}`);

  it('takes the document out of every listing', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf', bytes: 2048 });

    const res = await del(doc.id);

    expect(res.status).toBe(200);
    expect(await treeUnder(firm.id, root)).toEqual([]);
  });

  it('keeps the row and its bytes through the retention window', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf', bytes: 2048 });

    await del(doc.id);

    // A delete is recoverable for a month, and a legal hold needs something to
    // hold. The sweeper destroys both once the window passes.
    expect((await fileRowById(firm.id, doc.id)).deleted_at).toBeTruthy();
    expect(objects.has(doc.objectPath)).toBe(true);
  });

  it('credits the deleted bytes back to the firm quota immediately', async () => {
    await setStorageUsed(firm.id, 10_000);
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf', bytes: 2048 });

    await del(doc.id);

    // Usage that only ever goes up strands a firm at its limit on documents it
    // has already thrown away, and nothing on screen says why: the browser is
    // empty and the upload button still refuses.
    expect(await storageUsedBytes(firm.id)).toBe(10_000 - 2048);
  });

  it('revokes a live share link to the deleted document', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf' });
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/file-share-links`)
      .send({ fileId: doc.id, expiresInHours: 24 });

    await del(doc.id);

    // The token is the whole credential and it outlives the document. Left live
    // it keeps serving a file the firm believes it deleted.
    expect(await linkRow(created.body.link.token)).toMatchObject({ revoked: true });
  });

  it('empties a folder subtree in one statement', async () => {
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    const signed = await seedFolder(firm.id, { parentId: contracts.id, name: 'Signed' });
    await seedFile(firm.id, { parentId: contracts.id, name: 'Lease.pdf' });
    await seedFile(firm.id, { parentId: signed.id, name: 'Executed.pdf' });

    const res = await del(contracts.id);

    // The old path deleted objects one at a time and refused any folder past its
    // scan ceiling, because a walk that stopped early dropped the rows for
    // objects it never reached.
    expect(res.status).toBe(200);
    expect(await treeUnder(firm.id, root)).toEqual([]);
  });

  it('credits back every file byte in a deleted folder, and only the files', async () => {
    await setStorageUsed(firm.id, 50_000);
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    await seedFile(firm.id, { parentId: contracts.id, name: 'Lease.pdf', bytes: 2048 });
    await seedFile(firm.id, { parentId: contracts.id, name: 'Deed.pdf', bytes: 1024 });

    await del(contracts.id);

    // The folder itself carries no bytes, so counting it would credit back more
    // than the firm ever stored.
    expect(await storageUsedBytes(firm.id)).toBe(50_000 - 3072);
  });

  it('refuses a document in a matter under legal hold', async () => {
    // A hold is a row, not a column: which evidence was held, by whom and for
    // how long is itself the record a hold exists to produce.
    await testPool.query(
      'insert into legal_holds (law_firm_id, matter_id, reason) values ($1, $2, $3)',
      [firm.id, matterId, 'Anticipated litigation'],
    );
    const doc = await seedFile(firm.id, { parentId: root, name: 'Held.pdf' });

    const res = await del(doc.id);

    expect(res.status).toBe(403);
    expect((await fileRowById(firm.id, doc.id)).deleted_at).toBeNull();
  });
});

describe('who may delete what', () => {
  it('does not let a member who may only delete FILES remove a folder', async () => {
    const member = await memberWith(firm.id, ['files.view', 'files.delete']);
    await joinMatter(firm.id, matterId, member.uid);
    const contracts = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });
    await seedFile(firm.id, { parentId: contracts.id, name: 'Lease.pdf' });

    const res = await member.api.delete(`${F()}/delete?matterId=${matterId}&fileId=${contracts.id}`);

    // The router gate lets either permission through, so the folder/file split
    // is decided inside the handler. Emptying a folder is the destructive
    // version of the same click and is deliberately a separate grant.
    expect(res.status).toBe(403);
    expect(await treeUnder(firm.id, root)).toEqual(['Contracts', 'Contracts/Lease.pdf']);
  });

  it('does not let a member who may only manage FOLDERS delete a file', async () => {
    const member = await memberWith(firm.id, ['files.view', 'files.manageFolders']);
    await joinMatter(firm.id, matterId, member.uid);
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf' });

    const res = await member.api.delete(`${F()}/delete?matterId=${matterId}&fileId=${doc.id}`);

    expect(res.status).toBe(403);
    expect((await fileRowById(firm.id, doc.id)).deleted_at).toBeNull();
  });

  it('lets a member holding BOTH grants delete either', async () => {
    const member = await memberWith(firm.id, ['files.view', 'files.delete', 'files.manageFolders']);
    await joinMatter(firm.id, matterId, member.uid);
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf' });

    const res = await member.api.delete(`${F()}/delete?matterId=${matterId}&fileId=${doc.id}`);

    // Without this the two refusals above would pass just as well against a
    // route that refused everyone.
    expect(res.status).toBe(200);
  });
});

describe('folder colour', () => {
  it('writes the colour to the row', async () => {
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Contracts', color: '#0ea5e9' });

    const res = await owner.api.post(`${F()}/update-folder-color`)
      .send({ matterId, folderId: folder.id, folderColor: '#c2410c' });

    expect(res.status).toBe(200);
    expect((await fileRowById(firm.id, folder.id)).folder_color).toBe('#c2410c');
  });

  it('answers not-found for a folder that does not exist', async () => {
    const res = await owner.api.post(`${F()}/update-folder-color`)
      .send({ matterId, folderId: '00000000-0000-4000-8000-000000000000', folderColor: '#c2410c' });

    expect(res.status).toBe(404);
  });

  it('refuses to colour a file', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf' });

    const res = await owner.api.post(`${F()}/update-folder-color`)
      .send({ matterId, folderId: doc.id, folderColor: '#c2410c' });

    expect(res.status).toBe(404);
  });
});

describe('sharing a document with the client portal', () => {
  let client: ClientRecord;

  const setVisibility = (body: Record<string, unknown>) =>
    owner.api.patch(`${F()}/client-visibility`).send({ matterId, ...body });

  beforeEach(async () => {
    // A portal account AND a place on the matter. A client with neither cannot
    // be notified at all, so a fixture without them would make the notification
    // cases pass for the wrong reason.
    const portal = await createPortalUser({ name: 'Ada Ellis' });
    client = await createPersonClient(firm.id, {
      name: 'Ada Ellis', userId: portal.uid, email: `${portal.uid}@example.test`,
    });
    await testPool.query(
      'insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)',
      [matterId, client.id, firm.id],
    );
    await drainEvents();
  });

  it('records the share on the row', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Statement.pdf' });

    const res = await setVisibility({ fileId: doc.id, clientVisible: true });

    expect(res.status).toBe(200);
    expect((await fileRowById(firm.id, doc.id)).client_visible).toBe(true);
  });

  it('un-shares a document', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Statement.pdf', clientVisible: true });

    await setVisibility({ fileId: doc.id, clientVisible: false });

    expect((await fileRowById(firm.id, doc.id)).client_visible).toBe(false);
    expect(await filesRepo.visibleToClient(firm.id, doc.id, client.id)).toBe(false);
  });

  it('narrows a share to named clients', async () => {
    const other = await createPersonClient(firm.id, { name: 'Ben Hart' });
    const doc = await seedFile(firm.id, { parentId: root, name: 'Statement.pdf' });

    await setVisibility({ fileId: doc.id, clientVisible: true, visibleClientIds: [client.id] });

    // Both clients are on the matter. This restriction used to live on the
    // object metadata, where no database read could apply it, so the whole
    // narrowing was invisible to anything but a bucket walk.
    expect(await filesRepo.visibleToClient(firm.id, doc.id, client.id)).toBe(true);
    expect(await filesRepo.visibleToClient(firm.id, doc.id, other.id)).toBe(false);
  });

  it('clears a per-client restriction when the document is un-shared', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Statement.pdf' });
    await setVisibility({ fileId: doc.id, clientVisible: true, visibleClientIds: [client.id] });

    await setVisibility({ fileId: doc.id, clientVisible: false });

    // A restriction left standing would silently narrow the NEXT share of the
    // same document to whoever was named the last time.
    expect(await filesRepo.visibilityClientIds(firm.id, doc.id)).toEqual([]);
  });

  it('shares everything inside a shared folder', async () => {
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Shared' });
    const inner = await seedFile(firm.id, { parentId: folder.id, name: 'update.pdf' });
    const outside = await seedFile(firm.id, { parentId: root, name: 'internal.pdf' });

    await setVisibility({ fileId: folder.id, clientVisible: true });

    expect(await filesRepo.visibleToClient(firm.id, inner.id, client.id)).toBe(true);
    // The pair matters: a check that answered true for everything would pass the
    // first assertion on its own.
    expect(await filesRepo.visibleToClient(firm.id, outside.id, client.id)).toBe(false);
  });

  it('queues a notification for a fresh share', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Statement.pdf' });

    await setVisibility({ fileId: doc.id, clientVisible: true, notifyClient: true });
    await drainEvents();

    const { rows } = await testPool.query(
      'select file_id from file_client_access where law_firm_id = $1', [firm.id],
    );
    expect(rows.map((r: any) => r.file_id)).toContain(doc.id);
  });

  it('says nothing when a document is un-shared', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Statement.pdf', clientVisible: true });
    await testPool.query('delete from file_client_access where law_firm_id = $1', [firm.id]);

    await setVisibility({ fileId: doc.id, clientVisible: false, notifyClient: true });
    await drainEvents();

    // Telling a client a document is no longer theirs to read is worse than
    // telling them nothing.
    const { rows } = await testPool.query(
      'select count(*)::int n from file_client_access where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('stays quiet when the firm shares with notifyClient off', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Draft.pdf' });

    await setVisibility({ fileId: doc.id, clientVisible: true, notifyClient: false });
    await drainEvents();

    // A firm sharing a work-in-progress document should be able to do it
    // quietly and tell the client themselves.
    const { rows } = await testPool.query(
      'select count(*)::int n from file_client_access where law_firm_id = $1', [firm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('answers not-found for a file id that does not exist', async () => {
    const res = await setVisibility({
      fileId: '00000000-0000-4000-8000-000000000000', clientVisible: true,
    });

    expect(res.status).toBe(404);
  });
});

describe('external share links', () => {
  const links = () => `/api/lawfirms/${firm.id}/file-share-links`;

  it('mints a link for a document that exists', async () => {
    const doc = await seedFile(firm.id, { parentId: root, name: 'Engagement.pdf' });

    const res = await owner.api.post(links()).send({ fileId: doc.id, expiresInHours: 24 });

    expect(res.status).toBe(201);
    expect(res.body.link.token).toEqual(expect.any(String));
  });

  it('refuses a link to a file id that does not exist', async () => {
    const res = await owner.api.post(links())
      .send({ fileId: '00000000-0000-4000-8000-000000000000', expiresInHours: 24 });

    expect(res.status).toBe(404);
  });

  it('makes a link to a folder a multi-item link rather than a single-file one', async () => {
    const folder = await seedFolder(firm.id, { parentId: root, name: 'Contracts' });

    const res = await owner.api.post(links()).send({ fileId: folder.id, expiresInHours: 24 });

    // A folder has no object of its own to serve, so its link names it as an
    // item and serves what is inside it (see shareLinkItems.test.ts).
    expect(res.status).toBe(201);
    expect(res.body.link.isMultiItem).toBe(true);
    expect(res.body.link.fileId).toBeNull();
  });

  it('refuses to mint a link for a matter the caller is not on', async () => {
    const outsider = await memberWith(firm.id, ['files.view']);
    const doc = await seedFile(firm.id, { parentId: root, name: 'Privileged.pdf' });

    const res = await outsider.api.post(links()).send({ fileId: doc.id, expiresInHours: 24 });

    // The ethical wall. A member walled off from the matter must not be able to
    // publish its documents to the open internet.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('does not let another firm mint a link to this firm document', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const doc = await seedFile(firm.id, { parentId: root, name: 'Ours.pdf' });

    const res = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/file-share-links`)
      .send({ fileId: doc.id, expiresInHours: 24 });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});


/**
 * A matter-linked task's own file view.
 *
 * The task page shows "Task Files" with ONLY the task id, and a matter-linked
 * task's documents live in the matter's tree tagged with the task. So the scope
 * a write resolves to is a task scope whose rows carry `scope = 'matter'`, and
 * every route has to accept that pairing or the task view can list documents it
 * cannot touch.
 */
describe("a matter-linked task's own file view", () => {
  let linkedTask: string;
  let taskDoc: { id: string };
  let matterDoc: { id: string };

  const viaTask = () => ({ taskId: linkedTask });

  beforeEach(async () => {
    linkedTask = await seedTask(firm.id, { matterId, title: 'File the reply' });
    taskDoc = await seedFile(firm.id, { parentId: root, name: 'reply.pdf', taskId: linkedTask });
    matterDoc = await seedFile(firm.id, { parentId: root, name: 'complaint.pdf' });
  });

  it('renames one of its own documents', async () => {
    const res = await owner.api.post(`${F()}/rename`)
      .send({ ...viaTask(), fileId: taskDoc.id, newName: 'reply-v2.pdf' });

    // The row's scope is 'matter' because that is whose tree it sits in, and the
    // request's scope is the task. A check that demanded the two labels match
    // refused every write from this view with a 404.
    expect(res.status).toBe(200);
    expect((await fileRowById(firm.id, taskDoc.id)).name).toBe('reply-v2.pdf');
  });

  it('deletes one of its own documents', async () => {
    const res = await owner.api.delete(`${F()}/delete?lawFirmId=${firm.id}&taskId=${linkedTask}&fileId=${taskDoc.id}`);

    expect(res.status).toBe(200);
    expect((await fileRowById(firm.id, taskDoc.id)).deleted_at).not.toBeNull();
  });

  it("cannot reach a matter document that is not the task's", async () => {
    const res = await owner.api.post(`${F()}/rename`)
      .send({ ...viaTask(), fileId: matterDoc.id, newName: 'taken.pdf' });

    // The task view lists only the task's rows, so its writes reach only those.
    // The boundary that makes the two cases above a scope decision rather than
    // a task view that can touch the whole matter.
    expect(res.status).toBe(404);
    expect((await fileRowById(firm.id, matterDoc.id)).name).toBe('complaint.pdf');
  });

  it('creates a folder that the task view can then see', async () => {
    const created = await owner.api.post(`${F()}/create-folder`)
      .send({ lawFirmId: firm.id, ...viaTask(), folderName: 'Exhibits' });
    expect(created.status).toBe(201);

    const listed = await owner.api.get(`${F()}/list-folder?lawFirmId=${firm.id}&taskId=${linkedTask}`);

    // The folder is created in the MATTER's tree, because that is where the
    // task files, and it has to carry the task's tag or the task view filters
    // it straight back out: a folder the user just made, and cannot find.
    expect(listed.body.files.map((f: any) => f.name)).toContain('Exhibits');
    expect((await fileRowById(firm.id, created.body.folderId)).task_id).toBe(linkedTask);
  });

  it('keeps that folder out of the matter\'s own view', async () => {
    const created = await owner.api.post(`${F()}/create-folder`)
      .send({ lawFirmId: firm.id, ...viaTask(), folderName: 'Exhibits' });

    const listed = await owner.api.get(`${F()}/list-folder?lawFirmId=${firm.id}&matterId=${matterId}`);

    // The other direction of the same tag: what the task made belongs to the
    // task, and the matter's browser hides task-owned rows.
    expect(created.status).toBe(201);
    expect(listed.body.files.map((f: any) => f.name)).not.toContain('Exhibits');
  });
});
