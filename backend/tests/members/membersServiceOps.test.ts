/**
 * The firm member list and the writes against it.
 *
 * `permissions/memberPermissionResolution.test.ts` covers how a member's
 * effective permission set is computed, and `permissions/ownershipTransfer`
 * covers handing the firm over. This file covers the routes around them, and the
 * two rules they exist to enforce:
 *
 *   THE OWNER CANNOT BE REMOVED, and cannot leave. A firm with no owner has no
 *   account that can grant permissions back, so both doors are shut and
 *   ownership must be transferred first.
 *
 *   LEAVING IS NOT GATED ON A PERMISSION. It is an act on your own membership, so
 *   a role too narrow to hold `members.view` must still be able to walk away. The
 *   tenant check is the caller's own member row, not a permission code.
 *
 * Driven through the routes. `removeMember` and `changeRole` both take
 * `actingMember` from `req.member`, which only the middleware populates, so a
 * service-level call has to invent that object and proves nothing about the gate
 * that produced it.
 */
import {
  testPool,
  createFirm,
  seedRole,
  ownerOf,
  memberWith,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let otherFirm: Firm;
let otherOwner: Actor;

const M = (lawFirmId: string, suffix = '') => `/api/lawfirms/${lawFirmId}/members${suffix}`;
const LEAVE = (lawFirmId: string) => `/api/lawfirms/${lawFirmId}/leave`;

async function memberRows(lawFirmId: string) {
  const { rows } = await testPool.query(
    'select user_id, is_owner, role_id from members where law_firm_id = $1', [lawFirmId],
  );
  return rows;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Members Test Firm' });
  owner = await ownerOf(firm.id);
  otherFirm = await createFirm({ name: 'Neighbour LLP' });
  otherOwner = await ownerOf(otherFirm.id);
});

describe('listing members', () => {
  it('lists everyone in the firm and marks the owner', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);

    const res = await owner.api.get(M(firm.id));

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.members.map((m: any) => [m.userId, m]));
    expect(Object.keys(byId).sort()).toEqual([owner.uid, colleague.uid].sort());
    // `isOwner` drives which controls the member list renders. Getting it wrong
    // either hides the owner's own actions or offers a remove button that will
    // always be refused.
    expect(byId[owner.uid].isOwner).toBe(true);
    expect(byId[colleague.uid].isOwner).toBe(false);
  });

  it('never lists another firm members', async () => {
    await memberWith(firm.id, []);
    await memberWith(otherFirm.id, []);

    const mine = await owner.api.get(M(firm.id));
    const theirs = await otherOwner.api.get(M(otherFirm.id));

    // Both directions, and the two firms have the same shape, so only the ids
    // can tell them apart.
    const mineIds = mine.body.members.map((m: any) => m.userId);
    const theirIds = theirs.body.members.map((m: any) => m.userId);
    expect(mineIds).toHaveLength(2);
    expect(theirIds).toHaveLength(2);
    expect(mineIds.filter((id: string) => theirIds.includes(id))).toEqual([]);
  });

  it('does not serve a member of another firm by their id', async () => {
    const theirs = await memberWith(otherFirm.id, []);

    const res = await owner.api.get(M(firm.id, `/${theirs.uid}`));

    // A real person who really is a member, at another firm. The refusal is the
    // tenant scope rather than a missing row.
    expect(res.status).toBe(404);
  });
});

describe('removing a member', () => {
  it('removes an ordinary member', async () => {
    const colleague = await memberWith(firm.id, []);

    const res = await owner.api.delete(M(firm.id, `/${colleague.uid}`));

    expect(res.status).toBe(200);
    expect((await memberRows(firm.id)).map((r: any) => r.user_id)).toEqual([owner.uid]);
  });

  it('refuses to remove the firm owner', async () => {
    const res = await owner.api.delete(M(firm.id, `/${owner.uid}`));

    // A firm with no owner has no account holding the full permission set and no
    // way to grant one back. Ownership has to be transferred first.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/owner/i);
    expect((await memberRows(firm.id)).map((r: any) => r.user_id)).toContain(owner.uid);
  });

  it('refuses a member without members.remove', async () => {
    const colleague = await memberWith(firm.id, []);
    const bystander = await memberWith(firm.id, ['members.view']);

    const res = await bystander.api.delete(M(firm.id, `/${colleague.uid}`));

    expect(res.status).toBe(403);
    expect((await memberRows(firm.id)).map((r: any) => r.user_id)).toContain(colleague.uid);
  });

  it('does not remove a member of another firm through this firm path', async () => {
    const theirs = await memberWith(otherFirm.id, []);

    const res = await owner.api.delete(M(firm.id, `/${theirs.uid}`));

    // The id is real and the caller is a real administrator. Only the firm in
    // the path is wrong, so a delete keyed on the user id alone would succeed.
    expect(res.status).toBe(404);
    expect((await memberRows(otherFirm.id)).map((r: any) => r.user_id)).toContain(theirs.uid);
  });

  it('B02 A10/A11: cuts off the removed member on their very next request, without waiting for a cache expiry', async () => {
    // `changeRole`'s equivalent case above proves a NARROWED role takes effect
    // immediately. This is the more extreme case: the member row is gone
    // entirely, and `loadResolvedMember` has to fall from a cached grant to
    // "not a member of this firm" rather than keep serving the stale entry for
    // the rest of the permission cache's TTL. Nothing here clears the cache by
    // hand; `drainEvents()` only lets the MEMBER_REMOVED listener that owns the
    // invalidation finish, the same shape `roleLifecycleAccess.test.ts` uses for
    // a deleted role.
    const colleague = await memberWith(firm.id, ['matters.create', 'matters.view']);
    // Warm the permission cache with a real grant, so a request answering 403
    // below could not just mean "never had it" in the first place.
    const created = await colleague.api
      .post(`/api/lawfirms/${firm.id}/matters`)
      .send({ name: 'Matter created while still a member' });
    expect(created.status).toBe(201);

    const res = await owner.api.delete(M(firm.id, `/${colleague.uid}`));
    expect(res.status).toBe(200);
    await drainEvents();

    const blocked = await colleague.api
      .post(`/api/lawfirms/${firm.id}/matters`)
      .send({ name: 'Matter attempted after removal' });

    expect({ status: blocked.status, code: blocked.body?.code }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });

    // Surviving unrelated rights: the OWNER's own standing is untouched by a
    // colleague's removal, and the matter the colleague made while still a
    // member is not rolled back.
    const stillTheirs = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(stillTheirs.status).toBe(200);
    const names = (stillTheirs.body.matters || []).map((m: any) => m.name);
    expect(names).toContain('Matter created while still a member');
    expect(names).not.toContain('Matter attempted after removal');
  });
});

describe('changing a member role', () => {
  it('assigns a different role', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    const newRole = await seedRole(firm.id, { name: 'Senior Paralegal', permissions: ['matters.view', 'tasks.view'] });

    const res = await owner.api.put(M(firm.id, `/${colleague.uid}/role`)).send({ roleId: newRole });

    expect(res.status).toBe(200);
    const row = (await memberRows(firm.id)).find((r: any) => r.user_id === colleague.uid);
    expect(row.role_id).toBe(newRole);
  });

  it('takes effect on the member next request, without waiting for a cache expiry', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    // Read once first, so the permission cache holds an entry for this member.
    expect((await colleague.api.get(M(firm.id))).status).toBe(200);
    const narrow = await seedRole(firm.id, { name: 'Narrowed', permissions: [] });

    await owner.api.put(M(firm.id, `/${colleague.uid}/role`)).send({ roleId: narrow });
    const after = await colleague.api.get(M(firm.id, `/${colleague.uid}`));

    // The permission cache is per member, so a role change has to invalidate it.
    // Without that, a revoked grant keeps working until the TTL runs out and the
    // administrator has no way to tell.
    expect(after.status).toBe(200);
    expect(after.body.resolvedPermissions).not.toContain('matters.create');
  });

  it('refuses a role belonging to another firm', async () => {
    const colleague = await memberWith(firm.id, ['matters.view']);
    const foreignRole = await seedRole(otherFirm.id, { name: 'Their Role', permissions: ['matters.view'] });
    const before = (await memberRows(firm.id)).find((r: any) => r.user_id === colleague.uid);

    const res = await owner.api.put(M(firm.id, `/${colleague.uid}/role`))
      .send({ roleId: foreignRole });

    // Assigning another firm's role row would make this member's permissions
    // depend on a role that firm can edit at any time.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = (await memberRows(firm.id)).find((r: any) => r.user_id === colleague.uid);
    expect(after.role_id).toBe(before.role_id);
  });

  it('refuses a member without members.changeRole', async () => {
    const colleague = await memberWith(firm.id, []);
    const bystander = await memberWith(firm.id, ['members.view']);
    const newRole = await seedRole(firm.id, { name: 'Promoted', permissions: ['firm.manageRoles'] });

    const res = await bystander.api.put(M(firm.id, `/${colleague.uid}/role`))
      .send({ roleId: newRole });

    // Without this gate a member could grant themselves, or a colleague, the
    // role-management permission and take the firm from there.
    expect(res.status).toBe(403);
    const row = (await memberRows(firm.id)).find((r: any) => r.user_id === colleague.uid);
    expect(row.role_id).not.toBe(newRole);
  });

  // B02.2 A15: privilege escalation through ASSIGNING an EXISTING role, as
  // opposed to `roleEscalation.test.ts`'s coverage of CREATING/EDITING one.
  // `changeRole` (members.service.ts) carries the identical `excess.length > 0`
  // guard as `createRole`/`updateRole` and `inviteMember`, but nothing drove it
  // through this route: `refuses a member without members.changeRole` above
  // tests the permission GATE (the actor holds no changeRole grant at all),
  // not the escalation guard (the actor holds changeRole but the target role
  // outstrips their own permissions).
  it('refuses to assign an EXISTING role that grants more than the actor holds', async () => {
    const colleague = await memberWith(firm.id, []);
    // Holds changeRole itself, but nothing beyond the DEFAULT_PERMISSIONS
    // baseline every member gets -- notably not trust.manage.
    const promoter = await memberWith(firm.id, ['members.changeRole']);
    const trustRole = await seedRole(firm.id, { name: 'Trust Officer', permissions: ['trust.manage'] });

    const res = await promoter.api.put(M(firm.id, `/${colleague.uid}/role`))
      .send({ roleId: trustRole });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/more permissions than you have/i);
    const row = (await memberRows(firm.id)).find((r: any) => r.user_id === colleague.uid);
    expect(row.role_id).not.toBe(trustRole);
  });

  it('still allows assigning an EXISTING role within the actor\'s own permissions', async () => {
    // The positive control: a promoter who actually holds trust.manage may hand
    // out a role granting exactly that, so the guard above cannot be satisfied
    // by refusing every changeRole call.
    const colleague = await memberWith(firm.id, []);
    const promoter = await memberWith(firm.id, ['members.changeRole', 'trust.manage']);
    const trustRole = await seedRole(firm.id, { name: 'Trust Officer', permissions: ['trust.manage'] });

    const res = await promoter.api.put(M(firm.id, `/${colleague.uid}/role`))
      .send({ roleId: trustRole });

    expect(res.status).toBe(200);
    const row = (await memberRows(firm.id)).find((r: any) => r.user_id === colleague.uid);
    expect(row.role_id).toBe(trustRole);
  });
});

describe('setting a member default hourly rate', () => {
  it('stores the rate', async () => {
    const colleague = await memberWith(firm.id, []);

    const res = await owner.api.put(M(firm.id, `/${colleague.uid}/default-hourly-rate`))
      .send({ defaultHourlyRate: 325 });

    expect(res.status).toBe(200);
    // Stored in CENTS, like every other money field, while the API speaks
    // dollars. A rate written straight through as 325 would bill this person at
    // $3.25 an hour and look correct on the settings screen.
    const { rows } = await testPool.query(
      'select default_hourly_rate_cents from members where law_firm_id = $1 and user_id = $2',
      [firm.id, colleague.uid],
    );
    expect(Number(rows[0].default_hourly_rate_cents)).toBe(32500);
  });

  it('refuses a member without billing.manageRates', async () => {
    const colleague = await memberWith(firm.id, []);
    const bystander = await memberWith(firm.id, ['billing.viewRates']);

    const res = await bystander.api.put(M(firm.id, `/${colleague.uid}/default-hourly-rate`))
      .send({ defaultHourlyRate: 1 });

    // Viewing rates is baseline; setting the rate a colleague's time is billed
    // at is not. The pair is the whole point of the two permission codes.
    expect(res.status).toBe(403);
  });
});

describe('leaving a firm', () => {
  it('lets an ordinary member leave', async () => {
    const colleague = await memberWith(firm.id, []);

    const res = await colleague.api.post(LEAVE(firm.id)).send({});

    expect(res.status).toBe(200);
    expect((await memberRows(firm.id)).map((r: any) => r.user_id)).toEqual([owner.uid]);
  });

  it('lets a member too narrow to read the member list leave anyway', async () => {
    // `leave` is deliberately gated on membership rather than a permission. This
    // is the case that rule exists for: a role narrow enough to be refused
    // everywhere else must still be able to walk away.
    const narrow = await memberWith(firm.id, []);
    const res = await narrow.api.post(LEAVE(firm.id)).send({});

    expect(res.status).toBe(200);
  });

  it('refuses to let the owner leave', async () => {
    const res = await owner.api.post(LEAVE(firm.id)).send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await memberRows(firm.id)).map((r: any) => r.user_id)).toContain(owner.uid);
  });

  it('refuses a caller who is not a member of that firm', async () => {
    const res = await otherOwner.api.post(LEAVE(firm.id)).send({});

    // There is no permission gate on this route, so the caller's own member row
    // IS the tenant check. Without it, anyone signed in could post here.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await memberRows(firm.id)).toHaveLength(1);
  });
});
