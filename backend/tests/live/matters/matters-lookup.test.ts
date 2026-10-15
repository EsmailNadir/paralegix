/**
 * Matter lookup (typeahead) API - real integration tests.
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

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);
});

describe('GET /api/lawfirms/:lawFirmId/matters/lookup', () => {
  test('returns a { items, hasMore } envelope of slim picker rows', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup`, { token });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.hasMore).toBe('boolean');
    expect(res.body.items.length).toBeGreaterThan(0);

    const row = res.body.items[0];
    expect(typeof row.id).toBe('string');
    expect(typeof row.label).toBe('string');
    expect(row.label.length).toBeGreaterThan(0);
    // A picker row is deliberately slim: none of the enriched grid fields that
    // cost lateral JOINs should be present.
    expect(row.members).toBeUndefined();
    expect(row.memberUserIds).toBeUndefined();
    expect(row.clients).toBeUndefined();
    expect(row.outstandingBalance).toBeUndefined();
  });

  test('honours ?limit and rejects a limit above the schema cap', async () => {
    const limited = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=2`, { token });
    expect(limited.status).toBe(200);
    expect(limited.body.items.length).toBeLessThanOrEqual(2);

    const tooBig = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=500`, { token });
    expect(tooBig.status).toBe(400);
  });

  // Regression: a user typing `%` must search for that literal character rather
  // than matching every matter (toIlikeTerm escapes LIKE wildcards).
  test('treats a LIKE wildcard in the search term literally', async () => {
    const unfiltered = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=50`, { token });
    expect(unfiltered.status).toBe(200);

    const wildcard = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?search=%25&limit=50`, { token });
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.items.length).toBeLessThan(unfiltered.body.items.length);
    // Anything that does come back genuinely contains the character.
    for (const item of wildcard.body.items) {
      expect(`${item.label}${item.matterNumber || ''}`).toContain('%');
    }

    // `_` is the other LIKE wildcard: it must not match an arbitrary character.
    const underscore = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?search=_&limit=50`, { token });
    expect(underscore.status).toBe(200);
    expect(underscore.body.items.length).toBeLessThan(unfiltered.body.items.length);
  });

  test('?ids resolves exactly the requested matters', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=50`, { token });
    const target = all.body.items[0];

    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?ids=${target.id}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(target.id);
    expect(res.body.items[0].label).toBe(target.label);
  });

  test('ignores ?search when ?ids is supplied', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=50`, { token });
    const target = all.body.items[0];

    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?ids=${target.id}&search=zzz-no-such-matter-zzz`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([target.id]);
  });

  // Regression: an id-resolution request that resolves to nothing must return
  // nothing. Falling back to an unfiltered page would make a picker holding a
  // stale id label its selection with an arbitrary unrelated matter.
  test('returns an empty result when ?ids contains no usable id', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?ids=not-a-uuid`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);

    const multiple = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?ids=not-a-uuid,also-bogus`,
      { token },
    );
    expect(multiple.status).toBe(200);
    expect(multiple.body.items).toEqual([]);
    expect(multiple.body.hasMore).toBe(false);
  });

  test('rejects request with no auth token', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup`, {});
    expect(res.status).toBe(401);
  });
});

/**
 * Matter visibility is an ethical wall: regular members may only see matters
 * they belong to, while firm owners/admins see the whole firm. The lookup
 * endpoint must apply exactly the same scoping as the full matters list, or a
 * dropdown would leak matter names past the wall.
 *
 * The checks run across every firm the test account belongs to, so both branches
 * get exercised: the seeded account owns one firm (sees all of its matters) and
 * is a plain member of another (sees only its own subset).
 */
describe('matter lookup ethical wall', () => {
  test('never surfaces a matter the full list withholds, in any of the user\'s firms', async () => {
    const firmsRes = await api.get('/api/users/my-lawfirms', { token });
    expect(firmsRes.status).toBe(200);
    const firmIds = firmsRes.body.lawFirmIds || [];
    expect(firmIds.length).toBeGreaterThan(0);

    let firmsChecked = 0;

    for (const firmId of firmIds) {
      const listRes = await api.get(`/api/lawfirms/${firmId}/matters`, { token });
      const lookupRes = await api.get(`/api/lawfirms/${firmId}/matters/lookup?limit=50`, { token });

      // A firm whose role lacks matters.view is out of scope for this check, but
      // the two endpoints must at least agree on refusing it.
      if (listRes.status !== 200) {
        expect(lookupRes.status).not.toBe(200);
        continue;
      }
      expect(lookupRes.status).toBe(200);
      firmsChecked += 1;

      const visibleIds = new Set(listRes.body.matters.map((m: any) => m.id));
      for (const item of lookupRes.body.items) {
        expect(visibleIds.has(item.id)).toBe(true);
      }

      // Below the page cap the two must describe the identical visible set, so
      // the lookup can neither over-expose nor silently hide matters.
      if (visibleIds.size <= 50) {
        expect(lookupRes.body.items).toHaveLength(visibleIds.size);
      }

      // The same wall applies to id resolution: asking for an id the user cannot
      // see must not resolve it.
      const invisibleId = '00000000-0000-4000-8000-000000000000';
      const byId = await api.get(`/api/lawfirms/${firmId}/matters/lookup?ids=${invisibleId}`, { token });
      expect(byId.status).toBe(200);
      expect(byId.body.items).toHaveLength(0);
    }

    expect(firmsChecked).toBeGreaterThan(0);
  });
});

/**
 * `?clientId=` scoping. Several pickers are deliberately client-scoped (a trust
 * transaction, an invoice): offering every firm matter there would let one
 * client's money be attributed to another client's matter. The parameter must
 * narrow the result and never widen it past the ethical wall.
 */
describe('matter lookup ?clientId scoping', () => {
  const U = `TESTMLKP${Date.now()}`;
  const SCOPED_NAME = `${U}SCOPED`;
  const OTHER_NAME = `${U}OTHER`;
  const createdMatterIds: any = [];
  let scopedClientId: any;

  beforeAll(async () => {
    // One matter linked to a brand-new client, and one linked to nobody. The
    // second is the control: it must never appear under the first's clientId.
    const scoped = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
      token,
      body: {
        name: SCOPED_NAME,
        description: 'Created by automated test - safe to delete',
        clients: [{ name: `${U}CLIENT` }],
      },
    });
    expect(scoped.status).toBe(201);
    createdMatterIds.push(scoped.body.matterId);

    const other = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
      token,
      body: { name: OTHER_NAME, description: 'Created by automated test - safe to delete' },
    });
    expect(other.status).toBe(201);
    createdMatterIds.push(other.body.matterId);

    const detail = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/${scoped.body.matterId}`,
      { token },
    );
    expect(detail.status).toBe(200);
    scopedClientId = (detail.body.clients || [])[0]?.id;
    expect(typeof scopedClientId).toBe('string');
  }, 60000);

  afterAll(async () => {
    for (const id of createdMatterIds) {
      // eslint-disable-next-line no-await-in-loop
      await api.delete(`/api/lawfirms/${lawFirmId}/matters/${id}`, { token });
    }
    // Creating a matter with inline clients find-or-creates a firm `clients` row;
    // deleting the matter only unlinks it. Remove it too, or every run leaks one.
    if (scopedClientId) await api.delete(`/api/lawfirms/${lawFirmId}/clients/${scopedClientId}`, { token });
  }, 60000);

  test('restricts the result to that client\'s matters', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?clientId=${scopedClientId}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    const labels = res.body.items.map((i: any) => i.label);
    expect(labels).toContain(SCOPED_NAME);
    // The unlinked matter is visible to this user but not to this client.
    expect(labels).not.toContain(OTHER_NAME);
  });

  test('is additive: every scoped result also appears unscoped', async () => {
    const unscoped = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=50`, { token });
    const scoped = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?clientId=${scopedClientId}&limit=50`,
      { token },
    );

    expect(unscoped.status).toBe(200);
    expect(scoped.status).toBe(200);
    const unscopedIds = new Set(unscoped.body.items.map((i: any) => i.id));
    for (const item of scoped.body.items) expect(unscopedIds.has(item.id)).toBe(true);
    expect(scoped.body.items.length).toBeLessThanOrEqual(unscoped.body.items.length);
  });

  test('combines with ?search rather than replacing it', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?clientId=${scopedClientId}&search=${OTHER_NAME}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    // The searched matter belongs to no client, so the two predicates AND to nothing.
    expect(res.body.items).toEqual([]);
  });

  // A scoped request whose scope cannot be resolved must return nothing. Silently
  // dropping an unusable clientId would answer "this client's matters" with the
  // firm's whole list, which is the misattribution the scoping exists to prevent.
  test('returns nothing when ?clientId is not a usable id', async () => {
    const bogus = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?clientId=not-a-uuid`, { token });
    expect(bogus.status).toBe(200);
    expect(bogus.body.items).toEqual([]);
    expect(bogus.body.hasMore).toBe(false);

    const unknown = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?clientId=00000000-0000-4000-8000-000000000000`,
      { token },
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
  });

  // The wall is enforced by the same predicate chain in both modes, so a scoped
  // lookup can never reach past what the unscoped list already permits.
  test('never widens visibility past the full matters list, in any of the user\'s firms', async () => {
    const firmsRes = await api.get('/api/users/my-lawfirms', { token });
    const firmIds = firmsRes.body.lawFirmIds || [];

    for (const firmId of firmIds) {
      // eslint-disable-next-line no-await-in-loop
      const listRes = await api.get(`/api/lawfirms/${firmId}/matters`, { token });
      if (listRes.status !== 200) continue;
      const visibleIds = new Set(listRes.body.matters.map((m: any) => m.id));

      // Every client of the firm, probed through the scoped lookup.
      // eslint-disable-next-line no-await-in-loop
      const clientsRes = await api.get(`/api/lawfirms/${firmId}/clients/lookup?limit=20`, { token });
      if (clientsRes.status !== 200) continue;

      for (const client of clientsRes.body.items) {
        // eslint-disable-next-line no-await-in-loop
        const scoped = await api.get(
          `/api/lawfirms/${firmId}/matters/lookup?clientId=${client.id}&limit=50`,
          { token },
        );
        expect(scoped.status).toBe(200);
        for (const item of scoped.body.items) expect(visibleIds.has(item.id)).toBe(true);
      }
    }
  }, 120000);
});

/**
 * `?full=true` swaps the slim picker row for the complete enriched matter, for
 * the template-fill picker whose selection drives placeholder auto-fill. The
 * enrichment is a second pass over ids the visibility query already returned, so
 * it must describe exactly the same set as the slim mode.
 */
describe('matter lookup ?full=true', () => {
  test('returns the enriched matter alongside the picker label', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=1&full=true`, { token });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);

    const item = res.body.items[0];
    // The picker contract survives, so the same component renders either shape.
    expect(typeof item.label).toBe('string');
    expect(item).toHaveProperty('sublabel');
    // Plus the enriched fields the slim row deliberately omits.
    expect(item).toHaveProperty('matterReferenceId');
    expect(item).toHaveProperty('practiceAreaName');
    expect(item).toHaveProperty('category');
    expect(Array.isArray(item.members)).toBe(true);
    expect(Array.isArray(item.clients)).toBe(true);
  });

  test('describes the same matters, in the same order, as the slim mode', async () => {
    const slim = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=10`, { token });
    const full = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=10&full=true`, { token });

    expect(full.status).toBe(200);
    expect(full.body.items.map((i: any) => i.id)).toEqual(slim.body.items.map((i: any) => i.id));
    expect(full.body.hasMore).toBe(slim.body.hasMore);
  });

  test('honours ?ids and the ethical wall', async () => {
    const slim = await api.get(`/api/lawfirms/${lawFirmId}/matters/lookup?limit=1`, { token });
    const target = slim.body.items[0];

    const byId = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?ids=${target.id}&full=true`,
      { token },
    );
    expect(byId.status).toBe(200);
    expect(byId.body.items).toHaveLength(1);
    expect(byId.body.items[0].id).toBe(target.id);

    const invisible = await api.get(
      `/api/lawfirms/${lawFirmId}/matters/lookup?ids=00000000-0000-4000-8000-000000000000&full=true`,
      { token },
    );
    expect(invisible.status).toBe(200);
    expect(invisible.body.items).toEqual([]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
