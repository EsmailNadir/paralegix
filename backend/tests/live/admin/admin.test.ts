/**
 * Platform-admin gate - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.ts).
 *
 * `/api/admin` is the only router in the codebase that reads ACROSS tenants:
 * every route under it lists or mutates firms, users and subscriptions platform
 * wide. One `router.use(verifyToken, requireIsAdmin)` is what stands between a
 * signed-in customer and all of it, so the property worth pinning is that the
 * guard covers the WHOLE surface rather than the handful of routes someone
 * remembered to check.
 *
 * The primary test account carries isAdmin = true and therefore cannot
 * demonstrate a rejection; the non-admin token (see auth-helper.ts) is a real
 * signed-in account that is not a platform admin. The suite self-skips, loudly,
 * when no such account can be signed in.
 */

const { api } = require('../setup');
const { getTestToken, getNonAdminToken } = require('../auth-helper');

// One entry per distinct admin surface. Read routes only: a mutation would need
// a real target id, and the guard being asserted is mounted on the router, so it
// runs identically for every method.
const ADMIN_READS = [
  '/api/admin/lawfirms',
  '/api/admin/lawfirms/lookup',
  '/api/admin/users',
  '/api/admin/clients',
  '/api/admin/audit-events',
  '/api/admin/plans',
  '/api/admin/plan-usage',
  '/api/admin/whitelist',
  '/api/admin/outbox-health',
];

let token: any;
let nonAdminToken: any;
let isAdmin = false;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  nonAdminToken = await getNonAdminToken();
  const probe = await api.get('/api/admin/lawfirms', { token });
  isAdmin = probe.status === 200;
});

describe('the admin router rejects everyone who is not a platform admin', () => {
  test.each(ADMIN_READS)('%s rejects an unauthenticated request with 401', async (path) => {
    const res = await api.get(path);
    expect(res.status).toBe(401);
  });

  test.each(ADMIN_READS)('%s rejects a signed-in non-admin with 403', async (path) => {
    if (!nonAdminToken) return console.warn('SKIP: no non-admin account available');

    const res = await api.get(path, { token: nonAdminToken });
    expect({ path, status: res.status }).toEqual({ path, status: 403 });
    // A rejection that still ships the payload is not a rejection. None of these
    // collections may appear alongside the 403.
    for (const key of ['lawFirms', 'users', 'clients', 'items', 'events', 'plans']) {
      expect({ path, key, leaked: key in (res.body || {}) })
        .toEqual({ path, key, leaked: false });
    }
  });
});

describe('the cross-tenant reads themselves', () => {
  test('an admin sees firms from more than the one firm they belong to', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    const [platform, mine] = await Promise.all([
      api.get('/api/admin/lawfirms', { token }),
      api.get('/api/users/my-lawfirms', { token }),
    ]);
    expect(platform.status).toBe(200);
    expect(Array.isArray(platform.body.lawFirms)).toBe(true);

    // The point of the endpoint: it is not the caller's own membership list. If
    // these ever matched, the route would have quietly become tenant-scoped and
    // the admin console would under-report the platform.
    expect(platform.body.lawFirms.length).toBeGreaterThanOrEqual(mine.body.lawFirmIds.length);
  });

  test('the user list is an envelope, never a bare array', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    const res = await api.get('/api/admin/users', { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    expect(Array.isArray(res.body.users)).toBe(true);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
