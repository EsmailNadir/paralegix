/**
 * The lead pipeline, driven through the real routes.
 *
 * `leadStages.service.ts` sat at 14%. Most of it is one function,
 * `assertValidParent`, and every rule it enforces exists to stop the pipeline
 * becoming a shape the kanban board cannot draw:
 *
 *   - a stage cannot be its own parent,
 *   - a stage cannot sit under a parent from a different practice area's
 *     pipeline,
 *   - nothing can follow a closed (ending) stage,
 *   - and reparenting must not close a cycle.
 *
 * A cycle is the expensive one. `listForFirm` returns a flat list and the board
 * walks it into a tree, so a loop is not caught by the database; it is caught by
 * whichever renderer recurses into it first. Deleting also has to keep the tree
 * connected: `deleteWithReparent` promotes a deleted stage's children to its own
 * parent, and without that a firm loses a whole branch of its pipeline and the
 * leads sitting in it.
 *
 * Alongside those, the usual `(law_firm_id, id)` scope. `reorder` is the sharpest
 * case: it takes a caller-supplied list of ids and writes a sort order to each,
 * so a lost tenant predicate lets one firm silently reshuffle another firm's
 * board. That case checks the neighbour's ROW, not the status.
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

const path = (suffix = '') => `/api/lawfirms/${firm.id}/lead-stages${suffix}`;

/** A stage seeded straight into the table, never through the create route. */
async function seedStage(
  lawFirmId: string,
  overrides: {
    name?: string;
    isClosed?: boolean;
    parentStageId?: string | null;
    practiceAreaId?: string | null;
    sortOrder?: number;
  } = {},
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const name = overrides.name ?? `Stage ${id.slice(0, 8)}`;
  const res = await testPool.query(
    `insert into lead_stages
       (id, law_firm_id, name, is_closed, parent_stage_id, practice_area_id, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      lawFirmId,
      name,
      overrides.isClosed ?? false,
      overrides.parentStageId ?? null,
      overrides.practiceAreaId ?? null,
      overrides.sortOrder ?? 0,
    ],
  );
  expect(res.rowCount).toBe(1);
  return { id, name };
}

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    'insert into practice_areas (id, law_firm_id, name) values ($1, $2, $3)',
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

const names = (body: any): string[] => (body.stages || []).map((s: any) => s.name);

async function rowById(id: string) {
  const { rows } = await testPool.query(
    'select name, is_closed, parent_stage_id, sort_order from lead_stages where id = $1',
    [id],
  );
  return rows[0] || null;
}

async function stageCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int as n from lead_stages where law_firm_id = $1',
    [lawFirmId],
  );
  return rows[0].n;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('the lazily seeded default pipeline', () => {
  it('seeds one on the first read of a firm that has none', async () => {
    expect(await stageCount(firm.id)).toBe(0);

    const res = await owner.api.get(path());

    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual([
      'New', 'Contacted', 'Consultation Scheduled', 'Retained', 'Unresponsive', 'Not a Fit',
    ]);
  });

  it('links the seeded stages into a chain rather than six roots', async () => {
    const res = await owner.api.get(path());

    const byName = Object.fromEntries(res.body.stages.map((s: any) => [s.name, s]));
    // The board draws these as a tree. Six roots would render as six parallel
    // columns with no progression, which is a different product.
    expect(byName.New.parentStageId).toBeNull();
    expect(byName.Contacted.parentStageId).toBe(byName.New.id);
    expect(byName.Retained.parentStageId).toBe(byName['Consultation Scheduled'].id);
    expect(byName.Retained.isClosed).toBe(true);
  });

  it('does not seed a second pipeline on the next read', async () => {
    await owner.api.get(path());
    await owner.api.get(path());

    expect(await stageCount(firm.id)).toBe(6);
  });

  it('does not seed one for a firm that already has a stage', async () => {
    await seedStage(firm.id, { name: 'Only stage' });

    const res = await owner.api.get(path());

    expect(names(res.body)).toEqual(['Only stage']);
  });
});

describe('creating a stage', () => {
  it('creates a root stage', async () => {
    const res = await owner.api.post(path()).send({ name: 'Referred', color: '#123456', sortOrder: 7 });

    expect(res.status).toBe(201);
    expect(res.body.stage.name).toBe('Referred');
    expect(res.body.stageId).toBe(res.body.stage.id);
    expect((await rowById(res.body.stage.id)).sort_order).toBe(7);
  });

  it('creates a child under an open parent in the same pipeline', async () => {
    const parent = await seedStage(firm.id, { name: 'Contacted' });

    const res = await owner.api.post(path()).send({ name: 'Follow up', parentStageId: parent.id });

    expect(res.status).toBe(201);
    expect(res.body.stage.parentStageId).toBe(parent.id);
  });

  it('refuses a parent in a different practice area pipeline', async () => {
    const area = await seedPracticeArea(firm.id, 'Family Law');
    const parent = await seedStage(firm.id, { name: 'Family intake', practiceAreaId: area });

    // The child names no practice area, so it belongs to the firm-wide
    // pipeline and cannot hang off a practice-area stage.
    const res = await owner.api.post(path()).send({ name: 'Orphan child', parentStageId: parent.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same pipeline/i);
  });

  it('accepts that same parent when the child shares its practice area', async () => {
    const area = await seedPracticeArea(firm.id, 'Family Law');
    const parent = await seedStage(firm.id, { name: 'Family intake', practiceAreaId: area });

    const res = await owner.api
      .post(path())
      .send({ name: 'Family follow up', parentStageId: parent.id, practiceAreaId: area });

    // Paired with the refusal above, so that one cannot pass against a route
    // that rejects every parent.
    expect(res.status).toBe(201);
  });

  it('refuses a stage after a closed ending stage', async () => {
    const ending = await seedStage(firm.id, { name: 'Retained', isClosed: true });

    const res = await owner.api.post(path()).send({ name: 'After the end', parentStageId: ending.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/closed \(ending\) stage/i);
  });

  it('refuses a parent belonging to another firm and creates nothing', async () => {
    const otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    const theirStage = await seedStage(otherFirm.id, { name: 'Neighbour Stage' });

    const res = await owner.api.post(path()).send({ name: 'Cross firm child', parentStageId: theirStage.id });

    expect(res.status).toBe(400);
    expect(await stageCount(firm.id)).toBe(0);
  });

  it('refuses a practice area belonging to another firm', async () => {
    const otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    const theirArea = await seedPracticeArea(otherFirm.id, 'Their Family Law');

    const res = await owner.api.post(path()).send({ name: 'Cross firm stage', practiceAreaId: theirArea });

    expect(res.status).toBe(400);
    expect(await stageCount(firm.id)).toBe(0);
  });

  it('rejects a stage with no name', async () => {
    const res = await owner.api.post(path()).send({ name: '' });

    expect(res.status).toBe(400);
  });
});

describe('reparenting a stage', () => {
  it('refuses a stage as its own parent', async () => {
    const stage = await seedStage(firm.id, { name: 'Self referential' });

    const res = await owner.api.put(path(`/${stage.id}`)).send({ parentStageId: stage.id });

    expect(res.status).toBe(400);
    expect((await rowById(stage.id)).parent_stage_id).toBeNull();
  });

  it('refuses a reparent that would close a cycle', async () => {
    const root = await seedStage(firm.id, { name: 'Root' });
    const child = await seedStage(firm.id, { name: 'Child', parentStageId: root.id });

    const res = await owner.api.put(path(`/${root.id}`)).send({ parentStageId: child.id });

    // Root under its own child. Nothing in the schema forbids it, and the
    // board walks the list into a tree, so the loop surfaces as a hung render.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cycle/i);
    expect((await rowById(root.id)).parent_stage_id).toBeNull();
  });

  it('allows a legitimate reparent', async () => {
    const first = await seedStage(firm.id, { name: 'First' });
    const second = await seedStage(firm.id, { name: 'Second' });

    const res = await owner.api.put(path(`/${second.id}`)).send({ parentStageId: first.id });

    // Paired with the refusals above so neither passes against a route that
    // rejects every reparent.
    expect(res.status).toBe(200);
    expect((await rowById(second.id)).parent_stage_id).toBe(first.id);
  });

  it('refuses moving a stage to another pipeline rather than ignoring the request', async () => {
    const practiceAreaId = await seedPracticeArea(firm.id, 'Family Law');
    const stage = await seedStage(firm.id, { name: 'Qualifying' });

    const res = await owner.api
      .put(path(`/${stage.id}`))
      .send({ name: 'Renamed', practiceAreaId });

    // A stage's pipeline is fixed: its parent and children live in the same
    // one. Dropping the key silently answered 200 while the stage stayed put,
    // so the editor looked saved and was not.
    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select name, practice_area_id from lead_stages where id = $1',
      [stage.id],
    );
    expect(rows[0]).toEqual({ name: 'Qualifying', practice_area_id: null });
  });

  it('refuses marking a stage with later steps as an ending', async () => {
    const parent = await seedStage(firm.id, { name: 'Has a next step' });
    await seedStage(firm.id, { name: 'The next step', parentStageId: parent.id });

    const res = await owner.api.put(path(`/${parent.id}`)).send({ isClosed: true });

    expect(res.status).toBe(400);
    expect((await rowById(parent.id)).is_closed).toBe(false);
  });

  it('allows marking a leaf as an ending', async () => {
    const leaf = await seedStage(firm.id, { name: 'Nothing follows' });

    const res = await owner.api.put(path(`/${leaf.id}`)).send({ isClosed: true });

    expect(res.status).toBe(200);
    expect((await rowById(leaf.id)).is_closed).toBe(true);
  });

  it('answers 404 for a stage that does not exist', async () => {
    const res = await owner.api
      .put(path('/00000000-0000-0000-0000-000000000000'))
      .send({ name: 'Nothing to rename' });

    expect(res.status).toBe(404);
  });
});

describe('deleting a stage', () => {
  it('promotes the deleted stage children to its own parent', async () => {
    const root = await seedStage(firm.id, { name: 'Root' });
    const middle = await seedStage(firm.id, { name: 'Middle', parentStageId: root.id });
    const leaf = await seedStage(firm.id, { name: 'Leaf', parentStageId: middle.id });

    const res = await owner.api.delete(path(`/${middle.id}`));

    expect(res.status).toBe(200);
    expect(await rowById(middle.id)).toBeNull();
    // Without the reparent the leaf would point at a deleted row, and the
    // board would drop that whole branch along with the leads sitting in it.
    expect((await rowById(leaf.id)).parent_stage_id).toBe(root.id);
  });

  it('turns a root children into roots', async () => {
    const root = await seedStage(firm.id, { name: 'Root' });
    const child = await seedStage(firm.id, { name: 'Child', parentStageId: root.id });

    await owner.api.delete(path(`/${root.id}`));

    expect((await rowById(child.id)).parent_stage_id).toBeNull();
  });

  it('clears the assignment on leads at the deleted stage while preserving their tenant', async () => {
    const stage = await seedStage(firm.id, { name: 'Consultation scheduled' });
    const created = await owner.api
      .post(`/api/lawfirms/${firm.id}/leads`)
      .send({ name: 'Assigned prospect', stageId: stage.id });

    // Prove the lead reached this exact stage before deletion; otherwise the
    // post-delete NULL assertion could pass for a lead the route never assigned.
    expect(created.status).toBe(201);
    const leadId = created.body.lead.id;
    const before = await testPool.query(
      'select stage_id, law_firm_id from leads where id = $1',
      [leadId],
    );
    expect(before.rows).toEqual([{ stage_id: stage.id, law_firm_id: firm.id }]);

    const deleted = await owner.api.delete(path(`/${stage.id}`));

    expect(deleted.status).toBe(200);
    const after = await testPool.query(
      'select stage_id, law_firm_id from leads where id = $1',
      [leadId],
    );
    // The composite stage key cannot rely on ON DELETE SET NULL: that would
    // null law_firm_id too. The deletion transaction must deliberately clear
    // only stage_id so the prospect remains owned by this firm.
    expect(after.rows).toEqual([{ stage_id: null, law_firm_id: firm.id }]);
  });

  it('answers 404 for a stage that does not exist', async () => {
    const res = await owner.api.delete(path('/00000000-0000-0000-0000-000000000000'));

    expect(res.status).toBe(404);
  });
});

describe('reordering', () => {
  it('writes the array position as the sort order', async () => {
    const first = await seedStage(firm.id, { name: 'First', sortOrder: 0 });
    const second = await seedStage(firm.id, { name: 'Second', sortOrder: 1 });
    const third = await seedStage(firm.id, { name: 'Third', sortOrder: 2 });

    const res = await owner.api.post(path('/reorder')).send({ stageIds: [third.id, first.id, second.id] });

    expect(res.status).toBe(200);
    expect((await rowById(third.id)).sort_order).toBe(0);
    expect((await rowById(first.id)).sort_order).toBe(1);
    expect((await rowById(second.id)).sort_order).toBe(2);
  });

  it('leaves a stage that was not named alone', async () => {
    const listed = await seedStage(firm.id, { name: 'Listed', sortOrder: 5 });
    const untouched = await seedStage(firm.id, { name: 'Untouched', sortOrder: 9 });

    await owner.api.post(path('/reorder')).send({ stageIds: [listed.id] });

    expect((await rowById(listed.id)).sort_order).toBe(0);
    expect((await rowById(untouched.id)).sort_order).toBe(9);
  });

  it('cannot reshuffle another firm board', async () => {
    const otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    const theirStage = await seedStage(otherFirm.id, { name: 'Neighbour Stage', sortOrder: 4 });
    const mine = await seedStage(firm.id, { name: 'Mine', sortOrder: 4 });

    const res = await owner.api.post(path('/reorder')).send({ stageIds: [theirStage.id, mine.id] });

    // The route answers 200 either way: it reports the caller's own stages
    // back. The only evidence a lost tenant predicate leaves is on the
    // neighbour's row.
    expect(res.status).toBe(200);
    expect((await rowById(theirStage.id)).sort_order).toBe(4);
    expect((await rowById(mine.id)).sort_order).toBe(1);
  });

  it('rejects an empty list', async () => {
    const res = await owner.api.post(path('/reorder')).send({ stageIds: [] });

    expect(res.status).toBe(400);
  });
});

describe('tenancy', () => {
  let otherFirm: Firm;
  let otherOwner: Actor;
  let theirStage: { id: string; name: string };

  beforeEach(async () => {
    otherFirm = await createFirm({ name: 'Neighbouring Firm' });
    otherOwner = await ownerOf(otherFirm.id);
    theirStage = await seedStage(otherFirm.id, { name: 'Neighbour Stage' });
  });

  it('does not list another firm stages', async () => {
    const mine = await owner.api.get(path());
    const theirs = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/lead-stages`);

    // The neighbour's own read proves the stage exists and is reachable.
    expect(names(theirs.body)).toContain('Neighbour Stage');
    expect(names(mine.body)).not.toContain('Neighbour Stage');
  });

  it('refuses to rename another firm stage and leaves it untouched', async () => {
    const res = await owner.api
      .put(`/api/lawfirms/${firm.id}/lead-stages/${theirStage.id}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await rowById(theirStage.id)).name).toBe('Neighbour Stage');
  });

  it('refuses to delete another firm stage and leaves the row in place', async () => {
    const res = await owner.api.delete(`/api/lawfirms/${firm.id}/lead-stages/${theirStage.id}`);

    expect(res.status).toBe(404);
    expect(await rowById(theirStage.id)).not.toBeNull();
  });
});

describe('permissions', () => {
  it('lets a baseline member read the pipeline', async () => {
    await seedStage(firm.id, { name: 'Readable stage' });
    // `leads.view` is in DEFAULT_PERMISSIONS, so an empty role reads. Asserted
    // first so the write refusals below cannot pass on a member who is simply
    // locked out of the module.
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.get(path());

    expect(res.status).toBe(200);
    expect(names(res.body)).toContain('Readable stage');
  });

  it('refuses a member without leads.manageStages a create', async () => {
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(path()).send({ name: 'Nope' });

    expect(res.status).toBe(403);
    expect(await stageCount(firm.id)).toBe(0);
  });

  it('refuses that member a rename, and the name survives', async () => {
    const stage = await seedStage(firm.id, { name: 'Protected stage' });
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.put(path(`/${stage.id}`)).send({ name: 'Edited by a reader' });

    expect(res.status).toBe(403);
    expect((await rowById(stage.id)).name).toBe('Protected stage');
  });

  it('refuses that member a reorder, and the board keeps its order', async () => {
    const stage = await seedStage(firm.id, { name: 'Ordered stage', sortOrder: 3 });
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.post(path('/reorder')).send({ stageIds: [stage.id] });

    expect(res.status).toBe(403);
    expect((await rowById(stage.id)).sort_order).toBe(3);
  });

  it('refuses that member a delete, and the row survives', async () => {
    const stage = await seedStage(firm.id);
    const reader = await memberWith(firm.id, []);

    const res = await reader.api.delete(path(`/${stage.id}`));

    expect(res.status).toBe(403);
    expect(await rowById(stage.id)).not.toBeNull();
  });

  it('lets a member holding leads.manageStages create one', async () => {
    const manager = await memberWith(firm.id, ['leads.manageStages']);

    const res = await manager.api.post(path()).send({ name: 'Allowed' });

    // Paired with the refusals above so neither passes against a route that
    // refuses everybody.
    expect(res.status).toBe(201);
  });
});
