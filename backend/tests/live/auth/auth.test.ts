/**
 * Auth API - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.ts).
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');

let token: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
});

describe('POST /api/auth/check-user-exists', () => {
  // This route is deliberately unauthenticated (it answers during sign-up) and
  // takes the id token in the body, so both the accept and the reject path are
  // worth pinning. It carries its own tighter rate limiter than the rest of
  // /api/auth, so keep the number of calls here small.
  test('answers a boolean for a real token', async () => {
    const res = await api.post('/api/auth/check-user-exists', { body: { token } });
    expect(res.status).toBe(200);
    expect(typeof res.body.exists).toBe('boolean');
  });

  test('a token that is not a token is 401, not a 500 and not "exists: false"', async () => {
    // A malformed token must not be answered as "no such user": that would make
    // a broken client look like a fresh sign-up and route it into registration.
    const res = await api.post('/api/auth/check-user-exists', { body: { token: 'not-a-jwt' } });
    expect(res.status).toBe(401);
    expect(res.body.exists).toBeUndefined();
  });
});

describe('GET /api/auth/user-type', () => {
  test('returns one of the three user types', async () => {
    // Route protection in every layout branches on this value, so an unexpected
    // string here sends a real user to the wrong workspace.
    const res = await api.get('/api/auth/user-type', { token });
    expect(res.status).toBe(200);
    expect(['firm_member', 'client', 'pending']).toContain(res.body.userType);
  });

  test('rejects unauthenticated request', async () => {
    const res = await api.get('/api/auth/user-type');
    expect(res.status).toBe(401);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
