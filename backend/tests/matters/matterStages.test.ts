/**
 * Matter stages: the ordered steps a matter walks through on the board.
 *
 * `matterStages.service.ts` was at 12.5%. Everything it guards fails quietly:
 *
 *   SORT INDEX. A new stage is appended by reading the siblings and adding one
 *   to the highest sort_order. Sibling means "same pipeline AND same parent", so
 *   a lost parent filter renumbers a child from the root row's index and the
 *   whole board silently reorders. The numbering cases below spell out the
 *   expected integers rather than asserting "is greater than", because an
 *   off-by-one passes any relative comparison.
 *
 *   EXPLICIT ZERO. `sortOrder ?? computed` must keep an explicit 0. A `||` here
 *   looks identical and moves a caller's first stage to the end of the list.
 *
 *   THE TREE. A stage may sit under another stage in the same pipeline. Nothing
 *   in the database stops a cycle, a cross-pipeline parent, or a step placed
 *   after a closing stage, so the service is the only thing that does.
 *
 *   DELETE REPARENTS. Removing a middle stage promotes its children to the
 *   deleted stage's parent. `parent_stage_id` is `on delete set null`, so a
 *   delete that skipped the promotion would look successful and quietly cut the
 *   subtree loose as new roots.
 *
 * A second firm holds a decoy pipeline and decoy stages throughout. Every write
 * path here resolves the row by id and is separately responsible for its own
 * `law_firm_id` predicate, so each one gets its own cross-firm case that asserts
 * BOTH the refusal and that the other firm's row is untouched afterwards.
 *
 * Fixtures are plain SQL through the test pool. A stage seeded through the
 * repository under test could not expose a bug in it.
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
let pipelineA: string;
let pipelineB: string; // firm B's decoy pipeline

const STAGES = () => `/api/lawfirms/${firmA.id}/matter-stages`;

async function seedPipeline(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_stage_pipelines (id, law_firm_id, name, is_default)
     values ($1,$2,$3,false) returning id`,
    [id, lawFirmId, name],
  );
  // A seed rejected by a constraint would otherwise surface many lines later as
  // a missing row, and the failure would name the read rather than the seed.
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

interface StageSeed {
  name?: string;
  sortOrder?: number;
  isClosed?: boolean;
  parentStageId?: string | null;
}

async function seedStage(
  lawFirmId: string, pipelineId: string, seed: StageSeed = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_stages
       (id, law_firm_id, pipeline_id, name, sort_order, is_closed, parent_stage_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      id, lawFirmId, pipelineId,
      seed.name ?? `Stage ${id.slice(0, 8)}`,
      seed.sortOrder ?? 0,
      seed.isClosed === true,
      seed.parentStageId ?? null,
    ],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function stageRow(id: string) {
  const { rows } = await testPool.query(
    `select name, sort_order, is_closed, parent_stage_id, pipeline_id, law_firm_id
       from matter_stages where id = $1`,
    [id],
  );
  return rows[0];
}

async function stageCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from matter_stages where law_firm_id = $1', [lawFirmId],
  );
  return rows[0].n;
}

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  await ownerOf(firmB.id);
  pipelineA = await seedPipeline(firmA.id, 'Litigation');
  pipelineB = await seedPipeline(firmB.id, 'Litigation');
});

describe('creating a stage', () => {
  it('appends after the highest existing sibling', async () => {
    await seedStage(firmA.id, pipelineA, { name: 'Intake', sortOrder: 5 });

    const res = await alice.api.post(STAGES()).send({ name: 'Discovery', pipelineId: pipelineA });

    expect(res.status).toBe(201);
    expect(res.body.stage.sortOrder).toBe(6);
    expect((await stageRow(res.body.stageId)).sort_order).toBe(6);
  });

  it('numbers the first three root stages 0, 1, 2', async () => {
    // Spelled out rather than compared, so a seed at 1 or a double increment
    // fails instead of passing a "strictly increasing" assertion.
    const orders: number[] = [];
    for (const name of ['Intake', 'Discovery', 'Trial']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await alice.api.post(STAGES()).send({ name, pipelineId: pipelineA });
      expect(res.status).toBe(201);
      orders.push(res.body.stage.sortOrder);
    }

    expect(orders).toEqual([0, 1, 2]);
  });

  it('numbers children from zero, independently of their parent row', async () => {
    const parent = await alice.api.post(STAGES()).send({ name: 'Discovery', pipelineId: pipelineA });
    expect(parent.status).toBe(201);
    expect(parent.body.stage.sortOrder).toBe(0);

    const first = await alice.api.post(STAGES())
      .send({ name: 'Interrogatories', pipelineId: pipelineA, parentStageId: parent.body.stageId });
    const second = await alice.api.post(STAGES())
      .send({ name: 'Depositions', pipelineId: pipelineA, parentStageId: parent.body.stageId });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // If the sibling set stopped filtering by parent, these would be 1 and 2.
    expect([first.body.stage.sortOrder, second.body.stage.sortOrder]).toEqual([0, 1]);
  });

  it('keeps an explicit sortOrder of zero instead of appending', async () => {
    await seedStage(firmA.id, pipelineA, { name: 'Intake', sortOrder: 7 });

    const res = await alice.api.post(STAGES())
      .send({ name: 'Conflict Check', pipelineId: pipelineA, sortOrder: 0 });

    expect(res.status).toBe(201);
    // A `||` in place of the `??` would silently move this to the end at 8.
    expect((await stageRow(res.body.stageId)).sort_order).toBe(0);
  });

  it('refuses a pipeline belonging to another firm, then accepts this firm\'s own', async () => {
    const refused = await alice.api.post(STAGES())
      .send({ name: 'Discovery', pipelineId: pipelineB });

    expect(refused.status).toBe(400);
    expect(await stageCount(firmA.id)).toBe(0);
    expect(await stageCount(firmB.id)).toBe(0);

    // Same shape, this firm's own pipeline: proves the refusal above was the
    // tenancy check and not a malformed request.
    const accepted = await alice.api.post(STAGES())
      .send({ name: 'Discovery', pipelineId: pipelineA });
    expect(accepted.status).toBe(201);
  });

  it('refuses a parent stage belonging to another firm', async () => {
    const foreignParent = await seedStage(firmB.id, pipelineB, { name: 'Their Intake' });

    const res = await alice.api.post(STAGES())
      .send({ name: 'Discovery', pipelineId: pipelineA, parentStageId: foreignParent });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/parentStageId/i);
    expect(await stageCount(firmA.id)).toBe(0);
  });

  it('refuses a parent that sits in a different pipeline of the same firm', async () => {
    const otherPipeline = await seedPipeline(firmA.id, 'Estate Planning');
    const parent = await seedStage(firmA.id, otherPipeline, { name: 'Draft Will' });

    const res = await alice.api.post(STAGES())
      .send({ name: 'Discovery', pipelineId: pipelineA, parentStageId: parent });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same pipeline/i);
  });

  it('refuses a stage placed after a closing stage', async () => {
    const closing = await seedStage(firmA.id, pipelineA, { name: 'Closed', isClosed: true });

    const res = await alice.api.post(STAGES())
      .send({ name: 'Appeal', pipelineId: pipelineA, parentStageId: closing });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/closed|ending/i);
    expect(await stageCount(firmA.id)).toBe(1);
  });

  it('refuses a stage with no name', async () => {
    const res = await alice.api.post(STAGES()).send({ name: '', pipelineId: pipelineA });

    expect(res.status).toBe(400);
    expect(await stageCount(firmA.id)).toBe(0);
  });
});

describe('updating a stage', () => {
  it('renames it', async () => {
    const stage = await seedStage(firmA.id, pipelineA, { name: 'Discovry' });

    const res = await alice.api.put(`${STAGES()}/${stage}`).send({ name: 'Discovery' });

    expect(res.status).toBe(200);
    expect((await stageRow(stage)).name).toBe('Discovery');
  });

  it('refuses to mark a stage with later steps as an ending', async () => {
    const parent = await seedStage(firmA.id, pipelineA, { name: 'Discovery' });
    await seedStage(firmA.id, pipelineA, { name: 'Depositions', parentStageId: parent });

    const res = await alice.api.put(`${STAGES()}/${parent}`).send({ isClosed: true });

    expect(res.status).toBe(400);
    expect((await stageRow(parent)).is_closed).toBe(false);
  });

  it('marks a leaf as an ending', async () => {
    const leaf = await seedStage(firmA.id, pipelineA, { name: 'Closed' });

    const res = await alice.api.put(`${STAGES()}/${leaf}`).send({ isClosed: true });

    expect(res.status).toBe(200);
    expect((await stageRow(leaf)).is_closed).toBe(true);
  });

  it('refuses a parent change that would close a cycle', async () => {
    const top = await seedStage(firmA.id, pipelineA, { name: 'Intake' });
    const below = await seedStage(firmA.id, pipelineA, { name: 'Discovery', parentStageId: top });

    const res = await alice.api.put(`${STAGES()}/${top}`).send({ parentStageId: below });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cycle/i);
    expect((await stageRow(top)).parent_stage_id).toBeNull();
  });

  it('refuses a stage as its own parent', async () => {
    const stage = await seedStage(firmA.id, pipelineA, { name: 'Intake' });

    const res = await alice.api.put(`${STAGES()}/${stage}`).send({ parentStageId: stage });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own parent/i);
  });

  it('cannot rename another firm\'s stage', async () => {
    const theirs = await seedStage(firmB.id, pipelineB, { name: 'Their Intake' });

    const res = await alice.api.put(`${STAGES()}/${theirs}`).send({ name: 'Renamed By A' });

    expect(res.status).toBe(404);
    expect((await stageRow(theirs)).name).toBe('Their Intake');
  });
});

describe('deleting a stage', () => {
  it('promotes the children of a middle stage to its own parent', async () => {
    const top = await seedStage(firmA.id, pipelineA, { name: 'Intake' });
    const middle = await seedStage(firmA.id, pipelineA, { name: 'Discovery', parentStageId: top });
    const leaf = await seedStage(firmA.id, pipelineA, { name: 'Depositions', parentStageId: middle });

    const res = await alice.api.delete(`${STAGES()}/${middle}`);

    expect(res.status).toBe(200);
    expect(await stageRow(middle)).toBeUndefined();
    // Cut loose rather than promoted would leave this null and orphan the subtree.
    expect((await stageRow(leaf)).parent_stage_id).toBe(top);
  });

  it('turns the children of a root stage into roots', async () => {
    const top = await seedStage(firmA.id, pipelineA, { name: 'Intake' });
    const child = await seedStage(firmA.id, pipelineA, { name: 'Discovery', parentStageId: top });

    const res = await alice.api.delete(`${STAGES()}/${top}`);

    expect(res.status).toBe(200);
    expect((await stageRow(child)).parent_stage_id).toBeNull();
  });

  it('cannot delete another firm\'s stage', async () => {
    const theirs = await seedStage(firmB.id, pipelineB, { name: 'Their Intake' });

    const res = await alice.api.delete(`${STAGES()}/${theirs}`);

    expect(res.status).toBe(404);
    expect((await stageRow(theirs)).name).toBe('Their Intake');
    expect(await stageCount(firmB.id)).toBe(1);
  });

  it('answers 404 for an id that names nothing', async () => {
    const res = await alice.api.delete(`${STAGES()}/${randomUUID()}`);

    expect(res.status).toBe(404);
  });
});

describe('permissions', () => {
  it('refuses a create from a member without settings.manageFirm', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    const body = { name: 'Discovery', pipelineId: pipelineA };

    const refused = await viewer.api.post(STAGES()).send(body);

    expect(refused.status).toBe(403);
    expect(await stageCount(firmA.id)).toBe(0);

    // The identical body from the owner succeeds, so the 403 above cannot be a
    // rejection of the request itself.
    const accepted = await alice.api.post(STAGES()).send(body);
    expect(accepted.status).toBe(201);
  });

  it('refuses a delete from a member without settings.manageFirm', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    const stage = await seedStage(firmA.id, pipelineA, { name: 'Intake' });

    const refused = await viewer.api.delete(`${STAGES()}/${stage}`);

    expect(refused.status).toBe(403);
    expect((await stageRow(stage)).name).toBe('Intake');

    // Real data, and the owner can act on it: the refusal withheld a stage that
    // was there to be deleted.
    const accepted = await alice.api.delete(`${STAGES()}/${stage}`);
    expect(accepted.status).toBe(200);
    expect(await stageRow(stage)).toBeUndefined();
  });
});
