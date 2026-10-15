/**
 * Reaching for another firm's documents through every route that writes.
 *
 * One firm makes every request, fully legitimate and fully permissioned inside
 * its own walls, and names another firm's matter, task, folder or file. Nothing
 * here is an authentication case: the caller is a real, signed-in owner
 * throughout, so what is under test is scoping, not login.
 *
 * The shape of the wall changed with the tree. A request used to carry a full
 * object path, and the protection was a string comparison against the prefix the
 * caller's scope resolved to. It carries a file id now, and the lookup is scoped
 * to the caller's firm, so another firm's id resolves to nothing. That is a
 * better wall precisely because there is no comparison left to get wrong: a
 * route cannot forget to compare.
 *
 * Every attempt is followed by proof that the victim's tree is exactly as it
 * was, and the last section repeats each request as the OWNING firm, so none of
 * the refusals above can be passing against a module that refuses everyone.
 */
import { randomUUID } from 'crypto';

import { objects } from '../support/inMemoryBucket';
import {
  createFirm,
  createPersonClient,
  ownerOf,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { installRichBucket, resetRichBucket, zipEntryNames } from './richBucket';
import { exportArchive } from './exportWorld';
import {
  fileRowById,
  rootOf,
  seedFile,
  seedFolder,
  seedMatter,
  seedTask,
  treeUnder,
} from './fileWorld';

// MODULE scope, before the app is required: `files.storage.ts` resolves its
// bucket once, on load, and hands that one handle to every route.
installRichBucket();

/** The firm making the requests. Fully legitimate, fully permissioned. */
let mine: Firm;
let me: Actor;
let myMatter: string;
let myRoot: string;

/** The firm being reached for. Everything below belongs to them. */
let theirs: Firm;
let them: Actor;
let theirMatter: string;
let theirTask: string;
let theirRoot: string;
let theirDocument: { id: string; objectPath: string };
let theirFolder: { id: string };
let theirFolderFile: { id: string; objectPath: string };

const F = () => `/api/lawfirms/${mine.id}/files`;

/**
 * Everything the victim owns, unchanged. Called after every attempt.
 *
 * The folder colour and the share flag are checked, not just presence: a route
 * that refused the write but flipped a column first would leave the tree looking
 * intact while the document was already published to a portal.
 */
async function expectTheirTreeIntact(): Promise<void> {
  expect(await treeUnder(theirs.id, theirRoot)).toEqual([
    'Deposition.pdf',
    'Discovery',
    'Discovery/Exhibit A.pdf',
  ]);
  expect(objects.get(theirDocument.objectPath)?.bytes).toBe(4096);
  expect(await fileRowById(theirs.id, theirDocument.id))
    .toMatchObject({ name: 'Deposition.pdf', client_visible: false });
  expect(await fileRowById(theirs.id, theirFolder.id))
    .toMatchObject({ name: 'Discovery', folder_color: '#0ea5e9' });
}

beforeEach(async () => {
  resetRichBucket();

  mine = await createFirm({ name: 'Hale & Co' });
  me = await ownerOf(mine.id);
  myMatter = await seedMatter(mine.id, me.uid, 'Hollis v. Denton');
  myRoot = await rootOf(mine.id, { matterId: myMatter });

  theirs = await createFirm({ name: 'Rival LLP' });
  them = await ownerOf(theirs.id);
  theirMatter = await seedMatter(theirs.id, them.uid, 'Vance v. Orrick');
  theirTask = await seedTask(theirs.id, { matterId: theirMatter, title: 'File the reply' });
  theirRoot = await rootOf(theirs.id, { matterId: theirMatter });

  theirDocument = await seedFile(theirs.id, {
    parentId: theirRoot, name: 'Deposition.pdf', bytes: 4096,
  });
  theirFolder = await seedFolder(theirs.id, {
    parentId: theirRoot, name: 'Discovery', color: '#0ea5e9',
  });
  theirFolderFile = await seedFile(theirs.id, {
    parentId: theirFolder.id, name: 'Exhibit A.pdf', bytes: 2048,
  });
});

// ---------------------------------------------------------------------------
// The scope-resolving routes: the caller names another firm's MATTER or TASK.
// ---------------------------------------------------------------------------

describe('naming another firm matter as the scope', () => {
  it('refuses to create a folder in it', async () => {
    const res = await me.api.post(`${F()}/create-folder`)
      .send({ lawFirmId: mine.id, matterId: theirMatter, folderName: 'Injected' });

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to rename a document in it', async () => {
    const res = await me.api.post(`${F()}/rename`)
      .send({ lawFirmId: mine.id, matterId: theirMatter, fileId: theirDocument.id, newName: 'Mine.pdf' });

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to move a document out of it', async () => {
    const res = await me.api.post(`${F()}/move`).send({
      lawFirmId: mine.id,
      matterId: theirMatter,
      fileId: theirDocument.id,
      destinationFolderId: theirFolder.id,
    });

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to delete a document in it', async () => {
    const res = await me.api
      .delete(`${F()}/delete?lawFirmId=${mine.id}&matterId=${theirMatter}&fileId=${theirDocument.id}`);

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to delete a folder in it', async () => {
    const res = await me.api.delete(
      `${F()}/delete?lawFirmId=${mine.id}&matterId=${theirMatter}&fileId=${theirFolder.id}`,
    );

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to recolour a folder in it', async () => {
    const res = await me.api.post(`${F()}/update-folder-color`)
      .send({ lawFirmId: mine.id, matterId: theirMatter, folderId: theirFolder.id, folderColor: '#000000' });

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to share a document in it with a client portal', async () => {
    const res = await me.api.patch(`${F()}/client-visibility`)
      .send({ lawFirmId: mine.id, matterId: theirMatter, fileId: theirDocument.id, clientVisible: true });

    // The worst of the set: it needs no write to storage to do damage. A share
    // publishes the document to THIS firm's portal clients.
    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to upload into it', async () => {
    const res = await me.api.post(`${F()}/upload-init`).send({
      lawFirmId: mine.id,
      context: 'matter',
      matterId: theirMatter,
      files: [{ name: 'Planted.pdf', size: 7, contentType: 'application/pdf' }],
    });

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to file a note attachment into it', async () => {
    // Through the shared upload pair, which is what note attachments use now.
    // The refusal has to happen at INIT, before a session url exists: once one
    // is minted the bytes reach storage whatever the finalize step decides.
    const res = await me.api.post(`${F()}/upload-init`).send({
      lawFirmId: mine.id,
      context: 'matter',
      matterId: theirMatter,
      attachmentFolder: 'note-attachments',
      files: [{ name: 'Planted.pdf', size: 7, contentType: 'application/pdf' }],
    });

    expect(res.status).toBe(404);
    expect(res.body.uploads).toBeUndefined();
    await expectTheirTreeIntact();
  });

  it('refuses to export it as an archive', async () => {
    const res = await me.api.post(`${F()}/export-jobs?lawFirmId=${mine.id}`)
      .send({ matterId: theirMatter, folderId: theirFolder.id });

    // Reading is the point of this one: the archive would be the whole subtree
    // of another firm's matter, handed to a caller with no claim on any of it.
    // The refusal has to land at the REQUEST, before a job row exists: once one
    // is committed a worker builds the archive with no user to check.
    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select count(*)::int as n from file_export_jobs');
    expect(rows[0].n).toBe(0);
  });
});

describe('naming another firm task as the scope', () => {
  it('refuses to upload an attachment onto it', async () => {
    const res = await me.api.post(`${F()}/upload-init`).send({
      lawFirmId: mine.id,
      context: 'task',
      taskId: theirTask,
      files: [{ name: 'Planted.pdf', size: 7, contentType: 'application/pdf' }],
    });

    expect(res.status).toBe(404);
    expect(res.body.uploads).toBeUndefined();
    await expectTheirTreeIntact();
  });

  it('refuses to delete an attachment from it', async () => {
    const res = await me.api.delete(
      `${F()}/delete-task-attachment?lawFirmId=${mine.id}&taskId=${theirTask}&fileId=${theirDocument.id}`,
    );

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('refuses to delete an attachment from it even when the file really is under that task matter', async () => {
    // The file here genuinely sits in the tree that task files into, so the only
    // thing standing between this request and the delete is the task lookup
    // being scoped to the calling firm.
    const res = await me.api.delete(
      `${F()}/delete-task-attachment?lawFirmId=${mine.id}&taskId=${theirTask}&fileId=${theirFolderFile.id}`,
    );

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });
});

// ---------------------------------------------------------------------------
// The id-taking routes: the caller's OWN scope, another firm's file id.
// ---------------------------------------------------------------------------

describe('naming another firm file id inside a legitimate scope', () => {
  it('refuses to share it with a client portal', async () => {
    const res = await me.api.patch(`${F()}/client-visibility`)
      .send({ lawFirmId: mine.id, matterId: myMatter, fileId: theirDocument.id, clientVisible: true });

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('does not delete it, and does not silently delete something else either', async () => {
    const res = await me.api.delete(
      `${F()}/delete?lawFirmId=${mine.id}&matterId=${myMatter}&fileId=${theirDocument.id}`,
    );

    expect(res.status).toBe(404);
    await expectTheirTreeIntact();
  });

  it('does not move it into the caller own matter', async () => {
    const intake = await seedFolder(mine.id, { parentId: myRoot, name: 'Intake' });

    const res = await me.api.post(`${F()}/move`).send({
      lawFirmId: mine.id,
      matterId: myMatter,
      fileId: theirDocument.id,
      destinationFolderId: intake.id,
    });

    expect(res.status).toBe(404);
    expect(await treeUnder(mine.id, intake.id)).toEqual([]);
    await expectTheirTreeIntact();
  });

  it('refuses to mint a fresh download url for it', async () => {
    const res = await me.api.get(
      `${F()}/refresh-url?lawFirmId=${mine.id}&fileId=${theirDocument.id}`,
    );

    // A signed url is a bearer credential to the bytes. Once minted, nothing
    // downstream re-checks who asked for it.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.signedUrl).toBeUndefined();
  });

  it('refuses to put it in an export', async () => {
    const res = await me.api.post(`${F()}/export-jobs?lawFirmId=${mine.id}`)
      .send({ matterId: myMatter, fileIds: [theirDocument.id] });

    // Every id in a selection resolves against the caller's own firm, so a
    // selection made entirely of another firm's ids has nothing left in it.
    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select count(*)::int as n from file_export_jobs');
    expect(rows[0].n).toBe(0);
  });

  it('leaves another firm ids out of an export that also names the caller own', async () => {
    const mineFile = await seedFile(mine.id, {
      parentId: myRoot, name: 'My Brief.pdf', bytes: 512,
    });

    const res = await exportArchive(mine.id, me, {
      matterId: myMatter, fileIds: [mineFile.id, theirDocument.id],
    });

    // Mixed selections are where a filter that merely reported an error on the
    // all-foreign case would still leak: the request succeeds, so the only thing
    // saying the foreign document was dropped is the archive itself.
    expect(res.jobStatus).toBe('succeeded');
    expect(zipEntryNames(res.bytes!)).toEqual(['My Brief.pdf']);
  });

  it('refuses to finalize an upload onto it', async () => {
    const res = await me.api.post(`${F()}/upload-finalize`).send({
      lawFirmId: mine.id,
      context: 'matter',
      matterId: myMatter,
      uploads: [{ fileId: theirDocument.id, declaredSize: 4096 }],
    });

    // Finalize is the one write route that answers 201 with a per-entry failure
    // list. Adopting the entry would stamp another firm's row and charge these
    // bytes to the caller.
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(0);
    expect(res.body.failures).toEqual([
      { objectPath: null, error: 'Not an upload of yours' },
    ]);
    await expectTheirTreeIntact();
  });
});

// ---------------------------------------------------------------------------

describe('the same requests from the firm that owns the documents', () => {
  /**
   * Without these the whole file passes against a module that refuses everyone.
   * Each is the exact request above, made by the firm the documents belong to.
   */
  const T = () => `/api/lawfirms/${theirs.id}/files`;

  it('lets the owning firm rename its own document', async () => {
    const res = await them.api.post(`${T()}/rename`)
      .send({ lawFirmId: theirs.id, matterId: theirMatter, fileId: theirDocument.id, newName: 'Mine.pdf' });

    expect(res.status).toBe(200);
    expect((await fileRowById(theirs.id, theirDocument.id)).name).toBe('Mine.pdf');
  });

  it('lets the owning firm share its own document', async () => {
    const res = await them.api.patch(`${T()}/client-visibility`)
      .send({ lawFirmId: theirs.id, matterId: theirMatter, fileId: theirDocument.id, clientVisible: true });

    expect(res.status).toBe(200);
    expect((await fileRowById(theirs.id, theirDocument.id)).client_visible).toBe(true);
  });

  it('lets the owning firm delete its own document', async () => {
    const res = await them.api.delete(
      `${T()}/delete?lawFirmId=${theirs.id}&matterId=${theirMatter}&fileId=${theirDocument.id}`,
    );

    expect(res.status).toBe(200);
    expect((await fileRowById(theirs.id, theirDocument.id)).deleted_at).not.toBeNull();
  });

  it('lets the owning firm export its own folder', async () => {
    const res = await exportArchive(theirs.id, them, {
      matterId: theirMatter, folderId: theirFolder.id,
    });

    expect(res.jobStatus).toBe('succeeded');
    expect(zipEntryNames(res.bytes!)).toEqual(['Exhibit A.pdf']);
  });

  it('lets the owning firm recolour its own folder', async () => {
    const res = await them.api.post(`${T()}/update-folder-color`)
      .send({ lawFirmId: theirs.id, matterId: theirMatter, folderId: theirFolder.id, folderColor: '#000000' });

    expect(res.status).toBe(200);
    expect((await fileRowById(theirs.id, theirFolder.id)).folder_color).toBe('#000000');
  });
});

describe('the firm general area is not a way around the matter gate either', () => {
  it('refuses to delete another firm general document', async () => {
    const theirGeneralRoot = await rootOf(theirs.id);
    const theirGeneral = await seedFile(theirs.id, {
      parentId: theirGeneralRoot, name: 'Retainer Template.docx', bytes: 128,
    });

    const res = await me.api.delete(
      `${F()}/delete?lawFirmId=${mine.id}&fileId=${theirGeneral.id}`,
    );

    // No matter id at all, so the scope is the CALLER's own general folder: an
    // area every firm member is authorized for without any further gate. The
    // firm-scoped lookup is the whole of the protection here, which is why this
    // case is worth having separately from the matter ones above.
    expect(res.status).toBe(404);
    expect(await fileRowById(theirs.id, theirGeneral.id))
      .toMatchObject({ name: 'Retainer Template.docx', deleted_at: null });
  });

  it('refuses a rename of another firm general document', async () => {
    const theirGeneralRoot = await rootOf(theirs.id);
    const theirGeneral = await seedFile(theirs.id, {
      parentId: theirGeneralRoot, name: 'Retainer Template.docx', bytes: 128,
    });

    const res = await me.api.post(`${F()}/rename`)
      .send({ lawFirmId: mine.id, fileId: theirGeneral.id, newName: 'Taken.docx' });

    expect(res.status).toBe(404);
    expect((await fileRowById(theirs.id, theirGeneral.id)).name).toBe('Retainer Template.docx');
  });
});

describe('an unrelated firm id in the url is not a shortcut', () => {
  it('refuses a caller who is not a member of the firm in the path', async () => {
    const res = await me.api
      .delete(`/api/lawfirms/${theirs.id}/files/delete`
        + `?lawFirmId=${theirs.id}&matterId=${theirMatter}&fileId=${theirDocument.id}`);

    // The other direction: address the victim's firm directly. `resolveMember`
    // is what refuses here, before any files code runs.
    expect(res.status).toBe(403);
    await expectTheirTreeIntact();
  });

  it('refuses a caller with no membership anywhere', async () => {
    const nobodyUid = `outsider-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type)
       values ($1, $2, 'Outsider', 'firm_member')`,
      [nobodyUid, `${nobodyUid}@example.test`],
    );
    const { as, tokenFor } = require('../support/setupInProcess');

    const res = await as(tokenFor({ uid: nobodyUid }))
      .delete(`/api/lawfirms/${theirs.id}/files/delete`
        + `?lawFirmId=${theirs.id}&matterId=${theirMatter}&fileId=${theirDocument.id}`);

    expect(res.status).toBe(403);
    await expectTheirTreeIntact();
  });
});

// ---------------------------------------------------------------------------
// One set of requests, aimed at the three parents a document can hang off.
//
// The matter and task sections above were written one at a time and the client
// scope was never put through them. A document tree hangs off a matter, a task
// or a client through the same routes, so the same wall has to hold for each:
// the caller names the OTHER firm's parent as the scope and must reach nothing.
// ---------------------------------------------------------------------------

type ScopeKey = 'matterId' | 'taskId' | 'clientId';

interface ScopeCase {
  label: string;
  /** The request key naming the parent, and the upload `context` value. */
  key: ScopeKey;
  context: 'matter' | 'task' | 'client';
  /** A parent of that kind inside `lawFirmId`, with `uid` allowed to write to it. */
  seedParent(lawFirmId: string, uid: string): Promise<string>;
}

const SCOPES: ScopeCase[] = [
  { label: 'matter', key: 'matterId', context: 'matter', seedParent: (firmId, uid) => seedMatter(firmId, uid, 'Scoped matter') },
  // Standalone, so the task owns its own tree rather than sharing a matter's.
  { label: 'task', key: 'taskId', context: 'task', seedParent: (firmId) => seedTask(firmId, { title: 'Scoped task' }) },
  { label: 'client', key: 'clientId', context: 'client', seedParent: async (firmId) => (await createPersonClient(firmId, { name: 'Scoped client' })).id },
];

describe.each(SCOPES)('naming another firm $label as the scope', (scope) => {
  let victimParent: string;
  let victimRoot: string;
  let victimDoc: { id: string; objectPath: string };
  let victimFolder: { id: string };
  let myParent: string;

  const aimAtVictim = () => ({ [scope.key]: victimParent });
  const treeNow = () => treeUnder(theirs.id, victimRoot);

  async function expectVictimIntact(): Promise<void> {
    expect(await treeNow()).toEqual(['Scoped Deposition.pdf', 'Scoped Discovery']);
    expect(objects.get(victimDoc.objectPath)?.bytes).toBe(4096);
    expect(await fileRowById(theirs.id, victimDoc.id))
      .toMatchObject({ name: 'Scoped Deposition.pdf', client_visible: false, deleted_at: null });
    expect(await fileRowById(theirs.id, victimFolder.id))
      .toMatchObject({ name: 'Scoped Discovery', folder_color: '#0ea5e9' });
    // Nothing was planted in the CALLER's own firm under the victim's parent
    // either: a refused request must not leave a scope root behind.
    const { rows } = await testPool.query(
      `select count(*)::int as n from files
        where law_firm_id = $1 and (matter_id = $2 or task_id = $2 or client_id = $2)`,
      [mine.id, victimParent],
    );
    expect(rows[0].n).toBe(0);
  }

  beforeEach(async () => {
    victimParent = await scope.seedParent(theirs.id, them.uid);
    victimRoot = await rootOf(theirs.id, { [scope.key]: victimParent });
    victimDoc = await seedFile(theirs.id, { parentId: victimRoot, name: 'Scoped Deposition.pdf', bytes: 4096 });
    victimFolder = await seedFolder(theirs.id, { parentId: victimRoot, name: 'Scoped Discovery', color: '#0ea5e9' });
    myParent = await scope.seedParent(mine.id, me.uid);
  });

  it('refuses to create a folder in it', async () => {
    const res = await me.api.post(`${F()}/create-folder`)
      .send({ lawFirmId: mine.id, ...aimAtVictim(), folderName: 'Injected' });

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  it('refuses to rename a document in it', async () => {
    const res = await me.api.post(`${F()}/rename`)
      .send({ lawFirmId: mine.id, ...aimAtVictim(), fileId: victimDoc.id, newName: 'Mine.pdf' });

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  it('refuses to move a document out of it', async () => {
    const res = await me.api.post(`${F()}/move`).send({
      lawFirmId: mine.id, ...aimAtVictim(), fileId: victimDoc.id, destinationFolderId: victimFolder.id,
    });

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  it('refuses to delete a document in it', async () => {
    const res = await me.api.delete(
      `${F()}/delete?lawFirmId=${mine.id}&${scope.key}=${victimParent}&fileId=${victimDoc.id}`,
    );

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  it('refuses to delete a folder in it', async () => {
    const res = await me.api.delete(
      `${F()}/delete?lawFirmId=${mine.id}&${scope.key}=${victimParent}&fileId=${victimFolder.id}`,
    );

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  it('refuses to recolour a folder in it', async () => {
    const res = await me.api.post(`${F()}/update-folder-color`)
      .send({ lawFirmId: mine.id, ...aimAtVictim(), folderId: victimFolder.id, folderColor: '#000000' });

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  it('refuses to share a document in it with a client portal', async () => {
    const res = await me.api.patch(`${F()}/client-visibility`)
      .send({ lawFirmId: mine.id, ...aimAtVictim(), fileId: victimDoc.id, clientVisible: true });

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  it('refuses to upload into it, before any session url exists', async () => {
    const res = await me.api.post(`${F()}/upload-init`).send({
      lawFirmId: mine.id,
      context: scope.context,
      ...aimAtVictim(),
      files: [{ name: 'Planted.pdf', size: 7, contentType: 'application/pdf' }],
    });

    expect(res.status).toBe(404);
    expect(res.body.uploads).toBeUndefined();
    await expectVictimIntact();
  });

  it('refuses to export it as an archive, before a job row exists', async () => {
    const res = await me.api.post(`${F()}/export-jobs?lawFirmId=${mine.id}`)
      .send({ ...aimAtVictim(), folderId: victimFolder.id });

    expect(res.status).toBe(404);
    const { rows } = await testPool.query('select count(*)::int as n from file_export_jobs');
    expect(rows[0].n).toBe(0);
  });

  it('refuses another firm file id inside the caller own parent of the same kind', async () => {
    const res = await me.api.patch(`${F()}/client-visibility`)
      .send({ lawFirmId: mine.id, [scope.key]: myParent, fileId: victimDoc.id, clientVisible: true });

    expect(res.status).toBe(404);
    await expectVictimIntact();
  });

  describe('and the same requests from the firm that owns it', () => {
    const T = () => `/api/lawfirms/${theirs.id}/files`;

    it('lets the owning firm rename its own document', async () => {
      const res = await them.api.post(`${T()}/rename`)
        .send({ lawFirmId: theirs.id, ...aimAtVictim(), fileId: victimDoc.id, newName: 'Renamed.pdf' });

      expect(res.status).toBe(200);
      expect((await fileRowById(theirs.id, victimDoc.id)).name).toBe('Renamed.pdf');
    });

    it('lets the owning firm share its own document', async () => {
      const res = await them.api.patch(`${T()}/client-visibility`)
        .send({ lawFirmId: theirs.id, ...aimAtVictim(), fileId: victimDoc.id, clientVisible: true });

      expect(res.status).toBe(200);
      expect((await fileRowById(theirs.id, victimDoc.id)).client_visible).toBe(true);
    });

    it('lets the owning firm delete its own document', async () => {
      const res = await them.api.delete(
        `${T()}/delete?lawFirmId=${theirs.id}&${scope.key}=${victimParent}&fileId=${victimDoc.id}`,
      );

      expect(res.status).toBe(200);
      expect((await fileRowById(theirs.id, victimDoc.id)).deleted_at).not.toBeNull();
    });
  });
});
