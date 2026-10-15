/**
 * Billing Analytics & Workbench API - Real integration tests.
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

describe('GET /api/lawfirms/:lawFirmId/billing/analytics/billing-summary', () => {
  test('returns billing summary data', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/analytics/billing-summary`, { token });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/workbench', () => {
  test('returns workbench data', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/workbench`, { token });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/billing/unbilled-work', () => {
  test('returns unbilled work data', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/billing/unbilled-work`, { token });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
