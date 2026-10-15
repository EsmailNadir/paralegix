/**
 * Client Portal API - Real integration tests.
 * Portal routes require userType 'client'. A firm_member token will get 403.
 * These tests verify that firm members are correctly blocked.
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

describe('GET /api/client-portal/my-lawfirms', () => {
  test('rejects non-client users with 403', async () => {
    const res = await api.get('/api/client-portal/my-lawfirms', { token });
    expect(res.status).toBe(403);
  });

  test('rejects unauthenticated request with 401', async () => {
    const res = await api.get('/api/client-portal/my-lawfirms');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/client-portal/lawfirm/:lawFirmId/matters', () => {
  test('rejects non-client users with 403', async () => {
    const res = await api.get(`/api/client-portal/lawfirm/${lawFirmId}/matters`, { token });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/client-portal/lawfirm/:lawFirmId/billing', () => {
  test('rejects non-client users with 403', async () => {
    const res = await api.get(`/api/client-portal/lawfirm/${lawFirmId}/billing`, { token });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/client-portal/lawfirm/:lawFirmId/documents', () => {
  test('rejects non-client users with 403', async () => {
    const res = await api.get(`/api/client-portal/lawfirm/${lawFirmId}/documents`, { token });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/client-portal/unread-count', () => {
  test('rejects non-client users with 403', async () => {
    const res = await api.get('/api/client-portal/unread-count', { token });
    expect(res.status).toBe(403);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
