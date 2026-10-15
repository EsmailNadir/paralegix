/**
 * The matter category tree.
 *
 * `matterCategories.service.ts` was at 5.9%, the lowest in the matters module,
 * and it carries more derived state than anything else here. `parent_id` is
 * deliberately NOT foreign-keyed (see db/schema.sql), so every tree invariant is
 * the application's alone:
 *
 *   PATH AND LEVEL ARE DENORMALIZED. A category stores its own ">"-joined
 *   ancestry and its depth. Nothing recomputes them on read, and a matter is
 *   linked to its category by that PATH STRING, not by id (see
 *   `matterUsesCategory`). So a path that is written wrong, or not rewritten
 *   when a parent is renamed, quietly detaches every matter filed under it. The
 *   rename case below asserts the child's stored path, not just the parent's.
 *
 *   ORDER IS ASSIGNED, NOT CHOSEN. A new sibling takes max(order) + 1 within its
 *   parent. The numbering case spells out 0, 1, 2 rather than asserting an
 *   increase, because an off-by-one satisfies any relative comparison and shows
 *   up only as a reordered picker.
 *
 *   THE DELETE GUARDS ARE THE POINT. Deleting a category with children orphans a
 *   subtree that no foreign key will catch, and deleting one in use by matters
 *   leaves those matters pointing at a category that no longer exists. Both are
 *   asserted with real rows seeded first, so neither can pass against an empty
 *   world.
 *
 * A second firm holds a colliding tree throughout, so every exact-set assertion
 * doubles as a tenancy assertion, and each write path gets its own cross-firm
 * case that checks the other firm's row is untouched afterwards.
 *
 * Fixtures are plain SQL through the test pool: a tree built by the service
 * under test would agree with itself no matter how wrong it was.
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

let firmA: Firm;
let firmB: Firm;
let alice: Actor;   // owner at firm A

const CATEGORIES = () => `/api/lawfirms/${firmA.id}/matters/categories`;
const TREE = () => `/api/lawfirms/${firmA.id}/matters/categories/tree`;

interface CategorySeed {
  name: string;
  parentId?: string | null;
  path?: string;
  level?: number;
  order?: number;
}

async function seedCategory(lawFirmId: string, seed: CategorySeed): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_categories (id, law_firm_id, name, parent_id, path, level, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      id, lawFirmId, seed.name, seed.parentId ?? null,
      seed.path ?? seed.name, seed.level ?? 0, seed.order ?? 0,
    ],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function categoryRow(id: string) {
  const { rows } = await testPool.query(
    'select name, parent_id, path, level, sort_order, law_firm_id from matter_categories where id = $1',
    [id],
  );
  return rows[0];
}

async function categoryCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from matter_categories where law_firm_id = $1', [lawFirmId],
  );
  return rows[0].n;
}

/** A matter filed under a category path, the thing the delete guard protects. */
async function seedMatterInCategory(lawFirmId: string, categoryPath: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status, category)
     values ($1,$2,$3,$4,'active',$5) returning id`,
    [id, lawFirmId, `Matter ${id.slice(0, 8)}`, `REF-${id.slice(0, 8)}`, categoryPath],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  await ownerOf(firmB.id);
});

describe('creating a category', () => {
  it.each(['missing', 'foreign'])('rejects a %s parent without creating an orphan', async (kind) => {
    const parentId = kind === 'foreign' ? await seedCategory(firmB.id, { name: 'Foreign' }) : randomUUID();
    const response = await alice.api.post(CATEGORIES()).send({ name: 'Child', parentId });
    expect(response.status).toBe(404);
    expect(await categoryCount(firmA.id)).toBe(0);
  });
  it('stores a root at level 0 with its own name as the path', async () => {
    const res = await alice.api.post(CATEGORIES()).send({ name: '  Litigation  ' });

    expect(res.status).toBe(201);
    const row = await categoryRow(res.body.category.id);
    expect(row.name).toBe('Litigation');
    expect(row.path).toBe('Litigation');
    expect(row.level).toBe(0);
    expect(row.parent_id).toBeNull();
  });

  it('builds a two-deep path and level from the parent chain', async () => {
    const root = await alice.api.post(CATEGORIES()).send({ name: 'Litigation' });
    expect(root.status).toBe(201);
    const child = await alice.api.post(CATEGORIES())
      .send({ name: 'Family', parentId: root.body.category.id });
    expect(child.status).toBe(201);

    const grandchild = await alice.api.post(CATEGORIES())
      .send({ name: 'Custody', parentId: child.body.category.id });

    expect(grandchild.status).toBe(201);
    const row = await categoryRow(grandchild.body.category.id);
    expect(row.path).toBe('Litigation > Family > Custody');
    expect(row.level).toBe(2);
  });

  it('numbers the first three children of a parent 0, 1, 2', async () => {
    const parent = await alice.api.post(CATEGORIES()).send({ name: 'Litigation' });
    expect(parent.status).toBe(201);
    const orders: number[] = [];
    for (const name of ['Family', 'Probate', 'Appeals']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await alice.api.post(CATEGORIES())
        .send({ name, parentId: parent.body.category.id });
      expect(res.status).toBe(201);
      // eslint-disable-next-line no-await-in-loop
      orders.push((await categoryRow(res.body.category.id)).sort_order);
    }

    // Spelled out rather than compared: an off-by-one satisfies any "strictly
    // increasing" assertion and only shows up as a reordered picker.
    expect(orders).toEqual([0, 1, 2]);
  });

  it('numbers the first three ROOT categories 0, 1, 2', async () => {
    // Roots are numbered by the same sibling lookup as children, and it has to
    // match on a null parent to find them. `parent_id = null` is never true in
    // SQL, so a plain equality here returns no siblings, max(order) + 1 never
    // runs, and every root lands on 0. The tree read then falls back to sorting
    // roots by name, and any order a user sets is undercut by the next root
    // they add.
    //
    // Spelled out rather than compared: an off-by-one satisfies any "strictly
    // increasing" assertion and only shows up as a reordered picker.
    const orders: number[] = [];
    for (const name of ['Litigation', 'Estate', 'Corporate']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await alice.api.post(CATEGORIES()).send({ name });
      expect(res.status).toBe(201);
      // eslint-disable-next-line no-await-in-loop
      orders.push((await categoryRow(res.body.category.id)).sort_order);
    }

    expect(orders).toEqual([0, 1, 2]);
  });

  it('refuses a duplicate name under the same parent', async () => {
    const first = await alice.api.post(CATEGORIES()).send({ name: 'Litigation' });
    expect(first.status).toBe(201);

    const second = await alice.api.post(CATEGORIES()).send({ name: 'Litigation' });

    expect(second.status).toBe(400);
    expect(await categoryCount(firmA.id)).toBe(1);
  });

  it('allows the same name under two different parents', async () => {
    const one = await alice.api.post(CATEGORIES()).send({ name: 'Litigation' });
    const two = await alice.api.post(CATEGORIES()).send({ name: 'Estate' });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);

    const a = await alice.api.post(CATEGORIES())
      .send({ name: 'Disputes', parentId: one.body.category.id });
    const b = await alice.api.post(CATEGORIES())
      .send({ name: 'Disputes', parentId: two.body.category.id });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await categoryRow(a.body.category.id)).path).toBe('Litigation > Disputes');
    expect((await categoryRow(b.body.category.id)).path).toBe('Estate > Disputes');
  });

  it('does not treat another firm\'s identical name as a duplicate', async () => {
    await seedCategory(firmB.id, { name: 'Litigation' });

    const res = await alice.api.post(CATEGORIES()).send({ name: 'Litigation' });

    // A duplicate check that lost its firm scope would refuse this outright.
    expect(res.status).toBe(201);
    expect((await categoryRow(res.body.category.id)).law_firm_id).toBe(firmA.id);
  });

  it('refuses a blank name', async () => {
    const res = await alice.api.post(CATEGORIES()).send({ name: '' });

    expect(res.status).toBe(400);
    expect(await categoryCount(firmA.id)).toBe(0);
  });
});

describe('listing categories', () => {
  it('returns this firm\'s categories shallowest first, and none of the other firm\'s', async () => {
    const root = await seedCategory(firmA.id, { name: 'Litigation' });
    await seedCategory(firmA.id, {
      name: 'Family', parentId: root, path: 'Litigation > Family', level: 1,
    });
    await seedCategory(firmA.id, { name: 'Corporate' });
    // Deliberately colliding names at the other firm.
    await seedCategory(firmB.id, { name: 'Litigation' });
    await seedCategory(firmB.id, { name: 'Corporate' });

    const res = await alice.api.get(CATEGORIES());

    expect(res.status).toBe(200);
    // Level first, then name: 'Family' is created second but sorts last.
    expect(res.body.categories.map((c: any) => c.name))
      .toEqual(['Corporate', 'Litigation', 'Family']);
  });

  it('nests children under their parent in the tree read', async () => {
    const root = await seedCategory(firmA.id, { name: 'Litigation' });
    await seedCategory(firmA.id, {
      name: 'Probate', parentId: root, path: 'Litigation > Probate', level: 1, order: 1,
    });
    await seedCategory(firmA.id, {
      name: 'Family', parentId: root, path: 'Litigation > Family', level: 1, order: 0,
    });
    await seedCategory(firmB.id, { name: 'Their Root' });

    const res = await alice.api.get(TREE());

    expect(res.status).toBe(200);
    expect(res.body.categories.map((c: any) => c.name)).toEqual(['Litigation']);
    // Children ordered by their stored order, not by insertion.
    expect(res.body.categories[0].children.map((c: any) => c.name))
      .toEqual(['Family', 'Probate']);
  });

  it('withholds the categories from a member of a different firm', async () => {
    await seedCategory(firmA.id, { name: 'Litigation' });
    const outsider = await ownerOf(firmB.id);

    const refused = await outsider.api.get(CATEGORIES());

    expect(JSON.stringify(refused.body)).not.toContain('Litigation');
    expect(refused.status).toBe(403);

    // The row exists and is readable by someone who may read it, so the
    // refusal withheld data rather than describing an empty firm.
    const allowed = await alice.api.get(CATEGORIES());
    expect(allowed.body.categories.map((c: any) => c.name)).toEqual(['Litigation']);
  });
});

describe('updating a category', () => {
  it('rejects moving onto a sibling with the same unchanged name', async () => {
    const destination = await seedCategory(firmA.id, { name: 'Destination' });
    const moved = await seedCategory(firmA.id, { name: 'Family' });
    await seedCategory(firmA.id, { name: 'Family', parentId: destination, path: 'Destination > Family', level: 1 });
    const response = await alice.api.put(`${CATEGORIES()}/${moved}`).send({ parentId: destination });
    expect(response.status).toBe(400);
    expect((await categoryRow(moved)).parent_id).toBeNull();
    expect((await categoryRow(moved)).path).toBe('Family');
  });

  it('rejects moving into an existing ancestor cycle without looping', async () => {
    const moved = await seedCategory(firmA.id, { name: 'Moved' });
    const first = await seedCategory(firmA.id, { name: 'First' });
    const second = await seedCategory(firmA.id, { name: 'Second', parentId: first });
    await testPool.query('update matter_categories set parent_id = $1 where id = $2', [second, first]);
    const repo = require('../../src/modules/matters/categories/matterCategories.repository');
    const original = repo.findById;
    let reads = 0;
    const bounded = jest.spyOn(repo, 'findById').mockImplementation(async (...args: any[]) => {
      if (++reads > 5) throw new Error('Ancestor traversal repeated an existing cycle');
      return original.apply(repo, args);
    });
    try {
      const response = await alice.api.put(`${CATEGORIES()}/${moved}`).send({ parentId: first });
      expect(response.status).toBe(400);
      expect((await categoryRow(moved)).parent_id).toBeNull();
    } finally {
      bounded.mockRestore();
    }
  });

  it('rolls back tree and matter references if rewriting matter paths fails', async () => {
    const root = await seedCategory(firmA.id, { name: 'Original' });
    const matterId = await seedMatterInCategory(firmA.id, 'Original');
    const repo = require('../../src/modules/matters/categories/matterCategories.repository');
    const original = repo.rewriteMatterCategoryPaths;
    let rewritten = false;
    const fault = jest.spyOn(repo, 'rewriteMatterCategoryPaths').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      rewritten = true;
      throw new Error('Injected failure after matter path rewrite');
    });
    try {
      const response = await alice.api.put(`${CATEGORIES()}/${root}`).send({ name: 'Renamed' });
      expect(response.status).toBe(500);
      expect(rewritten).toBe(true);
      expect((await categoryRow(root)).path).toBe('Original');
      const { rows } = await testPool.query('select category from matters where id = $1', [matterId]);
      expect(rows).toEqual([{ category: 'Original' }]);
    } finally {
      fault.mockRestore();
    }
  });

  it.each(['missing', 'foreign'])('rejects moving under a %s parent', async (kind) => {
    const moved = await seedCategory(firmA.id, { name: 'Family' });
    const parentId = kind === 'foreign' ? await seedCategory(firmB.id, { name: 'Foreign' }) : randomUUID();
    const response = await alice.api.put(`${CATEGORIES()}/${moved}`).send({ parentId });
    expect(response.status).toBe(404);
    expect((await categoryRow(moved)).parent_id).toBeNull();
    expect((await categoryRow(moved)).path).toBe('Family');
  });

  it('keeps matters attached when renaming a category and its descendants', async () => {
    const root = await seedCategory(firmA.id, { name: 'Original' });
    const child = await seedCategory(firmA.id, { name: 'Child', parentId: root, path: 'Original > Child', level: 1 });
    const leaf = await seedCategory(firmA.id, { name: 'Leaf', parentId: child, path: 'Original > Child > Leaf', level: 2 });
    const ids = await Promise.all(['Original', 'Original > Child', 'Original > Child > Leaf'].map(path => seedMatterInCategory(firmA.id, path)));
    const foreign = await seedMatterInCategory(firmB.id, 'Original > Child');
    const response = await alice.api.put(`${CATEGORIES()}/${root}`).send({ name: 'Renamed' });
    expect(response.status).toBe(200);
    for (const [index, path] of ['Renamed', 'Renamed > Child', 'Renamed > Child > Leaf'].entries()) {
      const { rows } = await testPool.query('select category from matters where id = $1', [ids[index]]);
      expect(rows[0].category).toBe(path);
    }
    const { rows } = await testPool.query('select category from matters where id = $1', [foreign]);
    expect(rows[0].category).toBe('Original > Child');
    const deletion = await alice.api.delete(`${CATEGORIES()}/${leaf}`);
    expect(deletion.status).toBe(400);
  });

  it('rolls back rewritten children if the parent update fails', async () => {
    const root = await seedCategory(firmA.id, { name: 'Original' });
    const child = await seedCategory(firmA.id, { name: 'Child', parentId: root, path: 'Original > Child', level: 1 });
    const repo = require('../../src/modules/matters/categories/matterCategories.repository');
    const original = repo.update;
    let childWritten = false;
    const fault = jest.spyOn(repo, 'update').mockImplementation(async (...args: any[]) => {
      if (args[1] === root) throw new Error('Injected parent update failure');
      const row = await original.apply(repo, args);
      childWritten = true;
      return row;
    });
    try {
      const res = await alice.api.put(`${CATEGORIES()}/${root}`).send({ name: 'Changed' });
      expect(res.status).toBe(500);
      expect(childWritten).toBe(true);
      expect((await categoryRow(root)).path).toBe('Original');
      expect((await categoryRow(child)).path).toBe('Original > Child');
    } finally {
      fault.mockRestore();
    }
  });

  it('rewrites every level of a moved subtree', async () => {
    const root = await seedCategory(firmA.id, { name: 'Original' });
    const child = await seedCategory(firmA.id, { name: 'Child', parentId: root, path: 'Original > Child', level: 1 });
    const leaf = await seedCategory(firmA.id, { name: 'Leaf', parentId: child, path: 'Original > Child > Leaf', level: 2 });
    const newRoot = await seedCategory(firmA.id, { name: 'New' });
    const res = await alice.api.put(`${CATEGORIES()}/${root}`).send({ parentId: newRoot });
    expect(res.status).toBe(200);
    expect((await categoryRow(root)).path).toBe('New > Original');
    expect((await categoryRow(child)).path).toBe('New > Original > Child');
    expect((await categoryRow(leaf)).path).toBe('New > Original > Child > Leaf');
    expect((await categoryRow(leaf)).level).toBe(3);
  });

  it('rewrites its own path and its children\'s when renamed', async () => {
    const root = await seedCategory(firmA.id, { name: 'Litigaton' });
    const child = await seedCategory(firmA.id, {
      name: 'Family', parentId: root, path: 'Litigaton > Family', level: 1,
    });

    const res = await alice.api.put(`${CATEGORIES()}/${root}`).send({ name: 'Litigation' });

    expect(res.status).toBe(200);
    expect((await categoryRow(root)).path).toBe('Litigation');
    // A stale child path detaches every matter filed under it, since matters
    // reference the category by path string.
    expect((await categoryRow(child)).path).toBe('Litigation > Family');
  });

  it('recomputes path and level when moved under a new parent', async () => {
    const oldRoot = await seedCategory(firmA.id, { name: 'Litigation' });
    const newRoot = await seedCategory(firmA.id, { name: 'Estate' });
    const moved = await seedCategory(firmA.id, {
      name: 'Family', parentId: oldRoot, path: 'Litigation > Family', level: 1,
    });

    const res = await alice.api.put(`${CATEGORIES()}/${moved}`).send({ parentId: newRoot });

    expect(res.status).toBe(200);
    const row = await categoryRow(moved);
    expect(row.parent_id).toBe(newRoot);
    expect(row.path).toBe('Estate > Family');
    expect(row.level).toBe(1);
  });

  it('refuses a category as its own parent', async () => {
    const category = await seedCategory(firmA.id, { name: 'Litigation' });

    const res = await alice.api.put(`${CATEGORIES()}/${category}`).send({ parentId: category });

    expect(res.status).toBe(400);
    expect((await categoryRow(category)).parent_id).toBeNull();
  });

  it('refuses a move under its own descendant', async () => {
    const root = await seedCategory(firmA.id, { name: 'Litigation' });
    const child = await seedCategory(firmA.id, {
      name: 'Family', parentId: root, path: 'Litigation > Family', level: 1,
    });

    const res = await alice.api.put(`${CATEGORIES()}/${root}`).send({ parentId: child });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/circular/i);
    expect((await categoryRow(root)).parent_id).toBeNull();
  });

  it('refuses a rename onto a sibling\'s name', async () => {
    await seedCategory(firmA.id, { name: 'Litigation' });
    const other = await seedCategory(firmA.id, { name: 'Estate' });

    const res = await alice.api.put(`${CATEGORIES()}/${other}`).send({ name: 'Litigation' });

    expect(res.status).toBe(400);
    expect((await categoryRow(other)).name).toBe('Estate');
  });

  it('cannot rename another firm\'s category', async () => {
    const theirs = await seedCategory(firmB.id, { name: 'Their Litigation' });

    const res = await alice.api.put(`${CATEGORIES()}/${theirs}`).send({ name: 'Renamed By A' });

    expect(res.status).toBe(404);
    expect((await categoryRow(theirs)).name).toBe('Their Litigation');
  });
});

describe('deleting a category', () => {
  it('deletes a leaf that nothing uses', async () => {
    const category = await seedCategory(firmA.id, { name: 'Litigation' });

    const res = await alice.api.delete(`${CATEGORIES()}/${category}`);

    expect(res.status).toBe(200);
    expect(await categoryRow(category)).toBeUndefined();
  });

  it('refuses to delete a category that has subcategories', async () => {
    const root = await seedCategory(firmA.id, { name: 'Litigation' });
    await seedCategory(firmA.id, {
      name: 'Family', parentId: root, path: 'Litigation > Family', level: 1,
    });

    const res = await alice.api.delete(`${CATEGORIES()}/${root}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subcategor/i);
    expect((await categoryRow(root)).name).toBe('Litigation');
  });

  it('refuses to delete a category a matter is filed under', async () => {
    const root = await seedCategory(firmA.id, { name: 'Litigation' });
    const child = await seedCategory(firmA.id, {
      name: 'Family', parentId: root, path: 'Litigation > Family', level: 1,
    });
    // Matters reference the category by its full path, so the guard has to
    // match on the path and not on the bare name.
    await seedMatterInCategory(firmA.id, 'Litigation > Family');

    const res = await alice.api.delete(`${CATEGORIES()}/${child}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in use/i);
    expect((await categoryRow(child)).name).toBe('Family');
  });

  it('ignores another firm\'s matter when deciding a category is unused', async () => {
    const category = await seedCategory(firmA.id, { name: 'Litigation' });
    // Only the OTHER firm files a matter under this exact path.
    await seedMatterInCategory(firmB.id, 'Litigation');

    const res = await alice.api.delete(`${CATEGORIES()}/${category}`);

    // A usage check that lost its firm scope would refuse this with a 400.
    expect(res.status).toBe(200);
    expect(await categoryRow(category)).toBeUndefined();
  });

  it('cannot delete another firm\'s category', async () => {
    const theirs = await seedCategory(firmB.id, { name: 'Their Litigation' });

    const res = await alice.api.delete(`${CATEGORIES()}/${theirs}`);

    expect(res.status).toBe(404);
    expect((await categoryRow(theirs)).name).toBe('Their Litigation');
    expect(await categoryCount(firmB.id)).toBe(1);
  });
});

describe('permissions', () => {
  it('lets a read-only member list categories but not create one', async () => {
    const viewer = await memberWith(firmA.id, []);
    await seedCategory(firmA.id, { name: 'Litigation' });

    const read = await viewer.api.get(CATEGORIES());
    expect(read.status).toBe(200);
    expect(read.body.categories.map((c: any) => c.name)).toEqual(['Litigation']);

    const refused = await viewer.api.post(CATEGORIES()).send({ name: 'Estate' });
    expect(refused.status).toBe(403);
    expect(await categoryCount(firmA.id)).toBe(1);

    // The identical body from the owner succeeds, so the 403 was about the
    // caller and not about the payload.
    const accepted = await alice.api.post(CATEGORIES()).send({ name: 'Estate' });
    expect(accepted.status).toBe(201);
  });

  it('refuses a delete from a member without matters.update', async () => {
    const viewer = await memberWith(firmA.id, []);
    const category = await seedCategory(firmA.id, { name: 'Litigation' });

    const refused = await viewer.api.delete(`${CATEGORIES()}/${category}`);

    expect(refused.status).toBe(403);
    expect((await categoryRow(category)).name).toBe('Litigation');

    // Real data, and a permitted caller can act on it: the refusal withheld a
    // category that was there to delete.
    const accepted = await alice.api.delete(`${CATEGORIES()}/${category}`);
    expect(accepted.status).toBe(200);
  });
});
