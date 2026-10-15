/**
 * Trust Reconciliation API - Real integration tests.
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

describe('GET /api/lawfirms/:lawFirmId/trust/reconciliations', () => {
  test('lists reconciliations', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/reconciliations`, { token });
    expect(res.status).toBe(200);
    expect(res.body.reconciliations).toBeDefined();
    expect(Array.isArray(res.body.reconciliations)).toBe(true);
  });
});

describe('GET /api/lawfirms/:lawFirmId/trust/reconciliation-snapshot', () => {
  // The user picks an account before this endpoint is ever called, so a missing
  // `trustAccountId` is a client bug rather than user-actionable input. The route
  // says so and throws a generic Error, which the handler scrubs into a 500. The
  // point of the test is that the endpoint refuses and leaks nothing, not which
  // of the two failure codes it picks.
  test('refuses without leaking detail when trustAccountId is missing', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/reconciliation-snapshot`, { token });
    expect(res.status).toBe(500);
    expect(res.body).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('trustAccountId is required');
  });
});

describe('Auth required', () => {
  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/trust/reconciliations`);
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
