/**
 * Registration lookup and login, driven through the real routes.
 *
 * `auth.service.ts` was at 9%. Everything else in the product sits behind these
 * routes, and they are the ones an unauthenticated caller can reach, so the
 * questions worth asking are about what a bad or absent token gets and what one
 * user can learn about another.
 *
 * The Firebase Admin SDK is replaced by the harness mock, so `tokenFor({ uid })`
 * mints a token the mocked `verifyIdToken` resolves. That makes a spec able to
 * arrive as any caller, including one who has never registered, which is exactly
 * the state `check-user-exists` exists to handle.
 *
 * Note the shape: these routes take the Firebase ID token in the request BODY,
 * not the Authorization header, because the caller may not be a known user yet.
 *
 * `create-user`, `user-type` and the user settings routes are covered in
 * `tests/auth/authServiceUnit.test.ts` and `tests/settings/settings.test.ts`.
 */
import {
  drainEvents,
  createFirm,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { anonymous } from '../support/rows';

let firm: Firm;
let owner: Actor;

const A = '/api/auth';

/** A Firebase uid that has authenticated but has no `users` row yet. */
const strangerUid = () => `fresh-${Math.random().toString(36).slice(2, 10)}`;

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await drainEvents();
});

describe('check-user-exists', () => {
  it('reports a known user as existing, with their user type', async () => {
    const res = await anonymous().post(`${A}/check-user-exists`)
      .send({ token: tokenFor({ uid: owner.uid }) });

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.needsRegistration).toBe(false);
    // The type decides which app the person is sent to. A firm member routed
    // into the client portal sees none of their work.
    expect(res.body.userType).toBe('firm_member');
  });

  it('reports an unknown uid as needing registration', async () => {
    const res = await anonymous().post(`${A}/check-user-exists`)
      .send({ token: tokenFor({ uid: strangerUid() }) });

    // The OAuth path lands here: Firebase has authenticated the person, but the
    // product has never seen them. Answering "exists" would send them to a
    // dashboard with no account behind it.
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
    expect(res.body.needsRegistration).toBe(true);
  });

  it('refuses a garbage token', async () => {
    const res = await anonymous().post(`${A}/check-user-exists`).send({ token: 'garbage' });

    // The token is the only thing proving who the caller is, and this route
    // answers with a real user record. An unverified token reaching the lookup
    // would let anyone read any account by guessing a uid.
    expect(res.status).toBe(401);
  });

  it('refuses a request with no token at all', async () => {
    const res = await anonymous().post(`${A}/check-user-exists`).send({});

    expect(res.status).toBe(400);
  });
});

describe('login', () => {
  it('authenticates a registered user as their OWN record, not the one they name', async () => {
    const uid = strangerUid();
    const created = await as(tokenFor({ uid })).post(`${A}/create-user`).send({
      email: `${uid}@example.test`, name: 'New Person', userType: 'firm_member',
    });
    expect(created.status).toBe(200);

    const res = await anonymous().post(`${A}/login`)
      .send({ token: tokenFor({ uid }), uid: owner.uid });

    // A body field that overrode the token would turn login into a way to fetch
    // any account in the system.
    expect(res.status).toBe(200);
    expect(res.body.userData.id).toBe(uid);
    expect(JSON.stringify(res.body)).not.toContain(owner.uid);
  });

  it('refuses a garbage token', async () => {
    const res = await anonymous().post(`${A}/login`).send({ token: 'garbage' });

    expect(res.status).toBe(401);
  });

  it('refuses a request with no token', async () => {
    const res = await anonymous().post(`${A}/login`).send({});

    expect(res.status).toBe(400);
  });
});
