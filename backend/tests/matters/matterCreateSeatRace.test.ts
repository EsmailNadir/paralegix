/**
 * B10.2: "two simultaneous creations at the final available slot" for the
 * matter count limit.
 *
 * `createMatter` (`src/modules/matters/matters.service.ts`) checks the firm's
 * `maxMatters` plan cap with `enforceCountLimit(..., () =>
 * mattersRepo.countMatters(lawFirmId))` BEFORE calling
 * `mattersRepo.createMatterWithMembersTx`, which opens its own, separate
 * transaction to insert the row. Nothing serializes the count and the insert
 * across two concurrent requests: two creates racing for the same firm's last
 * open slot can each read the same "one slot free" count before either
 * commits its insert, and both succeed, landing the firm over its paid matter
 * cap with nothing on screen ever showing an error.
 *
 * This mirrors the `maxMembers` seat race already fixed for invitation
 * acceptance (`tests/users/invitationSeatRace.test.ts`): the fix serializes
 * concurrent creates on the firm's own row (a real Postgres `for update`
 * lock), moving the authoritative count check inside the same transaction as
 * the insert, after the lock is acquired. The two HTTP requests are proved
 * genuinely concurrent by gating `mattersRepo.countMatters` (the first
 * repository call the racy read reaches) and waiting for both to arrive
 * before releasing them. `Promise.all` alone would not prove overlap, since
 * Node could just as easily run the two requests sequentially and pass for
 * the wrong reason.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';

const mattersRepo = require('../../src/modules/matters/matters.repository');
const { PLAN_TIERS } = require('../../src/shared/plans/planDefinitions');

const STARTER = PLAN_TIERS.starter;

let firm: Firm;
let owner: Actor;
let gate: Gate | null = null;

afterEach(() => {
  gate?.restore();
  gate = null;
});

/** Overwrite a firm's plan state, mirroring tests/plans/planEnforcement.test.ts. */
async function setPlan(lawFirmId: string, planId: string): Promise<void> {
  await testPool.query(
    `update law_firms set plan_id = $2, plan = $3::jsonb where id = $1`,
    [lawFirmId, planId, JSON.stringify({ planId })],
  );
}

/** N matters straight into the table, cheap even for a large tier. */
async function seedMatters(lawFirmId: string, howMany: number): Promise<void> {
  if (howMany <= 0) return;
  const tag = randomUUID().slice(0, 8);
  await testPool.query(
    `insert into matters (law_firm_id, name, matter_reference_id, status)
     select $1, 'Seeded ' || g, $2 || '-' || g, 'active'
       from generate_series(1, $3) g`,
    [lawFirmId, tag, howMany],
  );
}

async function matterCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as c from matters where law_firm_id = $1`,
    [lawFirmId],
  );
  return rows[0].c;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await setPlan(firm.id, 'starter');
});

describe('maxMatters seat race on matter create', () => {
  it('does not let two concurrent creates both land on the final open slot', async () => {
    // One slot left before the starter cap.
    await seedMatters(firm.id, STARTER.limits.maxMatters - 1);
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters - 1);

    gate = gateMethod(mattersRepo, 'countMatters');

    // A bare `owner.api.post(url).send(body)` assigned to a variable is an
    // INERT, unsent supertest `Test` object. Superagent only dispatches once
    // something calls `.then()`/`.end()` on it, which a plain assignment or
    // `gate.arrived()` never does. Wrapping each in an `async function` that
    // RETURNS the chain makes the language itself call `.then()` on the
    // return value, which is what actually sends it (same pattern as
    // `tests/users/invitationSeatRace.test.ts`).
    async function createA() {
      return owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'Race A' });
    }
    async function createB() {
      return owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'Race B' });
    }

    const pA = createA();
    const pB = createB();

    // Proof the two requests are genuinely concurrent: both are paused inside
    // the count check at the same instant, neither has returned yet.
    await gate.arrived(2);
    gate.open();

    const [resA, resB] = await Promise.all([pA, pB]);
    const statuses = [resA.status, resB.status].sort();

    // Exactly one create succeeds and the other is refused at the cap, never
    // both succeeding (over the paid limit) and never both refused (a real
    // slot going unused).
    expect(statuses).toEqual([201, 403]);

    const refused = resA.status === 403 ? resA : resB;
    expect(refused.body.code).toBe('PLAN_LIMIT_REACHED');

    // The row count is the real oracle: the firm must land EXACTLY on its
    // cap, never one over it, regardless of what either response claimed.
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);
  });
});
