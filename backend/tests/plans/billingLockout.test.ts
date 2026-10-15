/**
 * The billing lockout gate: `src/shared/plans/requireActiveBilling.ts`, mounted
 * in `src/app.ts` at `/api/lawfirms/:lawFirmId` immediately after `verifyToken`
 * and ahead of every per-firm router below it.
 *
 * Sixty-nine lines decide whether a firm can use the product at all, and neither
 * direction of a mistake is visible on a screen. Allow one status too many and a
 * firm that stopped paying keeps the product. Block one too many and a paying
 * firm is locked out of its own matters. This file pins BOTH halves, because a
 * gate that allowed everything would pass every served case and a gate that
 * blocked everything would pass every refused case; only the pair fixes the
 * boundary.
 *
 * It is the read side of the pair whose write side is the Stripe webhook: the
 * webhook merges `billingStatus` into `law_firms.plan` (and the
 * `law_firms_sync_plan_columns` trigger mirrors it onto the
 * `law_firms.billing_status` column), and this gate reads it back.
 *
 * FIXTURE NOTE, and it is the whole reason this file exists rather than relying
 * on incidental coverage: `createFirm` seeds `billing_status = 'comped'` so that
 * ordinary specs are not locked out. A case here that forgets to set a status is
 * therefore testing 'comped' and proves nothing. Every case below states its
 * status explicitly, in plain SQL through `testPool`, never through the code
 * under test.
 */
import { randomUUID } from 'crypto';
import {
  createFirm,
  createPersonClient,
  memberWith,
  ownerOf,
  request,
  setFirmPlan,
  stranger,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

/**
 * Put the firm in a billing state, the shape the Stripe webhook actually writes
 * (`lawfirmsRepo.mergePlan` in subscriptions.service.ts). Since migration 0200
 * `billingStatus` and `planId` are typed COLUMNS -- `loadFirmPlan` reads both
 * straight off the row and the jsonb no longer carries them -- so the column is
 * the authoritative input to the gate. Seeding them into the jsonb instead
 * leaves the column on its `comped` default and tests a firm that is not locked
 * out at all.
 *
 * `replace: true` because every caller here states the firm's WHOLE plan; a
 * merge would carry a previous case's `comped` flag into the next one.
 */
const setPlan = (lawFirmId: string, plan: Record<string, unknown>) =>
  setFirmPlan(lawFirmId, plan, { replace: true });

/**
 * A firm whose plan jsonb is EMPTY -- no `comped`, no `trialEndsAt`, no Stripe
 * pointers -- carrying only a status on the column. That is every firm created
 * before it ever reached checkout, and it is the state in which the gate has
 * nothing but the column to go on.
 */
const setStatusColumnOnly = (lawFirmId: string, billingStatus: string) =>
  setFirmPlan(lawFirmId, { billingStatus }, { replace: true });

const readStatusColumn = async (lawFirmId: string) => {
  const { rows } = await testPool.query(
    `select billing_status from law_firms where id = $1`, [lawFirmId],
  );
  return rows[0].billing_status;
};

const seedMatter = async (lawFirmId: string, name: string) => {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, $3, $4)`,
    [id, lawFirmId, name, `REF-${id.slice(0, 8)}`],
  );
  return id;
};

const seedTask = async (lawFirmId: string, title: string) => {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title) values ($1, $2, $3)`,
    [id, lawFirmId, title],
  );
  return id;
};

/**
 * Three gated routes from three different modules.
 *
 * One route could pass while the gate was mounted on a single router by
 * accident; three cannot. Each carries its own served-shape assertion rather
 * than a shared `body.a ?? body.b` chain, because these endpoints genuinely
 * answer different envelopes (`{ matters, totalItems }`, `{ tasks, totalTasks }`,
 * `{ clients }`) and a fallback chain would keep passing after a rename.
 */
const GATED_ROUTES = [
  {
    label: 'matters list',
    path: (firmId: string) => `/api/lawfirms/${firmId}/matters`,
    expectServed: (body: any) => {
      expect(Array.isArray(body.matters)).toBe(true);
      expect(body.matters.length).toBeGreaterThan(0);
    },
    expectNoData: (body: any) => expect(body.matters).toBeUndefined(),
  },
  {
    label: 'tasks list',
    path: (firmId: string) => `/api/lawfirms/${firmId}/tasks`,
    expectServed: (body: any) => {
      expect(Array.isArray(body.tasks)).toBe(true);
      expect(body.tasks.length).toBeGreaterThan(0);
    },
    expectNoData: (body: any) => expect(body.tasks).toBeUndefined(),
  },
  {
    label: 'clients list',
    path: (firmId: string) => `/api/lawfirms/${firmId}/clients`,
    expectServed: (body: any) => {
      expect(Array.isArray(body.clients)).toBe(true);
      expect(body.clients.length).toBeGreaterThan(0);
    },
    expectNoData: (body: any) => expect(body.clients).toBeUndefined(),
  },
];

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm({ name: 'Gated Firm' });
  owner = await ownerOf(firm.id);
  // Real rows behind every gated route, so a "served" case proves data came back
  // rather than proving an empty 200. Without these, a route that silently
  // returned nothing would look identical to one the gate let through.
  await seedMatter(firm.id, 'Gated Matter');
  await seedTask(firm.id, 'Gated Task');
  await createPersonClient(firm.id, { name: 'Gated Client' });
});

/* ------------------------------------------------------------------ *
 * Allowed states
 * ------------------------------------------------------------------ */
describe('billing states that keep the workspace open', () => {
  // Goes red if any of these is dropped from BILLING_ACTIVE_STATUSES in
  // planEnforcement.ts, or if the gate stops reading the plan jsonb.
  it.each(['active', 'trialing', 'comped'])(
    'serves a firm whose plan jsonb billingStatus is %s',
    async (billingStatus) => {
      await setPlan(firm.id, { billingStatus });

      for (const route of GATED_ROUTES) {
        const res = await owner.api.get(route.path(firm.id));
        expect([route.label, res.status]).toEqual([route.label, 200]);
        route.expectServed(res.body);
      }
    },
  );

  // Legacy firm: status lives only on the column, plan jsonb is empty. Goes red
  // if loadFirmPlan stops falling back to `rows[0].billing_status`, which would
  // hand every such firm the fail-closed 'incomplete' default and lock it out.
  it.each(['active', 'trialing', 'comped'])(
    'serves a legacy firm whose status is only on the billing_status column (%s)',
    async (billingStatus) => {
      await setStatusColumnOnly(firm.id, billingStatus);

      const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(res.status).toBe(200);
      expect(res.body.matters.length).toBeGreaterThan(0);
    },
  );
});

/* ------------------------------------------------------------------ *
 * Blocked states
 * ------------------------------------------------------------------ */
describe('billing states that lock the workspace', () => {
  // Goes red if any of these is added to BILLING_ACTIVE_STATUSES: a firm that
  // never finished checkout, whose card failed, or whose subscription ended
  // would keep full access to the product.
  it.each(['incomplete', 'past_due', 'canceled'])(
    'refuses a firm whose billingStatus is %s with 402 BILLING_INACTIVE',
    async (billingStatus) => {
      await setPlan(firm.id, { billingStatus });

      for (const route of GATED_ROUTES) {
        const res = await owner.api.get(route.path(firm.id));
        expect([route.label, res.status]).toEqual([route.label, 402]);
        // What the frontend branches on: `status === 402 || code ===
        // 'BILLING_INACTIVE'` (frontend/src/lib/utils/apiErrors.ts), and
        // `details.billingStatus` routes the lock screen to onboarding
        // ('incomplete') versus billing (past_due/canceled).
        expect(res.body.code).toBe('BILLING_INACTIVE');
        expect(res.body.details).toEqual({ billingStatus });
        route.expectNoData(res.body);
      }
    },
  );

  it.each(['incomplete', 'past_due', 'canceled'])(
    'refuses a legacy firm blocked only on the billing_status column (%s)',
    async (billingStatus) => {
      await setStatusColumnOnly(firm.id, billingStatus);

      const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('BILLING_INACTIVE');
      expect(res.body.details).toEqual({ billingStatus });
      expect(res.body.matters).toBeUndefined();
    },
  );
});

/* ------------------------------------------------------------------ *
 * Unknown / missing status
 * ------------------------------------------------------------------ */
describe('an unrecognized or missing billing status fails closed', () => {
  /**
   * A status the gate has never heard of can no longer BE stored.
   *
   * This used to be a fail-closed normalization: the plan jsonb accepted any
   * string and the mirror trigger translated an unknown one onto the column,
   * with migration 0185 moving that fallback from 'active' to 'incomplete' so
   * the column stopped calling a locked-out firm a paying customer.
   *
   * Migration 0200 made the column the only store, and its CHECK constraint
   * turns the whole class of "unknown stored status" into a write that fails.
   * That is strictly stronger than normalizing after the fact, so what is worth
   * pinning is the refusal itself: goes red if the CHECK is relaxed, which is
   * what would let an unrecognized status back into the column and put the gate
   * back in the business of guessing what it means.
   */
  it('cannot store a status outside the column vocabulary at all', async () => {
    // An explicit starting status, so the assertion after the refused write is
    // about THIS test rather than about createFirm's 'comped' default.
    await setPlan(firm.id, { billingStatus: 'active' });

    await expect(
      setPlan(firm.id, { billingStatus: 'bogus_status' }),
    ).rejects.toMatchObject({ code: '23514' });

    // The refused write left the firm on its previous status rather than
    // half-applying, so the gate still has a value it understands.
    expect(await readStatusColumn(firm.id)).toBe('active');
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(200);
  });

  /**
   * The fail-closed rule that survives: a status the gate does not recognize as
   * ACTIVE locks the workspace. 'incomplete' is the value the repository
   * normalizes an unknown Stripe state to, so it is the one that actually
   * reaches the column in production.
   */
  it('refuses a firm the gate does not recognize as active', async () => {
    await setPlan(firm.id, { billingStatus: 'incomplete' });

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('BILLING_INACTIVE');
    expect(res.body.details).toEqual({ billingStatus: 'incomplete' });
  });

  // A jsonb null is falsy, so loadFirmPlan falls back to the column rather than
  // treating the absent value as permission. Goes red if that fallback is
  // dropped in a way that grants access, or if the plan jsonb is allowed to
  // shadow the column with a null.
  it('falls back to the column when the jsonb status is json null', async () => {
    await testPool.query(
      `update law_firms
          set billing_status = 'canceled',
              plan = jsonb_build_object('billingStatus', null)
        where id = $1`,
      [firm.id],
    );
    // Nothing mirrors the jsonb onto the column any more (migration 0200), so a
    // json null there cannot disturb the column.
    expect(await readStatusColumn(firm.id)).toBe('canceled');

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(402);
    expect(res.body.details).toEqual({ billingStatus: 'canceled' });
  });
});

/* ------------------------------------------------------------------ *
 * Escape hatches
 * ------------------------------------------------------------------ */
describe('the comped / unlimitedOverride escape hatches', () => {
  /**
   * These two flags are how a customer is kept working while a payment problem
   * is sorted out, and how internal and demo firms run with no Stripe
   * subscription at all. Both outrank the status: a firm marked canceled but
   * carrying the flag must still be served.
   *
   * Goes red if either short-circuit is removed from `isFirmBillingActive`. That
   * failure mode is a support escalation, not a screen: the firm the team just
   * promised would keep working is locked out anyway.
   */
  it.each(['comped', 'unlimitedOverride'])(
    'serves a canceled firm carrying %s: true',
    async (flag) => {
      await setPlan(firm.id, { billingStatus: 'canceled', [flag]: true });
      // The status really is the blocked one; only the flag is saving it.
      expect(await readStatusColumn(firm.id)).toBe('canceled');

      for (const route of GATED_ROUTES) {
        const res = await owner.api.get(route.path(firm.id));
        expect([route.label, res.status]).toEqual([route.label, 200]);
        route.expectServed(res.body);
      }
    },
  );

  // The flags are checked with `=== true`, so a truthy-but-not-true value must
  // not open the gate. Goes red if either check is loosened to a truthiness
  // test, which would let a stray string in the plan jsonb grant free access.
  it.each(['comped', 'unlimitedOverride'])(
    'does not treat a non-boolean %s value as an override',
    async (flag) => {
      await setPlan(firm.id, { billingStatus: 'canceled', [flag]: 'yes' });

      const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('BILLING_INACTIVE');
    },
  );
});

/* ------------------------------------------------------------------ *
 * No-card trial expiry
 * ------------------------------------------------------------------ */
describe('a no-card trial is expired by its own end date', () => {
  const dayAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dayAhead = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Nothing else expires a trial that never reached Stripe, so 'trialing' alone
  // is not the whole answer. Goes red if the trialEndsAt check is removed: every
  // expired no-card trial would keep the product forever.
  it('refuses a trialing firm whose trialEndsAt has passed', async () => {
    await setPlan(firm.id, { billingStatus: 'trialing', trialEndsAt: dayAgo() });

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('BILLING_INACTIVE');
    expect(res.body.details).toEqual({ billingStatus: 'trialing' });
  });

  it('serves a trialing firm whose trialEndsAt is still ahead', async () => {
    await setPlan(firm.id, { billingStatus: 'trialing', trialEndsAt: dayAhead() });

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(200);
    expect(res.body.matters.length).toBeGreaterThan(0);
  });

  /**
   * A Stripe-tracked trial is Stripe's to end, by webhook. Treating the stored
   * date as authoritative would lock a firm whose card has already been charged
   * on the day the trial rolls into a paid subscription. Goes red if the
   * `!plan.stripeSubscriptionId` condition is dropped.
   */
  it('serves a past-dated trial once Stripe tracks the subscription', async () => {
    await setPlan(firm.id, {
      billingStatus: 'trialing',
      trialEndsAt: dayAgo(),
      stripeSubscriptionId: 'sub_tracked',
    });

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(200);
    expect(res.body.matters.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Exempt paths: the way back out of a lockout
 * ------------------------------------------------------------------ */
describe('paths that stay reachable while the workspace is locked', () => {
  /**
   * If these were gated, a lapsed firm could not reach the page that lets it
   * pay, and the lockout would be permanent. Two come from
   * `EXEMPT_PREFIXES` inside the gate ('/subscriptions', '/invitations'); the
   * firm-detail and members routes are reachable because `app.use('/api/lawfirms',
   * [lawfirms, roles, members])` is mounted ABOVE the gate in app.ts, which is a
   * different mechanism and therefore its own risk.
   *
   * Each goes red if its exemption is removed.
   */
  beforeEach(async () => {
    await setPlan(firm.id, { billingStatus: 'canceled' });
  });

  // The subscriptions status endpoint staying readable, owner and all, once
  // the firm is locked is pinned in `subscriptionRoutes.test.ts` ("status").

  /**
   * The checkout endpoint is the actual way out of the lockout, so it has to be
   * reachable. Stripe is not reachable in-process, so the request is sent with a
   * deliberately empty body: `validate(createCheckoutSchema)` runs INSIDE the
   * subscriptions router, after the billing gate would have fired, so a 400 from
   * it proves the gate let the request through and stops the test before any
   * network call. Goes red as a 402 if '/subscriptions' loses its exemption.
   */
  it('lets a locked firm reach the checkout endpoint', async () => {
    const res = await owner.api
      .post(`/api/lawfirms/${firm.id}/subscriptions/checkout`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).not.toBe('BILLING_INACTIVE');
  });

  it('serves the invitations endpoints so a pending member can still be let in', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/invitations/pending-member-invites`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.invites)).toBe(true);
  });

  it('serves the firm detail route so the frontend can render the lock screen', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: firm.id }));
  });

  it('serves the members list route', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/members`);

    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.userId)).toContain(owner.uid);
  });

  /**
   * The exemption is a PATH-SEGMENT match (`path === p || path.startsWith(p +
   * '/')`), not a bare `startsWith`. Goes red if it is loosened to
   * `path.startsWith('/subscriptions')`, which would leave every future route
   * whose name merely begins with an exempt prefix silently ungated.
   */
  it('does not exempt a path that merely begins with an exempt prefix', async () => {
    const res = await owner.api.get(`/api/lawfirms/${firm.id}/subscriptionsx`);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('BILLING_INACTIVE');

    // The same path on a served firm is a plain 404, which proves the 402 above
    // came from the gate and not from the route simply not existing.
    const served = await createFirm({ name: 'Served Firm' });
    const servedOwner = await ownerOf(served.id);
    await setPlan(served.id, { billingStatus: 'active' });
    const notFound = await servedOwner.api.get(`/api/lawfirms/${served.id}/subscriptionsx`);
    expect(notFound.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * Middleware ordering
 * ------------------------------------------------------------------ */
describe('the gate runs ahead of the per-router permission gates', () => {
  /**
   * A locked firm must be told to PAY, not told it lacks permission. The gate is
   * mounted at `/api/lawfirms/:lawFirmId` before every router below it, so a
   * caller who is both locked out and unauthorized sees 402, and the client
   * routes them to billing rather than to a role dead end.
   *
   * `memberWith(firm, [])` holds exactly DEFAULT_PERMISSIONS (roles.service
   * unions the baseline into every role), which includes `matters.view` but not
   * `matters.create`. So this caller is genuinely refused by
   * `requirePermission` when billing is fine, which is what the second half
   * proves. Goes red if the gate is moved below the routers, or mounted per
   * router instead of on the shared prefix.
   */
  it('answers 402, not 403, when the caller also lacks the route permission', async () => {
    const narrow = await memberWith(firm.id, []);
    await setPlan(firm.id, { billingStatus: 'canceled' });

    const locked = await narrow.api.post(`/api/lawfirms/${firm.id}/matters`).send({});
    expect(locked.status).toBe(402);
    expect(locked.body.code).toBe('BILLING_INACTIVE');

    // Same caller, same route, billing restored: now the permission gate is the
    // one that answers. Without this half, the 402 above would pass even if the
    // caller had been allowed to create matters all along.
    await setPlan(firm.id, { billingStatus: 'active' });
    const unauthorized = await narrow.api.post(`/api/lawfirms/${firm.id}/matters`).send({});
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.body.details).toEqual({ requiredPermission: ['matters.create'] });
  });

  // `verifyToken` is mounted ahead of the gate on the same line. An anonymous
  // caller must get 401 and learn nothing about the firm. Goes red if the gate
  // is ever mounted without verifyToken in front of it, which is exactly the
  // regression the mount comment in app.ts records.
  it('answers 401, not 402, to an unauthenticated caller', async () => {
    await setPlan(firm.id, { billingStatus: 'canceled' });

    const res = await request().get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(401);
    expect(res.body.code).not.toBe('BILLING_INACTIVE');
  });
});

/* ------------------------------------------------------------------ *
 * Tenant scope
 * ------------------------------------------------------------------ */
describe('tenant scope', () => {
  let otherFirm: Firm;
  let otherOwner: Actor;

  beforeEach(async () => {
    otherFirm = await createFirm({ name: 'Other Firm' });
    otherOwner = await ownerOf(otherFirm.id);
    await seedMatter(otherFirm.id, 'Other Firm Matter');
    await setPlan(otherFirm.id, { billingStatus: 'active' });
    await setPlan(firm.id, { billingStatus: 'canceled' });
  });

  /**
   * The gate resolves the firm from the URL, so a member of a locked firm cannot
   * borrow a paying firm's status to reach that firm's data. The refusal comes
   * from the route's own membership gate, which is the same answer a stranger
   * would get for a perfectly healthy firm.
   *
   * Goes red if the gate ever resolves the firm from the caller's membership
   * rather than the URL, or if a 402 on the caller's own firm were allowed to
   * short-circuit into serving another firm's rows.
   */
  it("a member of a locked firm cannot read another firm's data", async () => {
    const res = await owner.api.get(`/api/lawfirms/${otherFirm.id}/matters`);

    expect(res.status).toBe(403);
    expect(res.body.matters).toBeUndefined();

    // The data really is there and really is readable by its own firm, so the
    // 403 above is a refusal and not an empty world.
    const legit = await otherOwner.api.get(`/api/lawfirms/${otherFirm.id}/matters`);
    expect(legit.status).toBe(200);
    expect(legit.body.matters.length).toBeGreaterThan(0);
  });

  /**
   * The 402 names the firm's subscription state, so answering it to a
   * non-member would make the gate an oracle for whether a firm exists and
   * whether it is paying. A non-member must fall through to the ordinary 403.
   * Goes red if the `loadResolvedMember` check is removed from the gate.
   */
  it('does not reveal a locked firm\'s billing state to a non-member', async () => {
    const outsider = stranger();

    const res = await outsider.api.get(`/api/lawfirms/${firm.id}/matters`);
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('BILLING_INACTIVE');
    expect(res.body.details).toBeUndefined();
  });
});
