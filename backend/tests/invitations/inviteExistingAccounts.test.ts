/**
 * Invitations addressed to someone who already has an account.
 *
 * Most invitation specs start from a stranger's address, which takes the
 * pending-invite path. An address that already belongs to a registered person
 * takes different branches: a client account is linked straight onto the
 * firm's books, a firm-member account is added to the firm without a token,
 * and an account of the WRONG type is refused so it cannot cross the boundary
 * between the client portal and the firm application. Accepting also has two
 * branches of its own that only an existing account reaches: a firm member
 * trying to become a client of the same firm, and a person already in another
 * firm who has to leave it to join.
 *
 * The joined-client resend path lives here too, because it is the one resend
 * that acts on a `clients` row rather than on an invitation.
 */
import { randomUUID } from 'crypto';
import { gateMethod } from '../support/gate';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  memberWith,
  seedRole,
  emailsMatching,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const firebase = require('../../src/shared/database/firebase');

let firm: Firm;
let owner: Actor;

const I = (suffix: string, lawFirmId = firm.id) => `/api/lawfirms/${lawFirmId}/invitations${suffix}`;

beforeEach(async () => {
  firm = await createFirm({ name: 'Harbor Law' });
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  delete firebase.auth.getUserByEmail;
});

it('keeps a member invitation pending when the destination firm has been scheduled for deletion', async () => {
  const invitee = await account('firm_member');
  const roleId = await seedRole(firm.id, { permissions: [] });
  const token = randomUUID();
  const { rows } = await testPool.query(
    `insert into invitations (law_firm_id, email, invite_type, role_id, token, invited_by)
     values ($1, $2, 'member', $3, $4, $5) returning id`, [firm.id, invitee.email, roleId, token, owner.uid],
  );
  await testPool.query('update law_firms set pending_deletion_at = now() where id = $1', [firm.id]);
  const response = await invitee.api.post('/api/invitations/member-accept').send({ token });
  expect(response.status).toBe(404);
  const { rows: membership } = await testPool.query('select user_id from members where user_id = $1', [invitee.uid]);
  expect(membership).toEqual([]);
  const { rows: invite } = await testPool.query('select status from invitations where id = $1', [rows[0].id]);
  expect(invite).toEqual([{ status: 'pending' }]);
});

/** A registered account of the given type, with its address. */
async function account(userType: 'client' | 'firm_member' | 'pending', name = 'Existing Person') {
  const uid = `acct-${randomUUID().slice(0, 8)}`;
  const email = `${uid}@example.test`;
  await testPool.query(
    'insert into users (id, email, name, user_type) values ($1, $2, $3, $4)',
    [uid, email, name, userType],
  );
  return { uid, email, api: as(tokenFor({ uid })) };
}

async function clientRowsFor(lawFirmId: string, email: string) {
  const { rows } = await testPool.query(
    `select id, user_id, portal_invite_pending
       from clients where law_firm_id = $1 and lower(email) = lower($2)`,
    [lawFirmId, email],
  );
  return rows;
}

async function invitationsFor(lawFirmId: string, email: string) {
  const { rows } = await testPool.query(
    'select id, invite_type, status from invitations where law_firm_id = $1 and email = $2',
    [lawFirmId, email],
  );
  return rows;
}

async function memberFirmIds(uid: string) {
  const { rows } = await testPool.query(
    'select law_firm_id from members where user_id = $1 order by law_firm_id',
    [uid],
  );
  return rows.map((r) => r.law_firm_id);
}

async function seedInvite(lawFirmId: string, email: string, inviteType: 'member' | 'client', roleId: string | null = null) {
  const id = randomUUID();
  const token = `token-${id}`;
  const res = await testPool.query(
    `insert into invitations (id, law_firm_id, email, invite_type, role_id, token, status, expires_at)
     values ($1, $2, $3, $4, $5, $6, 'pending', now() + interval '7 days')`,
    [id, lawFirmId, email, inviteType, roleId, token],
  );
  expect(res.rowCount).toBe(1);
  return { id, token };
}

describe('adding an existing client account directly', () => {
  it('links the account onto a new client record for the firm', async () => {
    const person = await account('client', 'Dana Client');

    const res = await owner.api.post(I('/associate-client-direct')).send({ email: person.email.toUpperCase() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Client added successfully', clientId: person.uid });
    const rows = await clientRowsFor(firm.id, person.email);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(person.uid);
  });

  it('adopts the firm placeholder for that address rather than creating a second record', async () => {
    const person = await account('client');
    const placeholder = await createPersonClient(firm.id, { email: person.email });

    const res = await owner.api.post(I('/associate-client-direct')).send({ email: person.email });

    expect(res.status).toBe(200);
    const rows = await clientRowsFor(firm.id, person.email);
    expect(rows.map((r) => [r.id, r.user_id])).toEqual([[placeholder.id, person.uid]]);
  });

  it('refuses an address whose client record is already linked', async () => {
    const person = await account('client');
    await createPersonClient(firm.id, { email: person.email, userId: person.uid });

    const res = await owner.api.post(I('/associate-client-direct')).send({ email: person.email });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This client is already associated with your law firm');
  });

  it.each([
    ['an address with no account', null],
    ['a firm-member account', 'firm_member'],
  ] as const)('refuses %s and writes no client record', async (_label, userType) => {
    const email = userType ? (await account(userType)).email : `nobody-${randomUUID().slice(0, 8)}@example.test`;

    const res = await owner.api.post(I('/associate-client-direct')).send({ email });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^No client account matches this email/);
    expect(await clientRowsFor(firm.id, email)).toHaveLength(0);
  });

  it('does not let another firm owner link an account into this firm', async () => {
    const person = await account('client');
    const outsider = await ownerOf((await createFirm()).id);

    const res = await outsider.api.post(I('/associate-client-direct')).send({ email: person.email });

    expect(res.status).toBe(403);
    expect(await clientRowsFor(firm.id, person.email)).toHaveLength(0);
  });
});

describe('sending a client invitation to an existing account', () => {
  it('links a client account at once, drops a stale pending invite, and tells them', async () => {
    const person = await account('client');
    const stale = await seedInvite(firm.id, person.email, 'client');

    const res = await owner.api.post(I('/send-client-invite')).send({ email: person.email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Client added successfully', email: person.email, status: 'added', clientId: person.uid,
    });
    const rows = await clientRowsFor(firm.id, person.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: person.uid, portal_invite_pending: false });
    const { rows: left } = await testPool.query('select 1 from invitations where id = $1', [stale.id]);
    expect(left).toHaveLength(0);
    expect(emailsMatching("You've been added to Harbor Law's client portal").map((e) => e.to)).toEqual([person.email]);
  });

  it('refuses a firm-member account and sends nothing', async () => {
    const person = await account('firm_member');

    const res = await owner.api.post(I('/send-client-invite')).send({ email: person.email });

    expect(res.status).toBe(400);
    expect(await invitationsFor(firm.id, person.email)).toHaveLength(0);
    expect(await clientRowsFor(firm.id, person.email)).toHaveLength(0);
  });

  it('refuses an address whose client record already has a portal identity', async () => {
    const person = await account('client');
    await createPersonClient(firm.id, { email: person.email, userId: person.uid });

    const res = await owner.api.post(I('/send-client-invite')).send({ email: person.email });

    expect(res.status).toBe(409);
    expect(await invitationsFor(firm.id, person.email)).toHaveLength(0);
  });

  it('points a new invitation at the firm placeholder and clears its pending flag', async () => {
    const email = `new-${randomUUID().slice(0, 8)}@example.test`;
    const placeholder = await createPersonClient(firm.id, { email });
    await testPool.query('update clients set portal_invite_pending = true where id = $1', [placeholder.id]);

    const res = await owner.api.post(I('/send-client-invite')).send({ email });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'invited', clientId: placeholder.id });
    expect((await clientRowsFor(firm.id, email))[0].portal_invite_pending).toBe(false);
    expect(await invitationsFor(firm.id, email)).toEqual([
      expect.objectContaining({ invite_type: 'client', status: 'pending' }),
    ]);
  });

  it('refuses a second invitation to an address that already has one pending', async () => {
    const email = `new-${randomUUID().slice(0, 8)}@example.test`;
    await seedInvite(firm.id, email, 'client');

    const res = await owner.api.post(I('/send-client-invite')).send({ email });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('An invite has already been sent to this email');
    expect(await invitationsFor(firm.id, email)).toHaveLength(1);
  });

  it('CHARACTERISATION: refuses an address Firebase knows that has no users row yet', async () => {
    const email = `auth-only-${randomUUID().slice(0, 8)}@example.test`;
    const seen: string[] = [];
    firebase.auth.getUserByEmail = async (address: string) => {
      seen.push(address);
      return { uid: `auth-only-${randomUUID().slice(0, 8)}`, email: address };
    };

    const res = await owner.api.post(I('/send-client-invite')).send({ email });

    // The Firebase fallback returns an identity with no user type, which the
    // client-type check reads as "not a client". No invitation goes out.
    expect(seen).toEqual([email]);
    expect(res.status).toBe(400);
    expect(await invitationsFor(firm.id, email)).toHaveLength(0);
  });
});

describe('inviting an existing account as a member', () => {
  it('reserves only the last available seat when two pending invitations overlap', async () => {
    await testPool.query("update law_firms set plan = jsonb_build_object('comped', true, 'limitOverrides', jsonb_build_object('maxMembers', 2)) where id = $1", [firm.id]);
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });
    const repo = require('../../src/modules/invitations/invitations.repository');
    const gate = gateMethod(repo, 'countMembersAndPendingMembers');
    const emails = [1, 2].map(() => `new-${randomUUID()}@example.test`);
    const requests = emails.map(async (email) => owner.api.post(I('/invite-member')).send({ email, roleId }));
    try {
      await gate.arrived(2);
      expect(gate.waiting()).toBe(2);
      gate.open();
      const results = await Promise.all(requests);
      expect(results.map((res) => res.status).sort()).toEqual([200, 403]);
      const invitations = (await Promise.all(emails.map((email) => invitationsFor(firm.id, email)))).flat();
      expect(invitations).toHaveLength(1);
      expect(invitations[0].status).toBe('pending');
    } finally {
      gate.restore();
      await Promise.all(requests);
    }
  });

  it('adds an unattached user to only one firm when two owners invite them concurrently', async () => {
    const person = await account('firm_member');
    const elsewhere = await createFirm();
    const otherOwner = await ownerOf(elsewhere.id);
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });
    const otherRoleId = await seedRole(elsewhere.id, { permissions: ['matters.view'] });
    const repo = require('../../src/modules/invitations/invitations.repository');
    const gate = gateMethod(repo, 'findUserByEmail');
    const fire = async (actor: Actor, lawFirmId: string, assignedRoleId: string) => actor.api.post(I('/invite-member', lawFirmId))
      .send({ email: person.email, roleId: assignedRoleId });
    const first = fire(owner, firm.id, roleId);
    const second = fire(otherOwner, elsewhere.id, otherRoleId);
    try {
      await gate.arrived(2);
      expect(gate.waiting()).toBe(2);
      gate.open();
      const results = await Promise.all([first, second]);
      expect(results.map((res) => res.status)).toEqual([200, 200]);
      expect(results.map((res) => res.body.status).sort()).toEqual(['added', 'invited']);
      expect(await memberFirmIds(person.uid)).toHaveLength(1);
    } finally {
      gate.restore();
      await Promise.all([first, second]);
    }
  });

  it('adds an unattached firm-member account straight to the firm', async () => {
    const person = await account('firm_member');
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });

    const res = await owner.api.post(I('/invite-member')).send({ email: person.email, roleId });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'User invited to law firm', email: person.email, status: 'added' });
    const { rows } = await testPool.query(
      'select role_id, invited_by from members where user_id = $1 and law_firm_id = $2',
      [person.uid, firm.id],
    );
    expect(rows).toEqual([{ role_id: roleId, invited_by: owner.uid }]);
    // No token was minted: the person is in.
    expect(await invitationsFor(firm.id, person.email)).toHaveLength(0);
    expect(emailsMatching(/Harbor Law/).map((e) => e.to)).toEqual([person.email]);
  });

  it('sends a person who is already in another firm a pending invite to accept instead', async () => {
    const elsewhere = await createFirm({ name: 'Elsewhere LLP' });
    const person = await createFirmMember(elsewhere.id, { isOwner: false, permissions: ['matters.view'] });
    const email = `${person.uid}@example.test`;
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });

    const res = await owner.api.post(I('/invite-member')).send({ email, roleId });

    // Adding them outright would silently exceed the one-firm cap; the invite
    // lets THEM decide whether to switch.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'invited', email });
    expect(await memberFirmIds(person.uid)).toEqual([elsewhere.id]);
    const [invite] = await invitationsFor(firm.id, email);
    expect(invite).toMatchObject({ invite_type: 'member', status: 'pending' });
    const [mail] = emailsMatching(/Harbor Law/);
    expect(mail.html).toContain(`/accept-member-invite?token=${res.body.token}`);
  });

  it('answers not-found for a role id that names no role, and writes no invitation', async () => {
    const email = `x-${randomUUID().slice(0, 8)}@example.test`;
    const res = await owner.api.post(I('/invite-member')).send({ email, roleId: randomUUID() });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Role not found');
    expect(await invitationsFor(firm.id, email)).toHaveLength(0);
  });
});

describe('accepting as an existing account', () => {
  it('refuses a firm member accepting a client invite to their own firm', async () => {
    const member = await memberWith(firm.id, ['matters.view']);
    const email = `${member.uid}@example.test`;
    const placeholder = await createPersonClient(firm.id, { email });
    const invite = await seedInvite(firm.id, email, 'client');

    const res = await member.api.post('/api/invitations/accept').send({ token: invite.token });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('You are already a member of this firm and cannot also join as a client.');
    const { rows } = await testPool.query('select user_id from clients where id = $1', [placeholder.id]);
    expect(rows[0].user_id).toBeNull();
    expect((await invitationsFor(firm.id, email))[0].status).toBe('pending');
  });

  describe('a person already in another firm', () => {
    let homeFirm: Firm;
    let person: Actor;
    let invite: { id: string; token: string };

    beforeEach(async () => {
      homeFirm = await createFirm({ name: 'Home Chambers' });
      await ownerOf(homeFirm.id);
      person = await memberWith(homeFirm.id, ['matters.view']);
      invite = await seedInvite(firm.id, `${person.uid}@example.test`, 'member');
    });

    it('is asked to confirm leaving, and nothing moves until they do', async () => {
      const res = await person.api.post('/api/invitations/member-accept').send({ token: invite.token });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FIRM_SWITCH_REQUIRED');
      expect(res.body.error).toBe("You're already part of Home Chambers. Leaving it is required to join this one.");
      // A plain member leaving does not take the firm with them.
      expect(res.body.details).toEqual({
        currentFirms: [{ lawFirmId: homeFirm.id, name: 'Home Chambers', willBeDeleted: false }],
      });
      expect(await memberFirmIds(person.uid)).toEqual([homeFirm.id]);
      expect((await invitationsFor(firm.id, `${person.uid}@example.test`))[0].status).toBe('pending');
    });

    it('leaves the old firm and joins the new one once confirmed', async () => {
      const res = await person.api.post('/api/invitations/member-accept')
        .send({ token: invite.token, confirmSwitch: true });
      await drainEvents();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Invitation accepted successfully', lawFirmId: firm.id });
      expect(await memberFirmIds(person.uid)).toEqual([firm.id]);
      expect((await invitationsFor(firm.id, `${person.uid}@example.test`))[0].status).toBe('accepted');
    });

    it('keeps the original membership and pending invitation if joining the destination fails', async () => {
      const repo = require('../../src/modules/invitations/invitations.repository');
      const original = repo.addMember;
      let joined = false;
      const fault = jest.spyOn(repo, 'addMember').mockImplementation(async (...args: any[]) => {
        await original.apply(repo, args);
        joined = true;
        throw new Error('Injected failure after destination join');
      });
      try {
        const res = await person.api.post('/api/invitations/member-accept').send({ token: invite.token, confirmSwitch: true });
        expect(res.status).toBe(500);
        expect(joined).toBe(true);
        expect(await memberFirmIds(person.uid)).toEqual([homeFirm.id]);
        expect((await invitationsFor(firm.id, `${person.uid}@example.test`))[0].status).toBe('pending');
      } finally {
        fault.mockRestore();
      }
    });
  });

  it('warns a sole owner that leaving would delete their firm', async () => {
    const soloFirm = await createFirm({ name: 'Solo Practice' });
    const solo = await ownerOf(soloFirm.id);
    const invite = await seedInvite(firm.id, `${solo.uid}@example.test`, 'member');

    const res = await solo.api.post('/api/invitations/member-accept').send({ token: invite.token });

    expect(res.status).toBe(409);
    expect(res.body.details.currentFirms).toEqual([
      { lawFirmId: soloFirm.id, name: 'Solo Practice', willBeDeleted: true },
    ]);
    expect(await memberFirmIds(solo.uid)).toEqual([soloFirm.id]);
  });

  it('restores a sole owner firm and keeps its calendar resources if the destination join fails', async () => {
    const soloFirm = await createFirm();
    const solo = await ownerOf(soloFirm.id);
    const invite = await seedInvite(firm.id, `${solo.uid}@example.test`, 'member');
    const repo = require('../../src/modules/invitations/invitations.repository');
    const google = require('../../src/modules/calendar/google/google.service');
    const stop = jest.spyOn(google, 'stopWatchChannelsForLawFirm');
    const original = repo.addMember;
    let joined = false;
    const fault = jest.spyOn(repo, 'addMember').mockImplementation(async (...args: any[]) => {
      await original.apply(repo, args);
      joined = true;
      throw new Error('Injected failure after destination join');
    });
    try {
      const res = await solo.api.post('/api/invitations/member-accept').send({ token: invite.token, confirmSwitch: true });
      expect(res.status).toBe(500);
      expect(joined).toBe(true);
      const { rows } = await testPool.query('select pending_deletion_at from law_firms where id = $1', [soloFirm.id]);
      expect(rows).toEqual([{ pending_deletion_at: null }]);
      expect(await memberFirmIds(solo.uid)).toEqual([soloFirm.id]);
      expect((await invitationsFor(firm.id, `${solo.uid}@example.test`))[0].status).toBe('pending');
      expect(stop).not.toHaveBeenCalled();
    } finally {
      fault.mockRestore();
      stop.mockRestore();
    }
  });
});

describe('resending to a client who already has portal access', () => {
  async function joinedClient(overrides: { email?: string | null; resendCount?: number; lastResendHoursAgo?: number } = {}) {
    const person = await account('client');
    const record = await createPersonClient(firm.id, {
      email: overrides.email === undefined ? person.email : overrides.email,
      userId: person.uid,
    });
    await testPool.query(
      `update clients set invitation_resend_count = $2,
              last_resend_at = case when $3::int is null then null else now() - ($3::int * interval '1 hour') end
        where id = $1`,
      [record.id, overrides.resendCount ?? 0, overrides.lastResendHoursAgo ?? null],
    );
    return { ...record, email: person.email };
  }

  async function resendState(id: string) {
    const { rows } = await testPool.query(
      'select invitation_resend_count, invitation_failed, last_resend_at from clients where id = $1',
      [id],
    );
    return rows[0];
  }

  it('sends the portal email again and counts it on the client record', async () => {
    const client = await joinedClient();

    const res = await owner.api.post(I('/resend-client-invite')).send({ clientId: client.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Invitation resent successfully', sent: true, resendCount: 1 });
    const state = await resendState(client.id);
    expect(state.invitation_resend_count).toBe(1);
    expect(state.invitation_failed).toBe(false);
    expect(state.last_resend_at).not.toBeNull();
    expect(emailsMatching("You've been added to Harbor Law's client portal").map((e) => e.to)).toEqual([client.email]);
  });

  it('refuses a client record with no address', async () => {
    const client = await joinedClient({ email: null });

    const res = await owner.api.post(I('/resend-client-invite')).send({ clientId: client.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No email address associated with this client.');
    expect((await resendState(client.id)).invitation_resend_count).toBe(0);
  });

  it('refuses inside the 24-hour cooldown', async () => {
    const client = await joinedClient({ resendCount: 1, lastResendHoursAgo: 2 });

    const res = await owner.api.post(I('/resend-client-invite')).send({ clientId: client.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Please wait up to 24 hours before resending this invitation.');
    expect((await resendState(client.id)).invitation_resend_count).toBe(1);
  });

  it('stops at ten resends even after the cooldown', async () => {
    const client = await joinedClient({ resendCount: 10, lastResendHoursAgo: 48 });

    const res = await owner.api.post(I('/resend-client-invite')).send({ clientId: client.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Maximum number of resends (10) reached for this invitation.');
    expect((await resendState(client.id)).invitation_resend_count).toBe(10);
  });

  it('does not resend to another firm client record', async () => {
    const other = await createFirm();
    const otherOwner = await ownerOf(other.id);
    const client = await joinedClient();

    const res = await otherOwner.api.post(I('/resend-client-invite', other.id)).send({ clientId: client.id });

    expect(res.status).toBe(404);
    expect((await resendState(client.id)).invitation_resend_count).toBe(0);
  });
});

describe('client deletion and targeted invitation isolation', () => {
  it('does not revoke another firm client invitation when a client sharing the email is deleted', async () => {
    const sharedEmail = `shared-${randomUUID().slice(0, 8)}@example.test`;
    const otherFirm = await createFirm();
    const otherClient = await createPersonClient(otherFirm.id, { email: sharedEmail });
    const localClient = await createPersonClient(firm.id, { email: sharedEmail });

    const localInviteId = randomUUID();
    await testPool.query(
      `insert into invitations (id, law_firm_id, email, invite_type, client_id, token, status, expires_at)
       values ($1, $2, $3, 'client', $4, $5, 'pending', now() + interval '7 days')`,
      [localInviteId, firm.id, sharedEmail, localClient.id, `token-${localInviteId}`],
    );

    const otherInviteId = randomUUID();
    await testPool.query(
      `insert into invitations (id, law_firm_id, email, invite_type, client_id, token, status, expires_at)
       values ($1, $2, $3, 'client', $4, $5, 'pending', now() + interval '7 days')`,
      [otherInviteId, otherFirm.id, sharedEmail, otherClient.id, `token-${otherInviteId}`],
    );

    const del = await owner.api.delete(`/api/lawfirms/${firm.id}/clients/${localClient.id}`);
    expect(del.status).toBe(200);

    const remaining = await testPool.query('select id, status from invitations where id in ($1, $2)', [localInviteId, otherInviteId]);
    expect(remaining.rows).toEqual([{ id: otherInviteId, status: 'pending' }]);
  });
});
