/**
 * The two "test tooling" surfaces on the admin console: the email-verification
 * whitelist, and the account creator.
 *
 * `POST /test-accounts` is the most powerful endpoint in the product. One
 * request mints a Firebase identity with a password the caller chooses,
 * pre-verified, and attaches it either to a brand new comped firm with every
 * plan limit lifted, or to an EXISTING firm as a member with a role the caller
 * names. Nothing else in the API creates a credential for an account somebody
 * can then log in as. It had no test of any kind.
 *
 * `tests/admin/adminMutations.test.ts` covers the whitelist's add, lowercasing,
 * remove, remove-nothing and malformed-address cases. What it does not cover is
 * adding the same address twice, which matters because `addWhitelist` is an
 * upsert on a `citext` column rather than an insert: a second add is meant to
 * refresh the note, and neither fail nor duplicate the row.
 *
 * The suite's Firebase double has no account-creation methods, deliberately, so
 * that a spec touching them has to say so. These specs install recording stubs
 * for exactly the three the creator uses and restore them afterwards, which also
 * makes "the identity was rolled back" and "no identity was ever created"
 * assertable rather than inferred from a status code.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  seedRole,
  type CallerAgent,
  type Firm,
} from '../support/setupInProcess';
import { platformAdmin } from '../support/rows';

const firebase = require('../../src/shared/database/firebase');

let firm: Firm;
let admin: CallerAgent;
let adminUid: string;

let createUser: jest.Mock;
let getUserByEmail: jest.Mock;
let deleteUser: jest.Mock;
let restoreAuth: () => void;

/** Firebase uids handed out by the stub, so a rollback can be checked by id. */
let mintedUids: string[];

const userRow = async (email: string) => {
  const { rows } = await testPool.query(
    'select id, email::text as email, name, user_type from users where email = $1', [email],
  );
  return rows[0] || null;
};

const whitelistRows = async () => {
  const { rows } = await testPool.query(
    'select email::text as email, note, created_by from email_verification_whitelist order by email',
  );
  return rows;
};

beforeEach(async () => {
  mintedUids = [];
  const authError = (code: string) => Object.assign(new Error(code), { code });

  createUser = jest.fn(async () => {
    const uid = `fb-${randomUUID().slice(0, 8)}`;
    mintedUids.push(uid);
    return { uid };
  });
  // The real SDK throws `auth/user-not-found` rather than returning null, and
  // `adminCreateAccount` reads that code specifically. A stub resolving null
  // would make every "already exists" branch unreachable.
  getUserByEmail = jest.fn(async () => { throw authError('auth/user-not-found'); });
  deleteUser = jest.fn(async () => undefined);

  const previous = {
    createUser: firebase.auth.createUser,
    getUserByEmail: firebase.auth.getUserByEmail,
    deleteUser: firebase.auth.deleteUser,
  };
  Object.assign(firebase.auth, { createUser, getUserByEmail, deleteUser });
  restoreAuth = () => Object.assign(firebase.auth, previous);

  firm = await createFirm({ name: 'Tooling Firm' });
  const seeded = await platformAdmin('Tooling Admin');
  adminUid = seeded.uid;
  admin = seeded.api;

  await drainEvents();
});

afterEach(() => {
  restoreAuth();
});

describe('creating a firm owner account', () => {
  it('mints the identity, the user row, the firm and the membership together', async () => {
    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'firm_owner',
      email: 'Founder@Example.Test',
      password: 'correct horse',
      name: 'Founder Person',
      firmName: 'Brand New Firm',
    });

    expect(res.status).toBe(201);
    const { uid, lawFirmId, password } = res.body.account;
    // The plaintext password comes back on purpose: it is the only copy, and
    // the admin has to hand it to whoever is testing.
    expect(password).toBe('correct horse');
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'founder@example.test',
      // Pre-verified, or the account cannot log in without an inbox.
      emailVerified: true,
    }));

    // Four rows have to exist together. Any one of them missing leaves an
    // account that can sign in and then sees nothing, or a firm nobody owns.
    expect(await userRow('founder@example.test')).toMatchObject({
      id: uid, name: 'Founder Person', user_type: 'firm_member',
    });
    const { rows: firms } = await testPool.query(
      'select name, plan, billing_status from law_firms where id = $1', [lawFirmId],
    );
    expect(firms[0].name).toBe('Brand New Firm');
    // Billing status lives in its own column since migration 0200, which is the
    // one the enforcement code reads; the jsonb keeps the rest of the plan.
    expect(firms[0].billing_status).toBe('comped');
    expect(firms[0].plan).toMatchObject({
      comped: true, unlimitedOverride: true, assignedBy: adminUid,
    });
    const { rows: members } = await testPool.query(
      'select is_owner from members where law_firm_id = $1 and user_id = $2', [lawFirmId, uid],
    );
    expect(members[0].is_owner).toBe(true);
  });
});

describe('creating a member account on an existing firm', () => {
  /**
   * Roles as a real firm has them. The names matter: `listRoles` returns them
   * alphabetically, so `Administrator` is what a "just take the first role"
   * implementation would pick, and `Member` is what the resolver is supposed to.
   * Seeding a set whose first entry already IS the member role would let that
   * mistake pass.
   */
  const seedRoles = async (lawFirmId: string) => {
    const ids: Record<string, string> = {};
    for (const name of ['Owner', 'Paralegal', 'Member', 'Administrator']) {
      ids[name] = await seedRole(lawFirmId, { name, isBuiltIn: true, permissions: ['matters.view'] });
    }
    return ids;
  };

  it('joins the named firm on its member role, not its owner role', async () => {
    const roles = await seedRoles(firm.id);

    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'member',
      email: 'joiner@example.test',
      password: 'hunter22',
      name: 'Joiner Person',
      lawFirmId: firm.id,
    });

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select role_id, is_owner from members where law_firm_id = $1 and user_id = $2',
      [firm.id, res.body.account.uid],
    );
    // The fallback picks "any non-owner role" when there is no role literally
    // named member, so a wrong resolution order hands a throwaway test account
    // the owner role on somebody's firm.
    expect(rows[0].role_id).toBe(roles.Member);
    expect(rows[0].is_owner).toBe(false);
  });

  it('honours an explicit role id over the default', async () => {
    const roles = await seedRoles(firm.id);

    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'member',
      email: 'paralegal@example.test',
      password: 'hunter22',
      name: 'Paralegal Person',
      lawFirmId: firm.id,
      roleId: roles.Paralegal,
    });

    expect(res.status).toBe(201);
    const { rows } = await testPool.query(
      'select role_id from members where law_firm_id = $1 and user_id = $2',
      [firm.id, res.body.account.uid],
    );
    expect(rows[0].role_id).toBe(roles.Paralegal);
  });

  it('refuses a firm that does not exist BEFORE minting an identity', async () => {
    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'member',
      email: 'orphan@example.test',
      password: 'hunter22',
      name: 'Orphan Person',
      lawFirmId: '00000000-0000-4000-8000-000000000000',
    });

    expect(res.status).toBe(404);
    // The order is the whole point. Creating the Firebase identity first and
    // discovering the firm afterwards leaves a live credential for an account
    // with no row behind it, and the email is then taken on the retry.
    expect(createUser).not.toHaveBeenCalled();
    expect(await userRow('orphan@example.test')).toBeNull();
  });

  it('refuses without a firm id at all', async () => {
    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'member', email: 'nofirm@example.test', password: 'hunter22', name: 'No Firm',
    });

    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('a firm with no assignable role rolls BOTH halves of the account back', async () => {
    // `createFirm` seeds no roles, which is also the state of a firm whose roles
    // were all deleted. `resolveMemberRoleId` throws, and it throws AFTER the
    // identity and the users row have been written, so this is the reachable
    // trigger for the rollback path.
    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'member',
      email: 'roleless@example.test',
      password: 'hunter22',
      name: 'Roleless Person',
      lawFirmId: firm.id,
    });

    expect(res.status).toBe(400);
    expect(deleteUser).toHaveBeenCalledWith(mintedUids[0]);
    // The half that used to survive. A leftover `users` row makes the address
    // permanently unusable: the duplicate check at the top of
    // `adminCreateAccount` refuses the retry as "an account already exists" for
    // an identity that no longer does.
    expect(await userRow('roleless@example.test')).toBeNull();
  });

  it('frees the address for a real retry after that rollback', async () => {
    // The consequence, not the mechanism. Asserting the absent row alone would
    // still pass if the duplicate check read something else, so the retry is
    // driven all the way through to a created account.
    const first = await admin.post('/api/admin/test-accounts').send({
      kind: 'member',
      email: 'retryable@example.test',
      password: 'hunter22',
      name: 'Retryable Person',
      lawFirmId: firm.id,
    });
    expect(first.status).toBe(400);

    await seedRoles(firm.id);

    const second = await admin.post('/api/admin/test-accounts').send({
      kind: 'member',
      email: 'retryable@example.test',
      password: 'hunter22',
      name: 'Retryable Person',
      lawFirmId: firm.id,
    });

    expect(second.status).toBe(201);
    expect(await userRow('retryable@example.test')).toMatchObject({ user_type: 'firm_member' });
    const { rows } = await testPool.query(
      'select 1 from members where user_id = $1', [second.body.account.uid],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('creating a client account', () => {
  it('creates a portal user with no firm membership', async () => {
    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'client', email: 'portal@example.test', password: 'hunter22', name: 'Portal Person',
    });

    expect(res.status).toBe(201);
    // `user_type` decides which half of the product this account can reach. A
    // client created as a firm_member would be answered by the firm API rather
    // than the portal.
    expect(await userRow('portal@example.test')).toMatchObject({ user_type: 'client' });
    const { rows } = await testPool.query(
      'select 1 from members where user_id = $1', [res.body.account.uid],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('refusing to reuse an address', () => {
  it('refuses when a users row already holds it, without minting an identity', async () => {
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Existing', 'firm_member')`,
      ['existing-uid', 'taken@example.test'],
    );

    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'client', email: 'taken@example.test', password: 'hunter22', name: 'Second Person',
    });

    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
    // Still exactly one row, and still the original person. A second row for the
    // same address would split one human across two accounts.
    const { rows } = await testPool.query(
      'select id from users where email = $1', ['taken@example.test'],
    );
    expect(rows.map((r: any) => r.id)).toEqual(['existing-uid']);
  });

  it('refuses when only Firebase holds it, so a half-created account cannot be re-minted', async () => {
    getUserByEmail.mockResolvedValue({ uid: 'firebase-only-uid' });

    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'client', email: 'ghost@example.test', password: 'hunter22', name: 'Ghost Person',
    });

    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
    expect(await userRow('ghost@example.test')).toBeNull();
  });

  it('matches the existing address case-insensitively', async () => {
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Existing', 'client')`,
      ['existing-uid', 'mixed@example.test'],
    );

    const res = await admin.post('/api/admin/test-accounts').send({
      kind: 'client', email: 'MiXeD@Example.Test', password: 'hunter22', name: 'Same Person',
    });

    // The address is lowercased before the lookup, and `users.email` is citext.
    // Without both, changing the capitalisation is enough to mint a duplicate.
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe('the verification whitelist', () => {
  it('treats a second add of the same address as a note update, not a duplicate', async () => {
    const first = await admin.post('/api/admin/whitelist')
      .send({ email: 'repeat@example.test', note: 'first pass' });
    const second = await admin.post('/api/admin/whitelist')
      .send({ email: 'repeat@example.test', note: 'second pass' });

    // `addWhitelist` is an upsert. A plain insert would answer the second call
    // with a 500 from the unique index, and the admin would read that as the
    // address not being whitelisted.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await whitelistRows()).toEqual([
      { email: 'repeat@example.test', note: 'second pass', created_by: adminUid },
    ]);
  });

  it('collapses a differently cased duplicate onto the same row', async () => {
    await admin.post('/api/admin/whitelist').send({ email: 'Case@Example.Test' });
    await admin.post('/api/admin/whitelist').send({ email: 'case@EXAMPLE.test', note: 'again' });

    // One row, lowercased. Two rows would mean the whitelist check, which
    // compares a normalised address, honours only one of them.
    const rows = await whitelistRows();
    expect(rows.map((r: any) => r.email)).toEqual(['case@example.test']);
  });

  it('names who added an address when listing', async () => {
    await admin.post('/api/admin/whitelist')
      .send({ email: 'audited@example.test', note: 'for the QA run' });

    const res = await admin.get('/api/admin/whitelist');

    expect(res.status).toBe(200);
    // The list is the only record of who lifted email verification for an
    // address, so the attribution is part of the answer, not decoration.
    expect(res.body.entries).toEqual([expect.objectContaining({
      email: 'audited@example.test',
      note: 'for the QA run',
      createdBy: adminUid,
      createdByEmail: `${adminUid}@example.test`,
    })]);
  });

  it('removes an address and leaves the others', async () => {
    await admin.post('/api/admin/whitelist').send({ email: 'keep@example.test' });
    await admin.post('/api/admin/whitelist').send({ email: 'drop@example.test' });

    const res = await admin.delete('/api/admin/whitelist').send({ email: 'DROP@example.test' });

    expect(res.status).toBe(200);
    // Exactly one address goes, and it is the named one. A delete that lost its
    // predicate would empty the whole whitelist and answer 200, which is how
    // every verification-exempt account would silently stop being exempt. The
    // uppercased form is accepted because the column is `citext`; the service
    // lowercases on top of that.
    expect((await whitelistRows()).map((r: any) => r.email)).toEqual(['keep@example.test']);
  });
});
