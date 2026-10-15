/**
 * The template folder tree: create, rename, move, delete, and what a delete does
 * to the templates and subfolders inside.
 *
 * The three existing template specs cover HTML storage, field placements and
 * access; none of them touches the folder routes. That is the half of the module
 * with the interesting failure modes, because a folder is the only thing in it
 * that OWNS other rows. Deleting one has to reparent every template and every
 * child folder inside it in a single transaction: get that wrong and a firm's
 * engagement letters are not merely misfiled, they are pointing at a folder id
 * that no longer exists and disappear from the sidebar entirely.
 *
 * The parent id arrives as a plain uuid in the request body, so it is also the
 * one field in the module that lets a caller name a row belonging to somebody
 * else. Every write path is asserted across firms for that reason.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const F = (lawFirmId: string, suffix = '') =>
  `/api/lawfirms/${lawFirmId}/templates/folders${suffix}`;

async function seedFolder(
  lawFirmId: string,
  options: { name?: string; parentFolderId?: string | null; order?: number | null } = {},
) {
  const id = randomUUID();
  await testPool.query(
    `insert into template_folders (id, law_firm_id, name, parent_folder_id, sort_order)
     values ($1, $2, $3, $4, $5)`,
    [
      id,
      lawFirmId,
      options.name ?? `Folder ${id.slice(0, 8)}`,
      options.parentFolderId ?? null,
      options.order ?? 0,
    ],
  );
  return { id };
}

async function seedTemplate(
  lawFirmId: string,
  options: { name?: string; folderId?: string | null } = {},
) {
  const id = randomUUID();
  await testPool.query(
    `insert into templates (id, law_firm_id, name, type, folder_id)
     values ($1, $2, $3, 'html', $4)`,
    [id, lawFirmId, options.name ?? `Template ${id.slice(0, 8)}`, options.folderId ?? null],
  );
  return { id };
}

const folderRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, color, parent_folder_id, sort_order, law_firm_id from template_folders where id = $1',
    [id],
  );
  return rows[0];
};

const folderCount = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    'select count(*)::int n from template_folders where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
};

const templateRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select name, folder_id, law_firm_id from templates where id = $1',
    [id],
  );
  return rows[0];
};

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm();
  otherOwner = await ownerOf(otherFirm.id);
});

describe('creating a folder', () => {
  it('writes it into the caller firm and nowhere else', async () => {
    const res = await owner.api.post(F(firm.id)).send({ name: 'Retainers', color: 'blue' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Folder created successfully');
    expect(res.body.folder).toMatchObject({
      name: 'Retainers', color: 'blue', parentFolderId: null, order: 0,
    });
    expect(await folderRow(res.body.folderId)).toMatchObject({
      name: 'Retainers', color: 'blue', parent_folder_id: null, law_firm_id: firm.id,
    });
    expect(await folderCount(otherFirm.id)).toBe(0);
  });

  it('trims the name', async () => {
    const res = await owner.api.post(F(firm.id)).send({ name: '  Retainers  ' });

    // Untrimmed, ' Retainers' and 'Retainers' are different names to the sibling
    // conflict check, so the same folder can be created twice by accident.
    expect(res.body.folder.name).toBe('Retainers');
    expect((await folderRow(res.body.folderId)).name).toBe('Retainers');
  });

  it('nests under a parent in the same firm', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers' });

    const res = await owner.api.post(F(firm.id)).send({
      name: 'Hourly', parentFolderId: parent.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.folder.parentFolderId).toBe(parent.id);
    expect((await folderRow(res.body.folderId)).parent_folder_id).toBe(parent.id);
  });

  it('numbers each new sibling after the ones already there', async () => {
    await seedFolder(firm.id, { name: 'First', order: 4 });

    const res = await owner.api.post(F(firm.id)).send({ name: 'Second' });

    // sort_order is what orders the sidebar. Restart it at zero on every create
    // and new folders jump to the top of a tree the firm has arranged.
    expect(res.body.folder.order).toBe(5);
  });

  it('counts siblings per parent, not across the whole tree', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers', order: 9 });

    const res = await owner.api.post(F(firm.id)).send({
      name: 'Hourly', parentFolderId: parent.id,
    });

    // The first child of a folder starts at zero regardless of how deep the
    // top-level list already runs.
    expect(res.body.folder.order).toBe(0);
  });

  it('refuses a duplicate name under the same parent', async () => {
    await seedFolder(firm.id, { name: 'Retainers' });

    const res = await owner.api.post(F(firm.id)).send({ name: 'retainers' });

    // Matched case-insensitively and after trimming: two folders reading
    // "Retainers" in the same place are indistinguishable in the sidebar, and a
    // template filed into one of them looks lost.
    expect(res.status).toBe(409);
    expect(await folderCount(firm.id)).toBe(1);
  });

  it('allows the same name under a DIFFERENT parent', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers' });

    const res = await owner.api.post(F(firm.id)).send({
      name: 'Retainers', parentFolderId: parent.id,
    });

    // The conflict is per sibling group, not per firm. A tree cannot have
    // "Drafts" under two different parents otherwise.
    expect(res.status).toBe(201);
    expect(await folderCount(firm.id)).toBe(2);
  });

  it('allows the same name in ANOTHER firm', async () => {
    await seedFolder(firm.id, { name: 'Retainers' });

    const res = await otherOwner.api.post(F(otherFirm.id)).send({ name: 'Retainers' });

    expect(res.status).toBe(201);
    expect(await folderCount(otherFirm.id)).toBe(1);
  });

  it('refuses a parent that belongs to ANOTHER firm', async () => {
    const foreignParent = await seedFolder(otherFirm.id, { name: 'Their Retainers' });

    const res = await owner.api.post(F(firm.id)).send({
      name: 'Hourly', parentFolderId: foreignParent.id,
    });

    // The parent id is a plain uuid in the body, so nothing but this check stops
    // a firm hanging a folder under another firm's tree. The candidate parents
    // are drawn from the caller's own folders, which is what makes the id
    // unresolvable rather than merely unauthorised.
    expect(res.status).toBe(404);
    expect(await folderCount(firm.id)).toBe(0);
  });

  it('refuses a parent that does not exist', async () => {
    const res = await owner.api.post(F(firm.id)).send({
      name: 'Hourly', parentFolderId: randomUUID(),
    });

    expect(res.status).toBe(404);
    expect(await folderCount(firm.id)).toBe(0);
  });

  it('refuses an empty name', async () => {
    const res = await owner.api.post(F(firm.id)).send({ name: '' });

    expect(res.status).toBe(400);
    expect(await folderCount(firm.id)).toBe(0);
  });

  it('refuses a member with templates.view but not templates.manage', async () => {
    const viewer = await memberWith(firm.id, ['templates.view']);

    const res = await viewer.api.post(F(firm.id)).send({ name: 'Retainers' });

    expect(res.status).toBe(403);
    expect(await folderCount(firm.id)).toBe(0);
  });

  it('refuses a member of another firm creating under this firm', async () => {
    const res = await otherOwner.api.post(F(firm.id)).send({ name: 'Retainers' });

    expect(res.status).toBe(403);
    expect(await folderCount(firm.id)).toBe(0);
  });

  it('refuses a firm whose plan does not include templates', async () => {
    const starterFirm = await createFirm({ planId: 'starter' });
    const starterOwner = await ownerOf(starterFirm.id);

    const res = await starterOwner.api.post(F(starterFirm.id)).send({ name: 'Retainers' });

    // The whole templates mount sits behind `requireFeature('templates')`, and
    // the folders router shares it. A folder tree reachable on a plan that
    // cannot open a template is a paywall with a hole in it.
    expect(res.status).toBe(403);
    expect(await folderCount(starterFirm.id)).toBe(0);
  });
});

describe('listing folders', () => {
  it('lists the firm folders ordered by sort order then name', async () => {
    await seedFolder(firm.id, { name: 'Zulu', order: 1 });
    await seedFolder(firm.id, { name: 'Alpha', order: 2 });

    const res = await owner.api.get(F(firm.id));

    expect(res.status).toBe(200);
    expect(res.body.folders.map((row: any) => row.name)).toEqual(['Zulu', 'Alpha']);
    expect(res.body.totalFolders).toBe(2);
  });

  it('does NOT list another firm folders', async () => {
    await seedFolder(otherFirm.id, { name: 'Confidential Matters Folder' });
    await seedFolder(firm.id, { name: 'Our Own Folder' });

    const res = await owner.api.get(F(firm.id));

    expect(res.body.folders.map((row: any) => row.name)).toEqual(['Our Own Folder']);
    expect(res.body.totalFolders).toBe(1);
  });

  it('CHARACTERISATION: a member with an empty role can read the tree', async () => {
    await seedFolder(firm.id, { name: 'Our Own Folder' });
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(F(firm.id));

    // `templates.view` is in DEFAULT_PERMISSIONS, so the sidebar renders for
    // every member. Without the tree the templates they ARE allowed to use have
    // nowhere to appear.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Our Own Folder');
  });

  it('refuses a member of another firm asking under this firm', async () => {
    await seedFolder(firm.id, { name: 'Confidential Matters Folder' });

    const res = await otherOwner.api.get(F(firm.id));

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Confidential Matters Folder');
  });
});

describe('renaming and moving a folder', () => {
  it('renames it', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Old Name' });

    const res = await owner.api.put(F(firm.id, `/${id}`)).send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.folder.name).toBe('New Name');
    // Read back from the table too: the response is assembled by merging the
    // update over the row it read, so it can report a name the write never
    // persisted.
    expect((await folderRow(id)).name).toBe('New Name');
  });

  it('leaves the parent alone when the request does not mention it', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers' });
    const { id } = await seedFolder(firm.id, { name: 'Hourly', parentFolderId: parent.id });

    await owner.api.put(F(firm.id, `/${id}`)).send({ name: 'Hourly Renamed' });

    // A rename that also unfiled the folder would flatten a firm's tree one edit
    // at a time.
    expect((await folderRow(id)).parent_folder_id).toBe(parent.id);
  });

  it('moves a folder to the top level when the parent is cleared', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers' });
    const { id } = await seedFolder(firm.id, { name: 'Hourly', parentFolderId: parent.id });

    const res = await owner.api.put(F(firm.id, `/${id}`)).send({ parentFolderId: null });

    // An explicit null means "move it out", distinct from an absent key. Collapse
    // the two and a folder cannot be pulled back to the root.
    expect(res.status).toBe(200);
    expect((await folderRow(id)).parent_folder_id).toBeNull();
  });

  it('renumbers a moved folder after its new siblings', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers', order: 0 });
    await seedFolder(firm.id, { name: 'Existing Child', parentFolderId: parent.id, order: 3 });
    const { id } = await seedFolder(firm.id, { name: 'Mover', order: 1 });

    await owner.api.put(F(firm.id, `/${id}`)).send({ parentFolderId: parent.id });

    // It kept its old top-level order otherwise, which would place it among its
    // new siblings arbitrarily.
    expect((await folderRow(id)).sort_order).toBe(4);
  });

  it('refuses to make a folder its own parent', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Retainers' });

    const res = await owner.api.put(F(firm.id, `/${id}`)).send({ parentFolderId: id });

    // A self-parented row is unreachable from the root, so the folder and
    // everything in it vanishes from the sidebar while still existing.
    expect(res.status).toBe(400);
    expect((await folderRow(id)).parent_folder_id).toBeNull();
  });

  it('refuses to move a folder inside its own descendant', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers' });
    const child = await seedFolder(firm.id, { name: 'Hourly', parentFolderId: parent.id });

    const res = await owner.api.put(F(firm.id, `/${parent.id}`)).send({ parentFolderId: child.id });

    // This is the cycle case, and it is the one that costs more than a broken
    // sidebar: the two folders point at each other, so any walk of the tree
    // spins forever and pins the event loop.
    expect(res.status).toBe(400);
    expect((await folderRow(parent.id)).parent_folder_id).toBeNull();
    expect((await folderRow(child.id)).parent_folder_id).toBe(parent.id);
  });

  it('refuses a rename that collides with a sibling', async () => {
    await seedFolder(firm.id, { name: 'Retainers' });
    const { id } = await seedFolder(firm.id, { name: 'Engagements' });

    const res = await owner.api.put(F(firm.id, `/${id}`)).send({ name: 'Retainers' });

    expect(res.status).toBe(409);
    expect((await folderRow(id)).name).toBe('Engagements');
  });

  it('allows a rename to the name it already has', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Retainers' });

    const res = await owner.api.put(F(firm.id, `/${id}`)).send({ name: 'Retainers', color: 'red' });

    // The conflict check excludes the folder being edited. Include it and no
    // folder can ever have its colour changed without also being renamed.
    expect(res.status).toBe(200);
    expect((await folderRow(id)).color).toBe('red');
  });

  it('refuses a move that would collide with a name in the destination', async () => {
    const parent = await seedFolder(firm.id, { name: 'Retainers' });
    await seedFolder(firm.id, { name: 'Drafts', parentFolderId: parent.id });
    const { id } = await seedFolder(firm.id, { name: 'Drafts' });

    const res = await owner.api.put(F(firm.id, `/${id}`)).send({ parentFolderId: parent.id });

    // The names are legal where they are and only collide once one moves, so the
    // check has to run against the DESTINATION siblings rather than the current
    // ones.
    expect(res.status).toBe(409);
    expect((await folderRow(id)).parent_folder_id).toBeNull();
  });

  it('refuses to update ANOTHER firm folder and leaves it untouched', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Confidential Matters Folder' });

    const res = await otherOwner.api.put(F(otherFirm.id, `/${id}`)).send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await folderRow(id)).name).toBe('Confidential Matters Folder');
  });

  it('refuses to move a folder under ANOTHER firm folder', async () => {
    const foreignParent = await seedFolder(otherFirm.id, { name: 'Their Retainers' });
    const { id } = await seedFolder(firm.id, { name: 'Ours' });

    const res = await owner.api.put(F(firm.id, `/${id}`)).send({ parentFolderId: foreignParent.id });

    // The move is the quiet version of the same leak the create path has: the
    // folder would carry this firm's law_firm_id under a parent carrying
    // another's, and neither firm's sidebar could reconcile the tree.
    expect(res.status).toBe(404);
    expect((await folderRow(id)).parent_folder_id).toBeNull();
  });

  it('answers not-found for a folder that does not exist', async () => {
    const res = await owner.api.put(F(firm.id, `/${randomUUID()}`)).send({ name: 'Ghost' });

    expect(res.status).toBe(404);
  });

  it('refuses a member with templates.view but not templates.manage', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Retainers' });
    const viewer = await memberWith(firm.id, ['templates.view']);

    // Both halves, so a gate that refused everything cannot satisfy this on its
    // own while breaking the read-only role.
    expect((await viewer.api.get(F(firm.id))).status).toBe(200);
    const res = await viewer.api.put(F(firm.id, `/${id}`)).send({ name: 'Renamed' });

    expect(res.status).toBe(403);
    expect((await folderRow(id)).name).toBe('Retainers');
  });
});

describe('deleting a folder', () => {
  it('removes the folder and moves the templates inside it up to the root', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Retainers' });
    const template = await seedTemplate(firm.id, { name: 'Engagement Letter', folderId: id });

    const res = await owner.api.delete(F(firm.id, `/${id}`));

    // The templates are the whole point of the folder. Cascading the delete, or
    // leaving them pointing at a folder id that is gone, loses the firm's
    // paperwork from the sidebar with nothing on screen looking wrong.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: 'Folder deleted successfully', folderId: id, movedTemplateCount: 1,
    });
    expect(await folderCount(firm.id)).toBe(0);
    expect(await templateRow(template.id)).toMatchObject({
      name: 'Engagement Letter', folder_id: null, law_firm_id: firm.id,
    });
  });

  it('moves the templates up one level, not all the way to the root', async () => {
    const grandparent = await seedFolder(firm.id, { name: 'Retainers' });
    const { id } = await seedFolder(firm.id, { name: 'Hourly', parentFolderId: grandparent.id });
    const template = await seedTemplate(firm.id, { folderId: id });

    await owner.api.delete(F(firm.id, `/${id}`));

    // "Up one level" is the contract, and it differs from "to the root" only for
    // a nested folder, so a top-level case alone would not tell the two apart.
    expect((await templateRow(template.id)).folder_id).toBe(grandparent.id);
  });

  it('reparents the child folders and renumbers them after the destination siblings', async () => {
    const grandparent = await seedFolder(firm.id, { name: 'Retainers' });
    await seedFolder(firm.id, { name: 'Existing Sibling', parentFolderId: grandparent.id, order: 2 });
    const { id } = await seedFolder(firm.id, { name: 'Doomed', parentFolderId: grandparent.id, order: 0 });
    const childA = await seedFolder(firm.id, { name: 'A Child', parentFolderId: id, order: 0 });
    const childB = await seedFolder(firm.id, { name: 'B Child', parentFolderId: id, order: 1 });

    const res = await owner.api.delete(F(firm.id, `/${id}`));

    expect(res.body).toMatchObject({ reparentedFolderCount: 2 });
    // Both survive under the grandparent, in their original relative order,
    // slotted after whatever was already there. Left pointing at the deleted
    // folder they would be orphaned; renumbered from zero they would interleave
    // with the existing sibling.
    expect(await folderRow(childA.id)).toMatchObject({
      parent_folder_id: grandparent.id, sort_order: 3,
    });
    expect(await folderRow(childB.id)).toMatchObject({
      parent_folder_id: grandparent.id, sort_order: 4,
    });
  });

  it('leaves the templates in OTHER folders alone', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Doomed' });
    const keeper = await seedFolder(firm.id, { name: 'Keeper' });
    const inside = await seedTemplate(firm.id, { folderId: id });
    const elsewhere = await seedTemplate(firm.id, { folderId: keeper.id });

    const res = await owner.api.delete(F(firm.id, `/${id}`));

    // The reparent is a single UPDATE over `folder_id = $folderId`. Lose that
    // predicate and one delete unfiles every template in the firm.
    expect(res.body.movedTemplateCount).toBe(1);
    expect((await templateRow(inside.id)).folder_id).toBeNull();
    expect((await templateRow(elsewhere.id)).folder_id).toBe(keeper.id);
  });

  it('does NOT touch another firm folders or templates', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Doomed' });
    await seedTemplate(firm.id, { folderId: id });
    const foreignFolder = await seedFolder(otherFirm.id, { name: 'Their Folder' });
    const foreignTemplate = await seedTemplate(otherFirm.id, { folderId: foreignFolder.id });

    await owner.api.delete(F(firm.id, `/${id}`));

    // The reparent UPDATE is tenant-scoped as well as folder-scoped. Both
    // predicates matter: this asserts the tenant half, with another firm's tree
    // actually populated so an unscoped write would show.
    expect(await folderCount(otherFirm.id)).toBe(1);
    expect((await templateRow(foreignTemplate.id)).folder_id).toBe(foreignFolder.id);
  });

  it('refuses to delete ANOTHER firm folder', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Confidential Matters Folder' });
    const template = await seedTemplate(firm.id, { folderId: id });

    const res = await otherOwner.api.delete(F(otherFirm.id, `/${id}`));

    expect(res.status).toBe(404);
    expect(await folderCount(firm.id)).toBe(1);
    expect((await templateRow(template.id)).folder_id).toBe(id);
  });

  it('answers not-found for a folder that is already gone', async () => {
    const { id } = await seedFolder(firm.id);
    expect((await owner.api.delete(F(firm.id, `/${id}`))).status).toBe(200);

    const res = await owner.api.delete(F(firm.id, `/${id}`));

    expect(res.status).toBe(404);
  });

  it('refuses a member with templates.view but not templates.manage', async () => {
    const { id } = await seedFolder(firm.id, { name: 'Retainers' });
    const template = await seedTemplate(firm.id, { folderId: id });
    const viewer = await memberWith(firm.id, ['templates.view']);

    const res = await viewer.api.delete(F(firm.id, `/${id}`));

    expect(res.status).toBe(403);
    expect(await folderCount(firm.id)).toBe(1);
    expect((await templateRow(template.id)).folder_id).toBe(id);
  });
});

describe('server-owned fields cannot be widened from the body', () => {
  it('ignores a lawFirmId in the create body and scopes the folder to the URL firm', async () => {
    // The caller here belongs to `firm` only and is not a member of `otherFirm`
    // at all. Neither create handler nor the service asserts membership on the
    // target firm beyond what the URL already implies, so a `lawFirmId` in the
    // body that could override the URL's would let anyone with
    // `templates.manage` in ANY firm plant (or rename) a folder in a firm they
    // have never belonged to.
    const res = await owner.api.post(F(firm.id)).send({
      name: 'Hijack Attempt', lawFirmId: otherFirm.id,
    });

    expect(res.status).toBe(201);
    expect((await folderRow(res.body.folderId)).law_firm_id).toBe(firm.id);
    const leaked = await testPool.query(
      `select id from template_folders where law_firm_id = $1 and name = 'Hijack Attempt'`,
      [otherFirm.id],
    );
    expect(leaked.rows).toHaveLength(0);
  });

  it('ignores a folderId/lawFirmId in the update body and never reaches another firm folder', async () => {
    const victim = await seedFolder(otherFirm.id, { name: 'Victim Folder' });
    const { id: mineId } = await seedFolder(firm.id, { name: 'My Own Folder' });

    // The URL names the folder and firm being edited. A `folderId`/`lawFirmId`
    // in the body that could override them would let a caller with
    // `templates.manage` in their own firm rename or reparent a folder
    // belonging to a completely unrelated firm, simply by naming it in the
    // payload of an update they are otherwise entitled to make on their own
    // folder.
    const res = await owner.api.put(F(firm.id, `/${mineId}`)).send({
      name: 'Hijacked', folderId: victim.id, lawFirmId: otherFirm.id,
    });

    expect(res.status).toBe(200);
    expect((await folderRow(mineId)).name).toBe('Hijacked');
    expect((await folderRow(victim.id)).name).toBe('Victim Folder');
  });
});
