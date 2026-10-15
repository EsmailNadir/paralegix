/**
 * Server-side clients search / sort / pagination - real integration tests.
 *
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 * Start the server first (`npm run dev`) pointed at a disposable DB, then run
 * the suite with the test auth env (see tests/validate-test-env.js).
 *
 * The suite seeds its own clients under a run-unique alphanumeric prefix so every
 * assertion is independent of whatever the database already contains.
 *
 * Clients carry no ethical wall (`clients.view` alone gates them), so there is no
 * visibility case here; the matters equivalent has one.
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let lawFirmId: any;

// Run-unique and deliberately free of `_` and `%` so the wildcard-escaping probes
// below are the only place those characters appear.
const U = `TESTCSRCH${Date.now()}`;

// `_A` vs `XA` differ only at the position an unescaped LIKE `_` would wildcard
// over, which is what makes them a decisive escaping probe.
const WILDCARD_NAMES = [`${U}_A`, `${U}XA`];
// Uppercase-letter-only suffixes sort identically under any collation.
const SORT_NAMES = [`${U}SZZZ`, `${U}SAAA`, `${U}SMMM`];
const ALL_NAMES = [...WILDCARD_NAMES, ...SORT_NAMES];

/** name -> clientId for every client this suite seeded. */
const createdByName = new Map();

async function createClient(name: any) {
  const res = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
    token,
    body: { name, organization: 'Created by automated test - safe to delete' },
  });
  if (res.status !== 201) throw new Error(`seed create failed (${res.status}): ${JSON.stringify(res.body)}`);
  createdByName.set(name, res.body.clientId);
  return res.body.clientId;
}

function names(res: any) {
  return (res.body.clients || []).map((c: any) => c.name);
}

/** Only the clients this suite seeded, in response order. */
function seededNames(res: any) {
  return names(res).filter((n: any) => n.startsWith(U));
}

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  lawFirmId = await getPrimaryLawFirmId(token);

  for (const n of ALL_NAMES) {
    // eslint-disable-next-line no-await-in-loop
    await createClient(n);
  }
}, 60000);

afterAll(async () => {
  for (const id of createdByName.values()) {
    // eslint-disable-next-line no-await-in-loop
    await api.delete(`/api/lawfirms/${lawFirmId}/clients/${id}`, { token });
  }
}, 60000);

describe('GET /clients (unpaginated) backwards compatibility', () => {
  test('omits totalItems and returns the full client list', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.clients)).toBe(true);
    expect(res.body).not.toHaveProperty('totalItems');
    // Every seeded client is present, so the default list is genuinely unwindowed.
    for (const n of ALL_NAMES) {
      expect(names(res)).toContain(n);
    }
  });

  test('clients carry the enriched entity shape', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });
    const seeded = res.body.clients.find((c: any) => c.name === SORT_NAMES[0]);

    expect(seeded).toBeDefined();
    expect(seeded).toHaveProperty('id');
    expect(seeded).toHaveProperty('status');
    expect(seeded).toHaveProperty('organization');
    // matterIds is the lateral aggregate the paged query has to keep supplying.
    expect(Array.isArray(seeded.matterIds)).toBe(true);
  });

  test('?portalOnly=true still narrows to portal-linked clients', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });
    const portal = await api.get(`/api/lawfirms/${lawFirmId}/clients?portalOnly=true`, { token });

    expect(portal.status).toBe(200);
    expect(portal.body).not.toHaveProperty('totalItems');
    const allIds = new Set(all.body.clients.map((c: any) => c.id));
    for (const c of portal.body.clients) {
      expect(allIds.has(c.id)).toBe(true);
      expect(c.userId).toBeTruthy();
    }
    // The seeded clients have no portal user, so none of them may appear.
    expect(portal.body.clients.some((c: any) => c.name.startsWith(U))).toBe(false);
  });
});

describe('GET /clients pagination', () => {
  test('limit windows the result and reports the full count', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=2`, { token });

    expect(res.status).toBe(200);
    expect(res.body.clients.length).toBeLessThanOrEqual(2);
    expect(typeof res.body.totalItems).toBe('number');
    // The suite seeds 5 clients, so the full result always exceeds a 2-row page.
    expect(res.body.totalItems).toBeGreaterThan(2);
  });

  test('totalItems matches the unpaginated result size', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients`, { token });
    const paged = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=1`, { token });

    expect(paged.body.totalItems).toBe(all.body.clients.length);
  });

  test('page 2 returns a different window than page 1', async () => {
    const p1 = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=1&page=1`, { token });
    const p2 = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=1&page=2`, { token });

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.body.clients).toHaveLength(1);
    expect(p2.body.clients).toHaveLength(1);
    expect(p1.body.clients[0].id).not.toBe(p2.body.clients[0].id);
  });

  test('rejects a limit above the schema cap with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=5000`, { token });
    expect(res.status).toBe(400);
  });

  // The window count rides on the returned rows, so an out-of-range page has no
  // row to read it from. Reporting 0 there is indistinguishable from "no matches",
  // and a UI holding a page number from a wider filter renders "no results" instead
  // of clamping back into range. The empty page must still carry the true total.
  test('an out-of-range page reports the true total, not 0', async () => {
    const first = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=5&page=1`, { token });
    expect(first.status).toBe(200);
    const total = first.body.totalItems;
    expect(total).toBeGreaterThan(0);

    const beyond = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=5&page=1000`, { token });

    expect(beyond.status).toBe(200);
    expect(beyond.body.clients).toEqual([]);
    expect(beyond.body.totalItems).toBe(total);
  });

  test('an out-of-range page keeps the filter total, not the unfiltered one', async () => {
    const inRange = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=2&page=1&search=${U}`,
      { token },
    );
    expect(inRange.status).toBe(200);
    expect(inRange.body.totalItems).toBe(ALL_NAMES.length);

    const beyond = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=2&page=50&search=${U}`,
      { token },
    );

    expect(beyond.status).toBe(200);
    expect(beyond.body.clients).toEqual([]);
    // The seeded-prefix total, not the firm-wide one.
    expect(beyond.body.totalItems).toBe(ALL_NAMES.length);
  });

  // The counterpart: a filter that genuinely matches nothing must still report 0,
  // so the fallback count cannot be masking a real empty result.
  test('a genuinely empty first page still reports 0', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=5&page=1&search=${U}NOSUCHCLIENT`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });
});

describe('GET /clients?search=', () => {
  test('narrows the result set to matching clients', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=1`, { token });
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=100&search=${U}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBe(ALL_NAMES.length);
    expect(res.body.totalItems).toBeLessThan(all.body.totalItems);
    expect(names(res).sort()).toEqual([...ALL_NAMES].sort());
  });

  test('a literal underscore does not act as a single-character wildcard', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=100&search=${encodeURIComponent(`${U}_A`)}`,
      { token },
    );

    expect(res.status).toBe(200);
    // Unescaped, `_` would also match `${U}XA`.
    expect(names(res)).toEqual([`${U}_A`]);
  });

  test('a literal percent does not match everything', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=100&search=${encodeURIComponent(`${U}%A`)}`,
      { token },
    );

    expect(res.status).toBe(200);
    // Unescaped, `%` would match both seeded wildcard probes.
    expect(res.body.clients).toHaveLength(0);
    expect(res.body.totalItems).toBe(0);
  });

  test('a bare percent does not return the whole firm', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=1`, { token });
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=100&search=${encodeURIComponent('%')}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.totalItems).toBeLessThan(all.body.totalItems);
  });

  test('matches on organization as well as name', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=500&search=${encodeURIComponent('Created by automated test')}`,
      { token },
    );

    expect(res.status).toBe(200);
    // Every seeded client shares that organization string.
    for (const n of ALL_NAMES) expect(names(res)).toContain(n);
  });
});

describe('GET /clients sorting', () => {
  test('sort=name:asc orders by name ascending', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=100&search=${U}S&sort=name:asc`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(seededNames(res)).toEqual([`${U}SAAA`, `${U}SMMM`, `${U}SZZZ`]);
  });

  test('sort=name:desc reverses the order', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=100&search=${U}S&sort=name:desc`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(seededNames(res)).toEqual([`${U}SZZZ`, `${U}SMMM`, `${U}SAAA`]);
  });

  test('sortBy/order sorts the same way as the sort model', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients?limit=100&search=${U}S&sortBy=name&order=asc`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(seededNames(res)).toEqual([`${U}SAAA`, `${U}SMMM`, `${U}SZZZ`]);
  });

  test('rejects an unknown sort field with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?sort=name;drop:asc`, { token });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown sort direction with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?sort=name:sideways`, { token });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown sortBy with 400', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?sortBy=secretColumn`, { token });
    expect(res.status).toBe(400);
  });
});

describe('GET /clients?ids= batch branch', () => {
  // The batch-resolve branch is a separate feature that shares the route. Adding
  // list validation must not disturb it.
  test('still resolves exactly the requested clients', async () => {
    const ids = ALL_NAMES.map((n) => createdByName.get(n));
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?ids=${ids.join(',')}`, { token });

    expect(res.status).toBe(200);
    expect(res.body.clients.map((c: any) => c.id).sort()).toEqual([...ids].sort());
  });
});

/**
 * `taskCount` restores the per-client task total the grid used to derive in the
 * browser by loading the firm's entire task list. It counts the tasks sitting on
 * any matter linked to the client, which is the definition the removed
 * client-side derivation used.
 */
describe('GET /clients taskCount', () => {
  const T = `TESTTC${Date.now()}`;
  const TASK_COUNT = 3;
  let clientId: any;
  let matterId: any;
  let emptyClientId: any;
  const createdTaskIds: any = [];

  function findClient(res: any, id: any) {
    return (res.body.clients || []).find((c: any) => c.id === id);
  }

  beforeAll(async () => {
    // One matter carrying a new client, and three tasks on that matter.
    const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
      token,
      body: {
        name: `${T}MATTER`,
        description: 'Created by automated test - safe to delete',
        clients: [{ name: `${T}WITHTASKS` }],
      },
    });
    expect(matterRes.status).toBe(201);
    matterId = matterRes.body.matterId;

    const detail = await api.get(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, { token });
    expect(detail.status).toBe(200);
    clientId = (detail.body.clients || [])[0]?.id;
    expect(typeof clientId).toBe('string');

    for (let i = 0; i < TASK_COUNT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const taskRes = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
        token,
        body: {
          title: `${T}TASK${i}`,
          description: 'Created by automated test - safe to delete',
          matterId,
        },
      });
      expect(taskRes.status).toBe(201);
      createdTaskIds.push(taskRes.body.taskId || taskRes.body.task?.id);
    }

    // A client with no matters at all, to pin the zero case.
    const emptyRes = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
      token,
      body: { name: `${T}NOTASKS`, organization: 'Created by automated test - safe to delete' },
    });
    expect(emptyRes.status).toBe(201);
    emptyClientId = emptyRes.body.clientId;
  }, 120000);

  afterAll(async () => {
    for (const id of createdTaskIds) {
      // eslint-disable-next-line no-await-in-loop
      if (id) await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${id}`, { token });
    }
    if (matterId) await api.delete(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, { token });
    // Creating a matter with inline clients find-or-creates a firm `clients` row;
    // deleting the matter only unlinks it, so it needs its own delete.
    if (clientId) await api.delete(`/api/lawfirms/${lawFirmId}/clients/${clientId}`, { token });
    if (emptyClientId) await api.delete(`/api/lawfirms/${lawFirmId}/clients/${emptyClientId}`, { token });
  }, 120000);

  test('every client row carries a numeric taskCount', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=25`, { token });

    expect(res.status).toBe(200);
    expect(res.body.clients.length).toBeGreaterThan(0);
    for (const c of res.body.clients) {
      expect(typeof c.taskCount).toBe('number');
      expect(c.taskCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('counts the tasks on the client\'s matters', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=500&search=${T}`, { token });

    expect(res.status).toBe(200);
    const withTasks = findClient(res, clientId);
    expect(withTasks).toBeDefined();
    expect(withTasks.taskCount).toBe(TASK_COUNT);
    expect(withTasks.matterIds).toContain(matterId);
  });

  test('is zero for a client with no matters', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=500&search=${T}`, { token });

    const empty = findClient(res, emptyClientId);
    expect(empty).toBeDefined();
    expect(empty.matterIds).toEqual([]);
    expect(empty.taskCount).toBe(0);
  });

  test('tracks a task added after the fact', async () => {
    const before = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=500&search=${T}`, { token });
    expect(findClient(before, clientId).taskCount).toBe(TASK_COUNT);

    const extra = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: {
        title: `${T}EXTRA`,
        description: 'Created by automated test - safe to delete',
        matterId,
      },
    });
    expect(extra.status).toBe(201);
    const extraId = extra.body.taskId || extra.body.task?.id;
    createdTaskIds.push(extraId);

    const after = await api.get(`/api/lawfirms/${lawFirmId}/clients?limit=500&search=${T}`, { token });
    expect(findClient(after, clientId).taskCount).toBe(TASK_COUNT + 1);
  }, 60000);

  test('is present on the unpaginated list too', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients?search=${T}`, { token });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('totalItems');
    expect(typeof findClient(res, clientId).taskCount).toBe('number');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
