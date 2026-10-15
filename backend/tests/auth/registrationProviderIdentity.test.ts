/**
 * What registration and login make of the identity Firebase hands them, and
 * the member-invite sweep's refusal paths.
 *
 * An OAuth account does not always carry an email or a display name on the ID
 * token: a Microsoft work account can put both only on its provider entry, and
 * some accounts have no address at all. The `users` row written for them is
 * what the whole app shows as that person's name, and its email is what later
 * invite matching compares against, so where each value came from matters.
 *
 * The sweep that claims pending member invites on registration skips an invite
 * rather than failing when the person is already in that firm, already at the
 * per-person firm cap, or when the firm is out of seats. A skipped invite must
 * stay pending so it can still be claimed once the obstacle is gone, which is
 * what the two-pass cases below prove.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  seedRole,
  setFirmPlan,
  as,
  tokenFor,
  type Firm,
} from '../support/setupInProcess';

const A = '/api/auth';
const anonymous = () => as('');
const firebase = require('../../src/shared/database/firebase');
const harnessGetUser = firebase.auth.getUser;

afterEach(() => {
  firebase.auth.getUser = harnessGetUser;
});

/** Replace the Firebase account record the service reads with `getUser`. */
function firebaseRecord(record: Record<string, unknown>) {
  firebase.auth.getUser = async (uid: string) => ({ uid, ...record });
}

const freshUid = () => `fresh-${randomUUID().slice(0, 8)}`;
const addressOf = (uid: string) => `${uid}@example.test`;

async function userRow(uid: string) {
  const { rows } = await testPool.query(
    'select email, name, user_type, preferences from users where id = $1',
    [uid],
  );
  return rows[0] || null;
}

async function tokenRow(uid: string, provider: 'google' | 'microsoft') {
  const { rows } = await testPool.query(
    'select access_token, refresh_token from user_oauth_tokens where user_id = $1 and provider = $2',
    [uid, provider],
  );
  return rows[0] || null;
}

async function seedInvite(lawFirmId: string, email: string, inviteType: 'member' | 'client', roleId: string | null = null) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into invitations (id, law_firm_id, email, invite_type, role_id, token, status, expires_at)
     values ($1, $2, $3, $4, $5, $6, 'pending', now() + interval '7 days')`,
    [id, lawFirmId, email, inviteType, roleId, `token-${id}`],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function inviteRow(id: string) {
  const { rows } = await testPool.query('select status, accepted_by from invitations where id = $1', [id]);
  return rows[0];
}

async function memberFirmIds(uid: string) {
  const { rows } = await testPool.query(
    'select law_firm_id from members where user_id = $1 order by law_firm_id',
    [uid],
  );
  return rows.map((r) => r.law_firm_id);
}

describe('identity taken from the provider entry', () => {
  it('uses the Microsoft provider address and name when the token carries neither', async () => {
    const uid = freshUid();
    firebaseRecord({
      emailVerified: false,
      providerData: [
        { providerId: 'google.com', email: 'google@example.test', displayName: 'Google Name' },
        { providerId: 'microsoft.com', email: 'ms-person@example.test', displayName: 'Microsoft Name' },
      ],
    });

    const res = await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid, email: undefined }) });

    // Microsoft wins over Google when both are linked, for both values.
    expect(res.status).toBe(200);
    expect(res.body.needsRegistration).toBe(true);
    expect(await userRow(uid)).toMatchObject({
      email: 'ms-person@example.test',
      name: 'Microsoft Name',
      user_type: 'pending',
    });
  });

  it('falls back to the Google provider entry when there is no Microsoft one', async () => {
    const uid = freshUid();
    firebaseRecord({
      emailVerified: false,
      providerData: [{ providerId: 'google.com', email: 'g-person@example.test', displayName: 'Google Person' }],
    });

    await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid, email: undefined }) });

    expect(await userRow(uid)).toMatchObject({ email: 'g-person@example.test', name: 'Google Person' });
    // Signing in with Google is not a calendar connection, so nothing about
    // one is recorded from the Firebase provider list.
    expect((await userRow(uid)).preferences?.loggedInWithGoogle).toBeUndefined();
  });

  it('stores a marked placeholder address and a generic name when no address exists anywhere', async () => {
    const uid = freshUid();
    firebaseRecord({ emailVerified: false, providerData: [{ providerId: 'apple.com' }] });

    const res = await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid, email: undefined }) });

    // `users.email` is NOT NULL. The placeholder is visibly not a real address
    // and is scoped to the uid, so it can never collide with or match an invite.
    expect(res.status).toBe(200);
    expect(await userRow(uid)).toMatchObject({
      email: `no-email+${uid}@users.noreply.paralegix`,
      name: 'Unknown User',
    });
  });

  it('names a person after their address when no display name exists', async () => {
    const uid = freshUid();
    firebaseRecord({ emailVerified: false, email: 'jordan.lee@example.test' });

    await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid, email: undefined }) });

    expect(await userRow(uid)).toMatchObject({ email: 'jordan.lee@example.test', name: 'jordan.lee' });
  });
});

async function plantConnectedGoogle(uid: string) {
  const res = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, scope, meta, is_sync_to_provider)
     values ($1, 'google', 'old-a', 'old-r', 'https://www.googleapis.com/auth/calendar', '{"accountId":"g-sub"}'::jsonb, true)`,
    [uid],
  );
  expect(res.rowCount).toBe(1);
}

async function fullGrantRow(uid: string, provider: 'google' | 'microsoft') {
  const { rows } = await testPool.query(
    'select * from user_oauth_tokens where user_id = $1 and provider = $2', [uid, provider],
  );
  return rows[0] || null;
}

/**
 * Social sign-in is identity only. The popup's access token has no refresh
 * token and may belong to a different provider account from the connected
 * calendar, so a body that still carries one is accepted (old clients keep
 * working) and ignored.
 */
describe('popup provider tokens', () => {
  it('ignores a Microsoft popup token on a first login', async () => {
    const uid = freshUid();
    firebaseRecord({ emailVerified: false, email: addressOf(uid), providerData: [] });

    const res = await anonymous().post(`${A}/login`).send({
      token: tokenFor({ uid }),
      microsoftAccessToken: 'ms-popup-access',
      microsoftRefreshToken: 'ms-popup-refresh',
    });

    expect(res.status).toBe(200);
    expect(res.body.needsRegistration).toBe(true);
    expect(await tokenRow(uid, 'microsoft')).toBeNull();
    expect((await userRow(uid)).preferences?.loggedInWithMicrosoft).toBeUndefined();
  });

  it('ignores both popup tokens on registration', async () => {
    const uid = freshUid();
    firebaseRecord({ emailVerified: false, email: addressOf(uid), providerData: [] });

    const res = await anonymous().post(`${A}/complete-registration`).send({
      token: tokenFor({ uid }),
      userType: 'firm_member',
      googleAccessToken: 'g-popup-access',
      microsoftAccessToken: 'ms-popup-access',
    });

    expect(res.status).toBe(200);
    expect(res.body.userData).toMatchObject({ id: uid, userType: 'firm_member' });
    expect(await tokenRow(uid, 'google')).toBeNull();
    expect(await tokenRow(uid, 'microsoft')).toBeNull();
    expect((await userRow(uid)).preferences?.loggedInWithGoogle).toBeUndefined();
  });

  it('ignores a popup token for a pending account that logs in again', async () => {
    const uid = freshUid();
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Pending Person', 'pending')`,
      [uid, addressOf(uid)],
    );

    const res = await anonymous().post(`${A}/login`).send({
      token: tokenFor({ uid }),
      googleAccessToken: 'g-popup-access',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'User needs to complete registration', needsRegistration: true });
    expect(await tokenRow(uid, 'google')).toBeNull();
  });
});

describe('a registered person logging in', () => {
  let firm: Firm;
  beforeEach(async () => {
    firm = await createFirm();
  });

  it('a first login no longer records a calendar connection from the linked provider', async () => {
    const owner = await ownerOf(firm.id);
    firebaseRecord({ emailVerified: true, providerData: [{ providerId: 'google.com' }] });

    const res = await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid: owner.uid }) });

    expect(res.status).toBe(200);
    expect(res.body.needsRegistration).toBe(false);
    const settings = await owner.api.get('/api/settings/user');
    expect(settings.body.preferences).toMatchObject({ loggedInWithGoogle: false, googleCalendarState: 'disconnected' });
    expect((await userRow(owner.uid)).preferences?.loggedInWithGoogle).toBeUndefined();
  });

  it('leaves the provider flags alone once they are seeded, so a disconnect sticks', async () => {
    const owner = await ownerOf(firm.id);
    await testPool.query(
      `update users set preferences = '{"loggedInWithGoogle": false, "loggedInWithMicrosoft": false}'::jsonb
        where id = $1`,
      [owner.uid],
    );
    firebaseRecord({ emailVerified: true, providerData: [{ providerId: 'google.com' }] });

    const res = await anonymous().post(`${A}/login`).send({ token: tokenFor({ uid: owner.uid }) });

    // The person turned Google off in settings. Their Firebase account is still
    // Google-linked, and re-deriving the flag from it on every login would turn
    // the integration back on behind their back.
    expect(res.status).toBe(200);
    expect((await userRow(owner.uid)).preferences.loggedInWithGoogle).toBe(false);
  });

  it('a Google sign-in leaves a connected calendar row untouched', async () => {
    const owner = await ownerOf(firm.id);
    await plantConnectedGoogle(owner.uid);
    const before = await fullGrantRow(owner.uid, 'google');
    firebaseRecord({ emailVerified: true, providerData: [{ providerId: 'google.com' }] });

    const res = await anonymous().post(`${A}/login`).send({
      token: tokenFor({ uid: owner.uid }),
      googleAccessToken: 'popup-a',
      googleRefreshToken: 'popup-r',
    });

    // A popup token from a different Google account would otherwise point the
    // calendar sync at that account's calendar until the next refresh.
    expect(res.status).toBe(200);
    expect(await fullGrantRow(owner.uid, 'google')).toEqual(before);
  });

  it('a Google sign-in with no calendar connection creates no token row', async () => {
    const owner = await ownerOf(firm.id);
    firebaseRecord({ emailVerified: true, providerData: [{ providerId: 'google.com' }] });

    const res = await anonymous().post(`${A}/login`).send({
      token: tokenFor({ uid: owner.uid }),
      googleAccessToken: 'popup-a',
      microsoftAccessToken: 'popup-ms',
    });

    expect(res.status).toBe(200);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
    expect(await tokenRow(owner.uid, 'microsoft')).toBeNull();
  });
});

describe('checking whether an account exists', () => {
  it('reports a pending account as needing registration, with its stored address', async () => {
    const uid = freshUid();
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, 'stored@example.test', 'P', 'pending')`,
      [uid],
    );

    const res = await anonymous().post(`${A}/check-user-exists`).send({ token: tokenFor({ uid }) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true, needsRegistration: true, uid, email: 'stored@example.test' });
  });
});

describe('the member-invite sweep on registration', () => {
  let firm: Firm;
  beforeEach(async () => {
    firm = await createFirm({ name: 'Inviting Firm' });
    firebaseRecord({ emailVerified: true });
  });

  /** Registration by email and password, the path that claims invites. */
  const register = (uid: string, userType = 'firm_member') => as(tokenFor({ uid }))
    .post(`${A}/create-user`)
    .send({ email: addressOf(uid), name: 'Invitee', userType });

  it('closes out an invite to a firm the person is already in, without a second membership', async () => {
    const member = await createFirmMember(firm.id, { isOwner: false, permissions: ['matters.view'] });
    const inviteId = await seedInvite(firm.id, addressOf(member.uid), 'member');

    const res = await register(member.uid);
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await inviteRow(inviteId)).toEqual({ status: 'accepted', accepted_by: member.uid });
    expect(await memberFirmIds(member.uid)).toEqual([firm.id]);
  });

  it('leaves an invite pending while the person is at the firm cap, and claims it once they are not', async () => {
    const homeFirm = await createFirm({ name: 'Home Firm' });
    const member = await createFirmMember(homeFirm.id, { isOwner: false, permissions: ['matters.view'] });
    const roleId = await seedRole(firm.id, { permissions: ['matters.view'] });
    const inviteId = await seedInvite(firm.id, addressOf(member.uid), 'member', roleId);

    const blocked = await register(member.uid);
    await drainEvents();

    expect(blocked.status).toBe(200);
    expect(await inviteRow(inviteId)).toEqual({ status: 'pending', accepted_by: null });
    expect(await memberFirmIds(member.uid)).toEqual([homeFirm.id]);

    await testPool.query('delete from members where user_id = $1', [member.uid]);
    const retried = await register(member.uid);
    await drainEvents();

    // The same request now joins, so it was the cap and nothing else that held
    // the invite back the first time.
    expect(retried.status).toBe(200);
    expect(await inviteRow(inviteId)).toEqual({ status: 'accepted', accepted_by: member.uid });
    expect(await memberFirmIds(member.uid)).toEqual([firm.id]);
  });

  it('leaves an invite pending while the firm is out of seats, and claims it once one frees up', async () => {
    await ownerOf(firm.id);
    await setFirmPlan(firm.id, { limitOverrides: { maxMembers: 1 } });
    const uid = freshUid();
    const inviteId = await seedInvite(firm.id, addressOf(uid), 'member');

    const blocked = await register(uid);
    await drainEvents();

    expect(blocked.status).toBe(200);
    expect(await inviteRow(inviteId)).toEqual({ status: 'pending', accepted_by: null });
    expect(await memberFirmIds(uid)).toEqual([]);

    await setFirmPlan(firm.id, { limitOverrides: { maxMembers: 2 } });
    const retried = await register(uid);
    await drainEvents();

    expect(retried.status).toBe(200);
    expect(await inviteRow(inviteId)).toEqual({ status: 'accepted', accepted_by: uid });
    expect(await memberFirmIds(uid)).toEqual([firm.id]);
  });

  it('claims a client invite when a verified person registers as a client by email and password', async () => {
    const uid = freshUid();
    const placeholder = await createPersonClient(firm.id, { email: addressOf(uid) });
    const inviteId = await seedInvite(firm.id, addressOf(uid), 'client');

    const res = await register(uid, 'client');
    await drainEvents();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'User data stored successfully', userId: uid });
    expect(await inviteRow(inviteId)).toEqual({ status: 'accepted', accepted_by: uid });
    const { rows } = await testPool.query('select user_id from clients where id = $1', [placeholder.id]);
    expect(rows[0].user_id).toBe(uid);
    expect(await memberFirmIds(uid)).toEqual([]);
  });
});
