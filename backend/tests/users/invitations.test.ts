/**
 * Invitations: the tokens that let someone into a firm.
 *
 * `invitations.service.ts` was at 11%. An invite token is a bearer credential
 * that turns a stranger into a client of a firm, with access to that client's
 * matters, invoices and documents. It travels by email, which means it gets
 * forwarded, quoted in replies and left in inboxes.
 *
 * So the property this file is built around is the one that makes a leaked token
 * harmless: ACCEPTING AN INVITE REQUIRES THE ACCEPTING ACCOUNT'S EMAIL TO MATCH
 * THE INVITED ADDRESS. Holding the token is not enough.
 *
 * The public lookup route deliberately shows an invite's details before login,
 * so a recipient can see who invited them. What it shows is therefore part of
 * the security surface too.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  createPortalUser,
  ownerOf,
  seedRole,
  as,
  tokenFor,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { anonymous } from '../support/rows';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
/**
 * The address the invitation is sent to, and the uid that will own it.
 *
 * The user does NOT exist yet, and that is the whole point: `send-client-invite`
 * has two branches. An email belonging to a REGISTERED user is associated
 * directly ("Client added successfully", no token, no invitation row); an
 * unregistered one produces a real invitation with a token. Seeding the user up
 * front silently takes the token branch away, and every accept case below then
 * fails on a token that was never issued.
 *
 * The harness derives a user's email from its uid, so the account created later
 * with this uid is the one the invitation is addressed to.
 */
let invitedUid: string;
let invitedEmail: string;

const I = () => `/api/lawfirms/${firm.id}/invitations`;

const sendClientInvite = (email = invitedEmail) =>
  owner.api.post(`${I()}/send-client-invite`).send({ clientId: client.id, email });

const inviteRow = async (token: string) => {
  const { rows } = await testPool.query(
    `select email, invite_type, status, accepted_by, expires_at, law_firm_id
       from invitations where token = $1`, [token],
  );
  return rows[0];
};

const clientUserId = async () => {
  const { rows } = await testPool.query(
    'select user_id from clients where id = $1', [client.id],
  );
  return rows[0].user_id;
};

/** Register the invited account, which is what a recipient does before accepting. */
const registerInvitedUser = () => createPortalUser({ uid: invitedUid });

/**
 * A `firm_member`-type account with no firm yet, for the member-invite lookup
 * and accept cases below. `createPortalUser` always writes `user_type =
 * 'client'`, which `inviteMember`'s cross-type guard would then refuse, so
 * member-invite scenarios need their own registration helper.
 */
const registerUnaffiliatedMember = (uid: string, email: string) =>
  testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, $3, 'firm_member')`,
    [uid, email, `Invitee ${uid.slice(-4)}`],
  );

/**
 * Send a member invitation while the address is still unregistered, which is
 * what actually issues a bearer token: `inviteMember` takes a direct-add,
 * no-token branch the moment the email already resolves to a `users` row (see
 * `invitationAcceptRace.test.ts`'s identical ordering note). Every member-invite
 * case below needs the token, so registration - where a case needs it at all -
 * must happen strictly after this call.
 */
const sendMemberInvite = (email: string, roleId: string) =>
  owner.api.post(`${I()}/invite-member`).send({ email, roleId });

/**
 * Send the invitation, THEN register the account it was addressed to.
 *
 * The order is load-bearing, for the reason given on `invitedUid` above: sending
 * to an address that already has an account takes the direct-association branch
 * and issues no token at all.
 */
async function inviteThenRegister(): Promise<string> {
  const sent = await sendClientInvite();
  await registerInvitedUser();
  return sent.body.token as string;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  invitedUid = `invitee-${Math.random().toString(36).slice(2, 10)}`;
  invitedEmail = `${invitedUid}@example.test`;
  client = await createPersonClient(firm.id, { name: 'Invited Client', email: invitedEmail });
  await drainEvents();
});

describe('sending a client invitation', () => {
  it('creates a pending invitation carrying a long, unique, expiring token', async () => {
    const res = await sendClientInvite();

    expect(res.status).toBe(200);
    // The token IS the credential. An invitation without one cannot be redeemed
    // and the client is left waiting for a link that never works.
    expect(String(res.body.token).length).toBeGreaterThan(20);
    const row = await inviteRow(res.body.token);
    expect(row.status).toBe('pending');
    expect(row.invite_type).toBe('client');
    // A token that never expires is a permanent key to a firm, sitting in an
    // inbox.
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());

    const second = await owner.api.post(`${I()}/send-client-invite`)
      .send({ clientId: client.id, email: 'someone.else@example.test' });

    // A shared or predictable token would let one recipient redeem another's
    // invitation.
    expect(second.status).toBe(200);
    expect(second.body.token).not.toBe(res.body.token);
  });

  it('refuses a malformed email address', async () => {
    const res = await owner.api.post(`${I()}/send-client-invite`)
      .send({ clientId: client.id, email: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  it('refuses a member without the permission', async () => {
    const narrow = await createFirmMember(firm.id, { isOwner: false, permissions: [] });
    const narrowApi = as(tokenFor({ uid: narrow.uid }));

    const res = await narrowApi.post(`${I()}/send-client-invite`)
      .send({ clientId: client.id, email: invitedEmail });

    // Inviting someone into a firm is granting access to it.
    expect(res.status).toBe(403);
  });

  it('gives two firms inviting the same address two separate invitations', async () => {
    const mine = await sendClientInvite();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const otherClient = await createPersonClient(otherFirm.id, { name: 'Their Client', email: invitedEmail });

    const theirs = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/invitations/send-client-invite`)
      .send({ clientId: otherClient.id, email: invitedEmail });

    // Any firm MAY invite any address: a person is routinely a client of more
    // than one firm, and that is what the portal's firm switcher is for. What
    // must not happen is the two firms sharing an invitation row or a token.
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    expect(theirs.body.token).not.toBe(mine.body.token);
    expect((await inviteRow(mine.body.token)).law_firm_id).toBe(firm.id);
    expect((await inviteRow(theirs.body.token)).law_firm_id).toBe(otherFirm.id);
  });

  it('CHARACTERISATION: associates an ALREADY REGISTERED email directly, with no token', async () => {
    await registerInvitedUser();

    const res = await sendClientInvite();

    // The other branch, and one a caller can easily not know about. When the
    // address already belongs to a platform account the service skips the
    // invitation entirely and links the account straight away: "Client added
    // successfully", status "added", no token, no `invitations` row. The person
    // gets portal access without ever clicking a link or confirming.
    //
    // That is defensible for a client the firm already knows, and it is why
    // every case below seeds the user AFTER sending. Recorded because the two
    // branches return different shapes from one endpoint, and code reading
    // `res.body.token` gets `undefined` on this one.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('added');
    expect(res.body.token).toBeUndefined();
    const { rows } = await testPool.query(
      'select id from invitations where law_firm_id = $1', [firm.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the public lookup', () => {
  it('answers not-found for an expired token instead of showing stale details', async () => {
    const sent = await sendClientInvite();
    await testPool.query(
      `update invitations set expires_at = now() - interval '1 second' where token = $1`,
      [sent.body.token],
    );

    const res = await anonymous().get(`/api/invitations/accept/${sent.body.token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(invitedEmail);
  });

  it('does not disclose a client token through the member lookup route', async () => {
    const sent = await sendClientInvite();

    const res = await anonymous().get(`/api/invitations/member-accept/${sent.body.token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(invitedEmail);
  });

  it('shows who invited them, before any login', async () => {
    const sent = await sendClientInvite();

    const res = await anonymous().get(`/api/invitations/accept/${sent.body.token}`);

    // Deliberately public: a recipient has to be able to see which firm is
    // asking, before deciding to create an account.
    expect(res.status).toBe(200);
    expect(res.body.invitation.lawFirmName).toBeTruthy();
    expect(res.body.invitation.email).toBe(invitedEmail);
  });

  it('answers not-found for a token that does not exist', async () => {
    const res = await anonymous().get('/api/invitations/accept/notarealtoken');

    expect(res.status).toBe(404);
  });

  it('does not echo the token back', async () => {
    const sent = await sendClientInvite();

    const res = await anonymous().get(`/api/invitations/accept/${sent.body.token}`);

    // The caller already has the token, so returning it gains nothing and puts
    // a live credential into another response body and another log line.
    expect(JSON.stringify(res.body)).not.toContain(sent.body.token);
  });

  it('does not disclose a member invitation through the client lookup route', async () => {
    const token = `wrong-type-token-${Math.random().toString(36).slice(2)}`;
    await testPool.query(
      `insert into invitations
        (law_firm_id, email, invite_type, token, status, invited_by, invited_at, expires_at)
       values ($1, $2, 'member', $3, 'pending', $4, now(), now() + interval '7 days')`,
      [firm.id, 'staff-secret@example.test', token, owner.uid],
    );

    const res = await anonymous().get(`/api/invitations/accept/${token}`);

    // Client and member tokens have different join semantics. A public route
    // for one kind must not become a metadata oracle for the other kind.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('staff-secret@example.test');
  });

  it('answers not-found for a REVOKED client invitation instead of showing stale details', async () => {
    // The existing expired-token case above proves the time-based half of
    // "not live" is enforced at lookup; revocation is a separate code path
    // (an explicit status write, not a clock comparison) and had no lookup-level
    // coverage of its own before this - only that the later ACCEPT is refused.
    const sent = await sendClientInvite();
    const pending = await owner.api.get(`${I()}/pending-client-invites`);
    await owner.api.post(`${I()}/client-invites/${pending.body.invites[0].id}/revoke`).send({});

    const res = await anonymous().get(`/api/invitations/accept/${sent.body.token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(invitedEmail);
  });

  it('shows who invited them for a MEMBER invitation, before any login', async () => {
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: ['tasks.view'] });
    const sent = await sendMemberInvite(invitedEmail, roleId);

    const res = await anonymous().get(`/api/invitations/member-accept/${sent.body.token}`);

    // The member-accept lookup shares its implementation with the client one
    // (`lookupInviteOfType`), but had never actually been driven through the
    // real route at the HTTP level - only its client-typed sibling had.
    expect(res.status).toBe(200);
    expect(res.body.invitation.lawFirmName).toBeTruthy();
    expect(res.body.invitation.email).toBe(invitedEmail);
  });

  it('answers not-found for a REVOKED member invitation instead of showing stale details', async () => {
    const roleId = await seedRole(firm.id, { name: 'Associate', permissions: ['tasks.view'] });
    const sent = await sendMemberInvite(invitedEmail, roleId);
    const pending = await owner.api.get(`${I()}/pending-member-invites`);
    await owner.api.post(`${I()}/member-invites/${pending.body.invites[0].id}/revoke`).send({});

    const res = await anonymous().get(`/api/invitations/member-accept/${sent.body.token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(invitedEmail);
  });

  it('discloses only alreadyProcessed, not the live invite shape, once a client invite has been accepted', async () => {
    // `lookupInviteOfType`'s second branch exists specifically so the accept
    // page can redirect cleanly instead of showing "invalid invitation" to
    // someone who already finished the flow (see the comment above it in
    // invitations.service.ts) - a real, deliberately-public disclosure this
    // route makes, and it had zero coverage of its own: nothing ever looked up
    // an ACCEPTED token, only a still-pending or a never-valid one.
    const token = await inviteThenRegister();
    await as(tokenFor({ uid: invitedUid })).post('/api/invitations/accept').send({ token });

    const res = await anonymous().get(`/api/invitations/accept/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.invitation).toEqual({
      alreadyProcessed: true,
      lawFirmId: firm.id,
      lawFirmName: expect.any(String),
      email: invitedEmail,
    });
    // The bearer token itself must still never come back, exactly as the
    // still-pending case above requires.
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('discloses only alreadyProcessed, not the live invite shape, once a member invite has been accepted', async () => {
    const roleId = await seedRole(firm.id, { name: 'Paralegal', permissions: ['tasks.view'] });
    const memberUid = `member-invitee-${randomUUID().slice(0, 8)}`;
    const memberEmail = `${memberUid}@example.test`;
    // Sent while unregistered (see sendMemberInvite's note), then registered,
    // then accepted - the same ordering invitationAcceptRace.test.ts uses, and
    // for the identical reason: registering first would take the direct-add,
    // no-token branch instead.
    const sent = await sendMemberInvite(memberEmail, roleId);
    await registerUnaffiliatedMember(memberUid, memberEmail);
    await as(tokenFor({ uid: memberUid })).post('/api/invitations/member-accept').send({ token: sent.body.token });

    const res = await anonymous().get(`/api/invitations/member-accept/${sent.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.invitation).toEqual({
      alreadyProcessed: true,
      lawFirmId: firm.id,
      lawFirmName: expect.any(String),
      email: memberEmail,
    });
    expect(JSON.stringify(res.body)).not.toContain(sent.body.token);
  });
});

describe('accepting an invitation', () => {

  it('rejects an empty token before any invitation lookup', async () => {
    const res = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token: '' });

    expect(res.status).toBe(400);
  });

  it('REFUSES an account whose email does not match, leaving the invitation pending and the client unlinked', async () => {
    const token = await inviteThenRegister();
    const stranger = await createPortalUser();

    const res = await as(tokenFor({ uid: stranger.uid }))
      .post('/api/invitations/accept').send({ token });

    // The property that makes a leaked token harmless. Invitations travel by
    // email: they get forwarded, quoted in replies, and left in inboxes. Anyone
    // holding this token can read the firm's name from the public lookup above,
    // and must still not be able to redeem it.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different email address/i);
    // Asserting the ROW. A refusal that still marked the invite accepted would
    // burn it, and the real recipient could never use it.
    expect((await inviteRow(token)).status).toBe('pending');
    // `clients.user_id` is portal identity. Writing the stranger's uid there
    // hands them the client's matters, invoices and documents.
    expect(await clientUserId()).toBeNull();
  });

  it('ACCEPTS the account the invitation was addressed to, and gives the client their portal identity', async () => {
    const token = await inviteThenRegister();

    const res = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token });

    // The positive half. A check that refused everyone would satisfy every case
    // above and make the whole invitation flow unusable.
    expect(res.status).toBe(200);
    const row = await inviteRow(token);
    expect(row.status).toBe('accepted');
    expect(row.accepted_by).toBe(invitedUid);
    // What accepting is FOR. Without this the invite completes and the client
    // still cannot see anything in the portal.
    expect(await clientUserId()).toBe(invitedUid);
  });

  it('refuses to accept the SAME invitation twice', async () => {
    const token = await inviteThenRegister();
    await as(tokenFor({ uid: invitedUid })).post('/api/invitations/accept').send({ token });

    const res = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token });

    // A single-use credential has to be single use. A token that stays live
    // after redemption is a permanent key.
    expect(res.status).toBe(404);
  });

  it('refuses a REVOKED invitation', async () => {
    const token = await inviteThenRegister();
    const pending = await owner.api.get(`${I()}/pending-client-invites`);
    await owner.api.post(`${I()}/client-invites/${pending.body.invites[0].id}/revoke`).send({});

    const res = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token });

    // Revoking is how a firm undoes a mistaken invite. If the token still works
    // afterwards, revoking is theatre.
    expect(res.status).toBe(404);
    expect(await clientUserId()).toBeNull();
  });

  it('refuses an EXPIRED invitation', async () => {
    const token = await inviteThenRegister();
    await testPool.query(
      `update invitations set expires_at = now() - interval '1 day' where token = $1`,
      [token],
    );

    const res = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token });

    // The expiry has to be enforced at redemption, not just displayed. A stored
    // date nothing checks is decoration.
    expect(res.status).toBe(404);
    expect(await clientUserId()).toBeNull();
  });

  it('refuses an invitation expiring at the EXACT boundary instant, not just comfortably past it', async () => {
    // `withInviteClaimTxn`'s guard is `expiresAt.getTime() <= Date.now()`, an
    // INCLUSIVE comparison — the millisecond an invite's clock reads as its
    // own expiry, it is already dead. The existing expired-invite case above
    // only proves a day-old token is refused, which a strictly-less-than (`<`)
    // comparison would refuse identically; only a boundary this tight tells
    // the two apart.
    const token = await inviteThenRegister();
    await testPool.query(
      `update invitations set expires_at = now() where token = $1`,
      [token],
    );

    const res = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token });

    expect(res.status).toBe(404);
    expect(await clientUserId()).toBeNull();
    expect((await inviteRow(token)).status).toBe('pending');
  });

  it('refuses a token that does not exist', async () => {
    await registerInvitedUser();

    const res = await as(tokenFor({ uid: invitedUid }))
      .post('/api/invitations/accept').send({ token: 'notarealtoken' });

    expect(res.status).toBe(404);
  });
});

describe('managing pending invitations', () => {
  it('lists a pending client invitation without its bearer token', async () => {
    const sent = await sendClientInvite();

    const res = await owner.api.get(`${I()}/pending-client-invites`);

    // The listing is available to every member with clients.view. Returning
    // the token here would turn that read permission into the ability to log
    // in as the invited client.
    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(res.body.invites[0]).not.toHaveProperty('token');
    expect(JSON.stringify(res.body)).not.toContain(sent.body.token);
  });

  it('does not expose member invitation bearer tokens in the pending list', async () => {
    const token = `member-list-token-${Math.random().toString(36).slice(2)}`;
    await testPool.query(
      `insert into invitations
        (law_firm_id, email, invite_type, token, status, invited_by, invited_at, expires_at)
       values ($1, $2, 'member', $3, 'pending', $4, now(), now() + interval '7 days')`,
      [firm.id, 'pending-member@example.test', token, owner.uid],
    );

    const res = await owner.api.get(`${I()}/pending-member-invites`);

    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(res.body.invites[0]).not.toHaveProperty('token');
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('keeps client and member invitations in separate lists', async () => {
    await sendClientInvite();

    const res = await owner.api.get(`${I()}/pending-member-invites`);

    // Two different kinds of access. A client invite showing up in the member
    // list would read as a pending staff member.
    expect(res.body.invites).toEqual([]);
  });

  it('drops a revoked invitation from the pending list', async () => {
    await sendClientInvite();
    const pending = await owner.api.get(`${I()}/pending-client-invites`);
    const inviteId = pending.body.invites[0].id;

    await owner.api.post(`${I()}/client-invites/${inviteId}/revoke`).send({});

    const after = await owner.api.get(`${I()}/pending-client-invites`);
    expect(after.body.invites).toEqual([]);
  });

  it('cannot revoke the same invitation twice', async () => {
    await sendClientInvite();
    const pending = await owner.api.get(`${I()}/pending-client-invites`);
    const inviteId = pending.body.invites[0].id;

    const first = await owner.api.post(`${I()}/client-invites/${inviteId}/revoke`).send({});
    const second = await owner.api.post(`${I()}/client-invites/${inviteId}/revoke`).send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });

  it('does NOT list another firm pending invitations', async () => {
    await sendClientInvite();
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .get(`/api/lawfirms/${otherFirm.id}/invitations/pending-client-invites`);

    // A pending invite names an email address the other firm is dealing with.
    expect(JSON.stringify(res.body ?? {})).not.toContain(invitedEmail);
  });

  it('does not let one firm revoke another firm invitation', async () => {
    await sendClientInvite();
    const pending = await owner.api.get(`${I()}/pending-client-invites`);
    const inviteId = pending.body.invites[0].id;
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);

    const res = await otherOwner.api
      .post(`/api/lawfirms/${otherFirm.id}/invitations/client-invites/${inviteId}/revoke`)
      .send({});

    expect(res.status).toBe(404);
    const after = await owner.api.get(`${I()}/pending-client-invites`);
    expect(after.body.invites).toHaveLength(1);
  });

  it('lists only pending member invites addressed to the authenticated email', async () => {
    const invitee = await createPortalUser({ uid: `member-invitee-${Math.random().toString(36).slice(2, 10)}` });
    const inviteeEmail = `${invitee.uid}@example.test`;
    const otherFirm = await createFirm();

    await testPool.query(
      `insert into invitations
        (law_firm_id, email, invite_type, token, status, invited_by, invited_at, expires_at)
       values
        ($1, $2, 'member', $3, 'pending', $4, now(), now() + interval '7 days'),
        ($5, $2, 'member', $6, 'pending', $4, now(), now() + interval '7 days'),
        ($1, $7, 'member', $8, 'pending', $4, now(), now() + interval '7 days')`,
      [
        firm.id, inviteeEmail, `matching-a-${Math.random()}`, owner.uid,
        otherFirm.id, `matching-b-${Math.random()}`, 'different@example.test', `different-${Math.random()}`,
      ],
    );

    const res = await as(tokenFor({ uid: invitee.uid }))
      .get('/api/invitations/my-pending-member-invites');

    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(2);
    expect(res.body.invites.map((invite: any) => invite.lawFirmId)).toEqual(
      expect.arrayContaining([firm.id, otherFirm.id]),
    );
    expect(res.body.invites.every((invite: any) => !('token' in invite))).toBe(true);
  });
});
