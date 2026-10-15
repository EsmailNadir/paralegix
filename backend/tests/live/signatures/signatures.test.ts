/**
 * Signatures API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 *
 * The signatures module provides document conversion endpoints.
 * These require file uploads which are harder to test via raw fetch,
 * so we test the listing endpoint and auth behavior.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;
let lawFirmId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;

  const res = await api.get('/api/users/my-lawfirms', { token });
  expect(res.status).toBe(200);
  lawFirmId = res.body.lawFirmIds[0];
});

describe('GET /api/lawfirms/:lawFirmId/signature-links/sessions', () => {
  test('lists signing sessions for the firm', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/signature-links/sessions`, { token });
    expect(res.status).toBe(200);
    expect(res.body.sessions).toBeDefined();
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });
});

describe('POST /api/lawfirms/:lawFirmId/signature-links/generate', () => {
  test('rejects with 400 when required fields are missing', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/signature-links/generate`, {
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('Auth required for signature-links', () => {
  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/signature-links/sessions`);
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
