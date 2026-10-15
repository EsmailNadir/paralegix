/**
 * Matter stage pipelines: the named boards a matter can be run on, each owning
 * a tree of stages.
 *
 * `matterStagePipelines.service.ts` was at 11.4%. Three things here are worth a
 * test and nothing else really is:
 *
 *   THE WALK ORDER. `orderStages` takes a flat payload of stages that reference
 *   each other by a caller-supplied `clientId` and returns them parent-before-
 *   child, roots and siblings sorted by `sortOrder`. The repository then inserts
 *   in that order and resolves each `parentClientId` against ids created earlier
 *   in the same transaction. A wrong order does not error, it produces a
 *   pipeline whose children hang off nothing. The ordering fixtures below are
 *   deliberately supplied in an order that differs from the expected result, so
 *   a walk that simply echoed the payload fails.
 *
 *   THE SINGLE DEFAULT. At most one pipeline per (firm, practice area) may be
 *   the default, and `_clearOtherDefaults` is what maintains it. That sweep is a
 *   bulk UPDATE with no id in its predicate, which is the exact shape that
 *   silently clears every other firm's default if it loses its tenant scope. The
 *   cross-firm default case is the highest-value test in this file.
 *
 *   THE AGGREGATE READ. The list endpoint reads pipelines and stages in two
 *   independent queries and joins them in memory by pipeline id. Either query
 *   can lose its scope without the other noticing, so the decoy firm below holds
 *   a pipeline with a colliding name and stages of its own.
 *
 * Fixtures are plain SQL through the test pool, so a broken repository cannot
 * produce both the row and the expectation.
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

const PIPELINES = () => `/api/lawfirms/${firmA.id}/matter-stage-pipelines`;

async function seedPracticeArea(lawFirmId: string, name: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into practice_areas (id, law_firm_id, name) values ($1,$2,$3) returning id`,
    [id, lawFirmId, name],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function seedPipeline(
  lawFirmId: string, name: string,
  opts: { practiceAreaId?: string | null; isDefault?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_stage_pipelines (id, law_firm_id, practice_area_id, name, is_default)
     values ($1,$2,$3,$4,$5) returning id`,
    [id, lawFirmId, opts.practiceAreaId ?? null, name, opts.isDefault === true],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function seedStage(
  lawFirmId: string, pipelineId: string, name: string, sortOrder = 0,
): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matter_stages (id, law_firm_id, pipeline_id, name, sort_order)
     values ($1,$2,$3,$4,$5) returning id`,
    [id, lawFirmId, pipelineId, name, sortOrder],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0].id;
}

async function pipelineRow(id: string) {
  const { rows } = await testPool.query(
    'select name, is_default, practice_area_id, law_firm_id from matter_stage_pipelines where id = $1',
    [id],
  );
  return rows[0];
}

/** Every pipeline of a firm currently flagged default, by name. */
async function defaultsOf(lawFirmId: string): Promise<string[]> {
  const { rows } = await testPool.query(
    'select name from matter_stage_pipelines where law_firm_id = $1 and is_default order by name',
    [lawFirmId],
  );
  return rows.map((r: any) => r.name);
}

async function pipelineCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    'select count(*)::int n from matter_stage_pipelines where law_firm_id = $1', [lawFirmId],
  );
  return rows[0].n;
}

/** A minimal well-formed create payload, so a refusal cannot be a validation refusal. */
const validPayload = (overrides: Record<string, unknown> = {}) => ({
  name: 'Litigation',
  stages: [{ clientId: 's1', name: 'Intake', sortOrder: 0, parentClientId: null }],
  ...overrides,
});

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm A' });
  firmB = await createFirm({ name: 'Firm B' });
  alice = await ownerOf(firmA.id);
  await ownerOf(firmB.id);
});

describe('listing pipelines', () => {
  it('returns this firm\'s pipelines with their own stages and none of the other firm\'s', async () => {
    const mine = await seedPipeline(firmA.id, 'Litigation');
    await seedStage(firmA.id, mine, 'Intake', 0);
    // Same pipeline name at the other firm, so an exact-set assertion is also a
    // tenancy assertion.
    const theirs = await seedPipeline(firmB.id, 'Litigation');
    await seedStage(firmB.id, theirs, 'Their Intake', 0);

    const res = await alice.api.get(PIPELINES());

    expect(res.status).toBe(200);
    expect(res.body.pipelines.map((p: any) => p.id)).toEqual([mine]);
    expect(res.body.pipelines[0].stages.map((s: any) => s.name)).toEqual(['Intake']);
  });

  it('orders the stages inside a pipeline by sortOrder, not by insertion', async () => {
    const pipeline = await seedPipeline(firmA.id, 'Litigation');
    // Inserted last-first on purpose: a read with no ORDER BY would echo this.
    await seedStage(firmA.id, pipeline, 'Trial', 2);
    await seedStage(firmA.id, pipeline, 'Intake', 0);
    await seedStage(firmA.id, pipeline, 'Discovery', 1);

    const res = await alice.api.get(PIPELINES());

    expect(res.status).toBe(200);
    expect(res.body.pipelines[0].stages.map((s: any) => s.name))
      .toEqual(['Intake', 'Discovery', 'Trial']);
  });

  it('withholds the pipelines from a member of a different firm', async () => {
    // `matters.view` sits in DEFAULT_PERMISSIONS, so no role at firm A can be
    // denied this read. Firm membership is the boundary that actually exists,
    // and this caller owns firm B and nothing at firm A.
    const pipeline = await seedPipeline(firmA.id, 'Litigation');
    await seedStage(firmA.id, pipeline, 'Intake', 0);
    const outsider = await ownerOf(firmB.id);

    const refused = await outsider.api.get(PIPELINES());

    // Assert on content, not only on the status: the point is that the name
    // never reaches this caller.
    expect(JSON.stringify(refused.body)).not.toContain('Litigation');
    expect(refused.status).toBe(403);

    // The data really is there for a caller who may see it, so the refusal
    // withheld something rather than describing an empty firm.
    const allowed = await alice.api.get(PIPELINES());
    expect(allowed.body.pipelines.map((p: any) => p.name)).toEqual(['Litigation']);
  });
});

describe('creating a pipeline', () => {
  it('returns the stages parent-before-child, siblings by sortOrder', async () => {
    const res = await alice.api.post(PIPELINES()).send({
      name: 'Litigation',
      // Supplied in an order that is neither the expected walk nor sorted.
      stages: [
        { clientId: 'trial', name: 'Trial', sortOrder: 2, parentClientId: null },
        { clientId: 'conflict', name: 'Conflict Check', sortOrder: 0, parentClientId: 'intake' },
        { clientId: 'intake', name: 'Intake', sortOrder: 0, parentClientId: null },
        { clientId: 'discovery', name: 'Discovery', sortOrder: 1, parentClientId: null },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.pipeline.stages.map((s: any) => s.name))
      .toEqual(['Intake', 'Conflict Check', 'Discovery', 'Trial']);
  });

  it('links each child row to the id created for its parent', async () => {
    const res = await alice.api.post(PIPELINES()).send({
      name: 'Litigation',
      stages: [
        { clientId: 'child', name: 'Conflict Check', sortOrder: 0, parentClientId: 'root' },
        { clientId: 'root', name: 'Intake', sortOrder: 0, parentClientId: null },
      ],
    });

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      `select name, parent_stage_id, id from matter_stages
        where law_firm_id = $1 and pipeline_id = $2`,
      [firmA.id, res.body.pipelineId],
    );
    const root = rows.find((r: any) => r.name === 'Intake');
    const child = rows.find((r: any) => r.name === 'Conflict Check');
    expect(root.parent_stage_id).toBeNull();
    // A dangling child is the failure this whole payload shape risks.
    expect(child.parent_stage_id).toBe(root.id);
  });

  it('refuses two stages sharing a clientId', async () => {
    const res = await alice.api.post(PIPELINES()).send(validPayload({
      stages: [
        { clientId: 'dup', name: 'Intake', sortOrder: 0, parentClientId: null },
        { clientId: 'dup', name: 'Trial', sortOrder: 1, parentClientId: null },
      ],
    }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unique clientId/i);
    expect(await pipelineCount(firmA.id)).toBe(0);
  });

  it('refuses a parentClientId that names no stage in the payload', async () => {
    const res = await alice.api.post(PIPELINES()).send(validPayload({
      stages: [{ clientId: 's1', name: 'Intake', sortOrder: 0, parentClientId: 'ghost' }],
    }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown parent/i);
    expect(await pipelineCount(firmA.id)).toBe(0);
  });

  it('refuses a stage that names itself as its parent', async () => {
    const res = await alice.api.post(PIPELINES()).send(validPayload({
      stages: [{ clientId: 's1', name: 'Intake', sortOrder: 0, parentClientId: 's1' }],
    }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own parent/i);
  });

  it('refuses a stage graph with no root', async () => {
    const res = await alice.api.post(PIPELINES()).send(validPayload({
      stages: [
        { clientId: 'a', name: 'A', sortOrder: 0, parentClientId: 'b' },
        { clientId: 'b', name: 'B', sortOrder: 1, parentClientId: 'a' },
      ],
    }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid root/i);
    expect(await pipelineCount(firmA.id)).toBe(0);
  });

  it('refuses an ending stage that has a later stage under it', async () => {
    const res = await alice.api.post(PIPELINES()).send(validPayload({
      stages: [
        { clientId: 'closed', name: 'Closed', sortOrder: 0, parentClientId: null, isClosed: true },
        { clientId: 'after', name: 'Appeal', sortOrder: 1, parentClientId: 'closed' },
      ],
    }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ending stage/i);
  });

  it('accepts an ending stage with nothing under it, and stores it closed', async () => {
    // The companion to the refusal above. An ending stage is only wrong when a
    // later stage hangs off it; a leaf ending stage is the normal last step of
    // every pipeline, and the check must find no children for it rather than
    // tripping over a stage that has no entry in the child map at all.
    const res = await alice.api.post(PIPELINES()).send(validPayload({
      stages: [
        { clientId: 'intake', name: 'Intake', sortOrder: 0, parentClientId: null },
        { clientId: 'closed', name: 'Closed', sortOrder: 1, parentClientId: 'intake', isClosed: true },
      ],
    }));

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      `select name, is_closed from matter_stages
        where law_firm_id = $1 and pipeline_id = $2 order by sort_order`,
      [firmA.id, res.body.pipelineId],
    );
    expect(rows).toEqual([
      { name: 'Intake', is_closed: false },
      { name: 'Closed', is_closed: true },
    ]);
  });

  it('refuses a practice area belonging to another firm, then accepts its own', async () => {
    const foreign = await seedPracticeArea(firmB.id, 'Family Law');

    const refused = await alice.api.post(PIPELINES())
      .send(validPayload({ practiceAreaId: foreign }));

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/practiceAreaId/i);
    expect(await pipelineCount(firmA.id)).toBe(0);

    const own = await seedPracticeArea(firmA.id, 'Family Law');
    const accepted = await alice.api.post(PIPELINES())
      .send(validPayload({ practiceAreaId: own }));
    expect(accepted.status).toBe(201);
    expect((await pipelineRow(accepted.body.pipelineId)).practice_area_id).toBe(own);
  });

  it('makes the first pipeline in a scope the default even when not asked to', async () => {
    const res = await alice.api.post(PIPELINES()).send(validPayload({ name: 'Litigation' }));

    expect(res.status).toBe(201);
    expect((await pipelineRow(res.body.pipelineId)).is_default).toBe(true);
  });

  it('leaves a second pipeline in the same scope off the default', async () => {
    const first = await alice.api.post(PIPELINES()).send(validPayload({ name: 'Litigation' }));
    expect(first.status).toBe(201);

    const second = await alice.api.post(PIPELINES()).send(validPayload({ name: 'Estate Planning' }));

    expect(second.status).toBe(201);
    expect((await pipelineRow(second.body.pipelineId)).is_default).toBe(false);
    expect(await defaultsOf(firmA.id)).toEqual(['Litigation']);
  });

  it('moves the default when a later pipeline asks for it', async () => {
    const first = await alice.api.post(PIPELINES()).send(validPayload({ name: 'Litigation' }));
    expect(first.status).toBe(201);

    const second = await alice.api.post(PIPELINES())
      .send(validPayload({ name: 'Estate Planning', isDefault: true }));

    expect(second.status).toBe(201);
    expect(await defaultsOf(firmA.id)).toEqual(['Estate Planning']);
    expect((await pipelineRow(first.body.pipelineId)).is_default).toBe(false);
  });

  it('does not clear another firm\'s default when claiming its own', async () => {
    // The sweep that clears the previous default has no id in its predicate, so
    // it is the query most likely to reach across firms unnoticed.
    const theirDefault = await seedPipeline(firmB.id, 'Their Litigation', { isDefault: true });

    const res = await alice.api.post(PIPELINES())
      .send(validPayload({ name: 'Litigation', isDefault: true }));

    expect(res.status).toBe(201);
    expect(await defaultsOf(firmA.id)).toEqual(['Litigation']);
    expect((await pipelineRow(theirDefault)).is_default).toBe(true);
  });

  it('keeps a practice-area default separate from the firm-wide one', async () => {
    const area = await seedPracticeArea(firmA.id, 'Family Law');
    const firmWide = await alice.api.post(PIPELINES()).send(validPayload({ name: 'General' }));
    expect(firmWide.status).toBe(201);

    const scoped = await alice.api.post(PIPELINES())
      .send(validPayload({ name: 'Family', practiceAreaId: area, isDefault: true }));

    expect(scoped.status).toBe(201);
    // Two defaults, one per scope: clearing across scopes would drop 'General'.
    expect(await defaultsOf(firmA.id)).toEqual(['Family', 'General']);
  });
});

describe('updating a pipeline', () => {
  it('renames it', async () => {
    const pipeline = await seedPipeline(firmA.id, 'Litigaton');

    const res = await alice.api.put(`${PIPELINES()}/${pipeline}`).send({ name: 'Litigation' });

    expect(res.status).toBe(200);
    expect((await pipelineRow(pipeline)).name).toBe('Litigation');
  });

  it('takes the default from the pipeline that held it', async () => {
    const held = await seedPipeline(firmA.id, 'Litigation', { isDefault: true });
    const other = await seedPipeline(firmA.id, 'Estate Planning');

    const res = await alice.api.put(`${PIPELINES()}/${other}`).send({ isDefault: true });

    expect(res.status).toBe(200);
    expect(await defaultsOf(firmA.id)).toEqual(['Estate Planning']);
    expect((await pipelineRow(held)).is_default).toBe(false);
  });

  it('returns the pipeline\'s stages alongside it', async () => {
    const pipeline = await seedPipeline(firmA.id, 'Litigation');
    await seedStage(firmA.id, pipeline, 'Intake', 0);

    const res = await alice.api.put(`${PIPELINES()}/${pipeline}`).send({ name: 'Litigation v2' });

    expect(res.status).toBe(200);
    expect(res.body.pipeline.stages.map((s: any) => s.name)).toEqual(['Intake']);
  });

  it('cannot rename another firm\'s pipeline', async () => {
    const theirs = await seedPipeline(firmB.id, 'Their Litigation');

    const res = await alice.api.put(`${PIPELINES()}/${theirs}`).send({ name: 'Renamed By A' });

    expect(res.status).toBe(404);
    expect((await pipelineRow(theirs)).name).toBe('Their Litigation');
  });
});

describe('deleting a pipeline', () => {
  it('deletes it and cascades its stages', async () => {
    const pipeline = await seedPipeline(firmA.id, 'Litigation');
    const stage = await seedStage(firmA.id, pipeline, 'Intake', 0);

    const res = await alice.api.delete(`${PIPELINES()}/${pipeline}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Pipeline deleted successfully', pipelineId: pipeline });
    expect(await pipelineRow(pipeline)).toBeUndefined();
    const { rows } = await testPool.query('select id from matter_stages where id = $1', [stage]);
    expect(rows).toHaveLength(0);
  });

  it('cannot delete another firm\'s pipeline', async () => {
    const theirs = await seedPipeline(firmB.id, 'Their Litigation');

    const res = await alice.api.delete(`${PIPELINES()}/${theirs}`);

    expect(res.status).toBe(404);
    expect((await pipelineRow(theirs)).name).toBe('Their Litigation');
  });
});

describe('permissions', () => {
  it('lets a matters viewer read pipelines but not create one', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    await seedPipeline(firmA.id, 'Litigation');

    const read = await viewer.api.get(PIPELINES());
    expect(read.status).toBe(200);
    expect(read.body.pipelines.map((p: any) => p.name)).toEqual(['Litigation']);

    const body = validPayload({ name: 'Estate Planning' });
    const refused = await viewer.api.post(PIPELINES()).send(body);
    expect(refused.status).toBe(403);
    expect(await pipelineCount(firmA.id)).toBe(1);

    // The identical body from the owner succeeds, so the 403 was about the
    // caller and not about the payload.
    const accepted = await alice.api.post(PIPELINES()).send(body);
    expect(accepted.status).toBe(201);
  });

  it('refuses a delete from a member without settings.manageFirm', async () => {
    const viewer = await memberWith(firmA.id, ['matters.view', 'matters.update']);
    const pipeline = await seedPipeline(firmA.id, 'Litigation');

    const refused = await viewer.api.delete(`${PIPELINES()}/${pipeline}`);

    expect(refused.status).toBe(403);
    expect((await pipelineRow(pipeline)).name).toBe('Litigation');

    const accepted = await alice.api.delete(`${PIPELINES()}/${pipeline}`);
    expect(accepted.status).toBe(200);
  });
});
