/**
 * Platform-admin law firm typeahead - real integration tests.
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 *
 * GET /api/admin/lawfirms/lookup is the only cross-tenant lookup in the codebase:
 * it lists firms across the whole platform rather than within one. Its guard is
 * therefore the point of the endpoint, and is covered here first.
 */

const { api } = require('../setup');
const { getTestToken, getNonAdminToken } = require('../auth-helper');

const PATH = '/api/admin/lawfirms/lookup';
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

let token: any;
let isAdmin = false;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  const probe = await api.get(PATH, { token });
  isAdmin = probe.status === 200;
});

describe('authorization', () => {
  test('rejects a request with no token', async () => {
    const res = await api.get(PATH);
    expect([401, 403]).toContain(res.status);
  });

  test('rejects a signed-in non-admin with 403', async () => {
    const nonAdminToken = await getNonAdminToken();
    if (!nonAdminToken) return console.warn('SKIP: no non-admin account available');

    const res = await api.get(PATH, { token: nonAdminToken });
    expect(res.status).toBe(403);
    // The rejection must not leak any firm data alongside it.
    expect(res.body.items).toBeUndefined();
  });

  test('allows a platform admin', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');
    const res = await api.get(PATH, { token });
    expect(res.status).toBe(200);
  });
});

describe('lookup contract', () => {
  test('returns the { items, hasMore } envelope with labelled rows', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    const res = await api.get(`${PATH}?limit=5`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.hasMore).toBe('boolean');
    // Never a bare array at the root.
    expect(Array.isArray(res.body)).toBe(false);

    for (const item of res.body.items) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
      expect(['string', 'object']).toContain(typeof item.sublabel);
    }
  });

  test('honours limit and reports hasMore from the limit+1 fetch', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    const res = await api.get(`${PATH}?limit=2`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(2);
    // The seeded database carries well over two firms, so there is more to come.
    if (res.body.items.length === 2) expect(res.body.hasMore).toBe(true);
  });

  test('rejects a limit above the cap with 400', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');
    const res = await api.get(`${PATH}?limit=51`, { token });
    expect(res.status).toBe(400);
  });

  test('narrows results by search term', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    const all = await api.get(`${PATH}?limit=50`, { token });
    const sample = (all.body.items || [])[0];
    if (!sample) return console.warn('SKIP: no firms to search');

    // A distinctive slice of a real firm name must find that firm.
    const needle = sample.label.slice(0, 4);
    const res = await api.get(`${PATH}?search=${encodeURIComponent(needle)}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: any) => i.id === sample.id)).toBe(true);
  });

  test('treats a literal % as text rather than a wildcard', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    const unfiltered = await api.get(`${PATH}?limit=50`, { token });
    const total = (unfiltered.body.items || []).length;
    if (!total) return console.warn('SKIP: no firms to search');

    // An unescaped `%` would compile to `%%%` and match every firm on the
    // platform. Escaped, it only matches names actually containing a percent sign.
    const res = await api.get(`${PATH}?search=${encodeURIComponent('%')}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThan(total);
  });
});

describe('ids mode (strictly exclusive)', () => {
  test('resolves the named firms and ignores the search term', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    const all = await api.get(`${PATH}?limit=2`, { token });
    const sample = (all.body.items || [])[0];
    if (!sample) return console.warn('SKIP: no firms to resolve');

    const res = await api.get(
      `${PATH}?ids=${sample.id}&search=${encodeURIComponent('zzz-no-such-firm-zzz')}`,
      { token }
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([sample.id]);
  });

  test('returns nothing when every supplied id is malformed', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');

    // Must not fall through to an unfiltered list: a picker holding a stale id
    // would otherwise label its selection with an arbitrary unrelated firm.
    const res = await api.get(`${PATH}?ids=not-a-uuid,also-not-a-uuid`, { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  test('returns nothing for a well-formed id that matches no firm', async () => {
    if (!isAdmin) return console.warn('SKIP: test account is not a platform admin');
    const res = await api.get(`${PATH}?ids=${RANDOM_UUID}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
