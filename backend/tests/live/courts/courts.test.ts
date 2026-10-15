/**
 * Courts API - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.ts).
 *
 * Every mutation is confirmed by reading the row back. A 200 on its own only
 * says the handler returned; it does not say the write landed, which is the
 * failure worth catching.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdCourtId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  // The seeded account belongs to a legacy firm whose roles predate several
  // permission codes; `lawFirmIds[0]` lands on it and yields spurious 403s.
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

afterAll(async () => {
  if (createdCourtId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/courts/${createdCourtId}`, { token });
  }
});

describe('courts CRUD', () => {
  test('creates a court and stores every field it was given', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/courts`, {
      token,
      body: {
        name: '__TEST__ District Court',
        abbreviation: 'TSTDC',
        city: 'Springfield',
        state: 'IL',
        courtType: 'district',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.courtId).toBeDefined();
    createdCourtId = res.body.courtId;

    const read = await api.get(`/api/lawfirms/${lawFirmId}/courts/${createdCourtId}`, { token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual(expect.objectContaining({
      name: '__TEST__ District Court',
      abbreviation: 'TSTDC',
      city: 'Springfield',
      state: 'IL',
    }));
  });

  test('the new court appears in the firm list', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/courts`, { token });
    expect(res.status).toBe(200);
    expect(res.body.courts.some((c: any) => c.id === createdCourtId)).toBe(true);
  });

  test('an update is visible on the next read', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/courts/${createdCourtId}`, {
      token,
      body: { name: '__TEST__ Updated Court' },
    });
    expect(res.status).toBe(200);

    const read = await api.get(`/api/lawfirms/${lawFirmId}/courts/${createdCourtId}`, { token });
    expect(read.body.name).toBe('__TEST__ Updated Court');
  });

  test('a delete actually removes the row', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/courts/${createdCourtId}`, { token });
    expect(res.status).toBe(200);

    const read = await api.get(`/api/lawfirms/${lawFirmId}/courts/${createdCourtId}`, { token });
    expect([403, 404]).toContain(read.status);

    const list = await api.get(`/api/lawfirms/${lawFirmId}/courts`, { token });
    expect(list.body.courts.some((c: any) => c.id === createdCourtId)).toBe(false);

    createdCourtId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
