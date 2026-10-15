/**
 * Share links that name several files and folders at once.
 *
 * A multi-item link is created from a selection in the file browser. Its
 * recipient sees the selected items, can open any shared folder, and can
 * download any document the link reaches, all with no login. The token is the
 * whole credential, so the property most worth protecting is REACH: a download
 * or a folder listing through the link must refuse anything that is not one of
 * the selected items or inside one of the selected folders, however the
 * request names it.
 *
 * A shared folder is live. It shares what is inside it when the recipient opens
 * the link, so a document added later is reachable and one deleted since is
 * not.
 */
import { installInMemoryBucket, objects } from '../support/inMemoryBucket';
import { hashSharePassword, rootOf, seedFile, seedFolder, seedMatter, seedTask } from './fileWorld';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

installInMemoryBucket();

let firm: Firm;
let owner: Actor;
let firmRoot: string;
/** A folder holding two documents and a subfolder with a third. */
let discovery: { id: string; name: string };
let interrogatories: { id: string; objectPath: string };
let subfolder: { id: string; name: string };
let nestedDoc: { id: string; objectPath: string };
/** A document beside the folder, shared on its own. */
let looseDoc: { id: string; objectPath: string };
/** A document in the same firm that no link names. */
let unsharedDoc: { id: string; objectPath: string };

const anonymous = () => as('');
const links = () => `/api/lawfirms/${firm.id}/file-share-links`;

/** Create a link through the real route and return its token. */
async function createLink(body: Record<string, unknown>) {
  const res = await owner.api.post(links()).send(body);
  expect(res.status).toBe(201);
  return String(res.body.link.token);
}

const linkCount = async () => {
  const { rows } = await testPool.query(
    'select count(*)::int as n from file_share_links where law_firm_id = $1',
    [firm.id],
  );
  return rows[0].n as number;
};

const names = (res: any) => (res.body.items as Array<{ name: string }>).map((i) => i.name).sort();

beforeEach(async () => {
  objects.clear();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  firmRoot = await rootOf(firm.id, {});
  discovery = await seedFolder(firm.id, { parentId: firmRoot, name: 'Discovery' });
  interrogatories = await seedFile(firm.id, { parentId: discovery.id, name: 'Interrogatories.pdf' });
  await seedFile(firm.id, { parentId: discovery.id, name: 'Requests for Production.pdf' });
  subfolder = await seedFolder(firm.id, { parentId: discovery.id, name: 'Depositions' });
  nestedDoc = await seedFile(firm.id, { parentId: subfolder.id, name: 'Smith Deposition.pdf' });
  looseDoc = await seedFile(firm.id, { parentId: firmRoot, name: 'Engagement Letter.pdf' });
  unsharedDoc = await seedFile(firm.id, { parentId: firmRoot, name: 'Privileged Memo.pdf' });
  await drainEvents();
});

describe('creating a link to several items', () => {
  it('records every selected item and names the link by its count', async () => {
    const res = await owner.api.post(links()).send({ fileIds: [discovery.id, looseDoc.id] });

    expect(res.status).toBe(201);
    expect(res.body.link.url).toContain(`/share/${res.body.link.token}`);
    const { rows: [link] } = await testPool.query(
      'select file_id, display_name from file_share_links where token = $1',
      [res.body.link.token],
    );
    // A multi-item link points at no single document; its items say what it holds.
    expect(link.file_id).toBeNull();
    expect(link.display_name).toBe('2 items');
    const { rows: items } = await testPool.query(
      'select file_id from file_share_link_items where token = $1',
      [res.body.link.token],
    );
    expect(items.map((r: any) => r.file_id).sort()).toEqual([discovery.id, looseDoc.id].sort());
  });

  it('names a link to one folder after the folder', async () => {
    const token = await createLink({ fileIds: [discovery.id] });

    const { rows: [link] } = await testPool.query(
      'select file_id, display_name from file_share_links where token = $1',
      [token],
    );
    expect(link.display_name).toBe('Discovery');
    expect(link.file_id).toBeNull();
  });

  it('keeps a selection of one document in the single-file shape', async () => {
    const token = await createLink({ fileIds: [looseDoc.id] });

    // The single-file shape is what every existing link and the delete-revokes
    // path rely on, so one document must not become a one-item bundle.
    const { rows: [link] } = await testPool.query(
      'select file_id from file_share_links where token = $1',
      [token],
    );
    expect(link.file_id).toBe(looseDoc.id);
    const { rows: items } = await testPool.query(
      'select 1 from file_share_link_items where token = $1',
      [token],
    );
    expect(items).toHaveLength(0);
  });

  it('refuses the whole selection when one item sits behind a matter the member cannot read', async () => {
    const member = await createFirmMember(firm.id, { isOwner: false, permissions: ['files.upload'] });
    const memberApi = as(tokenFor({ uid: member.uid }));
    const walled = await seedMatter(firm.id, null, 'Walled Matter');
    const walledRoot = await rootOf(firm.id, { matterId: walled });
    const walledDoc = await seedFile(firm.id, { parentId: walledRoot, name: 'Walled.pdf' });

    // The positive half first: the same member CAN share the firm document on
    // its own, so the refusal below is the wall, not a missing permission.
    const allowed = await memberApi.post(links()).send({ fileIds: [looseDoc.id] });
    expect(allowed.status).toBe(201);

    const res = await memberApi.post(links()).send({ fileIds: [looseDoc.id, walledDoc.id] });

    // The matter gate's own refusal, the same one a single-file link gets.
    expect(res.status).toBe(403);
    expect(await linkCount()).toBe(1);
  });

  it('refuses an item from another firm and writes nothing', async () => {
    const otherFirm = await createFirm();
    const otherRoot = await rootOf(otherFirm.id, {});
    const theirs = await seedFile(otherFirm.id, { parentId: otherRoot, name: 'Theirs.pdf' });

    const res = await owner.api.post(links()).send({ fileIds: [looseDoc.id, theirs.id] });

    expect(res.status).toBe(404);
    expect(await linkCount()).toBe(0);
  });

  it('refuses an empty selection and one past the cap', async () => {
    const empty = await owner.api.post(links()).send({ fileIds: [] });
    const tooMany = await owner.api.post(links()).send({
      fileIds: Array.from({ length: 101 }, () => looseDoc.id),
    });

    expect(empty.status).toBe(400);
    expect(tooMany.status).toBe(400);
    expect(await linkCount()).toBe(0);
  });

  it('lists a multi-item link on each item it names, and nowhere else', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const onFolder = await owner.api.get(`${links()}?fileId=${discovery.id}`);
    const onLoose = await owner.api.get(`${links()}?fileId=${looseDoc.id}`);
    const onUnshared = await owner.api.get(`${links()}?fileId=${unsharedDoc.id}`);

    // Opening "Share link" on any selected item is where the firm finds this
    // link again to copy or revoke it.
    expect(onFolder.body.links.map((l: any) => l.token)).toEqual([token]);
    expect(onLoose.body.links.map((l: any) => l.token)).toEqual([token]);
    expect(onFolder.body.links[0].displayName).toBe('2 items');
    expect(onUnshared.body.links).toEqual([]);
  });
});

describe('what the recipient sees', () => {
  it('marks the link as multi-item without naming its contents in the public metadata', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id], password: 'correct horse' });

    const res = await anonymous().get(`/api/share/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.isMultiItem).toBe(true);
    expect(res.body.requiresPassword).toBe(true);
    // The metadata answers before the password, so the names of what was
    // shared must wait for it.
    expect(JSON.stringify(res.body)).not.toContain('Engagement Letter.pdf');
    expect(JSON.stringify(res.body)).not.toContain('Discovery');
  });

  it('lists the selected items, and only those, at the top level', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const res = await anonymous().post(`/api/share/${token}/items`).send({});

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Discovery', 'Engagement Letter.pdf']);
    const folder = res.body.items.find((i: any) => i.name === 'Discovery');
    expect(folder.isFolder).toBe(true);
  });

  it('opens a shared folder and a folder inside it, with the path back to the top', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const inFolder = await anonymous().post(`/api/share/${token}/items`).send({ folderId: discovery.id });
    const inSub = await anonymous().post(`/api/share/${token}/items`).send({ folderId: subfolder.id });

    expect(inFolder.status).toBe(200);
    expect(names(inFolder)).toEqual(['Depositions', 'Interrogatories.pdf', 'Requests for Production.pdf']);
    expect(inSub.status).toBe(200);
    expect(names(inSub)).toEqual(['Smith Deposition.pdf']);
    expect(inSub.body.path.map((p: any) => p.name)).toEqual(['Discovery', 'Depositions']);
  });

  it('refuses to open a folder the link does not reach', async () => {
    const elsewhere = await seedFolder(firm.id, { parentId: firmRoot, name: 'Internal' });
    await seedFile(firm.id, { parentId: elsewhere.id, name: 'Internal Notes.pdf' });
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const res = await anonymous().post(`/api/share/${token}/items`).send({ folderId: elsewhere.id });
    const root = await anonymous().post(`/api/share/${token}/items`).send({ folderId: firmRoot });

    // The firm root is an ANCESTOR of a shared folder, not inside one. Walking up
    // from a shared item must never be how a recipient reaches the whole firm.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Internal Notes.pdf');
    expect(root.status).toBe(404);
    expect(JSON.stringify(root.body)).not.toContain('Privileged Memo.pdf');
  });
});

describe('what the recipient can download', () => {
  it('downloads a document two folders inside a shared folder', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: nestedDoc.id });

    expect(res.status).toBe(200);
    expect(res.body.url).toContain(encodeURIComponent(nestedDoc.objectPath));
    expect(res.body.displayName).toBe('Smith Deposition.pdf');
  });

  it('downloads a document selected on its own', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: looseDoc.id });

    expect(res.status).toBe(200);
    expect(res.body.url).toContain(encodeURIComponent(looseDoc.objectPath));
  });

  it('refuses a document in the same firm that the link does not name', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: unsharedDoc.id });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(unsharedDoc.objectPath);
    expect(JSON.stringify(res.body)).not.toContain('Privileged Memo.pdf');
  });

  it('refuses a document in another firm', async () => {
    const otherFirm = await createFirm();
    const otherRoot = await rootOf(otherFirm.id, {});
    const theirs = await seedFile(otherFirm.id, { parentId: otherRoot, name: 'Theirs.pdf' });
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: theirs.id });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(theirs.objectPath);
  });

  it('asks which document when a multi-item link is downloaded without one', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    const res = await anonymous().post(`/api/share/${token}/download`).send({});

    expect(res.status).toBe(400);
    expect(res.body.url).toBeUndefined();
  });

  it('counts each download as an access', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });

    await anonymous().post(`/api/share/${token}/download`).send({ fileId: looseDoc.id });
    await anonymous().post(`/api/share/${token}/download`).send({ fileId: interrogatories.id });

    const { rows: [link] } = await testPool.query(
      'select access_count from file_share_links where token = $1',
      [token],
    );
    expect(link.access_count).toBe(2);
  });
});

describe('a shared folder is live', () => {
  it('reaches a document added to the folder after the link was made', async () => {
    const token = await createLink({ fileIds: [discovery.id] });
    const later = await seedFile(firm.id, { parentId: discovery.id, name: 'Supplemental Responses.pdf' });

    const listed = await anonymous().post(`/api/share/${token}/items`).send({ folderId: discovery.id });
    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: later.id });

    expect(names(listed)).toContain('Supplemental Responses.pdf');
    expect(res.status).toBe(200);
  });

  it('stops reaching a document moved out of the folder', async () => {
    const token = await createLink({ fileIds: [discovery.id] });
    const before = await anonymous().post(`/api/share/${token}/download`).send({ fileId: interrogatories.id });
    await testPool.query('update files set parent_id = $2 where id = $1', [interrogatories.id, firmRoot]);

    const after = await anonymous().post(`/api/share/${token}/download`).send({ fileId: interrogatories.id });

    expect(before.status).toBe(200);
    expect(after.status).toBe(404);
  });

  it('drops a deleted item from the listing and refuses to download it', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });
    await testPool.query('update files set deleted_at = now() where id = $1', [looseDoc.id]);

    const listed = await anonymous().post(`/api/share/${token}/items`).send({});
    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: looseDoc.id });

    expect(names(listed)).toEqual(['Discovery']);
    expect(res.status).toBe(404);
  });

  it('keeps a task\'s documents inside a shared matter folder out of reach', async () => {
    const matterId = await seedMatter(firm.id, owner.uid, 'Smith v. Jones');
    const matterRoot = await rootOf(firm.id, { matterId });
    const pleadings = await seedFolder(firm.id, { parentId: matterRoot, name: 'Pleadings' });
    await seedFile(firm.id, { parentId: pleadings.id, name: 'Complaint.pdf' });
    const taskId = await seedTask(firm.id, { matterId });
    const taskDoc = await seedFile(firm.id, { parentId: pleadings.id, name: 'Task Draft.pdf', taskId });
    const token = await createLink({ fileIds: [pleadings.id, looseDoc.id] });

    const listed = await anonymous().post(`/api/share/${token}/items`).send({ folderId: pleadings.id });
    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: taskDoc.id });

    // The matter's own file browser hides a task's attachments, and a task can
    // restrict who sees it. A folder link shares what the folder shows, so the
    // task's document is neither listed nor downloadable through it.
    expect(names(listed)).toEqual(['Complaint.pdf']);
    expect(res.status).toBe(404);
  });
});

describe('the link\'s own state still governs every item', () => {
  it('requires the password to list items and to download one', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });
    await testPool.query('update file_share_links set password_hash = $2 where token = $1', [
      token, hashSharePassword('correct horse'),
    ]);

    const noPassword = await anonymous().post(`/api/share/${token}/items`).send({});
    const wrong = await anonymous().post(`/api/share/${token}/download`)
      .send({ fileId: looseDoc.id, password: 'wrong horse' });
    const right = await anonymous().post(`/api/share/${token}/items`).send({ password: 'correct horse' });

    expect(noPassword.status).toBe(401);
    expect(noPassword.body.items).toBeUndefined();
    expect(wrong.status).toBe(401);
    expect(wrong.body.url).toBeUndefined();
    expect(right.status).toBe(200);
    expect(names(right)).toEqual(['Discovery', 'Engagement Letter.pdf']);
  });

  it('refuses every item once the link is revoked', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });
    const before = await anonymous().post(`/api/share/${token}/items`).send({});
    await owner.api.delete(`${links()}/${token}`);

    const listed = await anonymous().post(`/api/share/${token}/items`).send({});
    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: nestedDoc.id });

    expect(before.status).toBe(200);
    expect(listed.status).toBe(404);
    expect(res.status).toBe(404);
  });

  it('refuses every item once the link has expired', async () => {
    const token = await createLink({ fileIds: [discovery.id, looseDoc.id] });
    await testPool.query(
      'update file_share_links set expires_at = now() - interval \'1 second\' where token = $1',
      [token],
    );

    const listed = await anonymous().post(`/api/share/${token}/items`).send({});
    const res = await anonymous().post(`/api/share/${token}/download`).send({ fileId: looseDoc.id });

    expect(listed.status).toBe(410);
    expect(res.status).toBe(410);
  });
});
