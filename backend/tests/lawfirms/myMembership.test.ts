/**
 * GET /api/lawfirms/:lawFirmId/members/me: the caller's own membership.
 *
 * Every workspace mount needs one fact: what may THIS person do here. It used to
 * get that by reading the whole firm roster and picking itself out of the list,
 * which resolves every member's identity and signs every member's avatar to
 * answer a question about one row. This route answers it directly.
 *
 * Two things are load-bearing and neither is visible on screen:
 *
 *   - It is gated on membership alone. Nothing but belonging to the firm is
 *     asked of the caller, because the question is about the caller's own row
 *     and any permission code in front of it would render a narrow member's app
 *     as if they held nothing. Membership is therefore the whole boundary, so
 *     the refusal for an outsider is the first case here.
 *   - Its permission list must be identical to the one the roster reports for
 *     the same person. Two resolvers that drift give a member a UI built from
 *     one answer and a backend enforcing the other, and the symptom is a 403
 *     from a button that was visible. The pinning cases below compare the two
 *     live answers rather than asserting a hardcoded list.
 */
import {
  createFirm,
  createFirmMember,
  drainEvents,
  memberWith,
  ownerOf,
  stranger,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS } from '../../src/modules/lawfirms/roles/permissions';

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

describe('who may call it', () => {
  it('refuses another firm\'s owner exactly as the roster route does', async () => {
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const mine = await otherOwner.api.get(`/api/lawfirms/${firm.id}/members/me`);
    const roster = await otherOwner.api.get(`/api/lawfirms/${firm.id}/members`);

    expect(mine.status).toBe(403);
    // Being an owner SOMEWHERE must not leak a membership row anywhere else, and
    // the refusal must not distinguish this firm from one that does not exist.
    expect(mine.body.member).toBeUndefined();
    expect(mine.status).toBe(roster.status);
    expect(mine.body.error).toBe(roster.body.error);
  });

  it('refuses a signed-in caller who belongs to no firm at all', async () => {
    const outsider = stranger();

    const res = await outsider.api.get(`/api/lawfirms/${firm.id}/members/me`);

    expect(res.status).toBe(403);
    expect(res.body.member).toBeUndefined();
  });

  it('answers a member holding nothing beyond the baseline', async () => {
    // The route asks nothing of the caller but membership, because it answers a
    // question about the caller's own row. A member with the narrowest role the
    // product can express is exactly the person whose permissions the UI has to
    // know: gate this on any code at all and their app renders as if they held
    // nothing.
    const narrow = await memberWith(firm.id, []);

    const res = await narrow.api.get(`/api/lawfirms/${firm.id}/members/me`);

    expect(res.status).toBe(200);
    expect([...res.body.member.resolvedPermissions].sort()).toEqual([...DEFAULT_PERMISSIONS].sort());
  });
});

describe('what it returns', () => {
  it('returns the calling member\'s own row and nobody else\'s', async () => {
    const me = await memberWith(firm.id, ['matters.update']);
    await createFirmMember(firm.id, { isOwner: false, permissions: ['billing.manageInvoices'] });
    await createFirmMember(firm.id, { isOwner: false, permissions: ['trust.manage'] });

    const res = await me.api.get(`/api/lawfirms/${firm.id}/members/me`);

    expect(res.status).toBe(200);
    expect(res.body.member.userId).toBe(me.uid);
    expect(res.body.member.lawFirmId).toBe(firm.id);
    expect(res.body.member.isOwner).toBe(false);
    // The whole point of the route: no roster travels with the answer. A
    // response that happened to carry every member would pass the identity
    // assertions above while costing exactly what this replaced.
    expect(JSON.stringify(res.body)).not.toContain('billing.manageInvoices');
    expect(JSON.stringify(res.body)).not.toContain('trust.manage');
  });

  it('carries the fields the permissions context reads', async () => {
    const me = await memberWith(firm.id, ['matters.update']);

    const res = await me.api.get(`/api/lawfirms/${firm.id}/members/me`);

    const member = res.body.member;
    // `id` is what the context falls back to when matching the current user, and
    // `name`/`email` are what the roles screen renders for the viewer.
    expect(member.id).toBe(me.uid);
    expect(member.email).toBe(`${me.uid}@example.test`);
    expect(typeof member.name).toBe('string');
    expect(member.name.length).toBeGreaterThan(0);
    expect(member.roleId).toEqual(expect.any(String));
    expect(Array.isArray(member.resolvedPermissions)).toBe(true);
  });

  it('gives an owner every permission and says so', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/members/me`);

    expect(res.status).toBe(200);
    expect(res.body.member.isOwner).toBe(true);
    // The owner flag is not a hint the frontend re-derives: the resolved set is
    // the full catalog, so a screen gated on a code no role was ever given still
    // opens for the person who owns the firm.
    expect([...res.body.member.resolvedPermissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(res.body.member.resolvedPermissions).toContain('firm.delete');
  });

  it('gives a member with no role the baseline, not nothing', async () => {
    const roleless = await memberWith(firm.id, ['matters.update']);
    await testPool.query(
      'update members set role_id = null where law_firm_id = $1 and user_id = $2',
      [firm.id, roleless.uid],
    );

    const res = await roleless.api.get(`/api/lawfirms/${firm.id}/members/me`);

    expect(res.status).toBe(200);
    // Losing a role degrades to read-only pages, never to a denial screen.
    expect([...res.body.member.resolvedPermissions].sort()).toEqual([...DEFAULT_PERMISSIONS].sort());
    expect(res.body.member.resolvedPermissions).not.toContain('matters.update');
  });
});

describe('it cannot disagree with the roster', () => {
  it('reports the same permission list the roster reports for that member', async () => {
    const me = await memberWith(firm.id, ['matters.update', 'members.view', 'billing.viewInvoices']);
    await createFirmMember(firm.id, { isOwner: false, permissions: ['trust.manage'] });

    const mine = await me.api.get(`/api/lawfirms/${firm.id}/members/me`);
    const roster = await me.api.get(`/api/lawfirms/${firm.id}/members`);

    expect(mine.status).toBe(200);
    expect(roster.status).toBe(200);
    const fromRoster = roster.body.members.find((m: any) => m.userId === me.uid);
    // Pinned against each other, not against a literal. A future change to
    // either resolver that moves one and not the other fails here, which is the
    // only place the divergence is observable before it reaches a user.
    expect(fromRoster).toBeDefined();
    expect([...mine.body.member.resolvedPermissions].sort())
      .toEqual([...fromRoster.resolvedPermissions].sort());
    expect(mine.body.member.resolvedPermissions).toContain('matters.update');
  });

  it('reports the same permission list as the roster for an owner', async () => {
    const mine = await owner.api.get(`/api/lawfirms/${firm.id}/members/me`);
    const roster = await owner.api.get(`/api/lawfirms/${firm.id}/members`);

    const fromRoster = roster.body.members.find((m: any) => m.userId === owner.uid);
    expect([...mine.body.member.resolvedPermissions].sort())
      .toEqual([...fromRoster.resolvedPermissions].sort());
  });

  it('follows a role edit the same way the roster does', async () => {
    const me = await memberWith(firm.id, ['members.view', 'firm.manageRoles', 'matters.view']);
    const before = await me.api.get(`/api/lawfirms/${firm.id}/members/me`);
    expect(before.body.member.resolvedPermissions).not.toContain('matters.update');

    await owner.api
      .put(`/api/lawfirms/${firm.id}/roles/${before.body.member.roleId}`)
      .send({ permissions: ['members.view', 'firm.manageRoles', 'matters.view', 'matters.update'] });
    // The role edit invalidates the resolved-permission cache through
    // ROLE_PERMISSIONS_CHANGED. Without the drain the next read is answered from
    // the pre-edit entry, and the case would pin staleness as if it were the
    // contract.
    await drainEvents();

    const mine = await me.api.get(`/api/lawfirms/${firm.id}/members/me`);
    const roster = await me.api.get(`/api/lawfirms/${firm.id}/members`);
    const fromRoster = roster.body.members.find((m: any) => m.userId === me.uid);

    // A stale answer here is worse than a wrong one: the member's role changed
    // and the app would keep rendering the old capability set.
    expect(mine.body.member.resolvedPermissions).toContain('matters.update');
    expect([...mine.body.member.resolvedPermissions].sort())
      .toEqual([...fromRoster.resolvedPermissions].sort());
  });
});
