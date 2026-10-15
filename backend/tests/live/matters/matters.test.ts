/**
 * Matters API - real integration tests.
 *
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 * Start the server first (`npm run dev`) pointed at a disposable DB, then run
 * the suite with the test auth env (see tests/validate-test-env.js).
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let createdMatterId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

afterAll(async () => {
  if (createdMatterId && lawFirmId) {
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
  }
});

describe('POST /api/lawfirms/:lawFirmId/matters', () => {
  test('creates a matter with valid data', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
      token,
      body: {
        name: '__TEST__ Integration Test Matter',
        matterNumber: 'TEST-001',
        description: 'Created by automated test - safe to delete',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.matterId).toBeDefined();
    createdMatterId = res.body.matterId;
  });

  test('rejects empty matter name with 400', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
      token,
      body: { name: '' },
    });
    expect(res.status).toBe(400);
  });

  test('rejects request with no auth token', async () => {
    const res = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
      body: { name: 'No Auth Matter' },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/lawfirms/:lawFirmId/matters', () => {
  test('returns list of matters', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.matters)).toBe(true);
  });

  test('includes the created test matter', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });
    const found = res.body.matters.find((m: any) => m.id === createdMatterId);
    expect(found).toBeDefined();
  });
});

describe('GET /api/lawfirms/:lawFirmId/matters/:matterId', () => {
  test('returns a single matter by ID', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('__TEST__ Integration Test Matter');
  });

  test('returns error for non-existent matter', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/00000000-0000-4000-8000-000000000000`, { token });
    expect([403, 404]).toContain(res.status);
  });
});

describe('PUT /api/lawfirms/:lawFirmId/matters/:matterId', () => {
  test('updates matter name', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, {
      token,
      body: { name: '__TEST__ Updated Name' },
    });
    expect(res.status).toBe(200);

    const getRes = await api.get(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
    expect(getRes.body.name).toBe('__TEST__ Updated Name');
  });

  test('updates matter status', async () => {
    const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, {
      token,
      body: { status: 'pending' },
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/lawfirms/:lawFirmId/matters/:matterId', () => {
  test('deletes the test matter', async () => {
    const res = await api.delete(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
    expect(res.status).toBe(200);

    const getRes = await api.get(`/api/lawfirms/${lawFirmId}/matters/${createdMatterId}`, { token });
    expect([403, 404]).toContain(getRes.status);

    createdMatterId = null;
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
