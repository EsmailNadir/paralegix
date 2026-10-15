/**
 * Client lookup (typeahead) API - real integration tests.
 *
 * Tests hit the REAL running server at localhost:5001 (see tests/setup.js).
 * Start the server first (`npm run dev`) pointed at a disposable DB, then run
 * the suite with the test auth env (see tests/validate-test-env.js).
 */

const { api } = require('../setup');
const { getTestToken } = require('../auth-helper');
const { getPrimaryLawFirmId } = require('../helpers');

let token: any;
let actingUserId: any;
let lawFirmId: any;

beforeAll(async () => {
  const auth = await getTestToken();
  token = auth.token;
  actingUserId = auth.userId;
  lawFirmId = await getPrimaryLawFirmId(token);
});

describe('GET /api/lawfirms/:lawFirmId/clients/lookup', () => {
  test('returns a { items, hasMore } envelope of slim picker rows', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup`, { token });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.hasMore).toBe('boolean');
    expect(res.body.items.length).toBeGreaterThan(0);

    const row = res.body.items[0];
    expect(typeof row.id).toBe('string');
    expect(typeof row.label).toBe('string');
    expect(row.label.length).toBeGreaterThan(0);
    // A picker row is deliberately slim: none of the enriched profile fields the
    // full client list pays JOINs for should be present.
    expect(row.matterIds).toBeUndefined();
    expect(row.phone).toBeUndefined();
    expect(row.address).toBeUndefined();
    expect(row.billingRates).toBeUndefined();
  });

  test('honours ?limit and rejects a limit above the schema cap', async () => {
    const limited = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=2`, { token });
    expect(limited.status).toBe(200);
    expect(limited.body.items.length).toBeLessThanOrEqual(2);

    const tooBig = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=500`, { token });
    expect(tooBig.status).toBe(400);
  });

  // Regression: a user typing `%` must search for that literal character rather
  // than matching every client (toIlikeTerm escapes LIKE wildcards).
  test('treats a LIKE wildcard in the search term literally', async () => {
    const unfiltered = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.items.length).toBeGreaterThan(0);

    // Anchor on a client carrying neither wildcard, rather than on result
    // counts. Counts are seed-dependent: a firm whose client names happen to
    // contain `_` makes a literal underscore search legitimately broad, which
    // would fail a count comparison even though the escaping is correct.
    const clean = unfiltered.body.items.find((item: any) => {
      const haystack = `${item.label} ${item.sublabel || ''}`;
      return !haystack.includes('%') && !haystack.includes('_');
    });
    expect(clean).toBeDefined();

    const wildcard = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?search=%25&limit=50`, { token });
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.items.map((i: any) => i.id)).not.toContain(clean.id);

    // `_` is the other LIKE wildcard: it must not match an arbitrary character.
    const underscore = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?search=_&limit=50`, { token });
    expect(underscore.status).toBe(200);
    expect(underscore.body.items.map((i: any) => i.id)).not.toContain(clean.id);
  });

  test('?ids resolves exactly the requested clients', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const target = all.body.items[0];

    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?ids=${target.id}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(target.id);
    expect(res.body.items[0].label).toBe(target.label);
  });

  test('ignores ?search when ?ids is supplied', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const target = all.body.items[0];

    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?ids=${target.id}&search=zzz-no-such-client-zzz`,
      { token },
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([target.id]);
  });

  // Regression: an id-resolution request that resolves to nothing must return
  // nothing. Falling back to an unfiltered page would make a picker holding a
  // stale id label its selection with an arbitrary unrelated client.
  test('returns an empty result when ?ids contains no usable id', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?ids=not-a-uuid`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);

    const multiple = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?ids=not-a-uuid,also-bogus`,
      { token },
    );
    expect(multiple.status).toBe(200);
    expect(multiple.body.items).toEqual([]);
    expect(multiple.body.hasMore).toBe(false);
  });

  test('?portalOnly=true narrows the result to portal-linked clients', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const portal = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?portalOnly=true&limit=50`, { token });

    expect(portal.status).toBe(200);
    const allIds = new Set(all.body.items.map((i: any) => i.id));
    for (const item of portal.body.items) {
      expect(allIds.has(item.id)).toBe(true);
    }
    expect(portal.body.items.length).toBeLessThanOrEqual(all.body.items.length);
  });

  test('rejects request with no auth token', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup`, {});
    expect(res.status).toBe(401);
  });
});

/**
 * `userId` on the slim row: the linked portal user's Firebase UID, or null.
 *
 * Some pickers choose a PERSON rather than a client record. The e-signature
 * recipient picker is the one that makes this load-bearing: a signature request is
 * addressed by UID, so a picker holding only the client-row id would ask the wrong
 * party to sign a document. Paired with `?portalOnly=true` the field is guaranteed
 * populated, which is exactly the combination that flow uses.
 */
describe('client lookup userId', () => {
  test('every slim row carries a userId key, string or null', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(item).toHaveProperty('userId');
      expect(item.userId === null || typeof item.userId === 'string').toBe(true);
    }
  });

  // The guarantee the signature flow depends on: filtering to portal-linked
  // clients must never yield a row whose UID is missing.
  test('?portalOnly=true yields rows whose userId is always populated', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?portalOnly=true&limit=50`, { token });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(typeof item.userId).toBe('string');
      expect(item.userId.length).toBeGreaterThan(0);
    }
  });

  test('resolving a portal-linked client by id keeps its userId', async () => {
    const portal = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?portalOnly=true&limit=50`, { token });
    const target = portal.body.items[0];

    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?ids=${target.id}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].userId).toBe(target.userId);
  });

  // Slim and full must agree on who the person is. If they ever disagreed, a
  // picker's answer would depend on which mode it happened to request.
  test('slim and ?full=true report the same userId for the same client', async () => {
    const slim = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const full = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?full=true&limit=50`, { token });

    expect(full.status).toBe(200);
    const fullById = new Map<string, any>(full.body.items.map((i: any) => [i.id, i]));
    for (const item of slim.body.items) {
      expect(fullById.get(item.id).userId || null).toBe(item.userId);
    }
  });
});

/**
 * `?userIds=`. The second spelling of the label-resolution mode, keyed on
 * `clients.user_id` (the linked portal account's Firebase UID) rather than the
 * `clients` row id.
 *
 * Some pickers select a PERSON rather than a client record: a messaging
 * participant is stored by UID, so a picker handed one has no client-row id to
 * resolve a label through and could neither pin nor un-select its own selection.
 * Firebase UIDs are opaque text, not uuids, which is why this branch screens them
 * for emptiness only.
 */
describe('client lookup ?userIds', () => {
  let portalRow: any;

  beforeAll(async () => {
    const portal = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?portalOnly=true&limit=50`,
      { token },
    );
    expect(portal.status).toBe(200);
    portalRow = portal.body.items[0];
    expect(typeof portalRow.userId).toBe('string');
  });

  test('resolves exactly the client holding that portal UID', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?userIds=${encodeURIComponent(portalRow.userId)}`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(portalRow.id);
    expect(res.body.items[0].userId).toBe(portalRow.userId);
    expect(res.body.items[0].label).toBe(portalRow.label);
    expect(res.body.hasMore).toBe(false);
  });

  test('ignores ?search when ?userIds is supplied', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?userIds=${encodeURIComponent(portalRow.userId)}&search=zzz-no-such-client-zzz`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toEqual([portalRow.id]);
  });

  // The same guarantee the `ids` branch makes. Falling through to browse would
  // answer "label these specific people" with a page of unrelated ones, so a
  // picker holding a stale UID would show someone else's name in its place.
  test('returns an empty result when ?userIds matches nobody', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?userIds=no-such-portal-uid-zzz`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);

    const multiple = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?userIds=no-such-portal-uid-zzz,also-nobody`,
      { token },
    );
    expect(multiple.status).toBe(200);
    expect(multiple.body.items).toEqual([]);
    expect(multiple.body.hasMore).toBe(false);
  });

  // `ids` and `userIds` are two spellings of one mode. Silently preferring one
  // would let a caller believe it resolved values it never asked about.
  test('rejects a request supplying both ?ids and ?userIds', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?ids=${portalRow.id}&userIds=${encodeURIComponent(portalRow.userId)}`,
      { token },
    );

    expect(res.status).toBe(400);
  });
});

/**
 * `?full=true`. The template auto-fill picker feeds its selection straight into
 * placeholder merge fields, so it needs the whole client record rather than a
 * label. The enriched mode must stay a strict superset of the slim one: same
 * clients, same order, plus the profile fields.
 */
describe('client lookup ?full=true', () => {
  test('returns the enriched client while keeping label/sublabel', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?full=true&limit=50`, { token });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.hasMore).toBe('boolean');
    expect(res.body.items.length).toBeGreaterThan(0);

    const row = res.body.items[0];
    // The picker renders the same way for either shape, so the labels stay.
    expect(typeof row.id).toBe('string');
    expect(typeof row.label).toBe('string');
    expect(row.label.length).toBeGreaterThan(0);
    expect(row).toHaveProperty('sublabel');

    // The merge fields the template picker reads off the selection.
    expect(row).toHaveProperty('phone');
    expect(row).toHaveProperty('address');
    expect(row).toHaveProperty('organization');
    expect(row).toHaveProperty('preferredContactMethod');
    expect(row).toHaveProperty('status');
    expect(Array.isArray(row.matterIds)).toBe(true);
    expect(row.lawFirmId).toBe(lawFirmId);
    // The linked-user backfill columns are an internal detail of the join.
    expect(row.userName).toBeUndefined();
    expect(row.userEmail).toBeUndefined();
  });

  test('returns the same clients in the same order as slim mode', async () => {
    const slim = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const full = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?full=true&limit=50`, { token });

    expect(full.status).toBe(200);
    expect(full.body.items.map((i: any) => i.id)).toEqual(slim.body.items.map((i: any) => i.id));
    expect(full.body.items.map((i: any) => i.label)).toEqual(slim.body.items.map((i: any) => i.label));
    expect(full.body.hasMore).toBe(slim.body.hasMore);
  });

  test('composes with ?search', async () => {
    const slim = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const term = slim.body.items[0].label.slice(0, 4);

    const slimSearch = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${encodeURIComponent(term)}&limit=50`,
      { token },
    );
    const fullSearch = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${encodeURIComponent(term)}&full=true&limit=50`,
      { token },
    );

    expect(fullSearch.status).toBe(200);
    expect(fullSearch.body.items.map((i: any) => i.id)).toEqual(slimSearch.body.items.map((i: any) => i.id));
  });

  test('composes with ?ids', async () => {
    const all = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const target = all.body.items[0];

    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?ids=${target.id}&full=true`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(target.id);
    expect(res.body.items[0].label).toBe(target.label);
    expect(res.body.items[0]).toHaveProperty('preferredContactMethod');
  });

  test('honours ?portalOnly, so enrichment cannot widen visibility', async () => {
    const slim = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?portalOnly=true&limit=50`, { token });
    const full = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?portalOnly=true&full=true&limit=50`,
      { token },
    );

    expect(full.status).toBe(200);
    expect(full.body.items.map((i: any) => i.id)).toEqual(slim.body.items.map((i: any) => i.id));
  });

  test('returns nothing when ?ids contains no usable id', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?ids=not-a-uuid&full=true`, { token });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });

  test('rejects a full value the schema does not allow', async () => {
    const res = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?full=yes`, { token });
    expect(res.status).toBe(400);
  });
});

/**
 * `?matterId=` scoping. Pickers that attach a client to something already bound
 * to a matter (a document request, a matter-context billing record) must not
 * offer the firm's whole client roster, or a record can be attributed to a client
 * with no connection to the matter.
 */
describe('client lookup ?matterId scoping', () => {
  const U = `TESTCLKP${Date.now()}`;
  const LINKED_CLIENT = `${U}LINKED`;
  const UNLINKED_CLIENT = `${U}UNLINKED`;
  const createdMatterIds: any = [];
  const createdClientIds: any = [];
  let matterId: any;

  beforeAll(async () => {
    // A matter carrying exactly one client, plus a second client linked to no
    // matter at all. The second is the control.
    const matterRes = await api.post(`/api/lawfirms/${lawFirmId}/matters`, {
      token,
      body: {
        name: `${U}MATTER`,
        description: 'Created by automated test - safe to delete',
        clients: [{ name: LINKED_CLIENT }],
      },
    });
    expect(matterRes.status).toBe(201);
    matterId = matterRes.body.matterId;
    createdMatterIds.push(matterId);

    // Creating a matter with inline clients find-or-creates a firm `clients` row;
    // deleting the matter only unlinks it, so the row is tracked for teardown too.
    const detail = await api.get(`/api/lawfirms/${lawFirmId}/matters/${matterId}`, { token });
    expect(detail.status).toBe(200);
    createdClientIds.push((detail.body.clients || [])[0].id);

    const clientRes = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
      token,
      body: { name: UNLINKED_CLIENT, organization: 'Created by automated test - safe to delete' },
    });
    expect(clientRes.status).toBe(201);
    createdClientIds.push(clientRes.body.clientId);
  }, 60000);

  afterAll(async () => {
    for (const id of createdMatterIds) {
      // eslint-disable-next-line no-await-in-loop
      await api.delete(`/api/lawfirms/${lawFirmId}/matters/${id}`, { token });
    }
    for (const id of createdClientIds) {
      // eslint-disable-next-line no-await-in-loop
      await api.delete(`/api/lawfirms/${lawFirmId}/clients/${id}`, { token });
    }
  }, 60000);

  test('restricts the result to that matter\'s clients', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=${matterId}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    const labels = res.body.items.map((i: any) => i.label);
    expect(labels).toContain(LINKED_CLIENT);
    expect(labels).not.toContain(UNLINKED_CLIENT);
  });

  test('is additive: every scoped result also appears unscoped', async () => {
    const unscoped = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?limit=50`, { token });
    const scoped = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=${matterId}&limit=50`,
      { token },
    );

    expect(scoped.status).toBe(200);
    const unscopedIds = new Set(unscoped.body.items.map((i: any) => i.id));
    for (const item of scoped.body.items) expect(unscopedIds.has(item.id)).toBe(true);
    expect(scoped.body.items.length).toBeLessThanOrEqual(unscoped.body.items.length);
  });

  test('combines with ?search rather than replacing it', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=${matterId}&search=${UNLINKED_CLIENT}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  // Same reasoning as the matters equivalent: an unresolvable scope must yield
  // nothing rather than silently falling back to the unscoped roster.
  test('returns nothing when ?matterId is not a usable id', async () => {
    const bogus = await api.get(`/api/lawfirms/${lawFirmId}/clients/lookup?matterId=not-a-uuid`, { token });
    expect(bogus.status).toBe(200);
    expect(bogus.body.items).toEqual([]);
    expect(bogus.body.hasMore).toBe(false);

    const unknown = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=00000000-0000-4000-8000-000000000000`,
      { token },
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
  });

  // The enriched second pass must inherit the matter scope, not just the label
  // pass: a full lookup that reached past it would hand the template picker a
  // client with no connection to the matter, complete with contact details.
  test('composes with ?full=true', async () => {
    const scoped = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=${matterId}&limit=50`,
      { token },
    );
    const full = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=${matterId}&full=true&limit=50`,
      { token },
    );

    expect(full.status).toBe(200);
    expect(full.body.items.map((i: any) => i.id)).toEqual(scoped.body.items.map((i: any) => i.id));
    expect(full.body.items.map((i: any) => i.label)).toContain(LINKED_CLIENT);
    expect(full.body.items.map((i: any) => i.label)).not.toContain(UNLINKED_CLIENT);
    expect(full.body.items[0]).toHaveProperty('preferredContactMethod');
    expect(full.body.items[0].matterIds).toContain(matterId);
  });

  test('composes with ?portalOnly', async () => {
    const scoped = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=${matterId}&limit=50`,
      { token },
    );
    const both = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?matterId=${matterId}&portalOnly=true&limit=50`,
      { token },
    );

    expect(both.status).toBe(200);
    const scopedIds = new Set(scoped.body.items.map((i: any) => i.id));
    for (const item of both.body.items) expect(scopedIds.has(item.id)).toBe(true);
    // The seeded client has no portal user, so the portal filter genuinely bites.
    expect(both.body.items.map((i: any) => i.label)).not.toContain(LINKED_CLIENT);
  });
});

/**
 * `?excludeArchived=true`. Archived means "no longer transacted with", so the
 * pickers that attach a client to new work must not offer one. The trust screens
 * (deposits, withdrawals, minimum balances, deposit requests) are the reason this
 * exists: offering an archived client there books money against a closed
 * relationship.
 *
 * It excludes ONLY 'archived'. 'inactive' is a softer state that stays selectable,
 * matching the `status !== 'archived'` filter those screens applied client-side.
 */
describe('client lookup ?excludeArchived', () => {
  const U = `TESTCLAR${Date.now()}`;
  const ACTIVE_CLIENT = `${U}ACTIVE`;
  const INACTIVE_CLIENT = `${U}INACTIVE`;
  const ARCHIVED_CLIENT = `${U}ARCHIVED`;
  const createdClientIds: any = [];
  let archivedId: any;

  beforeAll(async () => {
    for (const [name, status] of [
      [ACTIVE_CLIENT, 'active'],
      [INACTIVE_CLIENT, 'inactive'],
      [ARCHIVED_CLIENT, 'archived'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
        token,
        body: { name, status, organization: 'Created by automated test - safe to delete' },
      });
      expect(res.status).toBe(201);
      createdClientIds.push(res.body.clientId);
      if (status === 'archived') archivedId = res.body.clientId;
    }
  }, 60000);

  afterAll(async () => {
    for (const id of createdClientIds) {
      // eslint-disable-next-line no-await-in-loop
      await api.delete(`/api/lawfirms/${lawFirmId}/clients/${id}`, { token });
    }
  }, 60000);

  test('search returns archived clients by default', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${U}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.label).sort())
      .toEqual([ACTIVE_CLIENT, ARCHIVED_CLIENT, INACTIVE_CLIENT]);
  });

  test('drops archived clients while keeping active and inactive ones', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${U}&excludeArchived=true&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    const labels = res.body.items.map((i: any) => i.label);
    expect(labels).not.toContain(ARCHIVED_CLIENT);
    expect(labels).toContain(ACTIVE_CLIENT);
    // 'inactive' is not 'archived'; excluding it too would hide clients the trust
    // screens have always been able to pick.
    expect(labels).toContain(INACTIVE_CLIENT);
  });

  test('applies with no search term, so a browsed list omits archived clients', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?excludeArchived=true&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items.every((i: any) => i.status !== 'archived')).toBe(true);
    expect(res.body.items.map((i: any) => i.id)).not.toContain(archivedId);
  });

  // The point of the carve-out: a trust transaction saved before its client was
  // archived still has to render that client's name rather than a blank. The
  // paired search assertion is what pins it: excludeArchived must bite in the
  // browse/search branch and NOT in the ids branch, for the very same client.
  // Hoisting the predicate out of the `else` would blank the client name on every
  // historical trust transaction, and only this contrast catches that.
  test('still resolves an archived client by id, though search will not', async () => {
    const byId = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?ids=${archivedId}&excludeArchived=true`,
      { token },
    );

    expect(byId.status).toBe(200);
    expect(byId.body.items).toHaveLength(1);
    expect(byId.body.items[0].id).toBe(archivedId);
    expect(byId.body.items[0].label).toBe(ARCHIVED_CLIENT);
    // ...and says so, so a picker can mark the stale selection.
    expect(byId.body.items[0].status).toBe('archived');

    // The same client, by name, through the branch excludeArchived does govern.
    const bySearch = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${ARCHIVED_CLIENT}&excludeArchived=true&limit=50`,
      { token },
    );

    expect(bySearch.status).toBe(200);
    expect(bySearch.body.items.map((i: any) => i.id)).not.toContain(archivedId);
  });

  test('every slim row carries a status', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${U}&limit=50`,
      { token },
    );

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(['active', 'inactive', 'archived']).toContain(item.status);
    }
  });

  test('composes with ?full=true', async () => {
    const slim = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${U}&excludeArchived=true&limit=50`,
      { token },
    );
    const full = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${U}&excludeArchived=true&full=true&limit=50`,
      { token },
    );

    expect(full.status).toBe(200);
    expect(full.body.items.map((i: any) => i.id)).toEqual(slim.body.items.map((i: any) => i.id));
    expect(full.body.items.map((i: any) => i.label)).not.toContain(ARCHIVED_CLIENT);
  });

  test('rejects an excludeArchived value the schema does not allow', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?excludeArchived=yes`,
      { token },
    );
    expect(res.status).toBe(400);
  });
});

/**
 * `?userIds` together with `?excludeArchived`.
 *
 * The carve-out that keeps an archived-but-already-selected client labelled has
 * to hold for BOTH spellings of the resolution mode. A messaging picker holds
 * portal UIDs, so if `excludeArchived` ever reached that branch, every
 * participant whose client record was archived after the fact would render blank
 * and become impossible to remove.
 *
 * This block seeds its own fixture rather than reusing the archived clients in
 * the `?excludeArchived` block above: those are created without a `userId`, so
 * their `user_id` is null and they cannot be addressed by UID at all. Asserting
 * against one of them would pass for the wrong reason.
 *
 * Runs last in the file so its extra portal-linked client cannot perturb the
 * `?portalOnly` and `userId` blocks, which read whichever portal client sorts
 * first.
 */
describe('client lookup ?userIds with ?excludeArchived', () => {
  const ARCHIVED_PORTAL_CLIENT = `TESTCLUID${Date.now()}ARCHIVED`;
  let archivedClientId: any;

  beforeAll(async () => {
    // `clients.user_id` is a FK into `users`, so the fixture has to borrow a uid
    // that already exists; the acting member's own is the only one this suite can
    // count on. Creating a client keyed by a uid UPSERTS onto any existing row for
    // that uid, so confirm it owns no client row here first. Failing loudly beats
    // silently rewriting (and then deleting) a real client on some other seed.
    expect(typeof actingUserId).toBe('string');
    const unused = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?userIds=${encodeURIComponent(actingUserId)}`,
      { token },
    );
    expect(unused.status).toBe(200);
    expect(unused.body.items).toEqual([]);

    const res = await api.post(`/api/lawfirms/${lawFirmId}/clients`, {
      token,
      body: {
        name: ARCHIVED_PORTAL_CLIENT,
        status: 'archived',
        userId: actingUserId,
        organization: 'Created by automated test - safe to delete',
      },
    });
    expect(res.status).toBe(201);
    archivedClientId = res.body.clientId;
  }, 60000);

  afterAll(async () => {
    if (archivedClientId) {
      await api.delete(`/api/lawfirms/${lawFirmId}/clients/${archivedClientId}`, { token });
    }
  }, 60000);

  // Pins the fixture itself. A client with a null user_id is unreachable by UID,
  // which would make every assertion below vacuous rather than failing.
  test('the fixture really is archived and really is portal-linked', async () => {
    const res = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?ids=${archivedClientId}`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe('archived');
    expect(res.body.items[0].userId).toBe(actingUserId);
  });

  // The mirror of the `?ids` case above: `excludeArchived` must bite in the
  // browse/search branch and NOT in the userIds branch, for the very same client.
  // Collapsing the two resolution branches into one, or hoisting the predicate
  // above them, would blank the name of every archived participant a UID-keyed
  // picker still holds, and only this contrast catches that.
  test('still resolves an archived client by userIds, though search will not', async () => {
    const byUid = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?userIds=${encodeURIComponent(actingUserId)}&excludeArchived=true`,
      { token },
    );

    expect(byUid.status).toBe(200);
    expect(byUid.body.items).toHaveLength(1);
    expect(byUid.body.items[0].id).toBe(archivedClientId);
    expect(byUid.body.items[0].label).toBe(ARCHIVED_PORTAL_CLIENT);
    // ...and says so, so a picker can mark the stale selection.
    expect(byUid.body.items[0].status).toBe('archived');

    // The same client, by name, through the branch excludeArchived does govern.
    const bySearch = await api.get(
      `/api/lawfirms/${lawFirmId}/clients/lookup?search=${ARCHIVED_PORTAL_CLIENT}&excludeArchived=true&limit=50`,
      { token },
    );

    expect(bySearch.status).toBe(200);
    expect(bySearch.body.items.map((i: any) => i.id)).not.toContain(archivedClientId);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
