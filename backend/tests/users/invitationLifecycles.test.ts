/**
 * Inviting a FIRM MEMBER: the one invite that hands out permissions.
 *
 * `tests/users/invitations.test.ts` covers the client half of this table (the
 * token, its expiry, the email-match rule on accept, revocation, listing). This
 * file covers the other half, which has a different threat model: a member
 * invitation carries a `role_id`, and the role is what the invitee will hold
 * once they accept. So `invite-member` is a permission-GRANTING route, and the
 * two guards inside `inviteMember` are the whole reason it is not a privilege
 * escalation:
 *
 *   1. Only the firm owner may hand out the Owner role.
 *   2. A non-owner may not assign a role granting anything they do not already
 *      hold themselves.
 *
 * The second exists because the first is not enough on its own. The built-in
 * Admin role is `ALL_PERMISSIONS` minus `firm.transferOwnership` and is not
 * named "Owner", so a member holding nothing but `members.invite` could invite
 * an account they control as Admin and walk in through it. That is the case
 * named below, and it is the reason these run through the REAL route: the
 * inviter's permission set arrives as `req.member`, assembled by
 * `requirePermission`, so a service-level call would prove nothing about what
 * the route actually passes in.
 *
 * Every refusal case asserts the `invitations` table is untouched afterwards. A
 * route that answers 403 having already written the row has granted the role;
 * the status code alone cannot tell those apart.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  seedRole,
  createFirmMember,
  createPortalUser,
  memberWith,
  ownerOf,
  stranger,
  emailsMatching,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const { ALL_PERMISSIONS } = require('../../src/modules/lawfirms/roles/permissions');

let firm: Firm;
let owner: Actor;

const inviteUrl = () => `/api/lawfirms/${firm.id}/invitations/invite-member`;

/** Every member invitation this firm holds, oldest first. */
async function memberInvites() {
  const { rows } = await testPool.query(
    `select email, invite_type, role_id, status, token, invited_by, law_firm_id
       from invitations
      where law_firm_id = $1 and invite_type = 'member'
      order by created_at`,
    [firm.id],
  );
  return rows;
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Escalation Firm' });
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('sending a member invitation', () => {
  it('records a pending invitation carrying the role the invitee will hold', async () => {
    const paralegalRole = await seedRole(firm.id, { name: 'Paralegal', permissions: ['tasks.create', 'tasks.update'] });

    const res = await owner.api.post(inviteUrl()).send({
      email: 'Associate@Firm.Test',
      roleId: paralegalRole,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('invited');
    expect(res.body.token).toEqual(expect.any(String));

    const invites = await memberInvites();
    expect(invites).toHaveLength(1);
    // 'member', not 'firm_member': the invite_type check constraint allows only
    // 'member' and 'client', and the client half of the table is read by
    // invite_type everywhere.
    expect(invites[0].invite_type).toBe('member');
    expect(invites[0].role_id).toBe(paralegalRole);
    expect(invites[0].status).toBe('pending');
    expect(invites[0].invited_by).toBe(owner.uid);
    // The Zod schema lowercases the address, so a later lookup by email matches.
    expect(invites[0].email).toBe('associate@firm.test');
    expect(invites[0].token).toBe(res.body.token);
  });

  it('emails the invitee a link containing that exact token', async () => {
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: [] });

    const res = await owner.api.post(inviteUrl()).send({ email: 'associate@firm.test', roleId });

    const sent = emailsMatching('has invited you to join their team');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('associate@firm.test');
    // The token is the entire credential. An email that omits it, or carries a
    // different one, is an invitation nobody can accept.
    expect(sent[0].html).toContain(`/register/member-invite?token=${res.body.token}`);
  });
});

describe('handing out the Owner role', () => {
  it('refuses a non-owner, and writes no invitation', async () => {
    const inviter = await memberWith(firm.id, ['members.invite']);
    const ownerRole = await seedRole(firm.id, { name: 'Owner', permissions: ALL_PERMISSIONS });

    const res = await inviter.api.post(inviteUrl()).send({
      email: 'escalate@firm.test',
      roleId: ownerRole,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Only the firm owner can assign the Owner role/i);
    expect(await memberInvites()).toHaveLength(0);
  });

  it('allows the owner, who already holds everything', async () => {
    const ownerRole = await seedRole(firm.id, { name: 'Owner', permissions: ALL_PERMISSIONS });

    const res = await owner.api.post(inviteUrl()).send({
      email: 'cofounder@firm.test',
      roleId: ownerRole,
    });

    expect(res.status).toBe(200);
    const invites = await memberInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0].role_id).toBe(ownerRole);
  });
});

describe('a non-owner cannot invite someone stronger than themselves', () => {
  it('refuses the built-in Admin role, which is not called "Owner"', async () => {
    // The escalation the name check alone does not stop: Admin is
    // ALL_PERMISSIONS minus firm.transferOwnership, so an invitee holding it
    // can change roles, read every matter and move trust money.
    const inviter = await memberWith(firm.id, ['members.invite']);
    const adminRole = await seedRole(firm.id, { name: 'Admin', permissions: ALL_PERMISSIONS.filter((p: string) => p !== 'firm.transferOwnership') });

    const res = await inviter.api.post(inviteUrl()).send({
      email: 'backdoor@firm.test',
      roleId: adminRole,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot invite a member with more permissions than you have/i);
    expect(await memberInvites()).toHaveLength(0);
  });

  it('refuses a role carrying a single permission the inviter lacks', async () => {
    const inviter = await memberWith(firm.id, ['members.invite']);
    const trustRole = await seedRole(firm.id, { name: 'Trust Clerk', permissions: ['trust.manage'] });

    const res = await inviter.api.post(inviteUrl()).send({
      email: 'trustee@firm.test',
      roleId: trustRole,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/more permissions than you have/i);
    expect(await memberInvites()).toHaveLength(0);
  });

  it('allows a role that grants nothing beyond the baseline every member holds', async () => {
    // The guard must not be a blanket refusal. `members.invite` is worth nothing
    // if the holder cannot invite anybody at all.
    const inviter = await memberWith(firm.id, ['members.invite']);
    const baselineRole = await seedRole(firm.id, { name: 'Read Only', permissions: [] });

    const res = await inviter.api.post(inviteUrl()).send({
      email: 'reader@firm.test',
      roleId: baselineRole,
    });

    expect(res.status).toBe(200);
    const invites = await memberInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0].role_id).toBe(baselineRole);
    expect(invites[0].invited_by).toBe(inviter.uid);
  });

  it('allows a role whose permissions the inviter DOES hold', async () => {
    // Same target role as the refusal two cases up. The only thing that changed
    // is the inviter's own set, which is what the guard compares against.
    const inviter = await memberWith(firm.id, ['members.invite', 'trust.manage']);
    const trustRole = await seedRole(firm.id, { name: 'Trust Clerk', permissions: ['trust.manage'] });

    const res = await inviter.api.post(inviteUrl()).send({
      email: 'trustee@firm.test',
      roleId: trustRole,
    });

    expect(res.status).toBe(200);
    expect((await memberInvites())[0].role_id).toBe(trustRole);
  });
});

describe('the role has to belong to this firm', () => {
  it('refuses a role id borrowed from another firm', async () => {
    // Roles are tenant-scoped, so the lookup must not find it. Were it found,
    // one firm could seed a permissive role and hand its id to another.
    const otherFirm = await createFirm({ name: 'Other Firm' });
    const foreignRole = await seedRole(otherFirm.id, { name: 'Foreign Admin', permissions: ALL_PERMISSIONS });

    const res = await owner.api.post(inviteUrl()).send({
      email: 'crossfirm@firm.test',
      roleId: foreignRole,
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Role/i);
    expect(await memberInvites()).toHaveLength(0);
  });
});

describe('who may invite at all', () => {
  it('refuses a member without members.invite', async () => {
    const bystander = await memberWith(firm.id, ['matters.create']);
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: [] });

    const res = await bystander.api.post(inviteUrl()).send({ email: 'x@firm.test', roleId });

    expect(res.status).toBe(403);
    expect(await memberInvites()).toHaveLength(0);
  });

  it('refuses a signed-in caller who belongs to no firm', async () => {
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: [] });

    const res = await stranger().api.post(inviteUrl()).send({ email: 'x@firm.test', roleId });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Not a member of this firm/i);
    expect(await memberInvites()).toHaveLength(0);
  });
});

describe('refusing an invitation that should not be sent twice', () => {
  it('does not replace a pending invitee\'s original role with a stronger later request', async () => {
    // A pending member invitation is already a credential carrying an authority
    // assignment. Re-sending the same email with a stronger role must not
    // mutate the row behind the first email link: the eventual accept must get
    // exactly the role the first invitation granted.
    const originalRole = await seedRole(firm.id, { name: 'Read Only', permissions: [] });
    const strongerRole = await seedRole(firm.id, { name: 'Trust Manager', permissions: ['trust.manage'] });
    const email = 'pending-role@firm.test';

    const first = await owner.api.post(inviteUrl()).send({ email, roleId: originalRole });
    expect(first.status).toBe(200);

    const replacement = await owner.api.post(inviteUrl()).send({ email, roleId: strongerRole });

    expect(replacement.status).toBe(409);
    expect(replacement.body.error).toMatch(/An invite has already been sent to this email/i);
    const invites = await memberInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0].role_id).toBe(originalRole);
    expect(invites[0].token).toBe(first.body.token);
  });

  it('keeps the first invitation and its token when the same address is invited again', async () => {
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: [] });
    const first = await owner.api.post(inviteUrl()).send({ email: 'dup@firm.test', roleId });
    expect(first.status).toBe(200);

    const second = await owner.api.post(inviteUrl()).send({ email: 'dup@firm.test', roleId });

    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/An invite has already been sent to this email/i);
    // One row, still carrying the ORIGINAL token: a second invite must not
    // silently rotate the credential already sitting in the invitee's inbox.
    const invites = await memberInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0].token).toBe(first.body.token);
  });

  it('refuses an account that is already a member of this firm', async () => {
    const existing = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: [] });

    const res = await owner.api.post(inviteUrl()).send({
      email: `${existing.uid}@example.test`,
      roleId,
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already a member of the law firm/i);
    expect(await memberInvites()).toHaveLength(0);
  });

  it('refuses a client account, which must never cross into firm membership', async () => {
    // A `users` row of type 'client' owns portal access to their own matters.
    // Adding it to `members` would give that account firm-wide access under a
    // role, on both sides of the client/firm boundary at once.
    const portal = await createPortalUser();
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: [] });

    const res = await owner.api.post(inviteUrl()).send({
      email: `${portal.uid}@example.test`,
      roleId,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be added as a firm member/i);
    expect(await memberInvites()).toHaveLength(0);
    const { rows: members } = await testPool.query(
      'select user_id from members where law_firm_id = $1 and user_id = $2',
      [firm.id, portal.uid],
    );
    expect(members).toHaveLength(0);
  });
});
