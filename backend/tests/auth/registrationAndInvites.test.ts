/**
 * The registration gate: which app a person lands in, and which pending
 * invitations that decision consumes.
 *
 * `auth.service.ts` decides `users.user_type`, and every type-gated surface in
 * the product (the firm app, the client portal, messaging, signing) trusts that
 * one column afterwards. Getting it wrong does not look wrong on screen: an
 * outsider registered as `firm_member` simply sees the firm's work.
 *
 * Riding on the same decision is invite auto-processing, and the asymmetry
 * between the three entry points is deliberate rather than incidental:
 *
 *   `complete-registration` (OAuth) and `create-user` (email + password) both
 *   run the invite sweep, because both are the moment a person's account type
 *   is established.
 *
 *   `login` NEVER does. It is reached by a person who is already registered, or
 *   by one whose account is still `pending`, and claiming an invite there would
 *   consume a firm's plan seat for someone who has not yet said what kind of
 *   account they are. Several cases below exist only to pin that.
 *
 * The sweep is also gated on the FIREBASE account's `emailVerified`, not on the
 * ID token's claim: an email/password signup proves possession of a password,
 * not of the address, and an invite claimed there would hand the firm's seat to
 * whoever guessed an invited address first.
 *
 * `tests/users/auth.test.ts` already covers the unauthenticated surface of these
 * routes (bad tokens, missing tokens, reading someone else's record). Nothing
 * here repeats that.
 */
import { randomUUID } from 'crypto';
import { gateMethod } from '../support/gate';
import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  createPersonClient,
  seedRole,
  as,
  tokenFor,
  type Firm,
} from '../support/setupInProcess';
import { anonymous, seedInvite, userRow } from '../support/rows';

const A = '/api/auth';

/**
 * The harness's Firebase mock answers `getUser` with `{ uid, email }` and no
 * `emailVerified` field at all, so every account would silently read as
 * unverified. The service branches on that field, so each case states the
 * account it wants rather than inheriting an omission.
 */
const firebase = require('../../src/shared/database/firebase');
const harnessGetUser = firebase.auth.getUser;

function firebaseAccount(fields: { emailVerified: boolean }) {
  firebase.auth.getUser = async (uid: string) => ({
    uid,
    email: `${uid}@example.test`,
    ...fields,
  });
}

afterEach(() => {
  firebase.auth.getUser = harnessGetUser;
});

/** A Firebase uid that has authenticated but has no `users` row yet. */
const freshUid = () => `fresh-${randomUUID().slice(0, 8)}`;

/** The address `tokenFor` and the Firebase mock both mint for a uid. */
const addressOf = (uid: string) => `${uid}@example.test`;

const memberFirmIds = async (uid: string) => {
  const { rows } = await testPool.query(
    'select law_firm_id from members where user_id = $1 order by law_firm_id',
    [uid],
  );
  return rows.map((r) => r.law_firm_id);
};

const memberRow = async (uid: string, lawFirmId: string) => {
  const { rows } = await testPool.query(
    'select role_id, invited_by from members where user_id = $1 and law_firm_id = $2',
    [uid, lawFirmId],
  );
  return rows[0];
};

const inviteRow = async (id: string) => {
  const { rows } = await testPool.query(
    'select status, accepted_by from invitations where id = $1',
    [id],
  );
  return rows[0];
};

const clientUserId = async (id: string) => {
  const { rows } = await testPool.query('select user_id from clients where id = $1', [id]);
  return rows[0]?.user_id;
};

/** Write a `users` row directly, for the "already registered" starting state. */
async function seedUser(uid: string, userType: string, name = 'Existing Person') {
  const res = await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, $3, $4)`,
    [uid, addressOf(uid), name, userType],
  );
  expect(res.rowCount).toBe(1);
}

let firm: Firm;

beforeEach(async () => {
  firm = await createFirm();
  await drainEvents();
});

describe('the user-type decision', () => {
  it.each(['firm_member', 'client'])('puts a first-time OAuth caller who chooses %s into that app', async (userType) => {
    const uid = freshUid();
    firebaseAccount({ emailVerified: true });

    const res = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType });

    // `user_type` is what every type-gated surface reads afterwards. A
    // registration that stored anything other than what the person chose sends
    // them into the wrong application.
    expect(res.status).toBe(200);
    expect((await userRow(uid)).user_type).toBe(userType);
  });

  it('resolves a pending account to a real type', async () => {
    const uid = freshUid();
    await seedUser(uid, 'pending');
    firebaseAccount({ emailVerified: true });

    const res = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' });

    // `pending` is the one existing value the immutability guard must let
    // through: the OAuth login path creates the row before the person has
    // chosen, so a guard that refused any existing type would strand every
    // OAuth signup at the type picker forever.
    expect(res.status).toBe(200);
    expect((await userRow(uid)).user_type).toBe('firm_member');
  });

  it('refuses to re-register an established client as a firm_member, and leaves the type alone', async () => {
    const uid = freshUid();
    await seedUser(uid, 'client');
    firebaseAccount({ emailVerified: true });

    const res = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' });

    // A self-service flip is a privilege escalation: re-running registration
    // would move a portal client into the firm application, where matters,
    // billing and every other client's records live.
    expect(res.status).toBe(400);
    expect((await userRow(uid)).user_type).toBe('client');
  });

  it('accepts an email that differs from the authenticated one only in letter case', async () => {
    const uid = freshUid();
    firebaseAccount({ emailVerified: true });

    const res = await as(tokenFor({ uid })).post(`${A}/create-user`).send({
      email: addressOf(uid).toUpperCase(),
      name: 'Shouty Address',
      userType: 'firm_member',
    });

    // Addresses are case-insensitive, and a sign-in form that upper-cases the
    // first letter is ordinary. The comparison normalizes both sides, and the
    // row stores the normalized form so later invite matching (which lower-cases
    // the invited address) can find it.
    expect(res.status).toBe(200);
    expect((await userRow(uid)).email).toBe(addressOf(uid));
  });

  it('does not blank a stored name when the same person registers a second time', async () => {
    const uid = freshUid();
    firebaseAccount({ emailVerified: true });
    const first = await as(tokenFor({ uid })).post(`${A}/create-user`).send({
      email: addressOf(uid), name: 'Original Name', userType: 'firm_member',
    });
    expect(first.status).toBe(200);

    const res = await as(tokenFor({ uid })).post(`${A}/create-user`).send({
      email: addressOf(uid), userType: 'firm_member',
    });

    // The upsert coalesces: a second registration that omits the name (the
    // frontend does not resend it) must keep the stored one rather than
    // overwrite it with the empty string it computed.
    expect(res.status).toBe(200);
    expect((await userRow(uid)).name).toBe('Original Name');
  });
});

describe('member invites on registration', () => {
  it('leaves the invite pending if the firm is deleted after the registration batch read', async () => {
    const uid = freshUid();
    await seedUser(uid, 'pending');
    const inviteId = await seedInvite({ lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member' });
    firebaseAccount({ emailVerified: true });
    const usersRepo = require('../../src/modules/users/users.repository');
    const gate = gateMethod(usersRepo, 'lockForMembershipChange');
    const registration = anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' }).then(res => res);
    try {
      await gate.arrived(1);
      expect(gate.waiting()).toBe(1);
      await testPool.query('update law_firms set pending_deletion_at = now() where id = $1', [firm.id]);
      gate.open();
      expect((await registration).status).toBe(200);
      expect(await memberFirmIds(uid)).toEqual([]);
      expect((await inviteRow(inviteId)).status).toBe('pending');
    } finally {
      gate.restore();
      await registration;
    }
  });
  it('rechecks the membership cap when a direct invitation joins another firm during registration', async () => {
    const uid = freshUid();
    await seedUser(uid, 'pending');
    const inviteId = await seedInvite({ lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member' });
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    const roleId = await seedRole(otherFirm.id, { permissions: ['matters.view'] });
    firebaseAccount({ emailVerified: true });
    const usersRepo = require('../../src/modules/users/users.repository');
    const original = usersRepo.getLawFirmIdsForUser;
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = false;
    const gate = jest.spyOn(usersRepo, 'getLawFirmIdsForUser').mockImplementation(async (...args: any[]) => {
      const ids = await original.apply(usersRepo, args);
      if (args[0] === uid && !args[1] && !intercepted) {
        intercepted = true;
        reached();
        await resume;
      }
      return ids;
    });
    const registration = anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' }).then((res) => res);
    try {
      await paused;
      const directJoin = await otherOwner.api.post(`/api/lawfirms/${otherFirm.id}/invitations/invite-member`)
        .send({ email: addressOf(uid), roleId });
      expect(directJoin.status).toBe(200);
      expect(directJoin.body.status).toBe('added');
      release();
      expect((await registration).status).toBe(200);
      expect(await memberFirmIds(uid)).toEqual([otherFirm.id]);
      expect((await inviteRow(inviteId)).status).toBe('pending');
    } finally {
      release();
      await registration;
      gate.mockRestore();
    }
  });

  it('claims a pending member invite when an OAuth registration completes', async () => {
    const uid = freshUid();
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member', roleId,
    });
    firebaseAccount({ emailVerified: true });

    const res = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' });
    await drainEvents();

    // The invite is the whole onboarding path for a firm's staff. If it is not
    // consumed here the person registers into an account with no firm, and the
    // invite email they were sent has already been spent.
    expect(res.status).toBe(200);
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
    expect((await memberRow(uid, firm.id)).role_id).toBe(roleId);
    expect((await inviteRow(inviteId)).status).toBe('accepted');
    expect((await inviteRow(inviteId)).accepted_by).toBe(uid);
  });

  it('claims a pending member invite when an email/password registration completes', async () => {
    const uid = freshUid();
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member', roleId,
    });
    firebaseAccount({ emailVerified: true });

    const res = await as(tokenFor({ uid })).post(`${A}/create-user`).send({
      email: addressOf(uid), name: 'Invited Staffer', userType: 'firm_member',
    });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
    expect((await inviteRow(inviteId)).status).toBe('accepted');
  });

  it('does NOT claim a member invite on a first or a repeat login by an unregistered person', async () => {
    const uid = freshUid();
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member',
    });
    firebaseAccount({ emailVerified: true });

    // The first login takes the "no users row yet" branch and creates the
    // pending shell account.
    const first = await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid }) });
    // The second takes the separate "exists but still pending" branch, which is
    // where a person who abandoned the type picker and came back lands.
    const second = await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid }) });
    await drainEvents();

    // Neither branch may consume the invite. Doing so would spend a firm's plan
    // seat on someone who has not yet said whether they are staff or a client,
    // and would put them on the firm's roster without ever choosing a type.
    expect(first.status).toBe(200);
    expect(first.body.needsRegistration).toBe(true);
    expect(second.body.needsRegistration).toBe(true);
    expect(await memberFirmIds(uid)).toEqual([]);
    expect((await inviteRow(inviteId)).status).toBe('pending');

    // Proving the invite was claimable the whole time, so the absence above is
    // the login path declining to act rather than an unusable fixture.
    const registered = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' });
    await drainEvents();

    expect(registered.status).toBe(200);
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
    expect((await inviteRow(inviteId)).status).toBe('accepted');
  });

  it('does NOT join a fully registered member to a firm when they log in', async () => {
    const uid = freshUid();
    await seedUser(uid, 'firm_member');
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member',
    });
    firebaseAccount({ emailVerified: true });

    const loggedIn = await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid }) });
    await drainEvents();

    // The third login branch: an established account signing in. An invite that
    // arrived after registration is claimed through the explicit accept flow,
    // which checks the token and the address. Sweeping on every login would
    // instead add the person to any firm that had typed their address, without
    // them ever seeing an invitation.
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.body.needsRegistration).toBe(false);
    expect(await memberFirmIds(uid)).toEqual([]);
    expect((await inviteRow(inviteId)).status).toBe('pending');

    // The same account, in the same verified state, does claim it through the
    // registration route, so the invite was never unclaimable.
    const registered = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' });
    await drainEvents();

    expect(registered.status).toBe(200);
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
    expect((await inviteRow(inviteId)).status).toBe('accepted');
  });

  it('does NOT claim a member invite for an unverified Firebase account', async () => {
    const uid = freshUid();
    const inviteId = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member',
    });
    firebaseAccount({ emailVerified: false });

    const res = await as(tokenFor({ uid })).post(`${A}/create-user`).send({
      email: addressOf(uid), name: 'Unproven Owner', userType: 'firm_member',
    });
    await drainEvents();

    // The registration itself succeeds, which is what makes the absence below
    // meaningful: the request ran to completion and wrote the account, and only
    // the invite sweep was withheld.
    expect(res.status).toBe(200);
    expect((await userRow(uid)).user_type).toBe('firm_member');
    expect(await memberFirmIds(uid)).toEqual([]);
    expect((await inviteRow(inviteId)).status).toBe('pending');

    // Email/password signup proves a password, not ownership of the address.
    // Once Firebase says the address is verified, the same call claims it.
    firebaseAccount({ emailVerified: true });
    const verified = await as(tokenFor({ uid })).post(`${A}/create-user`).send({
      email: addressOf(uid), name: 'Unproven Owner', userType: 'firm_member',
    });
    await drainEvents();

    expect(verified.status).toBe(200);
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
    expect((await inviteRow(inviteId)).status).toBe('accepted');
  });

  it('skips an expired member invite while claiming a live one in the same sweep', async () => {
    const uid = freshUid();
    const staleFirm = await createFirm();
    const staleInvite = await seedInvite({
      lawFirmId: staleFirm.id,
      email: addressOf(uid),
      inviteType: 'member',
      expiresIn: '-1 hour',
    });
    const liveInvite = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member',
    });
    firebaseAccount({ emailVerified: true });

    const res = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' });
    await drainEvents();

    // The live invite proves the sweep ran. An expiry a firm set is the only
    // thing that takes an unaccepted invite out of circulation, so an expired
    // one that still joined would make revocation-by-expiry meaningless.
    expect(res.status).toBe(200);
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
    expect((await inviteRow(liveInvite)).status).toBe('accepted');
    expect((await inviteRow(staleInvite)).status).toBe('pending');
  });
});

describe('invites match the account type being registered', () => {
  it('registering as a firm_member consumes the member invite and leaves a client invite pending', async () => {
    const uid = freshUid();
    const portalFirm = await createFirm();
    const placeholder = await createPersonClient(portalFirm.id, { email: addressOf(uid) });
    const clientInvite = await seedInvite({
      lawFirmId: portalFirm.id, email: addressOf(uid), inviteType: 'client',
    });
    const memberInvite = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member',
    });
    firebaseAccount({ emailVerified: true });

    const res = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'firm_member' });
    await drainEvents();

    // The member invite landing proves the sweep ran in this request. The two
    // invite types are separate sweeps on purpose: an address invited to a
    // portal must not gain firm membership, and the reverse, whichever type the
    // person picks at registration.
    expect(res.status).toBe(200);
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
    expect((await inviteRow(memberInvite)).status).toBe('accepted');
    expect((await inviteRow(clientInvite)).status).toBe('pending');
    expect(await clientUserId(placeholder.id)).toBeNull();
  });

  it('registering as a client links the client record and leaves a member invite pending', async () => {
    const uid = freshUid();
    const portalFirm = await createFirm();
    const placeholder = await createPersonClient(portalFirm.id, { email: addressOf(uid) });
    const clientInvite = await seedInvite({
      lawFirmId: portalFirm.id, email: addressOf(uid), inviteType: 'client',
    });
    const memberInvite = await seedInvite({
      lawFirmId: firm.id, email: addressOf(uid), inviteType: 'member',
    });
    firebaseAccount({ emailVerified: true });

    const res = await anonymous().post(`${A}/complete-registration`)
      .send({ token: tokenFor({ uid }), userType: 'client' });
    await drainEvents();

    // The adopted client record proves the sweep ran. The member invite staying
    // pending is the half that matters: an outsider who registers for the portal
    // must not end up on a firm's roster with a staff member's reach.
    expect(res.status).toBe(200);
    expect(await clientUserId(placeholder.id)).toBe(uid);
    expect((await inviteRow(clientInvite)).status).toBe('accepted');
    expect((await inviteRow(memberInvite)).status).toBe('pending');
    expect(await memberFirmIds(uid)).toEqual([]);
  });
});
