/**
 * B10.2: "at most one default pipeline per scope" is a real DB invariant
 * (`matter_stage_pipelines_one_default_idx`, a partial unique index on
 * `(law_firm_id, coalesce(practice_area_id, sentinel)) where is_default`), and
 * `matterStagePipelines.repository.ts#createWithStages` maintains it with a
 * check-then-clear-then-insert sequence: read whether a default already exists
 * for the scope, and if not (or the caller asked for it explicitly) clear any
 * other default in the scope before inserting the new row as the default.
 *
 * That sequence runs inside ONE transaction, but nothing serializes it across
 * TWO concurrent transactions. Two concurrent "create the first pipeline in
 * this (firm, practice area) scope" requests can both read "no default exists
 * yet" before either commits, both decide they should be the default, and both
 * attempt to insert `is_default = true`. Postgres's own unique index then
 * blocks the second insert until the first commits and throws a raw
 * `23505 unique_violation` once it does, which is not an AppError, so it
 * reaches the client as an unhandled 500 instead of either a clean 201/409
 * pair or a coordinated "only one becomes default" outcome.
 *
 * This mirrors the already-fixed `maxMatters`/`maxMembers` seat races: the fix
 * is `lockFirmForPipelineDefaultCheck`, a real Postgres `for update` lock on
 * the firm's own `law_firms` row, taken before the default check, so the
 * second transaction's read of "does a default exist" only proceeds after the
 * first's write has committed.
 *
 * The two HTTP requests are proved genuinely concurrent by gating
 * `matterStagePipelinesRepo.lockFirmForPipelineDefaultCheck` itself and
 * waiting for both to arrive before releasing them: the gate pauses BEFORE
 * the real lock query runs, so both requests can be paused there at once even
 * though the underlying `for update` query serializes them for real once
 * released. A bare `Promise.all` would not prove overlap, since Node could
 * just as easily run the two requests sequentially and pass for the wrong
 * reason. (Before the fix, this same scenario was proved red by gating
 * `_clearOtherDefaults` instead, the chokepoint that existed prior to the fix
 * and let both transactions read "no default yet" concurrently; see the
 * B10.2 tick that introduced this file for that evidence.)
 */
import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const matterStagePipelinesRepo = require('../../src/modules/matters/pipelines/matterStagePipelines.repository');

let firm: Firm;
let owner: Actor;
let gate: Gate | null = null;

afterEach(() => {
  gate?.restore();
  gate = null;
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

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

const payload = (name: string) => ({
  name,
  stages: [{ clientId: 's1', name: 'Intake', sortOrder: 0, parentClientId: null }],
});

describe('at-most-one-default-per-scope race on pipeline create', () => {
  it('does not let two concurrent first-pipeline creates both become the scope default', async () => {
    expect(await pipelineCount(firm.id)).toBe(0);

    gate = gateMethod(matterStagePipelinesRepo, 'lockFirmForPipelineDefaultCheck');

    async function createA() {
      return owner.api
        .post(`/api/lawfirms/${firm.id}/matter-stage-pipelines`)
        .send(payload('Litigation'));
    }
    async function createB() {
      return owner.api
        .post(`/api/lawfirms/${firm.id}/matter-stage-pipelines`)
        .send(payload('Estate Planning'));
    }

    const pA = createA();
    const pB = createB();

    // Proof the two requests are genuinely concurrent: both are paused inside
    // the default-clearing step at the same instant, neither has returned yet.
    await gate.arrived(2);
    gate.open();

    const [resA, resB] = await Promise.all([pA, pB]);

    // Both are legitimate creates (different names, no cap involved), so both
    // must succeed. Neither is a plan-limit case, so a 500 here would be the
    // raw unique-constraint violation escaping the service, not a handled
    // refusal.
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    // The row count is the real oracle regardless of what either response
    // claimed about its own `isDefault`.
    expect(await pipelineCount(firm.id)).toBe(2);
    expect(await defaultsOf(firm.id)).toHaveLength(1);
  });
});
