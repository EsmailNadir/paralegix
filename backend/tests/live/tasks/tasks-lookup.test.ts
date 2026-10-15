/**
 * Task lookup (typeahead) API - real integration tests.
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

describe('GET /api/lawfirms/:lawFirmId/tasks/lookup', () => {
  test('returns a { items, hasMore } envelope of slim picker rows', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup`, { token });

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
    expect(row.assignedTo).toBeUndefined();
    expect(row.assignedToName).toBeUndefined();
    expect(row.clientIds).toBeUndefined();
    expect(row.dependencies).toBeUndefined();
  });

  test('honours ?limit and rejects a limit above the schema cap', async () => {
    const limited = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?limit=2`, { token });
    expect(limited.status).toBe(200);
    expect(limited.body.items.length).toBeLessThanOrEqual(2);

    const tooBig = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?limit=500`, { token });
    expect(tooBig.status).toBe(400);
  });

  // Regression: a user typing `%` must search for that literal character rather
  // than matching every task (toIlikeTerm escapes LIKE wildcards).
  test('treats a LIKE wildcard in the search term literally', async () => {
    const unfiltered = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?limit=50`, { token });
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.items.length).toBeGreaterThan(0);

    const wildcard = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?search=%25&limit=50`, { token });
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.items.length).toBeLessThan(unfiltered.body.items.length);
    // Anything that does come back genuinely contains the character.
    for (const item of wildcard.body.items) {
      expect(item.label).toContain('%');
    }

    // `_` is the other LIKE wildcard: it must not match an arbitrary character.
    const underscore = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?search=_&limit=50`, { token });
    expect(underscore.status).toBe(200);
    expect(underscore.body.items.length).toBeLessThan(unfiltered.body.items.length);
  });

  test('?ids resolves exactly the requested tasks', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?limit=50`, { token });
    const target = all.body.items[0];

    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?ids=${target.id}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(target.id);
    expect(res.body.items[0].label).toBe(target.label);
  });

  test('ignores ?search when ?ids is supplied', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?limit=50`, { token });
    const target = all.body.items[0];

    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks/lookup?ids=${target.id}&search=zzz-no-such-task-zzz`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([target.id]);
  });

  // Regression: an id-resolution request that resolves to nothing must return
  // nothing. Falling back to an unfiltered page would make a picker holding a
  // stale id label its selection with an arbitrary unrelated task.
  test('returns an empty result when ?ids contains no usable id', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?ids=not-a-uuid`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);

    const multiple = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks/lookup?ids=not-a-uuid,also-bogus`,
      { token },
    );
    expect(multiple.status).toBe(200);
    expect(multiple.body.items).toEqual([]);
    expect(multiple.body.hasMore).toBe(false);
  });

  test('rejects request with no auth token', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup`, {});
    expect(res.status).toBe(401);
  });
});

/**
 * Task visibility follows the matter ethical wall: firm-level (matter-less) tasks
 * are visible firm-wide, matter-scoped tasks only to members of that matter, and
 * firm owners/admins see everything. The lookup endpoint must apply exactly the
 * same scoping as the full task list, or a dropdown would leak task titles past
 * the wall.
 *
 * The checks run across every firm the test account belongs to, so both branches
 * get exercised: the seeded account owns one firm (sees all of its tasks) and is
 * a plain member of another (sees only its own subset).
 */
describe('task lookup visibility', () => {
  test('never surfaces a task the full list withholds, in any of the user\'s firms', async () => {
    const firmsRes = await api.get('/api/users/my-lawfirms', { token });
    expect(firmsRes.status).toBe(200);
    const firmIds = firmsRes.body.lawFirmIds || [];
    expect(firmIds.length).toBeGreaterThan(0);

    let firmsChecked = 0;

    for (const firmId of firmIds) {
      const listRes = await api.get(`/api/lawfirms/${firmId}/tasks`, { token });
      const lookupRes = await api.get(`/api/lawfirms/${firmId}/tasks/lookup?limit=50`, { token });

      // A firm whose role lacks tasks.view is out of scope for this check, but
      // the two endpoints must at least agree on refusing it.
      if (listRes.status !== 200) {
        expect(lookupRes.status).not.toBe(200);
        continue;
      }
      expect(lookupRes.status).toBe(200);
      firmsChecked += 1;

      const visibleIds = new Set(listRes.body.tasks.map((t: any) => t.id));
      for (const item of lookupRes.body.items) {
        expect(visibleIds.has(item.id)).toBe(true);
      }

      // Below the page cap the two must describe the identical visible set, so
      // the lookup can neither over-expose nor silently hide tasks.
      if (visibleIds.size <= 50) {
        expect(lookupRes.body.items).toHaveLength(visibleIds.size);
      }

      // The same wall applies to id resolution: asking for an id the user cannot
      // see must not resolve it.
      const invisibleId = '00000000-0000-4000-8000-000000000000';
      const byId = await api.get(`/api/lawfirms/${firmId}/tasks/lookup?ids=${invisibleId}`, { token });
      expect(byId.status).toBe(200);
      expect(byId.body.items).toHaveLength(0);
    }

    expect(firmsChecked).toBeGreaterThan(0);
  });
});

/**
 * `?clientId=` scoping. The firm-side "share files with client" picker offers a
 * client's own tasks as places to share from, so the parameter has to narrow the
 * result and never widen it: an unscoped list there would offer another client's
 * tasks as a source, and the file shared from one would land in the wrong
 * client's portal. Mirrors the matter lookup's scoping tests.
 */
describe('task lookup ?clientId scoping', () => {
  const U = `TESTTLKP${Date.now()}`;
  const SCOPED_TITLE = `${U}SCOPED`;
  const OTHER_TITLE = `${U}OTHER`;
  const createdTaskIds: any = [];
  let scopedClientId: any;

  beforeAll(async () => {
    const client = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
      token,
      body: { name: `${U}CLIENT` },
    });
    expect(client.status).toBe(201);
    scopedClientId = client.body.clientId;
    expect(typeof scopedClientId).toBe('string');

    // One task linked to that client, and one linked to nobody. The second is
    // the control: it must never appear under the first's clientId.
    const scoped = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: {
        title: SCOPED_TITLE,
        description: 'Created by automated test - safe to delete',
        status: 'open',
        clientIds: [scopedClientId],
      },
    });
    expect(scoped.status).toBe(201);
    createdTaskIds.push(scoped.body.taskId || scoped.body.task?.id);

    const other = await api.post(`/api/lawfirms/${lawFirmId}/tasks`, {
      token,
      body: {
        title: OTHER_TITLE,
        description: 'Created by automated test - safe to delete',
        status: 'open',
      },
    });
    expect(other.status).toBe(201);
    createdTaskIds.push(other.body.taskId || other.body.task?.id);
  }, 60000);

  afterAll(async () => {
    for (const id of createdTaskIds) {
      // eslint-disable-next-line no-await-in-loop
      if (id) await api.delete(`/api/lawfirms/${lawFirmId}/tasks/${id}`, { token });
    }
    if (scopedClientId) await api.delete(`/api/lawfirms/${lawFirmId}/clients/${scopedClientId}`, { token });
  }, 60000);

  test("restricts the result to that client's tasks", async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks/lookup?clientId=${scopedClientId}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    const labels = res.body.items.map((i: any) => i.label);
    expect(labels).toContain(SCOPED_TITLE);
    // The unlinked task is visible to this user but not to this client.
    expect(labels).not.toContain(OTHER_TITLE);
  });

  test('is additive: every scoped result is a task the caller can see unscoped', async () => {
    const scoped = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks/lookup?clientId=${scopedClientId}&limit=50`,
      { token },
    );
    expect(scoped.status).toBe(200);
    expect(scoped.body.items.length).toBeGreaterThan(0);

    // Checked against an unscoped id resolution rather than an unscoped browse
    // page: browsing returns one title-ordered window, so a scoped task that
    // sorts past that window would be missing from it for reasons that have
    // nothing to do with scoping. Id resolution answers for the exact ids.
    const ids = scoped.body.items.map((i: any) => i.id).join(',');
    const resolved = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?ids=${ids}&limit=50`, { token });

    expect(resolved.status).toBe(200);
    expect(resolved.body.items).toHaveLength(scoped.body.items.length);
  });

  test('combines with ?search rather than replacing it', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks/lookup?clientId=${scopedClientId}&search=${OTHER_TITLE}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    // The searched task belongs to no client, so the two predicates AND to nothing.
    expect(res.body.items).toEqual([]);
  });

  // A scoped request whose scope cannot be resolved must return nothing. Silently
  // dropping an unusable clientId would answer "this client's tasks" with the
  // firm's whole list, which is the misattribution the scoping exists to prevent.
  test('returns nothing when ?clientId is not a usable id', async () => {
    const bogus = await api.get(`/api/lawfirms/${lawFirmId}/tasks/lookup?clientId=not-a-uuid`, { token });
    expect(bogus.status).toBe(200);
    expect(bogus.body.items).toEqual([]);
    expect(bogus.body.hasMore).toBe(false);

    const unknown = await api.get(
      `/api/lawfirms/${lawFirmId}/tasks/lookup?clientId=00000000-0000-4000-8000-000000000000&limit=50`,
      { token },
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
