/**
 * Settings API - Real integration tests.
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

describe('GET /api/settings/user', () => {
  test('returns user settings', async () => {
    const res = await api.get(`/api/settings/user?lawFirmId=${lawFirmId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.preferences).toBeDefined();
  });

  test('rejects unauthenticated request', async () => {
    const res = await api.get('/api/settings/user');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/lawfirms/:lawFirmId/settings/firm', () => {
  test('returns firm settings', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/settings/firm`, { token });
    expect(res.status).toBe(200);
    expect(res.body.settings).toBeDefined();
  });
});

describe('POST /api/settings/user', () => {
  test('updates user settings', async () => {
    const res = await api.post(`/api/settings/user?lawFirmId=${lawFirmId}`, {
      token,
      body: {
        preferences: {
          theme: 'system',
        },
      },
    });
    expect(res.status).toBe(200);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
