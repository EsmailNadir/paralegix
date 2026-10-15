/**
 * Trust Client Balances API - Real integration tests.
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

describe('GET /api/lawfirms/:lawFirmId/trust/balances', () => {
  test('returns all client balances', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/balances`, { token });
    expect(res.status).toBe(200);
    expect(res.body.balances).toBeDefined();
    expect(Array.isArray(res.body.balances)).toBe(true);
  });
});

describe('Auth required', () => {
  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/balances`);
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
