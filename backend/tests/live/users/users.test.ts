/**
 * Users API - Real integration tests.
 * Tests hit the REAL running server at localhost:5001.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
});

describe('GET /api/users/profile', () => {
  test('returns current user profile', async () => {
    const res = await api.get('/api/users/profile', { token });
    expect(res.status).toBe(200);
    expect(res.body.email).toBeDefined();
    expect(res.body.name).toBeDefined();
  });

  test('rejects unauthenticated request', async () => {
    const res = await api.get('/api/users/profile');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/my-lawfirms', () => {
  test('returns law firm IDs for current user', async () => {
    const res = await api.get('/api/users/my-lawfirms', { token });
    expect(res.status).toBe(200);
    expect(res.body.lawFirmIds).toBeDefined();
    expect(Array.isArray(res.body.lawFirmIds)).toBe(true);
    expect(res.body.lawFirmIds.length).toBeGreaterThan(0);
  });
});

describe('GET /api/users/:userId', () => {
  test('returns a user by ID', async () => {
    const { userId } = await getTestToken();
    const res = await api.get(`/api/users/${userId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.email).toBeDefined();
  });

  test('returns 404 for nonexistent user', async () => {
    // An unknown id is a miss, not a crash: accepting a 500 here would let a
    // thrown lookup pass as correct behaviour.
    const res = await api.get('/api/users/nonexistent-user-id-12345', { token });
    expect(res.status).toBe(404);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
