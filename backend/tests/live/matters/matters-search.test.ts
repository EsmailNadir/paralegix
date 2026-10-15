/**
 * Server-side matters search / filter / sort / pagination - real integration tests.
 *
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 * Start the server first (`npm run dev`) pointed at a disposable DB, then run
 * the suite with the test auth env (see tests/validate-test-env.js).
 *
 * The suite seeds its own matters under a run-unique alphanumeric prefix so every
 * assertion is independent of whatever the database already contains.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let userId: any;
let lawFirmId: any;

// Run-unique and deliberately free of `_` and `%` so the wildcard-escaping probes
// below are the only place those characters appear.
const U = `TESTSRCH${Date.now()}`;

// `_A` vs `XA` differ only at the position an unescaped LIKE `_` would wildcard
// over, which is what makes them a decisive escaping probe.
const WILDCARD_NAMES = [`${U}_A`, `${U}XA`];
// Uppercase-letter-only suffixes sort identically under any collation.
const SORT_NAMES = [`${U}SZZZ`, `${U}SAAA`, `${U}SMMM`];

/** name -> matterId for every matter this suite seeded. */
const createdByName = new Map();

async function createMatter(name: any) {
  const res = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
    token,
    body: { name, description: 'Created by automated test - safe to delete' },
  });
  if (res.status !== 201) throw new Error(`seed create failed (${res.status}): ${JSON.stringify(res.body)}`);
  createdByName.set(name, res.body.matterId);
  return res.body.matterId;
}

function names(res: any) {
  return (res.body.matters || []).map((m: any) => m.name);
}

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  userId = auth.userId;
  lawFirmId = await getPrimaryLawFirmId(token);

  for (const n of [...WILDCARD_NAMES, ...SORT_NAMES]) {
    // Sequential on purpose: matter_reference_id generation retries on collision.
    // eslint-disable-next-line no-await-in-loop
    await createMatter(n);
  }
}, 60000);

afterAll(async () => {
  for (const id of createdByName.values()) {
    // eslint-disable-next-line no-await-in-loop
    await api.delete(`/api/lawfirms/${lawFirmId}/matters/${id}`, { token });
  }
}, 60000);

describe('GET /matters (unpaginated) backwards compatibility', () => {
  test('omits totalItems and returns the full visible set', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.matters)).toBe(true);
    expect(res.body).not.toHaveProperty('totalItems');
    // Every seeded matter is present, so the default list is genuinely unwindowed.
    for (const n of [...WILDCARD_NAMES, ...SORT_NAMES]) {
      expect(names(res)).toContain(n);
    }
  });

  test('matters carry the enriched entity shape', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });
    const seeded = res.body.matters.find((m: any) => m.name === SORT_NAMES[0]);

    expect(seeded).toBeDefined();
    expect(seeded).toHaveProperty('id');
    expect(seeded).toHaveProperty('members');
    expect(Array.isArray(seeded.memberUserIds)).toBe(true);
    expect(Array.isArray(seeded.clientNames)).toBe(true);
  });
});

describe('GET /matters pagination', () => {
  test('limit windows the result and reports the full count', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=2`, { token });

    expect(res.status).toBe(200);
    expect(res.body.matters.length).toBeLessThanOrEqual(2);
    expect(typeof res.body.totalItems).toBe('number');
    // The suite seeds 5 matters, so the full result always exceeds a 2-row page.
    expect(res.body.totalItems).toBeGreaterThan(2);
  });

  test('totalItems matches the unpaginated result size', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/matters`, { token });
    const paged = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=1`, { token });

    expect(paged.body.totalItems).toBe(all.body.matters.length);
  });

  test('page 2 returns a different window than page 1', async () => {
    const p1 = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=1&page=1`, { token });
    const p2 = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=1&page=2`, { token });

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.body.matters).toHaveLength(1);
    expect(p2.body.matters).toHaveLength(1);
    expect(p1.body.matters[0].id).not.toBe(p2.body.matters[0].id);
  });

  // The window count rides on the returned rows, so an out-of-range page has no
  // row to read it from. Reporting 0 there is indistinguishable from "no matches",
  // and a UI holding a page number from a wider filter renders "no results" instead
  // of clamping back into range. The empty page must still carry the true total.
  test('an out-of-range page reports the true total, not 0', async () => {
    const first = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=5&page=1`, { token });
    expect(first.status).toBe(200);
    const total = first.body.totalItems;
    expect(total).toBeGreaterThan(0);

    // Far past the last page of a 5-row window.
    const beyond = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=5&page=1000`, { token });

    expect(beyond.status).toBe(200);
    expect(beyond.body.matters).toEqual([]);
    expect(beyond.body.totalItems).toBe(total);
  });

  test('an out-of-range page keeps the filter total, not the unfiltered one', async () => {
    const inRange = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=2&page=1&search=${U}`,
      { token },
    );
    expect(inRange.status).toBe(200);
    expect(inRange.body.totalItems).toBe(5);

    const beyond = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=2&page=50&search=${U}`,
      { token },
    );

    expect(beyond.status).toBe(200);
    expect(beyond.body.matters).toEqual([]);
    // The seeded-prefix total, not the firm-wide one.
    expect(beyond.body.totalItems).toBe(5);
  });

  // The counterpart: a filter that genuinely matches nothing must still report 0,
  // so the fallback count cannot be masking a real empty result.
  test('a genuinely empty first page still reports 0', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=5&page=1&search=${U}NOSUCHMATTER`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.matters).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });
});

describe('GET /matters?search=', () => {
  test('narrows the result set to matching matters', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=1`, { token });
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=100&search=${U}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(5);
    expect(res.body.totalItems).toBeLessThan(all.body.totalItems);
    expect(names(res).sort()).toEqual([...WILDCARD_NAMES, ...SORT_NAMES].sort());
  });

  test('a literal underscore does not act as a single-character wildcard', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=100&search=${encodeURIComponent(`${U}_A`)}`,
      { token },
    );

    expect(res.status).toBe(200);
    // Unescaped, `_` would also match `${U}XA`.
    expect(names(res)).toEqual([`${U}_A`]);
  });

  test('a literal percent does not match everything', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=100&search=${encodeURIComponent(`${U}%A`)}`,
      { token },
    );

    expect(res.status).toBe(200);
    // Unescaped, `%` would match both seeded wildcard probes.
    expect(res.body.matters).toHaveLength(0);
    expect(res.body.totalItems).toBe(0);
  });

  test('a bare percent does not return the whole firm', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=1`, { token });
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=100&search=${encodeURIComponent('%')}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBeLessThan(all.body.totalItems);
  });
});

describe('GET /matters?status=', () => {
  test('filters to matters with the requested status', async () => {
    const target = createdByName.get(`${U}SAAA`);
    const upd = await api.put(`/api/lawfirms/${lawFirmId}/matters/${target}`, {
      token,
      body: { status: 'archived' },
    });
    expect(upd.status).toBe(200);

    const archived = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=100&search=${U}S&status=archived`,
      { token },
    );
    expect(archived.status).toBe(200);
    expect(names(archived)).toEqual([`${U}SAAA`]);

    const active = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=100&search=${U}S&status=active`,
      { token },
    );
    expect(active.status).toBe(200);
    expect(names(active).sort()).toEqual([`${U}SMMM`, `${U}SZZZ`]);
  });

  test('rejects an unknown status with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?status=not_a_status`, { token });
    expect(res.status).toBe(400);
  });
});

describe('GET /matters sorting', () => {
  test('sort=name:asc orders by name ascending', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=100&search=${U}S&sort=name:asc`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(names(res)).toEqual([`${U}SAAA`, `${U}SMMM`, `${U}SZZZ`]);
  });

  test('sort=name:desc reverses the order', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=100&search=${U}S&sort=name:desc`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(names(res)).toEqual([`${U}SZZZ`, `${U}SMMM`, `${U}SAAA`]);
  });

  test('sortBy/order sorts the same way as the sort model', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=100&search=${U}S&sortBy=name&order=asc`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(names(res)).toEqual([`${U}SAAA`, `${U}SMMM`, `${U}SZZZ`]);
  });

  test('rejects an unknown sort field with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?sort=name;drop:asc`, { token });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown sort direction with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?sort=name:sideways`, { token });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown sortBy with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?sortBy=secretColumn`, { token });
    expect(res.status).toBe(400);
  });
});

describe('ethical wall', () => {
  /**
   * Matter visibility is an ethical wall: a regular member sees only matters they
   * belong to. The paged query rebuilt that predicate from scratch, so this guards
   * against it being widened.
   *
   * Seed-independent by construction: it walks every firm the test account belongs
   * to and compares the paged result against the firm's own unpaginated result
   * (the long-standing wall-respecting path), then, for any firm where that result
   * is actually member-scoped, asserts membership on every paged row.
   */
  test('paged list never returns a matter the unpaginated list withholds', async () => {
    const firms = await api.get('/api/users/my-lawfirms', { token });
    expect(firms.status).toBe(200);
    const firmIds = firms.body.lawFirmIds || [];
    expect(firmIds.length).toBeGreaterThan(0);

    let scopedFirmsChecked = 0;

    for (const firmId of firmIds) {
      // eslint-disable-next-line no-await-in-loop
      const baseline = await api.get(`/api/lawfirms/${firmId}/matters`, { token });
      if (baseline.status !== 200) continue;

      // eslint-disable-next-line no-await-in-loop
      const paged = await api.get(`/api/lawfirms/${firmId}/matters?limit=500&page=1`, { token });
      expect(paged.status).toBe(200);

      const baselineIds = new Set(baseline.body.matters.map((m: any) => m.id));
      const pagedIds = paged.body.matters.map((m: any) => m.id);

      // A widened predicate would surface ids the unpaginated path withholds.
      for (const id of pagedIds) expect(baselineIds.has(id)).toBe(true);
      expect(paged.body.totalItems).toBe(baselineIds.size);

      // Where the firm's visible set is genuinely member-scoped (the account is a
      // plain member, not an owner/admin), every paged row must carry the account
      // in its member list.
      const memberScoped = baseline.body.matters.length > 0
        && baseline.body.matters.every((m: any) => (m.memberUserIds || []).includes(userId));
      if (memberScoped) {
        scopedFirmsChecked += 1;
        for (const m of paged.body.matters) {
          expect(m.memberUserIds || []).toContain(userId);
        }
        // A filtered/sorted page must respect the wall too.
        // eslint-disable-next-line no-await-in-loop
        const filtered = await api.get(
          `/api/lawfirms/${firmId}/matters?limit=500&sort=name:asc&search=a`,
          { token },
        );
        expect(filtered.status).toBe(200);
        for (const m of filtered.body.matters) {
          expect(m.memberUserIds || []).toContain(userId);
          expect(baselineIds.has(m.id)).toBe(true);
        }
      }
    }

    // The per-firm comparison above is a wall guard on every firm regardless of
    // role, so the test is meaningful on any seed. This only surfaces the weaker
    // case, where no firm exercised the membership-scoped branch specifically.
    if (scopedFirmsChecked === 0) {
      console.warn('[matters-search] no member-scoped firm in this seed; membership assertions did not run');
    }
  }, 120000);
});

/**
 * Features the matters grid had while it filtered client-side, now that filtering
 * is resolved server-side. Each block seeds its own matters so it is independent
 * of whatever the database already contains.
 */
describe('GET /matters ?paymentOngoing filter', () => {
  const P = `TESTPAY${Date.now()}`;
  const ids: Record<string, any> = {};

  beforeAll(async () => {
    // Three matters that differ only in the two inputs to the derived flag:
    // terminal status, and the manual payment_ongoing override.
    for (const key of ['flagged', 'terminalOnly', 'flaggedActive']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
        token,
        body: { name: `${P}${key}`, description: 'Created by automated test - safe to delete' },
      });
      expect(res.status).toBe(201);
      ids[key] = res.body.matterId;
    }

    const patch = async (id: any, body: any) => {
      const res = await api.put(`/api/lawfirms/${lawFirmId}/matters/${id}`, { token, body });
      expect(res.status).toBe(200);
    };
    await patch(ids.flagged, { status: 'completed', paymentOngoing: true });
    await patch(ids.terminalOnly, { status: 'completed', paymentOngoing: false });
    // Terminal status is a precondition of the flag, so an active matter carrying
    // the override must still be excluded.
    await patch(ids.flaggedActive, { status: 'active', paymentOngoing: true });
  }, 60000);

  afterAll(async () => {
    for (const id of Object.values(ids)) {
      // eslint-disable-next-line no-await-in-loop
      await api.delete(`/api/lawfirms/${lawFirmId}/matters/${id}`, { token });
    }
  }, 60000);

  test('returns only matters whose derived paymentOngoing flag is set', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&paymentOngoing=true&search=${P}`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.matters.map((m: any) => m.id)).toEqual([ids.flagged]);
    expect(res.body.matters[0].paymentOngoing).toBe(true);
  });

  test('every returned matter actually carries the flag', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=500&paymentOngoing=true`, { token });

    expect(res.status).toBe(200);
    expect(res.body.matters.length).toBeGreaterThan(0);
    for (const m of res.body.matters) expect(m.paymentOngoing).toBe(true);
  });

  test('paymentOngoing=false leaves the result unfiltered', async () => {
    const off = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=500&search=${P}&paymentOngoing=false`, { token });
    const none = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=500&search=${P}`, { token });

    expect(off.status).toBe(200);
    expect(off.body.matters.map((m: any) => m.id).sort()).toEqual(none.body.matters.map((m: any) => m.id).sort());
    expect(off.body.matters).toHaveLength(3);
  });

  test('composes with the status filter', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${P}&paymentOngoing=true&status=active`,
      { token },
    );

    expect(res.status).toBe(200);
    // The only flagged matter is completed, so ANDing an active status matches nothing.
    expect(res.body.matters).toEqual([]);
  });

  test('rejects a non-boolean paymentOngoing with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/matters?paymentOngoing=maybe`, { token });
    expect(res.status).toBe(400);
  });
});

describe('GET /matters category subtree filter and category/leadUser sorting', () => {
  const C = `TESTCAT${Date.now()}`;
  // `matters.category` stores the full ' > '-joined path of the category tree, so
  // filtering on a parent must also match its descendants. PARENTX exists to prove
  // the match is a path-segment prefix and not a bare string prefix.
  const CATS = {
    parent: `${C}PARENT`,
    child: `${C}PARENT > ${C}CHILD`,
    grandchild: `${C}PARENT > ${C}CHILD > ${C}LEAF`,
    sibling: `${C}PARENTX`,
    unrelated: `${C}ZOTHER`,
  };
  const ids: Record<string, any> = {};

  beforeAll(async () => {
    for (const [key, category] of Object.entries(CATS)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
        token,
        body: { name: `${C}${key}`, category, description: 'Created by automated test - safe to delete' },
      });
      expect(res.status).toBe(201);
      ids[key] = res.body.matterId;
    }
  }, 60000);

  afterAll(async () => {
    for (const id of Object.values(ids)) {
      // eslint-disable-next-line no-await-in-loop
      await api.delete(`/api/lawfirms/${lawFirmId}/matters/${id}`, { token });
    }
  }, 60000);

  test('a parent category includes its subcategories', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&category=${encodeURIComponent(CATS.parent)}`,
      { token },
    );

    expect(res.status).toBe(200);
    const got = res.body.matters.map((m: any) => m.id).sort();
    expect(got).toEqual([ids.parent, ids.child, ids.grandchild].sort());
  });

  test('a leaf category matches only itself', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&category=${encodeURIComponent(CATS.grandchild)}`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.matters.map((m: any) => m.id)).toEqual([ids.grandchild]);
  });

  test('an intermediate category includes only what is beneath it', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&category=${encodeURIComponent(CATS.child)}`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.matters.map((m: any) => m.id).sort()).toEqual([ids.child, ids.grandchild].sort());
  });

  // Regression guard: matching with a bare `like 'PARENT%'` would wrongly sweep in
  // PARENTX, which is a different top-level category, not a child.
  test('does not match a category that merely starts with the same text', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&category=${encodeURIComponent(CATS.parent)}`,
      { token },
    );

    expect(res.body.matters.map((m: any) => m.id)).not.toContain(ids.sibling);
  });

  test('sort=category:asc orders by the stored category path', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sort=category:asc`,
      { token },
    );

    expect(res.status).toBe(200);
    const seeded = res.body.matters.filter((m: any) => m.name.startsWith(C)).map((m: any) => m.category);
    expect(seeded).toHaveLength(5);
    expect(seeded).toEqual([...seeded].sort((a, b) => a.localeCompare(b)));
  });

  test('sort=category:desc reverses that order', async () => {
    const asc = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sort=category:asc`,
      { token },
    );
    const desc = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sort=category:desc`,
      { token },
    );

    expect(desc.status).toBe(200);
    const ascCats = asc.body.matters.filter((m: any) => m.name.startsWith(C)).map((m: any) => m.category);
    const descCats = desc.body.matters.filter((m: any) => m.name.startsWith(C)).map((m: any) => m.category);
    expect(descCats).toEqual([...ascCats].reverse());
  });

  // The seeded matters all share one lead (the test account is the only member
  // available to this suite), so this asserts the field is accepted and resolves
  // in both the page CTE and the outer select rather than asserting a distinct order.
  test('sort=leadUser:asc is accepted and returns the full result set', async () => {
    const sorted = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sort=leadUser:asc`,
      { token },
    );
    const baseline = await api.get(`/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}`, { token });

    expect(sorted.status).toBe(200);
    expect(sorted.body.matters.map((m: any) => m.id).sort())
      .toEqual(baseline.body.matters.map((m: any) => m.id).sort());
    // Ordering by the lead's NAME, not the raw uid: every row resolves a name.
    for (const m of sorted.body.matters) expect(typeof m.leadUserName).toBe('string');
  });

  test('sort=leadUser:desc and the sortBy/order form are accepted too', async () => {
    const desc = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sort=leadUser:desc`,
      { token },
    );
    expect(desc.status).toBe(200);

    const legacy = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sortBy=leadUser&order=asc`,
      { token },
    );
    expect(legacy.status).toBe(200);

    const byCategory = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sortBy=category&order=desc`,
      { token },
    );
    expect(byCategory.status).toBe(200);
  });

  test('paging a leadUser-sorted result stays consistent with the whole set', async () => {
    const all = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=500&search=${C}&sort=leadUser:asc`,
      { token },
    );
    const p1 = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=2&page=1&search=${C}&sort=leadUser:asc`,
      { token },
    );
    const p2 = await api.get(
      `/api/lawfirms/${lawFirmId}/matters?limit=2&page=2&search=${C}&sort=leadUser:asc`,
      { token },
    );

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.body.totalItems).toBe(all.body.matters.length);
    // The `c.id asc` tiebreaker makes paging over equal sort keys deterministic,
    // so the two pages must not overlap.
    const p1Ids = new Set(p1.body.matters.map((m: any) => m.id));
    for (const m of p2.body.matters) expect(p1Ids.has(m.id)).toBe(false);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
