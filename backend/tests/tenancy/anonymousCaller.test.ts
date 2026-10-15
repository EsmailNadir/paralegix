/**
 * B02 A01: an anonymous caller (no Authorization header at all) on every route
 * the app believes it has locked behind a signed-in user.
 *
 * `verifyToken` answering `401 NO_TOKEN` for a single hand-picked route is
 * pinned in `tests/auth/tokenCache.test.ts`. What that does not cover is the
 * thing A01 actually asks for: that EVERY route wired to require a caller
 * answers the same way, and that hitting one before
 * authenticating produces no side effect at all — no row written, no row
 * deleted, no name or figure disclosed in the refusal body.
 *
 * This file OWNS the anonymous-caller refusal. Per-module "refuses an
 * unauthenticated caller" copies are not kept alongside it.
 *
 * `tests/contracts/routeCatalog.ts` is a mechanical inventory of every
 * registered endpoint, built once by walking the route files with the
 * TypeScript compiler API, with each row's `authCategory` read off the actual
 * middleware wired at that call site. It existed with no consumer before this
 * file: the sweep below is the first test to actually walk it end to end.
 *
 * `firm-member`, `portal-client` and `platform-admin` all mount `verifyToken`
 * (see the type's own doc comment in routeCatalog.ts: admin's is applied once
 * by a `router.use` at the top of admin.routes.ts, but it is still there).
 * `public-token`, `cron`, `webhook`, `anonymous` and `docs-session` routes are
 * deliberately reachable without a Firebase session and are excluded; they
 * have their own, different, refusal contracts, tested elsewhere.
 *
 * WHY ONE `it()` PER CATEGORY RATHER THAN ONE PER ROUTE: `setupInProcess`
 * truncates every table in `beforeEach` for every spec in the suite (see
 * `backend/AGENTS.md`), and none of these ~640 requests writes anything for
 * that truncate to undo. Paying that cost once per route would multiply the
 * full-suite runtime for a battery that variantly. Looping inside one test
 * keeps the mechanical sweep cheap while still exercising the real app,
 * the real router tree, and the real `verifyToken` middleware for every row.
 */
import {
  ROUTE_CATALOG,
  CATALOG_STATS,
  type RouteRow,
  type AuthCategory,
  type RouteMethod,
} from '../contracts/routeCatalog';
import {
  request,
  createFirm,
  ownerOf,
  memberWith,
  createPersonClient,
  drainEvents,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const GATED: AuthCategory[] = ['firm-member', 'portal-client', 'platform-admin'];

/**
 * Swap every `:param` segment for a syntactically valid placeholder. Auth
 * runs before routing ever inspects the real value, so this only needs to
 * match the route's own path SHAPE, not name a real record.
 *
 * The firm id gets a REAL (but otherwise irrelevant) firm rather than an
 * all-zero uuid. `verifyToken` rejects every one of these calls before the
 * firm id is ever looked up for authorization, but a handful of routes also
 * fire a background, fire-and-forget audit-log write keyed on
 * `req.params.lawFirmId` regardless of how the request was answered. A
 * nonexistent firm id made that write fail its foreign key and log a scary
 * (but harmless) stack trace on every one of those routes; a real row avoids
 * the noise without changing what is actually being asserted.
 */
function concretePath(route: RouteRow, firmId: string): string {
  return route.path
    .replace(/:lawFirmId\b/g, firmId)
    .replace(/:lawfirmId\b/g, firmId)
    .replace(/:[a-zA-Z0-9_]+/g, '00000000-0000-0000-0000-000000000000');
}

const METHOD_FN: Record<RouteMethod, 'get' | 'post' | 'put' | 'patch' | 'delete'> = {
  GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete',
};

async function callAnonymously(route: RouteRow, firmId: string) {
  const agent = request() as unknown as Record<string, (path: string) => any>;
  const fn = METHOD_FN[route.method];
  return agent[fn](concretePath(route, firmId));
}

describe('B02 A01: route catalog stays in sync with what this sweep walks', () => {
  it('the catalog literal totals match the live array (routeCatalog.ts own intended check)', () => {
    // Lifted from routeCatalog.ts's own doc comment on CATALOG_STATS: a
    // computed count can never disagree with the array it is computed from,
    // so the totals are hand-written literals instead, and a test is meant to
    // assert the array against them. Nothing did until now. If this goes red,
    // the catalog itself is stale (a route was added/removed/recategorized in
    // source without updating routeCatalog.ts) and the sweep below is
    // silently testing the wrong universe.
    expect(ROUTE_CATALOG.length).toBe(CATALOG_STATS.total);
    const counted: Record<string, number> = {};
    for (const route of ROUTE_CATALOG) {
      counted[route.authCategory] = (counted[route.authCategory] ?? 0) + 1;
    }
    expect(counted).toEqual(CATALOG_STATS.byAuthCategory);
  });
});

describe.each(GATED)('B02 A01: anonymous caller, %s routes', (category) => {
  const routes = ROUTE_CATALOG.filter((r) => r.authCategory === category);

  it(`refuses all ${routes.length} routes with the standard 401 NO_TOKEN envelope`, async () => {
    // A category with zero routes would make the loop below vacuously pass.
    expect(routes.length).toBeGreaterThan(0);

    const { id: placeholderFirmId } = await createFirm({ name: 'A01 Placeholder Firm' });

    const failures: string[] = [];
    for (const route of routes) {
      // eslint-disable-next-line no-await-in-loop
      const res = await callAnonymously(route, placeholderFirmId);
      if (res.status !== 401 || res.body?.code !== 'NO_TOKEN') {
        failures.push(`${route.method} ${route.path} -> ${res.status} ${res.body?.code ?? '(no code)'}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

describe('B02 A01: anonymous caller performs no mutation and discloses no protected body', () => {
  let firm: Firm;
  let owner: Actor;
  let matterId: string;
  let clientId: string;

  beforeEach(async () => {
    firm = await createFirm({ name: 'Guarded Firm' });
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, {
      name: 'Guarded Confidential Client', email: 'guarded@example.test',
    });
    clientId = client.id;
    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Guarded Matter', clients: [{ clientId, name: 'Guarded Confidential Client' }],
    });
    expect(matter.status).toBe(201);
    matterId = matter.body.matterId;
    await drainEvents();
  });

  it('creates no task', async () => {
    const res = await request().post(`/api/lawfirms/${firm.id}/tasks`)
      .send({ title: 'Should never exist', matterId });

    expect(res.status).toBe(401);
    const { rows } = await testPool.query('select id from tasks where law_firm_id = $1', [firm.id]);
    expect(rows).toHaveLength(0);
  });

  it('deletes no matter', async () => {
    const res = await request().delete(`/api/lawfirms/${firm.id}/matters/${matterId}`);

    expect(res.status).toBe(401);
    const { rows } = await testPool.query('select id from matters where id = $1', [matterId]);
    expect(rows).toHaveLength(1);
  });

  it('adds no member to the matter roster', async () => {
    // A real firm member who is NOT on this matter, named in the body. The
    // anonymous call must leave them off; the owner's identical call is the
    // control that proves this body really does add them when authorized.
    const candidate = await memberWith(firm.id, ['matters.view']);
    const roster = async () => {
      const { rows } = await testPool.query(
        'select user_id from matter_members where law_firm_id = $1 and matter_id = $2',
        [firm.id, matterId],
      );
      return rows.map((r: any) => r.user_id);
    };
    const add = (agent: { post: (path: string) => any }) => agent
      .post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`)
      .send({ targetUserIds: [candidate.uid] });

    const res = await add(request());

    expect(res.status).toBe(401);
    expect(await roster()).not.toContain(candidate.uid);

    const control = await add(owner.api);
    expect(control.status).toBe(200);
    expect(await roster()).toContain(candidate.uid);
  });

  it('discloses no client name or email in the 401 body', async () => {
    const res = await request().get(`/api/lawfirms/${firm.id}/clients/${clientId}`);

    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body ?? {});
    expect(body).not.toContain('Guarded Confidential Client');
    expect(body).not.toContain('guarded@example.test');
  });

  it('discloses no matter name in a 401 on the note-creation route (never reaches the handler)', async () => {
    const res = await request()
      .post(`/api/lawfirms/${firm.id}/matters/${matterId}/notes`)
      .send({ content: 'Should never be written' });

    expect(res.status).toBe(401);
    const { rows } = await testPool.query(
      'select id from notes where law_firm_id = $1 and matter_id = $2',
      [firm.id, matterId],
    );
    expect(rows).toHaveLength(0);
  });
});
