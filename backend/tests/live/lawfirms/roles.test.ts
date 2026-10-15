/**
 * Roles API - Real integration tests.
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

describe('GET /api/lawfirms/:lawFirmId/roles', () => {
  test('returns list of roles', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/roles`, { token });
    expect(res.status).toBe(200);
    // The list endpoints answer with a counted envelope, not a bare array.
    expect(Array.isArray(res.body.roles)).toBe(true);
    expect(res.body.roles.length).toBeGreaterThan(0);
    expect(res.body.totalItems).toBe(res.body.roles.length);
  });

  test('includes built-in roles (Owner, Admin, etc)', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/roles`, { token });
    const roleNames = res.body.roles.map((r: any) => r.name);
    expect(roleNames).toContain('Owner');
    expect(roleNames).toContain('Admin');
  });
});

describe('Auth required', () => {
  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/roles`);
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
