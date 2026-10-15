/**
 * Lawfirms API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;
let originalName: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

afterAll(async () => {
  // Restore original name if we changed it
  if (originalName && lawFirmId) {
    await api.put(`/api/lawfirms/${lawFirmId}`, {
      token,
      body: { name: originalName },
    });
  }
});

describe('GET /api/lawfirms/:lawFirmId', () => {
  test('returns law firm details', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.name).toBeDefined();
    originalName = res.body.name;
  });

  test('rejects unauthenticated request', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/lawfirms/:lawFirmId', () => {
  test('updates law firm name and restores it', async () => {
    const newName = '__TEST__ Temp Firm Name';
    const updateRes = await api.put(`/api/lawfirms/${lawFirmId}`, {
      token,
      body: { name: newName },
    });
    expect(updateRes.status).toBe(200);

    // Verify
    const getRes = await api.get(`/api/lawfirms/${lawFirmId}`, { token });
    expect(getRes.body.name).toBe(newName);

    // Restore
    const restoreRes = await api.put(`/api/lawfirms/${lawFirmId}`, {
      token,
      body: { name: originalName },
    });
    expect(restoreRes.status).toBe(200);
    originalName = null; // prevent afterAll double-restore
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
