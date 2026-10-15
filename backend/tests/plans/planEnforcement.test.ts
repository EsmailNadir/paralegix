/**
 * Plan limit enforcement, driven through the routes that call it.
 *
 * `src/shared/plans/planEnforcement.ts` is the monetization boundary: it is the
 * only thing between a Starter firm and unlimited matters, and the only thing
 * between a paying firm and a refusal at a ceiling it already paid past. Both
 * failure directions are invisible on screen. One is revenue never collected;
 * the other is churn.
 *
 * Three properties are worth more than the rest and every case here exists to
 * hold one of them:
 *
 *  1. The BOUNDARY has two sides. `current >= limit` refuses; one below it must
 *     still succeed. A suite that only asserts the 403 passes just as happily
 *     against a gate that refuses everyone, which is the churn failure.
 *  2. A refusal WRITES NOTHING. `enforceCountLimit` runs before the insert at
 *     every call site, and a gate that answers 403 after inserting has already
 *     sold the seat. Every refusal case counts rows, not just status codes.
 *  3. The numbers come from `planDefinitions.ts`, never from a literal here.
 *     Every expectation is derived from `PLAN_TIERS`, so raising Starter's
 *     matter cap changes one file and these tests follow it. A hard-coded 25
 *     would instead turn a deliberate pricing change into a wall of red.
 *
 * Two behaviours documented here are NOT what the surrounding prose in the
 * codebase suggests, and are pinned deliberately:
 *
 *  - `comped: true` is a BILLING escape hatch (`isFirmBillingActive`), not a
 *    limit one. `getEffectiveLimits` reads only `unlimitedOverride`, so a comped
 *    Starter firm is still capped at 25 matters. If comping is ever meant to
 *    lift limits too, `comped_does_not_lift_a_count_limit` is the test that
 *    should go red when that changes.
 *  - A pending invite occupies a member seat until its status leaves 'pending'.
 *    `countMembersAndPendingMembers` filters on status alone and ignores
 *    `expires_at`, so an EXPIRED-but-unswept invite still holds the seat; only
 *    revoking it, or the expiry sweep flipping the row, releases it.
 *
 * Fixtures are plain SQL. Seeding 25 matters through the create route would be
 * slow and, worse, would build the fixture out of the code under test.
 */
import { randomUUID } from 'crypto';

import { installInMemoryBucket } from '../support/inMemoryBucket';
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
  setFirmPlan,
} from '../support/setupInProcess';

installInMemoryBucket();

const { PLAN_TIERS } = require('../../src/shared/plans/planDefinitions');

const STARTER = PLAN_TIERS.starter;
const PROFESSIONAL = PLAN_TIERS.professional;
const ENTERPRISE = PLAN_TIERS.enterprise;

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Overwrite a firm's plan state: the tier on the `plan_id` column, which is the
 * only place `loadFirmPlan` reads it, and the overrides as the whole plan jsonb.
 * The billing status is left as `createFirm` set it.
 */
async function setPlan(
  lawFirmId: string,
  plan: {
    planId: string;
    comped?: boolean;
    unlimitedOverride?: boolean;
    limitOverrides?: Record<string, number>;
    featureOverrides?: Record<string, boolean>;
  },
): Promise<void> {
  await setFirmPlan(lawFirmId, plan, { replace: true });
}

/** Firm-level feature opt-out, which lives in `settings.features`, not in `plan`. */
async function setFirmFeatureSetting(
  lawFirmId: string,
  feature: string,
  enabled: boolean,
): Promise<void> {
  await testPool.query(
    `update law_firms
        set settings = coalesce(settings, '{}'::jsonb)
          || jsonb_build_object('features',
               coalesce(settings -> 'features', '{}'::jsonb)
                 || jsonb_build_object($2::text, $3::boolean))
      where id = $1`,
    [lawFirmId, feature, enabled],
  );
}

/** N matters straight into the table. One statement, so a 250-row tier is cheap. */
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

async function seedLead(lawFirmId: string, name = 'Dana Prospect'): Promise<{ id: string }> {
  const id = randomUUID();
  await testPool.query(
    `insert into leads (id, law_firm_id, name, email) values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `${id.slice(0, 8)}@example.test`],
  );
  return { id };
}

async function seedRole(lawFirmId: string, permissions: string[] = ['matters.view']): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into roles (id, law_firm_id, name, is_built_in, permissions)
     values ($1, $2, $3, false, $4)`,
    [id, lawFirmId, `Role ${id.slice(0, 8)}`, permissions],
  );
  return id;
}

/**
 * A pending invitation row. Written by SQL rather than by sending one, because
 * several cases need a state the send path will not produce (already expired,
 * already revoked, addressed to a user who exists).
 */
async function seedInvite(
  lawFirmId: string,
  overrides: {
    email: string;
    inviteType?: 'member' | 'client';
    status?: string;
    roleId?: string | null;
    expiresAt?: string;
  },
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, '');
  await testPool.query(
    `insert into invitations
       (id, law_firm_id, email, invite_type, role_id, token, status, expires_at, invited_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      id,
      lawFirmId,
      overrides.email,
      overrides.inviteType ?? 'member',
      overrides.roleId ?? null,
      token,
      overrides.status ?? 'pending',
      overrides.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ],
  );
  return { id, token };
}

/** A firm_member `users` row with NO membership anywhere: an invite acceptor. */
async function seedUnattachedUser(): Promise<{ uid: string; email: string; api: Actor['api'] }> {
  const uid = `invitee-${randomUUID().slice(0, 8)}`;
  const email = `${uid}@example.test`;
  await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, $3, 'firm_member')`,
    [uid, email, `Invitee ${uid.slice(-4)}`],
  );
  return { uid, email, api: as(tokenFor({ uid })) };
}

// ── counters (read the rows, never the response) ────────────────────────────

async function matterCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as c from matters where law_firm_id = $1`,
    [lawFirmId],
  );
  return rows[0].c;
}

async function memberCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as c from members where law_firm_id = $1`,
    [lawFirmId],
  );
  return rows[0].c;
}

async function inviteCount(lawFirmId: string, status = 'pending'): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as c from invitations where law_firm_id = $1 and status = $2`,
    [lawFirmId, status],
  );
  return rows[0].c;
}

async function clientCount(lawFirmId: string): Promise<number> {
  const { rows } = await testPool.query(
    `select count(*)::int as c from clients where law_firm_id = $1`,
    [lawFirmId],
  );
  return rows[0].c;
}

/** The PLAN_LIMIT_REACHED contract the frontend branches on. */
function expectPlanLimit(
  res: { status: number; body: any },
  expected: { resource: string; current: number; limit: number; planId: string },
) {
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
  expect(res.body.details).toEqual(expected);
}

// ── maxMatters: matter create ───────────────────────────────────────────────

describe('maxMatters on matter create', () => {
  let firm: Firm;
  let owner: Actor;

  beforeEach(async () => {
    firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, { planId: 'starter' });
    owner = await ownerOf(firm.id);
  });

  const create = (name: string) =>
    owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name });

  // RED when the gate refuses at limit-1 (an off-by-one the other direction is
  // a paying firm told it is full one matter early).
  it('allows the create that lands exactly ON the starter limit', async () => {
    await seedMatters(firm.id, STARTER.limits.maxMatters - 1);

    const res = await create('The last one that fits');

    expect(res.status).toBe(201);
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);
  });

  // RED when the comparison loosens (>= to >), when the limit is read from the
  // wrong tier, or when enforcement is dropped from createMatter entirely.
  it('refuses the create past the starter limit and writes nothing', async () => {
    await seedMatters(firm.id, STARTER.limits.maxMatters);

    const res = await create('One too many');

    expectPlanLimit(res, {
      resource: 'maxMatters',
      current: STARTER.limits.maxMatters,
      limit: STARTER.limits.maxMatters,
      planId: 'starter',
    });
    // The count, not the status. A gate that inserts and then throws answers the
    // same 403 as one that refuses first.
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);
    const { rows } = await testPool.query(
      `select id from matters where law_firm_id = $1 and name = 'One too many'`,
      [firm.id],
    );
    expect(rows).toHaveLength(0);
  });

  // RED when the limit stops being read per-tier (a constant, or the default
  // tier used for every firm). Starter's 25 would refuse this firm at 25.
  it('applies the professional limit to a professional firm, not the default tier', async () => {
    await setPlan(firm.id, { planId: 'professional' });
    await seedMatters(firm.id, PROFESSIONAL.limits.maxMatters - 1);

    const allowed = await create('Fits on professional');
    expect(allowed.status).toBe(201);

    const refused = await create('Past professional');
    expectPlanLimit(refused, {
      resource: 'maxMatters',
      current: PROFESSIONAL.limits.maxMatters,
      limit: PROFESSIONAL.limits.maxMatters,
      planId: 'professional',
    });
  });

  // RED when UNLIMITED (-1) stops short-circuiting: `current >= -1` is true for
  // every firm, so a lost short-circuit refuses enterprise at its first matter.
  it('never refuses an enterprise firm, whose limit is unlimited', async () => {
    expect(ENTERPRISE.limits.maxMatters).toBe(-1);
    await setPlan(firm.id, { planId: 'enterprise' });
    await seedMatters(firm.id, STARTER.limits.maxMatters + 5);

    const res = await create('Enterprise has no ceiling');

    expect(res.status).toBe(201);
  });

  // RED when unlimitedOverride stops lifting limits. This is how a customer is
  // comped past a tier by hand; a regression bills someone promised free.
  it('lets unlimitedOverride carry a starter firm past its limit', async () => {
    await setPlan(firm.id, { planId: 'starter', unlimitedOverride: true });
    await seedMatters(firm.id, STARTER.limits.maxMatters);

    const res = await create('Comped past the cap');

    expect(res.status).toBe(201);
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters + 1);
  });

  // RED when limitOverrides stops being honored, or stops taking precedence over
  // the tier value. The paired case above proves the same firm is refused
  // without the override, so this cannot pass against a gate that allows all.
  it('honors a per-firm limitOverrides ceiling above the tier value', async () => {
    const raised = STARTER.limits.maxMatters + 10;
    await setPlan(firm.id, { planId: 'starter', limitOverrides: { maxMatters: raised } });
    await seedMatters(firm.id, STARTER.limits.maxMatters);

    const res = await create('Allowed by the override');

    expect(res.status).toBe(201);
  });

  /**
   * `comped` is checked by `isFirmBillingActive` only. `getEffectiveLimits` reads
   * `unlimitedOverride` and nothing else, so comping a firm keeps its workspace
   * unlocked without lifting its caps. Pinned because the two flags are named as
   * a pair everywhere they are set, and it is easy to assume they behave alike.
   *
   * RED if `comped` is ever wired into the limit path (which may be intended -
   * this test is then the one to update, deliberately).
   */
  it('does not lift a count limit for a comped firm (comped is a billing flag)', async () => {
    await setPlan(firm.id, { planId: 'starter', comped: true });
    await seedMatters(firm.id, STARTER.limits.maxMatters);

    const refused = await create('Comped but still capped');
    expectPlanLimit(refused, {
      resource: 'maxMatters',
      current: STARTER.limits.maxMatters,
      limit: STARTER.limits.maxMatters,
      planId: 'starter',
    });

    // Same firm, same row count, unlimitedOverride added: now it creates. This is
    // the flag that actually comps a limit.
    await setPlan(firm.id, { planId: 'starter', comped: true, unlimitedOverride: true });
    const allowed = await create('Now genuinely comped');
    expect(allowed.status).toBe(201);
  });

  it('re-enables creation after a legitimate deletion brings the firm below the limit', async () => {
    await seedMatters(firm.id, STARTER.limits.maxMatters - 1);
    const lastOne = await create('Last allowed matter');
    expect(lastOne.status).toBe(201);
    const lastMatterId = lastOne.body.matterId;

    const overflow = await create('Overflow matter');
    expect(overflow.status).toBe(403);
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);

    const del = await owner.api.delete(`/api/lawfirms/${firm.id}/matters/${lastMatterId}`);
    expect(del.status).toBe(200);
    await drainEvents();
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters - 1);

    const reCreate = await create('Replacement matter');
    expect(reCreate.status).toBe(201);
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);
  });

  it('does not count matters belonging to unrelated firms toward this firm cap', async () => {
    const otherFirm = await createFirm({ planId: 'enterprise' });
    await seedMatters(otherFirm.id, STARTER.limits.maxMatters + 10);

    expect(await matterCount(firm.id)).toBe(0);
    const res = await create('Our own matter');
    expect(res.status).toBe(201);
    expect(await matterCount(firm.id)).toBe(1);
  });
});

// ── maxMatters: lead conversion ─────────────────────────────────────────────

/**
 * Lead conversion reaches `maxMatters` through its own call site
 * (`leads.service.ts`), not through `createMatter`. Deleting the line there
 * leaves every matter-create test above green while a Starter firm converts its
 * way to matter 26.
 */
describe('maxMatters on lead conversion', () => {
  let firm: Firm;
  let owner: Actor;

  beforeEach(async () => {
    firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, { planId: 'starter' });
    owner = await ownerOf(firm.id);
  });

  const convert = (leadId: string, body: Record<string, unknown>) =>
    owner.api.post(`/api/lawfirms/${firm.id}/leads/${leadId}/convert`).send(body);

  it('converts a lead into the matter that lands exactly on the limit', async () => {
    await seedMatters(firm.id, STARTER.limits.maxMatters - 1);
    const lead = await seedLead(firm.id);

    const res = await convert(lead.id, { name: 'Converted matter' });

    expect(res.status).toBe(200);
    expect(res.body.matterId).toBeTruthy();
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);
  });

  // RED when the enforceCountLimit call is removed from convertLead, or moved
  // below the write. The lead row is the sharpest witness: a gate that refuses
  // after converting leaves the lead marked converted with no matter behind it.
  it('refuses conversion past the limit and leaves the lead unconverted', async () => {
    await seedMatters(firm.id, STARTER.limits.maxMatters);
    const lead = await seedLead(firm.id);
    const clientsBefore = await clientCount(firm.id);

    const res = await convert(lead.id, { name: 'Matter twenty six' });

    expectPlanLimit(res, {
      resource: 'maxMatters',
      current: STARTER.limits.maxMatters,
      limit: STARTER.limits.maxMatters,
      planId: 'starter',
    });
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);
    expect(await clientCount(firm.id)).toBe(clientsBefore);
    const { rows } = await testPool.query(
      `select converted_at, converted_matter_id, converted_client_id
         from leads where id = $1`,
      [lead.id],
    );
    expect(rows[0].converted_at).toBeNull();
    expect(rows[0].converted_matter_id).toBeNull();
    expect(rows[0].converted_client_id).toBeNull();
  });

  // RED when the gate is hoisted above the createMatter branch. Converting to a
  // client only creates no matter, so a full firm must still be able to do it;
  // refusing here is the churn direction of this bug.
  it('still converts a lead to a client-only record at the matter limit', async () => {
    await seedMatters(firm.id, STARTER.limits.maxMatters);
    const lead = await seedLead(firm.id);

    const res = await convert(lead.id, { createMatter: false });

    expect(res.status).toBe(200);
    expect(res.body.matterId).toBeNull();
    expect(res.body.clientId).toBeTruthy();
    expect(await matterCount(firm.id)).toBe(STARTER.limits.maxMatters);
  });
});

// ── maxMembers: invite ──────────────────────────────────────────────────────

describe('maxMembers on member invite', () => {
  let firm: Firm;
  let owner: Actor;
  let roleId: string;

  beforeEach(async () => {
    firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, { planId: 'starter' });
    // The owner is the firm's first member and counts toward the seat total.
    owner = await ownerOf(firm.id);
    roleId = await seedRole(firm.id);
  });

  const invite = (email: string) =>
    owner.api.post(`/api/lawfirms/${firm.id}/invitations/invite-member`).send({ email, roleId });

  /** Fill the firm to `total` members, owner included. */
  async function fillMembersTo(total: number): Promise<void> {
    const existing = await memberCount(firm.id);
    for (let i = existing; i < total; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture setup, order irrelevant but width is not
      await createFirmMember(firm.id, { isOwner: false });
    }
  }

  it('allows the invite that fills the last starter seat', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);

    const res = await invite('lastseat@example.test');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('invited');
    expect(await inviteCount(firm.id)).toBe(1);
  });

  it('refuses the invite past the starter seat count and writes no invitation', async () => {
    await fillMembersTo(STARTER.limits.maxMembers);

    const res = await invite('onetoomany@example.test');

    expectPlanLimit(res, {
      resource: 'maxMembers',
      current: STARTER.limits.maxMembers,
      limit: STARTER.limits.maxMembers,
      planId: 'starter',
    });
    expect(await inviteCount(firm.id)).toBe(0);
    expect(await memberCount(firm.id)).toBe(STARTER.limits.maxMembers);
  });

  // RED when the pending-invite term is dropped from
  // `countMembersAndPendingMembers`. Without it a Starter firm invites an
  // unbounded number of people and gets every one of them for free, because each
  // one only starts counting once they accept.
  it('counts a pending member invite as an occupied seat', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    await seedInvite(firm.id, { email: 'pending@example.test', roleId });

    const res = await invite('wouldbefourth@example.test');

    expectPlanLimit(res, {
      resource: 'maxMembers',
      current: STARTER.limits.maxMembers,
      limit: STARTER.limits.maxMembers,
      planId: 'starter',
    });
    expect(await inviteCount(firm.id)).toBe(1);
  });

  // The other half of the seat accounting: revoking gives the seat back. RED if
  // the count stops filtering on status (every historical invite would then hold
  // a seat forever, and a firm that revoked one could never re-fill it).
  it('releases the seat when the pending invite is revoked', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    const pending = await seedInvite(firm.id, { email: 'pending@example.test', roleId });

    const blocked = await invite('blocked@example.test');
    expect(blocked.status).toBe(403);

    const revoke = await owner.api
      .post(`/api/lawfirms/${firm.id}/invitations/member-invites/${pending.id}/revoke`)
      .send({});
    expect(revoke.status).toBe(200);

    const res = await invite('nowfits@example.test');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('invited');
  });

  /**
   * The count filters on `status = 'pending'` and never looks at `expires_at`,
   * so a lapsed invite used to keep its seat until the housekeeping sweep flipped
   * the row. That sweep runs from POST /api/cron/housekeeping, and the only
   * scheduler job for it is staging-only (docs/dev/ops/cron-jobs.md), with
   * "housekeeping cron scheduled" still unticked in PRODUCTION_CUTOVER.md. So in
   * production the seat was held indefinitely, and a Starter firm whose two
   * invitees never accepted simply could not hire again.
   *
   * Reserving the seat bought nothing, because an expired invite is unredeemable
   * and the cap is enforced TWICE MORE against real members only: in the
   * claim-and-join transaction (invitations.service acceptInvitation) and on
   * registration auto-accept (auth.service). So the count is a capacity
   * RESERVATION, and reserving capacity for a dead token is pure loss to the firm
   * with no compensating protection.
   *
   * RED if the expiry predicate is ever dropped from the count.
   */
  it('does NOT hold a seat for an expired invite, sweep or no sweep', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    await seedInvite(firm.id, {
      email: 'lapsed@example.test',
      roleId,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    // The row still SAYS pending; nothing has swept it. The seat is free anyway.
    expect(await inviteCount(firm.id, 'pending')).toBe(1);

    const res = await invite('nowfits@example.test');
    expect(res.status).toBe(200);
  });

  it('still holds the seat for an invite that has NOT expired', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    await seedInvite(firm.id, {
      email: 'live@example.test',
      roleId,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    // The half that keeps the case above honest. A count that simply stopped
    // reading invitations would satisfy the expired case and let a firm invite
    // past its paid seats.
    const blocked = await invite('blocked@example.test');
    expectPlanLimit(blocked, {
      resource: 'maxMembers',
      current: STARTER.limits.maxMembers,
      limit: STARTER.limits.maxMembers,
      planId: 'starter',
    });
  });

  it('leaves the sweep as hygiene, not as the thing that frees the seat', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    await seedInvite(firm.id, {
      email: 'lapsed@example.test',
      roleId,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    // The exact function POST /api/cron/housekeeping calls. It still tidies the
    // row, and the seat was already free before it ran.
    await require('../../src/modules/invitations/invitations.routes').sweepExpiredInvitations();

    expect(await inviteCount(firm.id, 'expired')).toBe(1);
    const res = await invite('afterSweep@example.test');
    expect(res.status).toBe(200);
  });

  // RED when the invite_type filter is dropped: a firm's pending CLIENT invites
  // would start eating member seats, refusing a firm that has bought enough.
  it('does not count a pending client invite against member seats', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    await seedInvite(firm.id, { email: 'aclient@example.test', inviteType: 'client' });

    const res = await invite('stillfits@example.test');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('invited');
  });

  it('never refuses an invite on enterprise, whose member limit is unlimited', async () => {
    expect(ENTERPRISE.limits.maxMembers).toBe(-1);
    await setPlan(firm.id, { planId: 'enterprise' });
    await fillMembersTo(STARTER.limits.maxMembers + 2);

    const res = await invite('enterpriseseat@example.test');

    expect(res.status).toBe(200);
  });
});

// ── maxMembers: invite accept ───────────────────────────────────────────────

/**
 * The second `maxMembers` call site. It exists because a firm can downgrade or
 * fill up between sending an invite and someone accepting it, and it counts
 * MEMBERS ONLY: the acceptor is themselves one of the pending rows, so counting
 * pending here would refuse the very invite being accepted.
 */
describe('maxMembers on member invite accept', () => {
  let firm: Firm;

  beforeEach(async () => {
    firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, { planId: 'starter' });
    await ownerOf(firm.id);
  });

  async function fillMembersTo(total: number): Promise<void> {
    const existing = await memberCount(firm.id);
    for (let i = existing; i < total; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- fixture setup
      await createFirmMember(firm.id, { isOwner: false });
    }
  }

  it('lets the acceptor take the last seat', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    const invitee = await seedUnattachedUser();
    const roleId = await seedRole(firm.id);
    const inv = await seedInvite(firm.id, { email: invitee.email, roleId });

    const res = await invitee.api.post('/api/invitations/member-accept').send({ token: inv.token });

    expect(res.status).toBe(200);
    expect(await memberCount(firm.id)).toBe(STARTER.limits.maxMembers);
    expect(await inviteCount(firm.id, 'accepted')).toBe(1);
  });

  /**
   * The refusal rolls the whole accept transaction back, so the invite must
   * still be pending afterwards: the claim (`status` -> 'accepted') happens
   * BEFORE the join, and a gate that let the claim stand would burn the person's
   * only invite while refusing to admit them.
   *
   * RED when enforcement is dropped from the accept path, when it starts
   * counting pending rows too, or when the claim stops rolling back.
   */
  it('refuses an accept that would exceed the seat count, adding no member and burning no invite', async () => {
    await fillMembersTo(STARTER.limits.maxMembers);
    const invitee = await seedUnattachedUser();
    const roleId = await seedRole(firm.id);
    const inv = await seedInvite(firm.id, { email: invitee.email, roleId });

    const res = await invitee.api.post('/api/invitations/member-accept').send({ token: inv.token });

    expectPlanLimit(res, {
      resource: 'maxMembers',
      current: STARTER.limits.maxMembers,
      limit: STARTER.limits.maxMembers,
      planId: 'starter',
    });
    expect(await memberCount(firm.id)).toBe(STARTER.limits.maxMembers);
    const { rows } = await testPool.query(
      `select status, accepted_by from invitations where id = $1`,
      [inv.id],
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].accepted_by).toBeNull();
  });

  /**
   * Members only, pending excluded. With 2 members, the acceptor's own invite and
   * one more outstanding, `countMembersAndPendingMembers` would return 4 against
   * a limit of 3 and refuse a person the firm has already paid for.
   *
   * RED if the accept path is "tidied" to use the same counter as the send path.
   */
  it('counts members only, so other pending invites do not block an accept', async () => {
    await fillMembersTo(STARTER.limits.maxMembers - 1);
    const invitee = await seedUnattachedUser();
    const roleId = await seedRole(firm.id);
    const inv = await seedInvite(firm.id, { email: invitee.email, roleId });
    await seedInvite(firm.id, { email: 'someoneelse@example.test', roleId });

    const res = await invitee.api.post('/api/invitations/member-accept').send({ token: inv.token });

    expect(res.status).toBe(200);
    expect(await memberCount(firm.id)).toBe(STARTER.limits.maxMembers);
  });
});

// ── enforceFeatureAccess ────────────────────────────────────────────────────

/**
 * `templates` is the cleanest probe: off on starter/basic, on from professional
 * up, and `templates.view` is in DEFAULT_PERMISSIONS, so every case here turns on
 * the plan gate rather than on permissions.
 */
describe('enforceFeatureAccess', () => {
  let firm: Firm;
  let owner: Actor;

  beforeEach(async () => {
    firm = await createFirm({ planId: 'starter' });
    await setPlan(firm.id, { planId: 'starter' });
    owner = await ownerOf(firm.id);
  });

  const listTemplates = () => owner.api.get(`/api/lawfirms/${firm.id}/templates`);

  it('serves a feature the tier includes', async () => {
    expect(ENTERPRISE.features.templates).toBe(true);
    await setPlan(firm.id, { planId: 'enterprise' });

    const res = await listTemplates();

    expect(res.status).toBe(200);
  });

  // RED when the plan ceiling stops being enforced server-side. The frontend
  // hiding the nav item is not the boundary; this is.
  it('refuses a feature the tier excludes', async () => {
    expect(STARTER.features.templates).toBe(false);

    const res = await listTemplates();

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not included in your current plan/i);
  });

  it('grants a plan-excluded feature through plan.featureOverrides', async () => {
    await setPlan(firm.id, { planId: 'starter', featureOverrides: { templates: true } });

    const res = await listTemplates();

    expect(res.status).toBe(200);
  });

  it('grants every feature under unlimitedOverride', async () => {
    await setPlan(firm.id, { planId: 'starter', unlimitedOverride: true });

    const res = await listTemplates();

    expect(res.status).toBe(200);
  });

  /**
   * The firm-level opt-out in `settings.features`, which is a different column
   * from `plan` and a different precedence rule: it can only take a feature away,
   * never grant one. Both halves are pinned, because losing the opt-out is a
   * privacy/config regression and losing the plan ceiling is a revenue one.
   */
  it('honors the firm-level settings.features opt-out on a tier that includes the feature', async () => {
    await setPlan(firm.id, { planId: 'enterprise' });
    expect((await listTemplates()).status).toBe(200);

    await setFirmFeatureSetting(firm.id, 'templates', false);

    const res = await listTemplates();
    expect(res.status).toBe(403);
  });

  it('does not let settings.features grant a feature the plan lacks', async () => {
    await setFirmFeatureSetting(firm.id, 'templates', true);

    const res = await listTemplates();

    expect(res.status).toBe(403);
  });

  // A non-member must not learn anything about the firm's plan: the feature gate
  // is an oracle for tier and existence otherwise. The plan denial and the
  // permission denial must be indistinguishable from outside.
  it('answers a non-member with the ordinary permission denial, not a plan one', async () => {
    await setPlan(firm.id, { planId: 'enterprise' });
    const outsiderFirm = await createFirm({ planId: 'enterprise' });
    const outsider = await ownerOf(outsiderFirm.id);

    const res = await outsider.api.get(`/api/lawfirms/${firm.id}/templates`);

    expect(res.status).toBe(403);
    expect(res.body.error).not.toMatch(/not included in your current plan/i);
  });
});
