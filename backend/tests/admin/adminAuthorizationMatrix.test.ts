/**
 * One authorization case per admin endpoint, for every caller the product can
 * produce that is not a platform admin.
 *
 * This file is where the admin gate is owned. `tests/users/admin.test.ts` and
 * `tests/admin/adminMutations.test.ts` cover what the console reads and writes
 * for the admin, and each keeps only the admin's side of the gate (the allowed
 * call and revocation of the flag); every refusal lives here. The router mounts
 * thirty-one endpoints, and a hand-picked list of refusals only ever pins the
 * ones somebody happened to think of. The gate is a single `router.use(verifyToken,
 * requireIsAdmin)` at the top of `admin.routes.ts`, so what is pinned here is
 * that nothing was ever mounted above it, before it, or on a second router that
 * skipped it. That is a one-line mistake with the whole platform behind it, and
 * a per-endpoint table is the only shape that notices when a thirty-second
 * endpoint arrives without one.
 *
 * Three callers, because they fail for three different reasons and a gate can be
 * wrong for one and right for the others:
 *
 *   an ordinary firm member  holds a real role with real permission codes, and
 *                            is the caller a permission-shaped check would let
 *                            through if `requireIsAdmin` were ever swapped for
 *                            a firm permission.
 *   a firm owner             holds every permission their firm can grant. The
 *                            broadest role the product offers must buy nothing
 *                            here, not even against their OWN firm, which is
 *                            what every path below names.
 *   a portal client          is not a firm member at all. Their user row is
 *                            `client`, so any check that reads a membership
 *                            finds none and could plausibly fall open rather
 *                            than closed.
 *
 * THE CONTROL BELOW IS NOT OPTIONAL. `requireIsAdmin` sits on `router.use`, so
 * it runs before Express decides whether the path matches anything at all: a
 * misspelled path in the table is answered 403 for a non-admin exactly like a
 * real one, and every refusal case would pass while testing nothing. The second
 * describe sends the same thirty-one paths as the platform admin and asserts the
 * answer is neither 403 nor the app's `ROUTE_NOT_FOUND`, which is what proves
 * each row of the table names a route that exists.
 *
 * Data is seeded on both firms before the refusals run. A console that returned
 * an empty platform and a console that refused are indistinguishable by status
 * alone, so the read refusals assert the seeded names are absent from the body
 * and the control asserts the admin can see them.
 *
 * Stripe is stubbed at the module boundary. `subscription/create` reaches it
 * before any local guard can refuse, and the suite's key is a placeholder, so an
 * unstubbed control would put a real request on the wire.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  // Rejecting rather than resolving: nothing in this file asserts a Stripe
  // outcome, and a stub that resolved would let a control case pass by
  // pretending the provider agreed to something.
  const unreachable = () => Promise.reject(new Error('stripe stub: not reachable in this spec'));
  return {
    customers: { create: unreachable },
    subscriptions: {
      create: unreachable, cancel: unreachable, update: unreachable, retrieve: unreachable,
    },
    invoices: { list: unreachable },
    refunds: { create: unreachable },
    invoicePayments: { list: unreachable },
  };
});

import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  portalUser,
  seedRole,
  as,
  tokenFor,
  type CallerAgent,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { firmRow, platformAdmin, seedInvite } from '../support/rows';

/** Everything a path or body needs, resolved fresh for each test. */
interface World {
  firmA: Firm;
  firmB: Firm;
  ownerA: Actor;
  plainMember: Actor;
  client: Actor;
  adminUid: string;
  roleId: string;
  inviteId: string;
  clientInviteId: string;
}

interface Endpoint {
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: (w: World) => string;
  body?: (w: World) => Record<string, unknown>;
  /** True when a correct response carries cross-firm rows the refusal must not. */
  reads: boolean;
}

/** Names seeded into the platform, and therefore never present in a refusal. */
const SEEDED_FIRM_NAME = 'Matrix Firm Alpha';
const SEEDED_CLIENT_NAME = 'Matrix Client Alpha';
const SEEDED_WHITELIST_EMAIL = 'matrix-seed@example.test';

/**
 * Every route `admin.routes.ts` mounts, in file order. Paths name firmA, the
 * firm the member and the owner belong to: their own firm is the sharpest case,
 * because a gate that fell back to membership would let them through here and
 * nowhere else.
 */
const ENDPOINTS: Endpoint[] = [
  { name: 'GET /outbox-health', method: 'get', path: () => '/api/admin/outbox-health', reads: false },
  { name: 'GET /lawfirms', method: 'get', path: () => '/api/admin/lawfirms', reads: true },
  {
    name: 'GET /lawfirms/lookup',
    method: 'get',
    path: () => '/api/admin/lawfirms/lookup?search=Matrix',
    reads: true,
  },
  { name: 'GET /users', method: 'get', path: () => '/api/admin/users', reads: true },
  { name: 'GET /clients', method: 'get', path: () => '/api/admin/clients', reads: true },
  { name: 'GET /audit-events', method: 'get', path: () => '/api/admin/audit-events', reads: true },
  {
    name: 'GET /lawfirms/:lawFirmId',
    method: 'get',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}`,
    reads: true,
  },
  {
    name: 'PATCH /lawfirms/:lawFirmId/roles/:roleId',
    method: 'patch',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/roles/${w.roleId}`,
    body: () => ({ name: 'Escalated Role', permissions: ['firm.delete'] }),
    reads: false,
  },
  {
    name: 'PATCH /lawfirms/:lawFirmId/members/:memberId/role',
    method: 'patch',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/members/${w.plainMember.uid}/role`,
    body: (w) => ({ roleId: w.roleId }),
    reads: false,
  },
  {
    name: 'DELETE /lawfirms/:lawFirmId/members/:memberId',
    method: 'delete',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/members/${w.plainMember.uid}`,
    reads: false,
  },
  {
    name: 'DELETE /lawfirms/:lawFirmId/pending-invites/:inviteId',
    method: 'delete',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/pending-invites/${w.inviteId}`,
    reads: false,
  },
  {
    name: 'DELETE /lawfirms/:lawFirmId/pending-client-invites/:inviteId',
    method: 'delete',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/pending-client-invites/${w.clientInviteId}`,
    reads: false,
  },
  {
    name: 'PATCH /lawfirms/:lawFirmId',
    method: 'patch',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}`,
    body: () => ({ lawFirm: { name: 'Renamed By A Non Admin' } }),
    reads: false,
  },
  {
    name: 'PATCH /users/:userId/admin',
    method: 'patch',
    path: (w) => `/api/admin/users/${w.ownerA.uid}/admin`,
    body: () => ({ isAdmin: true }),
    reads: false,
  },
  { name: 'GET /plans', method: 'get', path: () => '/api/admin/plans', reads: false },
  {
    name: 'GET /lawfirms/:lawFirmId/plan',
    method: 'get',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/plan`,
    reads: true,
  },
  {
    name: 'PATCH /lawfirms/:lawFirmId/plan',
    method: 'patch',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/plan`,
    body: () => ({ planId: 'enterprise', unlimitedOverride: true }),
    reads: false,
  },
  {
    name: 'POST /lawfirms/:lawFirmId/storage/recount',
    method: 'post',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/storage/recount`,
    reads: false,
  },
  { name: 'GET /plan-usage', method: 'get', path: () => '/api/admin/plan-usage', reads: true },
  {
    name: 'POST /subscription/create',
    method: 'post',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/subscription/create`,
    body: () => ({ planId: 'professional', interval: 'monthly' }),
    reads: false,
  },
  {
    name: 'POST /subscription/cancel',
    method: 'post',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/subscription/cancel`,
    body: () => ({ immediate: true }),
    reads: false,
  },
  {
    name: 'POST /subscription/extend-trial',
    method: 'post',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/subscription/extend-trial`,
    body: () => ({ days: 30 }),
    reads: false,
  },
  {
    name: 'POST /subscription/apply-coupon',
    method: 'post',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/subscription/apply-coupon`,
    body: () => ({ couponId: 'FREE100' }),
    reads: false,
  },
  {
    name: 'POST /subscription/refund',
    method: 'post',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/subscription/refund`,
    body: () => ({ full: true }),
    reads: false,
  },
  {
    name: 'POST /subscription/comp',
    method: 'post',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/subscription/comp`,
    body: () => ({ planId: 'enterprise', reason: 'granted by a non admin' }),
    reads: false,
  },
  {
    name: 'GET /subscription/invoices',
    method: 'get',
    path: (w) => `/api/admin/lawfirms/${w.firmA.id}/subscription/invoices`,
    reads: false,
  },
  { name: 'GET /whitelist', method: 'get', path: () => '/api/admin/whitelist', reads: false },
  {
    name: 'POST /whitelist',
    method: 'post',
    path: () => '/api/admin/whitelist',
    body: () => ({ email: 'smuggled-in@example.test' }),
    reads: false,
  },
  {
    name: 'DELETE /whitelist',
    method: 'delete',
    path: () => '/api/admin/whitelist',
    body: () => ({ email: SEEDED_WHITELIST_EMAIL }),
    reads: false,
  },
  {
    name: 'POST /test-accounts',
    method: 'post',
    path: () => '/api/admin/test-accounts',
    // Deliberately invalid against this route's own schema (a `member` account
    // needs a lawFirmId), so the control below is answered by this route's
    // `validate` rather than by Firebase, which the suite does not stand up for
    // account creation. The refusals never reach validation at all.
    body: () => ({
      kind: 'member', email: 'made-up@example.test', password: 'hunter22', name: 'Made Up',
    }),
    reads: false,
  },
];

let world: World;
let admin: CallerAgent;

/**
 * A real user row with `is_admin = false` in the database, whose decoded token
 * carries `claims` on top of it. `tokenFor` spreads its overrides straight onto
 * the payload `verifyToken` hands back as `req.user`, so this is the only way a
 * caller in this suite can put an admin-shaped field on the token without it
 * being true in the database.
 */
async function forgedClaimActor(claims: Record<string, unknown>): Promise<{ uid: string; api: CallerAgent }> {
  const uid = `forged-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type, is_admin)
     values ($1, $2, 'Forged Claim User', 'firm_member', false)`,
    [uid, `${uid}@example.test`],
  );
  return { uid, api: as(tokenFor({ uid, ...claims })) };
}

const rowCount = async (sql: string, params: unknown[] = []) => {
  const { rows } = await testPool.query(sql, params);
  return rows.length;
};

const send = (agent: CallerAgent, endpoint: Endpoint) => {
  const req = agent[endpoint.method](endpoint.path(world));
  const body = endpoint.body?.(world);
  return body ? req.send(body) : req.send();
};

beforeEach(async () => {
  const firmA = await createFirm({ name: SEEDED_FIRM_NAME });
  const firmB = await createFirm({ name: 'Matrix Firm Beta' });

  const ownerA = await ownerOf(firmA.id);
  // A real role with real codes, not an empty one. An empty role would be
  // refused by any check at all, including a wrong one.
  const plainMember = await memberWith(firmA.id, [
    'dashboard.view', 'members.view', 'members.invite', 'members.remove',
    'firm.update', 'firm.manageRoles', 'clients.view', 'clients.manage',
    'billing.viewInvoices', 'billing.manageInvoices',
  ]);
  const client = await portalUser();

  await createPersonClient(firmA.id, { name: SEEDED_CLIENT_NAME });
  await createPersonClient(firmB.id, { name: 'Matrix Client Beta' });

  const roleId = await seedRole(firmA.id, { name: 'Matrix Role', permissions: ['clients.view'] });

  const inviteId = await seedInvite({ lawFirmId: firmA.id, inviteType: 'member', invitedNow: true });
  const clientInviteId = await seedInvite({ lawFirmId: firmA.id, inviteType: 'client', invitedNow: true });

  await testPool.query(
    'insert into email_verification_whitelist (email, note) values ($1, $2)',
    [SEEDED_WHITELIST_EMAIL, 'seeded'],
  );

  const seeded = await platformAdmin('Matrix Admin');
  admin = seeded.api;

  world = {
    firmA, firmB, ownerA, plainMember, client, adminUid: seeded.uid,
    roleId, inviteId, clientInviteId,
  };

  await drainEvents();
});

describe('every admin endpoint refuses every caller who is not a platform admin', () => {
  it.each(ENDPOINTS)('$name', async (endpoint) => {
    for (const [label, actor] of [
      ['an ordinary firm member', () => world.plainMember],
      ['the firm owner', () => world.ownerA],
      ['a portal client', () => world.client],
    ] as const) {
      const res = await send(actor().api, endpoint);

      // The label rides along in the assertion so a failure names WHICH caller
      // got through, not just that one did.
      expect({ caller: label, status: res.status }).toEqual({ caller: label, status: 403 });

      if (endpoint.reads) {
        // The content, not only the status. A refusal that still shipped the
        // platform's rows would leak everything while looking like a gate, and
        // the seeded names are the only way to tell that apart from a console
        // that had nothing to return.
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(SEEDED_FIRM_NAME);
        expect(body).not.toContain(SEEDED_CLIENT_NAME);
        expect(body).not.toContain(world.firmB.id);
      }
    }
  });
});

describe('the platform admin reaches the same paths', () => {
  // Without this the file is worthless. `requireIsAdmin` runs on `router.use`,
  // ahead of route matching, so a typo in the table above is refused for a
  // non-admin exactly like a real endpoint. Answering the admin with something
  // other than the app's ROUTE_NOT_FOUND is what proves the path is mounted.
  it.each(ENDPOINTS)('$name is a mounted route, not a 403 from a misspelled path', async (endpoint) => {
    const res = await send(admin, endpoint);

    expect(res.body?.code ?? null).not.toBe('ROUTE_NOT_FOUND');
    expect(res.status).not.toBe(403);
  });

  it('sees the seeded firm and client the refusals withheld', async () => {
    const firms = await admin.get('/api/admin/lawfirms');
    const clients = await admin.get('/api/admin/clients');

    // The other half of the read cases above. Those assert the seeded names are
    // absent from a refusal; unless something asserts they were present to
    // begin with, an empty platform satisfies both.
    expect(JSON.stringify(firms.body)).toContain(SEEDED_FIRM_NAME);
    expect(JSON.stringify(clients.body)).toContain(SEEDED_CLIENT_NAME);
  });
});

describe('the refusals leave the platform exactly as they found it', () => {
  it('changes nothing after all three callers have tried every write', async () => {
    const before = await firmRow(world.firmA.id);

    for (const actor of [world.plainMember, world.ownerA, world.client]) {
      for (const endpoint of ENDPOINTS.filter((e) => e.method !== 'get')) {
        await send(actor.api, endpoint);
      }
    }
    await drainEvents();

    // A 403 that had already written is the failure this catches: the status is
    // identical either way, and only the row says which happened.
    expect(await firmRow(world.firmA.id)).toEqual(before);

    expect(await rowCount(
      'select 1 from members where law_firm_id = $1 and user_id = $2',
      [world.firmA.id, world.plainMember.uid],
    )).toBe(1);
    expect(await rowCount(
      'select 1 from roles where id = $1 and name = $2', [world.roleId, 'Matrix Role'],
    )).toBe(1);
    expect(await rowCount(
      'select 1 from invitations where id = any($1)', [[world.inviteId, world.clientInviteId]],
    )).toBe(2);
    // Exactly the seeded address: the deletion did not land and the addition did
    // not either.
    const { rows } = await testPool.query(
      'select email::text as email from email_verification_whitelist',
    );
    expect(rows.map((r: any) => r.email)).toEqual([SEEDED_WHITELIST_EMAIL]);
  });

  it('leaves the platform-admin flag alone on every user it was asked to change', async () => {
    for (const actor of [world.plainMember, world.ownerA, world.client]) {
      await actor.api.patch(`/api/admin/users/${actor.uid}/admin`).send({ isAdmin: true });
      await actor.api.patch(`/api/admin/users/${world.ownerA.uid}/admin`).send({ isAdmin: true });
      // The other direction: stripping the real admin would be as effective an
      // attack as granting yourself the flag.
      await actor.api.patch(`/api/admin/users/${world.adminUid}/admin`).send({ isAdmin: false });
    }

    const { rows } = await testPool.query(
      'select id, is_admin from users where id = any($1)',
      [[world.plainMember.uid, world.ownerA.uid, world.client.uid, world.adminUid]],
    );
    const flags = Object.fromEntries(rows.map((r: any) => [r.id, r.is_admin]));

    expect(flags[world.plainMember.uid]).toBe(false);
    expect(flags[world.ownerA.uid]).toBe(false);
    expect(flags[world.client.uid]).toBe(false);
    expect(flags[world.adminUid]).toBe(true);
  });
});

/**
 * Every case above tests a REAL caller: a real role, a real membership, a
 * real portal client. `requireIsAdmin` (`src/shared/middleware/requireIsAdmin.ts`)
 * never reads any of that -- it takes only `req.user.uid` off the verified
 * token and looks up `users.is_admin` in the database, so the only forgeable
 * surface left is the decoded token payload itself: whatever a caller could get
 * `req.user` to carry alongside a real `uid`. This describe manufactures
 * exactly that shape and proves it buys nothing over the real column.
 */
describe('a forged admin-shaped token claim buys nothing over the real is_admin column', () => {
  it.each([
    { isAdmin: true },
    { is_admin: true },
    { admin: true },
    { role: 'platform-admin' },
    { permissions: ['platform.admin'] },
  ])('refuses a read and the self-escalation write when the token carries %j but is_admin is false', async (claims) => {
    const { uid, api } = await forgedClaimActor(claims);

    const read = await api.get('/api/admin/lawfirms');
    expect(read.status).toBe(403);

    // The sharpest case: granting yourself the flag through the very route that
    // sets it. A gate that trusted the token here would be a full escalation.
    const grant = await api.patch(`/api/admin/users/${uid}/admin`).send({ isAdmin: true });
    expect(grant.status).toBe(403);

    const { rows } = await testPool.query('select is_admin from users where id = $1', [uid]);
    expect(rows[0].is_admin).toBe(false);
  });
});
