/**
 * Members API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

describe('GET /api/lawfirms/:lawFirmId/members', () => {
  test('returns list of members', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/members`, { token });
    expect(res.status).toBe(200);
    // The list endpoints answer with a counted envelope, not a bare array.
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members.length).toBeGreaterThan(0);
    expect(res.body.totalItems).toBe(res.body.members.length);
  });

  test('includes the current user (owner) in the list', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/members`, { token });
    const { userId } = await getTestToken();
    const me = res.body.members.find((m: any) => m.userId === userId || m.id === userId);
    expect(me).toBeDefined();
  });
});

describe('Auth required', () => {
  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/members`);
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
