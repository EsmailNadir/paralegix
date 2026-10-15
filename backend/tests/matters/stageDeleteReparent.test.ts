/**
 * B10.2: two matter-stage scenarios the existing `matterStages.test.ts` file
 * does not reach.
 *
 * DELETING A REFERENCED STAGE. `matters.stage_id` is `references
 * matter_stages(id) on delete set null` (`db/schema.sql`). Every existing
 * delete test seeds bare stages with no matter pointed at them, so nothing
 * proves the FK actually fires through the real route: `deleteStage` calls
 * `matterStagesRepo.deleteWithReparent`, which issues its DELETE through
 * Drizzle's `scopedDelete` rather than a raw SQL statement, and an ORM-issued
 * DELETE that FAILED to also trip the database's own FK action would look
 * identical to a working one in every test that never seeds a referencing
 * matter. This seeds a real matter pointed at the stage being deleted and
 * proves both halves at once: the matter survives with its `stage_id` nulled,
 * and (per the existing reparent contract) the deleted stage's own children
 * are promoted rather than orphaned.
 *
 * SUCCESSFUL REPARENTING. `matterStages.test.ts` only exercises `parentStageId`
 * changes that get REJECTED (self-parent, a cycle). No test exercises a
 * legitimate move: taking an existing stage that already has a parent and a
 * child of its own, and reparenting it under a different, valid, non-cyclic
 * stage. That is the one case `assertValidParent` is actually meant to allow,
 * and it is a "branch ordering" scenario named in the B10.2 plan.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let pipelineId: string;

const STAGES = () => `/api/lawfirms/${firm.id}/matter-stages`;

async function seedPipeline(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_stage_pipelines (id, law_firm_id, name, is_default)
     values ($1,$2,$3,false) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

interface StageSeed {
  name?: string;
  sortOrder?: number;
  isClosed?: boolean;
  parentStageId?: string | null;
}

async function seedStage(lawFirmId: string, pipelineId2: string, seed: StageSeed = {}): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_stages
       (id, law_firm_id, pipeline_id, name, sort_order, is_closed, parent_stage_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      id, lawFirmId, pipelineId2,
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

/** A minimal matter row, pointed at a given stage, without the full create route. */
async function seedMatter(lawFirmId: string, name: string, stageId: string | null): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const res = await testPool.query(
    `insert into matters (law_firm_id, name, matter_reference_id, status, stage_id, stage_pipeline_id)
     values ($1,$2,$3,'active',$4,$5) returning id`,
    [lawFirmId, name, tag, stageId, stageId ? pipelineId : null],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function matterStageId(matterId: string): Promise<string | null> {
  const { rows } = await testPool.query('select stage_id from matters where id = $1', [matterId]);
  return rows[0].stage_id;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Stage Delete/Reparent Firm' });
  owner = await ownerOf(firm.id);
  pipelineId = await seedPipeline(firm.id, 'Litigation');
});

describe('deleting a stage that a matter currently sits on', () => {
  it('nulls the matter\'s stage_id and still promotes the deleted stage\'s children', async () => {
    const top = await seedStage(firm.id, pipelineId, { name: 'Intake' });
    const middle = await seedStage(firm.id, pipelineId, { name: 'Discovery', parentStageId: top });
    const leaf = await seedStage(firm.id, pipelineId, { name: 'Depositions', parentStageId: middle });
    const matter = await seedMatter(firm.id, 'Doe v. Roe', middle);

    expect(await matterStageId(matter)).toBe(middle);

    const res = await owner.api.delete(`${STAGES()}/${middle}`);

    expect(res.status).toBe(200);
    expect(await stageRow(middle)).toBeUndefined();
    // The FK's on-delete-set-null action, not application code, is what has to
    // fire here: no service code writes to `matters` on stage delete at all.
    expect(await matterStageId(matter)).toBeNull();
    // The existing reparent contract still holds for the deleted stage's own
    // subtree, independent of the matter reference.
    expect((await stageRow(leaf)).parent_stage_id).toBe(top);
  });

  it('leaves an unrelated matter\'s stage_id alone when a different stage is deleted', async () => {
    const kept = await seedStage(firm.id, pipelineId, { name: 'Intake' });
    const removed = await seedStage(firm.id, pipelineId, { name: 'Discovery' });
    const matter = await seedMatter(firm.id, 'Smith v. Jones', kept);

    const res = await owner.api.delete(`${STAGES()}/${removed}`);

    expect(res.status).toBe(200);
    // Negative control: proves the nulling above is specific to the deleted
    // stage's own referrers, not a side effect of any stage delete on the firm.
    expect(await matterStageId(matter)).toBe(kept);
  });
});

describe('reparenting a stage', () => {
  it('moves a stage and its own children under a different, valid parent', async () => {
    const oldParent = await seedStage(firm.id, pipelineId, { name: 'Intake' });
    const newParent = await seedStage(firm.id, pipelineId, { name: 'Conflict Check' });
    const moving = await seedStage(firm.id, pipelineId, { name: 'Discovery', parentStageId: oldParent });
    const child = await seedStage(firm.id, pipelineId, { name: 'Depositions', parentStageId: moving });

    const res = await owner.api.put(`${STAGES()}/${moving}`).send({ parentStageId: newParent });

    expect(res.status).toBe(200);
    expect(res.body.stage.parentStageId).toBe(newParent);
    expect((await stageRow(moving)).parent_stage_id).toBe(newParent);
    // The moved stage's own subtree travels with it rather than being reparented
    // or cut loose by the move.
    expect((await stageRow(child)).parent_stage_id).toBe(moving);
    // The stage it left is no longer its parent and gets no other child in its place.
    const { rows: oldParentsChildren } = await testPool.query(
      'select id from matter_stages where parent_stage_id = $1', [oldParent],
    );
    expect(oldParentsChildren).toHaveLength(0);
  });

  it('lets a reparented stage become a root by clearing parentStageId', async () => {
    const parent = await seedStage(firm.id, pipelineId, { name: 'Intake' });
    const moving = await seedStage(firm.id, pipelineId, { name: 'Discovery', parentStageId: parent });

    const res = await owner.api.put(`${STAGES()}/${moving}`).send({ parentStageId: null });

    expect(res.status).toBe(200);
    expect(res.body.stage.parentStageId).toBeNull();
    expect((await stageRow(moving)).parent_stage_id).toBeNull();
  });
});
