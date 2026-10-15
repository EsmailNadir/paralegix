/**
 * A malformed :lawFirmId must be refused, not crash the request.
 *
 * `law_firms.id` is a uuid, so a caller-supplied string that is not one can
 * never name a real firm. Every gate in the chain has to reach that conclusion
 * on its own, because they run in a fixed order and each one queries before the
 * next gets a turn:
 *
 *     verifyToken -> requireActiveBilling -> requireFeature -> requirePermission
 *
 * `requirePermission` carries an `isUuid` guard and answers 403. `loadFirmPlan`,
 * behind `requireActiveBilling`, carries one too. `loadResolvedMember` did not,
 * and `requireFeature` calls it FIRST, so on every plan-gated router the
 * malformed id reached the `members` JOIN `roles` query as a Postgres cast error
 * (22P02) and the request answered 500.
 *
 * A 500 is the wrong answer twice over. It tells the caller the server is
 * broken when the request was, it is logged as a server fault so a scan of
 * malformed ids reads as an outage, and it is the one status the error handler
 * deliberately refuses to explain, so nothing downstream can tell the two apart.
 *
 * The plan-gated routers are the affected set: trust, templates, file-share
 * links, signing templates, signature links, messaging, flat fees and analytics.
 * Several are covered below rather than one, because the gate is mounted per
 * router in app.ts and a fix that missed a mount would still look correct from
 * any single route.
 */
import {
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type ClientRecord,
  type Firm,
} from '../support/setupInProcess';
import { rootOf, seedFile } from '../files/fileWorld';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let fileId: string;

const BAD = 'not-a-uuid';

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  // Real, because the control half of each pair asks the same route to SUCCEED
  // under a valid firm id, and a route addressed at a client that does not
  // exist answers 404 whether the gate ran or not.
  client = await createPersonClient(firm.id, { name: 'Gate Client' });
  // Real, for the same reason: the share-links route answers 404 for a file
  // that does not exist, whether or not the gate in front of it ran.
  const firmRoot = await rootOf(firm.id, {});
  fileId = (await seedFile(firm.id, { parentId: firmRoot, name: 'a.pdf' })).id;
  await drainEvents();
});

describe('a plan-gated router refuses a malformed firm id', () => {
  // Each of these mounts `requireFeature` separately in app.ts, so each can
  // regress on its own.
  // Each path is built so the control half can actually SUCCEED under a real
  // firm id. That means carrying the query parameter the share-links route
  // requires, in the `lawfirmids/<firmId>/` shape its own path check demands,
  // and a client that exists. A route answering 400 or 404 for its own reasons
  // proves nothing about the gate in front of it.
  const routes: Array<readonly [string, (id: string) => string]> = [
    ['trust', (id) => `/api/lawfirms/${id}/trust/accounts`],
    ['templates', (id) => `/api/lawfirms/${id}/templates`],
    ['file share links', (id) => `/api/lawfirms/${id}/file-share-links?fileId=${fileId}`],
    ['signing templates', (id) => `/api/lawfirms/${id}/signing-templates`],
    ['flat fees', (id) => `/api/lawfirms/${id}/billing/flat-fees/client/${client.id}`],
    ['analytics', (id) => `/api/lawfirms/${id}/billing/analytics/billing-summary`],
  ];

  it.each(routes)('answers a client error, not 500, on %s', async (_name, path) => {
    const res = await owner.api.get(path(BAD));

    // Not `toBe(403)`: the point is that the request is REFUSED rather than
    // crashing, and pinning one exact status here would make this file fail on
    // an unrelated and legitimate change to which gate refuses first.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it.each(routes)('still serves the SAME route under a real firm id on %s', async (_name, path) => {
    const res = await owner.api.get(path(firm.id));

    // The half that makes the cases above mean anything. Without it, a router
    // that answered 4xx to everything would pass the whole block, and so would
    // a route path this file simply got wrong.
    expect(res.status).toBeLessThan(400);
  });
});

describe('the gates that already guarded still do', () => {
  it('refuses a malformed firm id on a router with no plan gate', async () => {
    const res = await owner.api.get(`/api/lawfirms/${BAD}/matters`);

    // `requirePermission` has always carried the guard. This case pins that the
    // fix to `loadResolvedMember` did not change the answer here.
    expect(res.status).toBe(403);
  });

  it('serves the same unguarded router under a real firm id', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);

    expect(res.status).toBe(200);
  });
});
