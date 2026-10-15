/**
 * The platform admin console.
 *
 * `admin.service.ts` was at 10%. These routes are the one place in the product
 * that deliberately reads ACROSS firms: the console lists every firm, every
 * user and every client on the platform. That makes the gate the whole story.
 * Every other test file in this suite asserts that one firm cannot see another;
 * here the reach is the feature, so what has to be tested is who is allowed it.
 *
 * The gate is `users.is_admin === true` (`requireIsAdmin`), a column on the user
 * row rather than a firm permission. Every refusal of it, including a firm
 * owner's, is owned by `tests/admin/adminAuthorizationMatrix.test.ts`, and
 * revocation of the flag by `tests/admin/adminMutations.test.ts`. This file
 * covers what the console returns to an admin.
 *
 * The list routes take `search`, not `q`. Messaging uses `q`, so the two differ
 * across the API. Passing the wrong one is not an error: the filter is simply
 * ignored and every row comes back, which reads as a broken search rather than a
 * wrong parameter.
 */
import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  as,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firmA: Firm;
let ownerA: Actor;
let firmB: Firm;
let ownerB: Actor;
/** `ownerA`, promoted to platform admin. */
let admin: ReturnType<typeof as>;

const makeAdmin = async (uid: string) => {
  await testPool.query('update users set is_admin = true where id = $1', [uid]);
  return as(tokenFor({ uid }));
};

beforeEach(async () => {
  firmA = await createFirm({ name: 'Firm Alpha' });
  ownerA = await ownerOf(firmA.id);
  await createPersonClient(firmA.id, { name: 'Alpha Client' });

  firmB = await createFirm({ name: 'Firm Beta' });
  ownerB = await ownerOf(firmB.id);
  await createPersonClient(firmB.id, { name: 'Beta Client' });

  admin = await makeAdmin(ownerA.uid);
  await drainEvents();
});

describe('what the console sees', () => {
  it('lists firms from ACROSS the platform', async () => {
    const res = await admin.get('/api/admin/lawfirms');

    // The reach is the feature here, and it is the opposite of every other
    // tenancy assertion in this suite.
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('Firm Alpha');
    expect(body).toContain('Firm Beta');
  });

  it('lists clients from across the platform, naming their firm', async () => {
    const res = await admin.get('/api/admin/clients');

    // Without the firm name a cross-platform client list is unusable: two firms
    // routinely have a client of the same name.
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('Alpha Client');
    expect(body).toContain('Beta Client');
    expect(body).toContain('Firm Alpha');
  });

  it('lists users from across the platform', async () => {
    const res = await admin.get('/api/admin/users');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(ownerB.uid);
  });

  it('serves one firm by id, including a firm the admin is not a member of', async () => {
    const res = await admin.get(`/api/admin/lawfirms/${firmB.id}`);

    // `ownerA` is not a member of Firm Beta. Every other route in the product
    // refuses that; this one is supposed to allow it.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Firm Beta');
  });

  it('reports outbox health', async () => {
    const res = await admin.get('/api/admin/outbox-health');

    // The operational read behind the console's health panel. It has to answer
    // even with the worker disabled, which is the default.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pending');
    expect(res.body.workerEnabled).toBe(false);
  });
});

describe('searching', () => {
  it('filters the firm lookup by name', async () => {
    const res = await admin.get('/api/admin/lawfirms/lookup?search=Alpha');

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('Firm Alpha');
    expect(body).not.toContain('Firm Beta');
  });

  it('returns nothing for a term that matches no firm', async () => {
    const res = await admin.get('/api/admin/lawfirms/lookup?search=Zzzznomatch');

    // The negative half, and the one that catches an ignored filter. A lookup
    // that returned every firm regardless would satisfy the positive case above
    // purely by including the one being searched for.
    expect(res.body.items).toEqual([]);
  });

  it('filters the firm LIST by name too', async () => {
    const res = await admin.get('/api/admin/lawfirms?search=Alpha');

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body.lawFirms ?? []);
    expect(body).toContain('Firm Alpha');
    expect(body).not.toContain('Firm Beta');
  });

  it('CHARACTERISATION: an unknown search parameter is ignored, not refused', async () => {
    const res = await admin.get('/api/admin/lawfirms/lookup?q=Zzzznomatch');

    // These routes take `search`. Messaging takes `q`. Passing `q` here is not
    // an error: it is dropped and every firm comes back, which on screen reads
    // as a search that does not work rather than as a wrong parameter name.
    //
    // Recorded rather than changed, because rejecting unknown query keys is a
    // wider decision than this one route. This test goes red if the parameter
    // name is ever unified.
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Firm Beta');
  });
});
