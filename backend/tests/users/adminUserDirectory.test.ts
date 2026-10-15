/**
 * The platform admin console's user directory, in its paged form.
 *
 * `GET /api/admin/users` with no `limit` and no `search` returns the capped
 * export (`tests/users/admin.test.ts` covers that). Any `limit` or `search`
 * switches to the directory read, which filters, sorts and pages in SQL, joins
 * every firm a user belongs to, and attaches their most recent sign-in. The
 * admin uses it to find one account among every firm's, so a filter that
 * silently widens, or a total that disagrees with the rows, sends them to the
 * wrong person.
 *
 * The suite truncates before every case, so each case knows exactly which
 * accounts exist: the admin plus the ones it seeds.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
  ownerOf,
  as,
  tokenFor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let adminUid: string;
let admin: ReturnType<typeof as>;

beforeEach(async () => {
  firm = await createFirm({ name: 'Beacon Legal' });
  adminUid = (await ownerOf(firm.id)).uid;
  await testPool.query(
    `update users set is_admin = true, name = 'Platform Admin', created_at = '2020-01-01T00:00:00Z' where id = $1`,
    [adminUid],
  );
  admin = as(tokenFor({ uid: adminUid }));
});

/** A users row with a known name, type and signup instant. */
async function seedUser(fields: { name: string; userType: string; createdAt: string; email?: string }) {
  const uid = `u-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    'insert into users (id, email, name, user_type, created_at) values ($1, $2, $3, $4, $5)',
    [uid, fields.email ?? `${uid}@example.test`, fields.name, fields.userType, fields.createdAt],
  );
  return uid;
}

const names = (res: { body: { users: { name: string }[] } }) => res.body.users.map((u) => u.name);

describe('searching', () => {
  it('matches a name or an address without regard to case', async () => {
    await seedUser({ name: 'Rosa Diaz', userType: 'client', createdAt: '2025-01-01T00:00:00Z' });
    await seedUser({ name: 'Amy Santiago', userType: 'client', createdAt: '2025-01-02T00:00:00Z', email: 'rosa.backup@example.test' });
    await seedUser({ name: 'Jake Peralta', userType: 'client', createdAt: '2025-01-03T00:00:00Z' });

    const res = await admin.get('/api/admin/users?search=ROSA');

    expect(res.status).toBe(200);
    // Newest signup first when no order is asked for.
    expect(names(res)).toEqual(['Amy Santiago', 'Rosa Diaz']);
    // No limit was sent, so every match comes back and the total agrees.
    expect(res.body.totalItems).toBe(2);
  });

  it('treats a wildcard character in the term as literal text', async () => {
    await seedUser({ name: 'Discount 100% Off', userType: 'client', createdAt: '2025-01-01T00:00:00Z' });
    await seedUser({ name: 'Plain Person', userType: 'client', createdAt: '2025-01-02T00:00:00Z' });

    const res = await admin.get(`/api/admin/users?search=${encodeURIComponent('%')}`);

    // An unescaped `%` would match every account on the platform.
    expect(names(res)).toEqual(['Discount 100% Off']);
  });

  it('finds platform admins by the word "admin"', async () => {
    await seedUser({ name: 'Ordinary Person', userType: 'firm_member', createdAt: '2025-01-01T00:00:00Z' });

    const res = await admin.get('/api/admin/users?search=admin');

    expect(res.body.users.map((u: any) => u.uid)).toEqual([adminUid]);
    expect(res.body.users[0].isAdmin).toBe(true);
  });
});

describe('filtering', () => {
  it('narrows to one account type', async () => {
    await seedUser({ name: 'Pending One', userType: 'pending', createdAt: '2025-01-01T00:00:00Z' });
    await seedUser({ name: 'Client One', userType: 'client', createdAt: '2025-01-02T00:00:00Z' });

    const res = await admin.get('/api/admin/users?limit=50&userType=pending');

    expect(names(res)).toEqual(['Pending One']);
    expect(res.body.totalItems).toBe(1);
  });

  it('narrows to accounts that are not platform admins', async () => {
    await seedUser({ name: 'Staffer', userType: 'firm_member', createdAt: '2025-01-01T00:00:00Z' });

    const res = await admin.get('/api/admin/users?limit=50&isAdmin=false');

    expect(names(res)).toEqual(['Staffer']);
  });

  it('narrows to the members and clients of one firm, and names their firms', async () => {
    const other = await createFirm({ name: 'Other Office' });
    const staffer = await createFirmMember(firm.id, { isOwner: false, permissions: ['matters.view'], name: 'Firm Staffer' });
    const clientUid = await seedUser({ name: 'Firm Client', userType: 'client', createdAt: '2025-02-01T00:00:00Z' });
    await createPersonClient(firm.id, { userId: clientUid, email: `${clientUid}@example.test` });
    await ownerOf(other.id);
    await seedUser({ name: 'Unattached', userType: 'client', createdAt: '2025-03-01T00:00:00Z' });

    const res = await admin.get(`/api/admin/users?limit=50&lawFirmId=${firm.id}&sortBy=name&order=asc`);

    expect(res.status).toBe(200);
    const byUid = Object.fromEntries(res.body.users.map((u: any) => [u.uid, u]));
    expect(Object.keys(byUid).sort()).toEqual([adminUid, clientUid, staffer.uid].sort());
    expect(byUid[staffer.uid].memberFirms).toEqual([
      expect.objectContaining({ id: firm.id, name: 'Beacon Legal', isOwner: false }),
    ]);
    expect(byUid[staffer.uid].clientFirms).toEqual([]);
    expect(byUid[clientUid].clientFirms).toEqual([{ id: firm.id, name: 'Beacon Legal' }]);
    expect(byUid[clientUid].memberFirms).toEqual([]);
  });
});

describe('ordering and paging', () => {
  beforeEach(async () => {
    await seedUser({ name: 'Charlie', userType: 'client', createdAt: '2025-01-03T00:00:00Z', email: 'a@example.test' });
    await seedUser({ name: 'Alpha', userType: 'client', createdAt: '2025-01-01T00:00:00Z', email: 'c@example.test' });
    await seedUser({ name: 'Bravo', userType: 'client', createdAt: '2025-01-02T00:00:00Z', email: 'b@example.test' });
  });

  it('sorts by a single column in the direction asked', async () => {
    const res = await admin.get('/api/admin/users?limit=50&userType=client&sortBy=email&order=asc');

    expect(names(res)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts by the multi-column model, which takes precedence', async () => {
    const res = await admin.get('/api/admin/users?limit=50&userType=client&sort=name:desc&sortBy=email&order=asc');

    expect(names(res)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('pages the window and reports the total across every page', async () => {
    const res = await admin.get('/api/admin/users?limit=2&offset=2&sortBy=createdAt&order=asc');

    // Four accounts in all: the admin (2020) and the three seeded above.
    expect(names(res)).toEqual(['Bravo', 'Charlie']);
    expect(res.body.totalItems).toBe(4);
  });

  it('still reports the true total on a page past the end', async () => {
    const res = await admin.get('/api/admin/users?limit=2&offset=10&userType=client');

    // The total rides on each row, so an empty page has to count separately or
    // it would claim there is nothing to page back to.
    expect(res.body.users).toEqual([]);
    expect(res.body.totalItems).toBe(3);
  });

  it('turns a page number into the matching window', async () => {
    const res = await admin.get('/api/admin/users?limit=1&page=2&userType=client&sortBy=name&order=asc');

    expect(names(res)).toEqual(['Bravo']);
  });

  it('rejects a sort field outside the whitelist rather than ignoring it', async () => {
    const res = await admin.get('/api/admin/users?limit=5&sort=password:asc');

    expect(res.status).toBe(400);
  });
});

describe('what each row carries', () => {
  it('reports the newest recorded sign-in and its provider', async () => {
    const uid = await seedUser({ name: 'Signs In', userType: 'firm_member', createdAt: '2025-01-01T00:00:00Z' });
    await testPool.query(
      `insert into audit_events (actor_uid, action, metadata, created_at) values
         ($1, 'auth.login', '{"provider":"password"}', '2025-05-01T10:00:00Z'),
         ($1, 'auth.login', '{"provider":"google.com"}', '2025-05-02T10:00:00Z'),
         ($1, 'matter.viewed', '{}', '2025-05-03T10:00:00Z')`,
      [uid],
    );

    const res = await admin.get('/api/admin/users?search=Signs');

    // The later event that is not a login must not count as one.
    expect(res.body.users).toEqual([expect.objectContaining({
      uid,
      lastLoginAt: '2025-05-02T10:00:00.000Z',
      lastLoginProvider: 'google.com',
    })]);
  });

  it('reports null for an account with no recorded sign-in', async () => {
    await seedUser({ name: 'Never Seen', userType: 'client', createdAt: '2025-01-01T00:00:00Z' });

    const res = await admin.get('/api/admin/users?search=Never');

    expect(res.body.users[0]).toMatchObject({ lastLoginAt: null, lastLoginProvider: null });
  });

  it('carries unfiltered platform counts alongside a filtered page', async () => {
    await seedUser({ name: 'C1', userType: 'client', createdAt: '2020-02-01T00:00:00Z' });
    await seedUser({ name: 'P1', userType: 'pending', createdAt: '2020-02-01T00:00:00Z' });
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Brand New', 'client')`,
      [`new-${randomUUID().slice(0, 8)}`, `new-${randomUUID().slice(0, 8)}@example.test`],
    );

    const res = await admin.get('/api/admin/users?limit=1&userType=pending');

    expect(res.body.totalItems).toBe(1);
    // The stat cards describe the whole platform, not the current filter.
    expect(res.body.stats).toEqual({
      total: 4,
      clients: 2,
      firmMembers: 1,
      pending: 1,
      admins: 1,
      new24h: 1,
      new7d: 1,
      new30d: 1,
    });
  });
});
