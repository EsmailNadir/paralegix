/**
 * Creating and editing the firm record itself.
 *
 * Three rules that nothing else covers:
 *
 *   ONLY A firm_member MAY CREATE A FIRM. `requireUserType(['firm_member'])`
 *   sits on the route because the choice is a radio button on the signup screen
 *   and nothing else would stop a portal client from posting to it directly and
 *   becoming an Owner. That refusal, and the membership-cap refusal, are pinned
 *   in `lawFirmCreatedAnalytics.test.ts`, which also proves neither is reported.
 *
 *   A NEW FIRM ARRIVES SEEDED. Built-in roles, a trial plan and the creator's
 *   owning membership all land together. A firm created without its roles has no
 *   grantable permissions and no way to add any.
 *
 *   READING THE FIRM IS BASELINE, EDITING IT IS `firm.update`. Every member sees
 *   the firm name in the header; only an administrator changes it.
 *
 * Driven through the routes. `updateLawFirm` takes POSITIONAL arguments
 * (`lawFirmId, data`) rather than a destructured object, so a service-level call
 * written in the object style silently passes the object as the id and answers
 * "Law firm not found" - which reads as a missing fixture rather than a wrong
 * call.
 */
import {
  as,
  createFirm,
  drainEvents,
  memberWith,
  ownerOf,
  setFirmPlan,
  testPool,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { firmRow } from '../support/rows';

const { randomUUID } = require('crypto');

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const F = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}${suffix}`;

/** A signed-in firm_member who belongs to no firm yet, so they may create one. */
async function unaffiliatedFounder() {
  const uid = `founder-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, 'Founder', 'firm_member')`,
    [uid, `${uid}@example.test`],
  );
  return { uid, api: as(tokenFor({ uid })) };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Initial Firm' });
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('creating a firm', () => {
  it('creates it with the founder as owner, seeded roles and a trial plan', async () => {
    const founder = await unaffiliatedFounder();

    const res = await founder.api.post('/api/lawfirms/create-lawfirm').send({
      name: 'Patterson & Associates',
      firmSize: '2-5',
      practiceArea: 'Litigation',
    });

    expect(res.status).toBe(201);
    const lawFirmId = res.body.lawFirmId;

    // Three separate things have to land together, and a firm missing any of
    // them is unusable in a way the create response would not show.
    const created = await firmRow(lawFirmId);
    expect(created).toMatchObject({ name: 'Patterson & Associates' });
    // The tier and status are typed columns since migration 0200; the jsonb
    // keeps the rest of the trial bookkeeping and no longer copies these two.
    expect(created.plan_id).toBe('professional');
    expect(created.billing_status).toBe('trialing');
    expect(created.plan).toMatchObject({ trialConsumed: true, comped: false });

    const { rows: roles } = await testPool.query(
      'select name from roles where law_firm_id = $1 order by name', [lawFirmId],
    );
    expect(roles.map((r: any) => r.name))
      .toEqual(['Admin', 'Attorney', 'Owner', 'Paralegal', 'Staff']);

    const { rows: members } = await testPool.query(
      'select user_id, is_owner from members where law_firm_id = $1', [lawFirmId],
    );
    expect(members).toEqual([{ user_id: founder.uid, is_owner: true }]);
  });

  it('serves the new firm back to its founder', async () => {
    const founder = await unaffiliatedFounder();
    const created = await founder.api.post('/api/lawfirms/create-lawfirm')
      .send({ name: 'Patterson & Associates' });

    const res = await founder.api.get(F(created.body.lawFirmId));

    // The founder's membership is what makes this readable. A create that wrote
    // the firm but not the membership would answer 403 here.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.lawFirmId, name: 'Patterson & Associates' });
  });

  it('rejects a creation with no name', async () => {
    const founder = await unaffiliatedFounder();

    const res = await founder.api.post('/api/lawfirms/create-lawfirm').send({ name: '' });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query(
      'select 1 from members where user_id = $1', [founder.uid],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('reading a firm', () => {
  it('lets any member read it', async () => {
    const member = await memberWith(firm.id, []);

    const res = await member.api.get(F(firm.id));

    // Gated on `members.view`, which is baseline: the firm name is in the header
    // of every page.
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Initial Firm');
  });

  it('does not serve another firm', async () => {
    const res = await otherOwner.api.get(F(firm.id));

    expect(res.status).toBe(403);
  });
});

describe('editing a firm', () => {
  it('writes the profile and contact fields', async () => {
    const res = await owner.api.put(F(firm.id)).send({
      name: 'Patterson, Sterling & Associates',
      phone: '555-900-1000',
      city: 'Boston',
      state: 'MA',
    });

    expect(res.status).toBe(200);
    expect(await firmRow(firm.id)).toMatchObject({
      name: 'Patterson, Sterling & Associates',
      phone: '555-900-1000',
      city: 'Boston',
      state: 'MA',
    });
  });

  it('leaves unmentioned fields alone', async () => {
    await owner.api.put(F(firm.id)).send({ phone: '555-900-1000', city: 'Boston' });

    await owner.api.put(F(firm.id)).send({ state: 'MA' });

    // A whole-row write instead of a patch would blank the phone and city that
    // the first request set, and the settings screen would show them empty with
    // no error.
    expect(await firmRow(firm.id)).toMatchObject({
      name: 'Initial Firm', phone: '555-900-1000', city: 'Boston', state: 'MA',
    });
  });

  it('refuses a member without firm.update, and changes nothing', async () => {
    const member = await memberWith(firm.id, ['members.view']);

    const res = await member.api.put(F(firm.id)).send({ name: 'Renamed By Staff' });

    expect(res.status).toBe(403);
    expect(await firmRow(firm.id)).toMatchObject({ name: 'Initial Firm' });
  });

  it('does not edit another firm', async () => {
    const res = await otherOwner.api.put(F(firm.id)).send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(await firmRow(firm.id)).toMatchObject({ name: 'Initial Firm' });
  });

  it('never lets a firm edit its own plan through the profile route', async () => {
    // Seed a tier that is NOT the one the request asks for. `createFirm`
    // defaults to enterprise, so without this the before and after values are
    // both 'enterprise' and the assertion below cannot tell an ignored update
    // from an applied one.
    await setFirmPlan(firm.id, { planId: 'basic', billingStatus: 'active' });

    const res = await owner.api.put(F(firm.id)).send({
      name: 'Initial Firm',
      plan: { planId: 'enterprise', billingStatus: 'active' },
      storageQuotaBytes: 999_999_999_999,
    });

    // The plan and the storage quota are set by the platform console and by
    // Stripe, never by the firm. A profile update that passed its whole body
    // through would let any administrator grant their own firm an unlimited plan.
    const row = await firmRow(firm.id);
    expect(row.plan_id).toBe('basic');
    expect(Number(row.storage_quota_bytes ?? 0)).not.toBe(999_999_999_999);
    expect(res.status).toBeLessThan(500);
  });
});

describe('requesting deletion revokes a warm permission cache immediately', () => {
  it('retains the deleted firm owner membership and counts it against creating another firm', async () => {
    expect((await owner.api.delete(F(firm.id))).status).toBe(200);
    const { rows } = await testPool.query('select law_firm_id, is_owner from members where user_id = $1', [owner.uid]);
    expect(rows).toEqual([{ law_firm_id: firm.id, is_owner: true }]);
    const attempted = await owner.api.post('/api/lawfirms/create-lawfirm').send({ name: 'Replacement firm', firmSize: '2-5', practiceArea: 'Litigation' });
    expect(attempted.status).toBe(400);
    expect(JSON.stringify(attempted.body)).toMatch(/maximum number of law firm memberships/i);
    const { rows: firms } = await testPool.query("select id from law_firms where name = 'Replacement firm'");
    expect(firms).toEqual([]);
  });
  it('invalidates cached access even when external cleanup fails after the deletion stamp commits', async () => {
    const member = await memberWith(firm.id, ['matters.create', 'matters.view']);
    const warm = await member.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'Warm grant' });
    expect(warm.status).toBe(201);
    const repo = require('../../src/modules/lawfirms/lawfirms.repository');
    const original = repo.findById;
    let cleanupFailed = false;
    const fault = jest.spyOn(repo, 'findById').mockImplementation(async (...args: any[]) => {
      const row = await original.apply(repo, args);
      if (row?.pendingDeletionAt) {
        cleanupFailed = true;
        throw new Error('Injected external cleanup lookup failure');
      }
      return row;
    });
    try {
      const response = await owner.api.delete(F(firm.id));
      expect(response.status).toBe(200);
      expect(cleanupFailed).toBe(true);
      await drainEvents();
      const blocked = await member.api.post(`/api/lawfirms/${firm.id}/matters`).send({ name: 'After deletion' });
      expect(blocked.status).toBe(403);
    } finally {
      fault.mockRestore();
    }
  });
  // `requirePermission` resolves a member through `permissionCache` first and
  // only falls to the DB (which filters `pending_deletion_at is null`) on a
  // miss. A member's grant is warmed into that cache by an earlier request in
  // this test, same as `roleLifecycleAccess.test.ts` warms it for a role
  // deletion. Without the `LAWFIRM_DELETION_REQUESTED` listener clearing the
  // firm's cache entries, that warm entry would keep answering requests for
  // this firm for up to the cache's TTL after deletion was requested, even
  // though the route's own comment promises access is revoked "immediately".
  it('refuses a member whose grant was cached before the firm was scheduled for deletion', async () => {
    const member = await memberWith(firm.id, ['matters.create', 'matters.view']);

    const created = await member.api
      .post(`/api/lawfirms/${firm.id}/matters`)
      .send({ name: 'Matter created before deletion was requested' });
    expect(created.status).toBe(201);

    const deleted = await owner.api.delete(F(firm.id));
    expect(deleted.status).toBe(200);
    await drainEvents();

    const blocked = await member.api
      .post(`/api/lawfirms/${firm.id}/matters`)
      .send({ name: 'Matter attempted after deletion was requested' });
    expect({ status: blocked.status, code: blocked.body?.code }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('does not disturb a member of a different firm whose cache happens to be warm', async () => {
    const otherMember = await memberWith(otherFirm.id, ['matters.create', 'matters.view']);
    await otherMember.api
      .post(`/api/lawfirms/${otherFirm.id}/matters`)
      .send({ name: 'Warm the cache in the untouched firm' });

    const deleted = await owner.api.delete(F(firm.id));
    expect(deleted.status).toBe(200);
    await drainEvents();

    const stillAllowed = await otherMember.api
      .post(`/api/lawfirms/${otherFirm.id}/matters`)
      .send({ name: 'Created after a different firm was scheduled for deletion' });
    expect(stillAllowed.status).toBe(201);
  });
});
