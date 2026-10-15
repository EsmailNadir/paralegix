/**
 * The six self-serve subscription routes, driven through the real app.
 *
 * `tests/subscriptions/subscriptionWebhook.test.ts` covers the inbound half:
 * what Stripe tells us. This file covers the outbound half: what a caller can
 * make us tell Stripe, and who is allowed to.
 *
 * WHY WHO MATTERS MORE THAN WHAT. Five of the six routes move money or move the
 * firm's entitlement, and they are separated from the rest of the firm by ONE
 * permission code (`settings.manageFirm`), which is deliberately not in the
 * always-on baseline. If that gate slipped, any member of a firm could downgrade
 * it mid-month, cancel it, or open a Stripe billing portal session against the
 * firm's real customer record. None of that looks wrong on a screen until the
 * renewal fails. So every refusal below asserts BOTH that the stored plan is
 * unchanged AND that no Stripe call was attempted: a route that refuses after
 * calling Stripe has already done the damage.
 *
 * HOW STRIPE IS STUBBED. Same mechanism as the webhook spec: `stripe.config` is
 * a REAL Stripe instance built from a placeholder key, with only the five
 * methods these routes use replaced. Everything else about the client is intact,
 * and nothing reaches the network. A developer's `.env` carries a live
 * STRIPE_SECRET_KEY, so leaving these live would talk to a real account.
 */

// Hoisted above the imports by Jest. The `mock` prefix is what lets the factory
// close over the spies.
const mockSubscriptionRetrieve = jest.fn();
const mockSubscriptionUpdate = jest.fn();
const mockCustomerCreate = jest.fn();
const mockCheckoutCreate = jest.fn();
const mockPortalCreate = jest.fn();
const mockSubscriptionList = jest.fn();
const mockCheckoutList = jest.fn();
const mockCheckoutExpire = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  // `require`, not `import`: the package's ESM entry does not parse under Jest.
  const StripeCtor = require('stripe');
  // `new Stripe(key)` performs no I/O at construction, so a fake key is enough.
  const instance = new StripeCtor('sk_test_offline_subscription_routes');
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  instance.subscriptions.update = (...args: any[]) => mockSubscriptionUpdate(...args);
  instance.customers.create = (...args: any[]) => mockCustomerCreate(...args);
  instance.checkout.sessions.create = (...args: any[]) => mockCheckoutCreate(...args);
  instance.billingPortal.sessions.create = (...args: any[]) => mockPortalCreate(...args);
  instance.subscriptions.list = (...args: any[]) => mockSubscriptionList(...args);
  instance.checkout.sessions.list = (...args: any[]) => mockCheckoutList(...args);
  instance.checkout.sessions.expire = (...args: any[]) => mockCheckoutExpire(...args);
  return instance;
});

import { randomUUID } from 'crypto';
import {
  createFirm,
  createFirmMember,
  drainEvents,
  memberWith,
  ownerOf,
  portalUser,
  setFirmPlan,
  testPool,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const PROFESSIONAL_ANNUAL = 'price_test_professional_annual_routes';
const ENTERPRISE_MONTHLY = 'price_test_enterprise_monthly_routes';

let firm: Firm;
let owner: Actor;
/** A member with the always-on baseline and nothing else. */
let member: Actor;
let client: Actor;

const url = (suffix: string, lawFirmId = firm.id) =>
  `/api/lawfirms/${lawFirmId}/subscriptions${suffix}`;

/** The firm's billing state as every gate in the product reads it. */
async function billingRow(lawFirmId: string) {
  const { rows } = await testPool.query(
    'select billing_status, plan_id, plan from law_firms where id = $1',
    [lawFirmId],
  );
  return rows[0];
}

/**
 * Put the firm in a known billing state without going through a handler.
 * `setFirmPlan` routes planId/billingStatus to their columns, which is where
 * migration 0200 made them authoritative; seeding them into the plan jsonb
 * leaves the columns on their defaults and silently tests a comped firm.
 */
const seedPlan = (lawFirmId: string, plan: Record<string, unknown>) =>
  setFirmPlan(lawFirmId, plan, { replace: true });

/** A live subscription as `subscriptions.retrieve` renders it. */
function liveSubscription(overrides: { id?: string; status?: string } = {}) {
  return {
    id: overrides.id ?? 'sub_routes_1',
    object: 'subscription',
    status: overrides.status ?? 'active',
    cancel_at_period_end: false,
    items: {
      object: 'list',
      data: [{
        id: 'si_routes_1',
        object: 'subscription_item',
        price: { id: ENTERPRISE_MONTHLY, object: 'price' },
        current_period_start: Math.floor(Date.UTC(2026, 5, 1) / 1000),
        current_period_end: Math.floor(Date.UTC(2026, 6, 1) / 1000),
      }],
    },
  };
}

/** No Stripe call of any kind was attempted. */
function expectNoStripeCalls() {
  expect(mockSubscriptionRetrieve).not.toHaveBeenCalled();
  expect(mockSubscriptionUpdate).not.toHaveBeenCalled();
  expect(mockCustomerCreate).not.toHaveBeenCalled();
  expect(mockCheckoutCreate).not.toHaveBeenCalled();
  expect(mockPortalCreate).not.toHaveBeenCalled();
  expect(mockSubscriptionList).not.toHaveBeenCalled();
  expect(mockCheckoutList).not.toHaveBeenCalled();
  expect(mockCheckoutExpire).not.toHaveBeenCalled();
}

beforeAll(() => {
  // Set BEFORE the first request, which is when the app graph is first required
  // and `stripePrices.ts` freezes PRICE_MAP into a module constant. Assigned
  // rather than defaulted: whatever an untracked `.env` holds must not decide
  // which prices this file maps, and CI has no `.env` at all.
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_subscription_routes';
  process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID = PROFESSIONAL_ANNUAL;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY;
  // Blanked, not merely left alone. A developer's untracked `.env` carries real
  // price ids for every tier, and the "maps to no price" case below needs one
  // combination that genuinely resolves to null.
  process.env.STRIPE_BASIC_MONTHLY_PRICE_ID = '';
  process.env.STRIPE_BASIC_ANNUAL_PRICE_ID = '';
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  member = await memberWith(firm.id, []);
  client = await portalUser();
  [mockSubscriptionRetrieve, mockSubscriptionUpdate, mockCustomerCreate,
    mockCheckoutCreate, mockPortalCreate, mockSubscriptionList, mockCheckoutList,
    mockCheckoutExpire].forEach((spy) => spy.mockReset());
  // Stripe's answer for a customer with nothing in flight. A case that needs
  // another subscription or an open checkout overrides it.
  mockSubscriptionList.mockResolvedValue({ object: 'list', data: [], has_more: false });
  mockCheckoutList.mockResolvedValue({ object: 'list', data: [], has_more: false });
  mockCheckoutExpire.mockResolvedValue({ status: 'expired' });
  await drainEvents();
});

describe('a member without settings.manageFirm', () => {
  /**
   * The five routes that change billing, with a body where one is required.
   * `/status` is deliberately absent: it is gated on `members.view`, which IS in
   * the baseline, and its own case is below.
   */
  const MUTATIONS: Array<[string, string, Record<string, unknown>]> = [
    ['checkout', '/checkout', { planId: 'professional', interval: 'annual' }],
    ['portal', '/portal', {}],
    ['change-plan', '/change-plan', { planId: 'professional', interval: 'annual' }],
    ['cancel', '/cancel', {}],
    ['reactivate', '/reactivate', {}],
  ];

  it.each(MUTATIONS)('is refused on %s, and reaches neither the plan nor Stripe', async (
    _name, suffix, body,
  ) => {
    // A firm with a real, live subscription, so there is genuinely something to
    // damage. Against an empty plan the route would refuse for its own reasons
    // and the refusal would prove nothing about the permission gate.
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_routes_1',
      stripeCustomerId: 'cus_routes_1',
      cancelAtPeriodEnd: false,
    });
    const before = await billingRow(firm.id);
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());

    const res = await member.api.post(url(suffix)).send(body);
    await drainEvents();

    expect(res.status).toBe(403);
    expect(await billingRow(firm.id)).toEqual(before);
    // The half a status assertion cannot see. A gate that runs after the Stripe
    // call has already cancelled the subscription and then reported 403.
    expectNoStripeCalls();
  });

  it('may still read status, because members.view is in the baseline', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await member.api.get(url('/status'));

    // Deliberately readable by everyone: this is the one firm-scoped payload
    // still served once billing lapses and the workspace is locked, and it
    // carries the owner's name so a member who cannot pay knows who to ask.
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe('enterprise');
    expect(res.body.owner.email).toBe(`${owner.uid}@example.test`);
    expect(res.body.owner.email).not.toBe(`${member.uid}@example.test`);
  });
});

describe('a portal client', () => {
  const ROUTES: Array<[string, 'get' | 'post', string, Record<string, unknown>]> = [
    ['status', 'get', '/status', {}],
    ['checkout', 'post', '/checkout', { planId: 'professional', interval: 'annual' }],
    ['portal', 'post', '/portal', {}],
    ['change-plan', 'post', '/change-plan', { planId: 'professional', interval: 'annual' }],
    ['cancel', 'post', '/cancel', {}],
    ['reactivate', 'post', '/reactivate', {}],
  ];

  it.each(ROUTES)('is refused on %s and learns nothing about the firm', async (
    _name, method, suffix, body,
  ) => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_routes_1',
      stripeCustomerId: 'cus_routes_1',
    });
    const before = await billingRow(firm.id);
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());

    const res = method === 'get'
      ? await client.api.get(url(suffix))
      : await client.api.post(url(suffix)).send(body);
    await drainEvents();

    // A client has no `members` row at all, so every route here refuses,
    // `/status` included. The body check is what catches a refusal that still
    // rendered the firm's Stripe ids into the error payload.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('cus_routes_1');
    expect(await billingRow(firm.id)).toEqual(before);
    expectNoStripeCalls();
  });
});

describe('an owner of a different firm', () => {
  it('cannot cancel this firm subscription', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', stripeSubscriptionId: 'sub_routes_1',
    });
    const before = await billingRow(firm.id);
    const otherFirm = await createFirm();
    const otherOwner = await ownerOf(otherFirm.id);
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());

    const res = await otherOwner.api.post(url('/cancel')).send({});
    await drainEvents();

    // Owner of somewhere else is not owner here. The permission gate resolves
    // the member against the firm in the URL, so this is the tenancy boundary.
    expect(res.status).toBe(403);
    expect(await billingRow(firm.id)).toEqual(before);
    expectNoStripeCalls();
  });
});

describe('the owner changing plan', () => {
  beforeEach(async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      billingInterval: 'monthly',
      stripeSubscriptionId: 'sub_routes_1',
      stripeCustomerId: 'cus_routes_1',
    });
  });

  it('updates the Stripe subscription item to the new plan price', async () => {
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());
    mockSubscriptionUpdate.mockResolvedValue(liveSubscription());

    const res = await owner.api.post(url('/change-plan'))
      .send({ planId: 'professional', interval: 'annual' });
    await drainEvents();

    expect(res.status).toBe(200);
    expect(mockSubscriptionUpdate).toHaveBeenCalledTimes(1);
    const [subscriptionId, payload] = mockSubscriptionUpdate.mock.calls[0];
    expect(subscriptionId).toBe('sub_routes_1');
    // The price id, the item it is swapped onto, and the proration behaviour are
    // the entire content of this route. A wrong price bills the firm for the
    // wrong tier; a missing item id creates a SECOND subscription item and the
    // firm pays for both.
    expect(payload.items).toEqual([{ id: 'si_routes_1', price: PROFESSIONAL_ANNUAL }]);
    expect(payload.proration_behavior).toBe('create_prorations');
    expect(payload.metadata).toMatchObject({ lawFirmId: firm.id, planId: 'professional' });
  });

  it('leaves the stored plan alone, because Stripe converges it by webhook', async () => {
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());
    mockSubscriptionUpdate.mockResolvedValue(liveSubscription());

    await owner.api.post(url('/change-plan')).send({ planId: 'professional', interval: 'annual' });
    await drainEvents();

    // CHARACTERISED, NOT ENDORSED. The row still says enterprise/monthly. That
    // is deliberate: `customer.subscription.updated` is what writes the plan, so
    // the firm's entitlement always reflects what Stripe actually billed rather
    // than what was requested. It also means a change-plan whose webhook never
    // arrives leaves the firm on the old tier, which is the safe direction.
    const row = await billingRow(firm.id);
    expect(row.plan_id).toBe('enterprise');
    expect(row.plan.billingInterval).toBe('monthly');
  });

  it('refuses a plan or interval that maps to no price, and calls Stripe not at all', async () => {
    const res = await owner.api.post(url('/change-plan'))
      .send({ planId: 'basic', interval: 'monthly' });

    // `basic/monthly` has no price id configured in this file, so `getPriceId`
    // answers null. Validation passes (it is a legal enum value), which is what
    // makes this the service's guard rather than the schema's.
    expect(res.status).toBe(400);
    expect(mockSubscriptionUpdate).not.toHaveBeenCalled();
    expect((await billingRow(firm.id)).plan_id).toBe('enterprise');
  });

  it('refuses when the firm has no subscription at all', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await owner.api.post(url('/change-plan'))
      .send({ planId: 'professional', interval: 'annual' });

    expect(res.status).toBe(400);
    expectNoStripeCalls();
  });

  describe('to a plan the firm has outgrown', () => {
    // Professional allows 15 seats and 250 matters; the seeded firm is on
    // Enterprise, which allows any number of both. The firm starts with two
    // members: its owner and the baseline member from the outer beforeEach.
    async function addMembers(count: number) {
      for (let i = 0; i < count; i += 1) await createFirmMember(firm.id, { isOwner: false });
    }
    async function addPendingInvites(count: number) {
      for (let i = 0; i < count; i += 1) {
        await testPool.query(
          `insert into invitations (id, law_firm_id, email, invite_type, token, status, expires_at, invited_at)
           values ($1, $2, $3, 'member', $4, 'pending', now() + interval '7 days', now())`,
          [randomUUID(), firm.id, `invitee-${randomUUID().slice(0, 8)}@example.test`, randomUUID().replace(/-/g, '')],
        );
      }
    }
    async function addMatters(count: number) {
      await testPool.query(
        `insert into matters (law_firm_id, name, matter_reference_id)
         select $1, 'Matter ' || n, 'REF-' || n || '-' || substr(md5(random()::text), 1, 6)
         from generate_series(1, $2::int) n`,
        [firm.id, count],
      );
    }

    beforeEach(() => {
      mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());
      mockSubscriptionUpdate.mockResolvedValue(liveSubscription());
    });

    it('refuses when members plus pending invitations exceed the new plan\'s seats', async () => {
      // 14 members (2 to start, 12 more) and 2 invitations: 16 seats against 15.
      await addMembers(12);
      await addPendingInvites(2);

      const res = await owner.api.post(url('/change-plan'))
        .send({ planId: 'professional', interval: 'annual' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/16 members/);
      expect(res.body.error).toMatch(/2 pending invitations/);
      expect(res.body.error).toMatch(/Professional allows 15/);
      // The refusal has to come before Stripe bills the firm for the new tier.
      expect(mockSubscriptionUpdate).not.toHaveBeenCalled();
    });

    it('refuses when the firm has more matters than the new plan allows', async () => {
      await addMatters(251);

      const res = await owner.api.post(url('/change-plan'))
        .send({ planId: 'professional', interval: 'annual' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/251 matters/);
      expect(res.body.error).toMatch(/Professional allows 250/);
      expect(mockSubscriptionUpdate).not.toHaveBeenCalled();
    });

    it('allows a firm sitting exactly at the new plan\'s limits', async () => {
      await addMembers(13);
      await addMatters(250);

      const res = await owner.api.post(url('/change-plan'))
        .send({ planId: 'professional', interval: 'annual' });

      expect(res.status).toBe(200);
      expect(mockSubscriptionUpdate).toHaveBeenCalledTimes(1);
    });

    it('measures against the firm\'s own limit overrides, as enforcement does', async () => {
      await seedPlan(firm.id, {
        planId: 'enterprise', billingStatus: 'active', billingInterval: 'monthly',
        stripeSubscriptionId: 'sub_routes_1', stripeCustomerId: 'cus_routes_1',
        limitOverrides: { maxMembers: 40 },
      });
      await addMembers(19);

      const res = await owner.api.post(url('/change-plan'))
        .send({ planId: 'professional', interval: 'annual' });

      expect(res.status).toBe(200);
      expect(mockSubscriptionUpdate).toHaveBeenCalledTimes(1);
    });

    it('lets an unlimited-override firm move to any plan', async () => {
      await seedPlan(firm.id, {
        planId: 'enterprise', billingStatus: 'active', billingInterval: 'monthly',
        stripeSubscriptionId: 'sub_routes_1', stripeCustomerId: 'cus_routes_1',
        unlimitedOverride: true,
      });
      await addMembers(19);

      const res = await owner.api.post(url('/change-plan'))
        .send({ planId: 'professional', interval: 'annual' });

      expect(res.status).toBe(200);
      expect(mockSubscriptionUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses when Stripe no longer has the subscription', async () => {
    mockSubscriptionRetrieve.mockRejectedValue(
      Object.assign(new Error('No such subscription'), { statusCode: 404, code: 'resource_missing' }),
    );

    const res = await owner.api.post(url('/change-plan'))
      .send({ planId: 'professional', interval: 'annual' });

    // A dead id is terminal, not an outage: it must answer 404 rather than
    // propagating a Stripe error as a 500.
    expect(res.status).toBe(404);
    expect(mockSubscriptionUpdate).not.toHaveBeenCalled();
  });
});

describe('the owner cancelling and reactivating', () => {
  beforeEach(async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_routes_1',
      cancelAtPeriodEnd: false,
    });
  });

  it('persists cancelAtPeriodEnd and asks Stripe for the same thing', async () => {
    mockSubscriptionUpdate.mockResolvedValue(liveSubscription());

    const res = await owner.api.post(url('/cancel')).send({});
    await drainEvents();

    expect(res.status).toBe(200);
    expect(mockSubscriptionUpdate)
      .toHaveBeenCalledWith('sub_routes_1', { cancel_at_period_end: true });
    const row = await billingRow(firm.id);
    // Written locally as well as at Stripe, because the billing screen reads
    // this row rather than calling Stripe on render.
    expect(row.plan.cancelAtPeriodEnd).toBe(true);
    // Access is NOT revoked here. The firm has paid through the period, so the
    // status stays active until the `deleted` webhook arrives.
    expect(row.billing_status).toBe('active');
    expect(row.plan.stripeSubscriptionId).toBe('sub_routes_1');
  });

  it('clears cancelAtPeriodEnd on reactivate', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_routes_1',
      cancelAtPeriodEnd: true,
    });
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());
    mockSubscriptionUpdate.mockResolvedValue(liveSubscription());

    const res = await owner.api.post(url('/reactivate')).send({});
    await drainEvents();

    expect(res.status).toBe(200);
    expect(mockSubscriptionUpdate)
      .toHaveBeenCalledWith('sub_routes_1', { cancel_at_period_end: false });
    expect((await billingRow(firm.id)).plan.cancelAtPeriodEnd).toBe(false);
  });

  it('refuses to reactivate a subscription Stripe has already ended', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'canceled',
      stripeSubscriptionId: 'sub_routes_1',
      cancelAtPeriodEnd: true,
    });
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription({ status: 'canceled' }));

    const res = await owner.api.post(url('/reactivate')).send({});
    await drainEvents();

    // A terminal Stripe subscription cannot be un-cancelled. Writing
    // `cancelAtPeriodEnd: false` here would leave the firm's screen claiming an
    // active subscription that will never bill again.
    expect(res.status).toBe(400);
    expect(mockSubscriptionUpdate).not.toHaveBeenCalled();
    const row = await billingRow(firm.id);
    expect(row.plan.cancelAtPeriodEnd).toBe(true);
    expect(row.billing_status).toBe('canceled');
  });

  it('refuses to cancel when there is no subscription', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'comped' });

    const res = await owner.api.post(url('/cancel')).send({});

    expect(res.status).toBe(400);
    expectNoStripeCalls();
  });
});

describe('the owner opening checkout and the billing portal', () => {
  it('creates a checkout session against the stored customer', async () => {
    await seedPlan(firm.id, { billingStatus: 'incomplete', stripeCustomerId: 'cus_routes_1' });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_1', url: 'https://stripe.test/checkout/cs_1' });

    const res = await owner.api.post(url('/checkout'))
      .send({ planId: 'professional', interval: 'annual' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkoutUrl: 'https://stripe.test/checkout/cs_1', sessionId: 'cs_1' });
    const [payload] = mockCheckoutCreate.mock.calls[0];
    expect(payload.customer).toBe('cus_routes_1');
    expect(payload.line_items).toEqual([{ price: PROFESSIONAL_ANNUAL, quantity: 1 }]);
    // The firm id has to travel on the subscription's own metadata: it is the
    // ONLY thing the webhook has to identify which firm a Stripe event is about.
    expect(payload.subscription_data.metadata.lawFirmId).toBe(firm.id);
    // A customer already exists, so a second one must not be created; two Stripe
    // customers for one firm splits its payment methods and invoice history.
    expect(mockCustomerCreate).not.toHaveBeenCalled();
  });

  it('refuses checkout while a live subscription already exists', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      stripeSubscriptionId: 'sub_routes_1',
      stripeCustomerId: 'cus_routes_1',
    });
    mockSubscriptionRetrieve.mockResolvedValue(liveSubscription());

    const res = await owner.api.post(url('/checkout'))
      .send({ planId: 'professional', interval: 'annual' });

    // Otherwise a firm ends up paying two subscriptions at once, and only the
    // most recent webhook decides which one the product believes in.
    expect(res.status).toBe(400);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('refuses checkout when Stripe has an unfinished subscription the firm row does not know about yet', async () => {
    // The first checkout completed a moment ago and its webhook has not landed,
    // so nothing on the firm row says there is a subscription. Stripe does.
    await seedPlan(firm.id, { billingStatus: 'incomplete', stripeCustomerId: 'cus_routes_1' });
    mockSubscriptionList.mockResolvedValue({
      object: 'list', has_more: false,
      data: [liveSubscription({ id: 'sub_canceled_long_ago', status: 'canceled' }), liveSubscription({ status: 'trialing' })],
    });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_second', url: 'https://stripe.test/checkout/cs_second' });

    const res = await owner.api.post(url('/checkout'))
      .send({ planId: 'professional', interval: 'annual' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already has an active subscription/i);
    expect(mockSubscriptionList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_routes_1', status: 'all' }));
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('allows checkout when every subscription Stripe has for the customer is finished', async () => {
    await seedPlan(firm.id, { billingStatus: 'canceled', stripeCustomerId: 'cus_routes_1' });
    mockSubscriptionList.mockResolvedValue({
      object: 'list', has_more: false,
      data: [
        liveSubscription({ id: 'sub_old_1', status: 'canceled' }),
        liveSubscription({ id: 'sub_old_2', status: 'incomplete_expired' }),
      ],
    });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_4', url: 'https://stripe.test/checkout/cs_4' });

    const res = await owner.api.post(url('/checkout'))
      .send({ planId: 'professional', interval: 'annual' });

    expect(res.status).toBe(200);
    expect(mockCheckoutCreate).toHaveBeenCalledTimes(1);
  });

  it('expires the customer\'s other open subscription checkouts, so only the newest can be paid', async () => {
    // Two tabs, or two admins: both opened checkout before either paid. Neither
    // has produced a subscription yet, so the check above cannot see them.
    await seedPlan(firm.id, { billingStatus: 'incomplete', stripeCustomerId: 'cus_routes_1' });
    mockCheckoutList.mockResolvedValue({
      object: 'list', has_more: false,
      data: [
        { id: 'cs_other_tab', object: 'checkout.session', mode: 'subscription', status: 'open' },
        { id: 'cs_not_a_subscription', object: 'checkout.session', mode: 'payment', status: 'open' },
      ],
    });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_5', url: 'https://stripe.test/checkout/cs_5' });

    const res = await owner.api.post(url('/checkout'))
      .send({ planId: 'professional', interval: 'annual' });

    expect(res.status).toBe(200);
    expect(mockCheckoutList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_routes_1', status: 'open' }));
    expect(mockCheckoutExpire.mock.calls).toEqual([['cs_other_tab']]);
    expect(mockCheckoutCreate).toHaveBeenCalledTimes(1);
  });

  it('does not grant a second trial to a firm that has already consumed one', async () => {
    await seedPlan(firm.id, {
      billingStatus: 'canceled', stripeCustomerId: 'cus_routes_1', trialConsumed: true,
    });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_2', url: 'https://stripe.test/checkout/cs_2' });

    const res = await owner.api.post(url('/checkout'))
      .send({ planId: 'professional', interval: 'annual' });

    expect(res.status).toBe(200);
    // `trialConsumed` survives cancellation precisely so cancel-then-recheckout
    // cannot mint a fresh 14-day trial on repeat, indefinitely.
    expect(mockCheckoutCreate.mock.calls[0][0].subscription_data.trial_period_days)
      .toBeUndefined();
  });

  it('offers a trial to a firm that has never had a subscription', async () => {
    await seedPlan(firm.id, { billingStatus: 'incomplete', stripeCustomerId: 'cus_routes_1' });
    mockCheckoutCreate.mockResolvedValue({ id: 'cs_3', url: 'https://stripe.test/checkout/cs_3' });

    await owner.api.post(url('/checkout')).send({ planId: 'professional', interval: 'annual' });

    // The control for the case above: without it, "no trial" would pass just as
    // well against a route that never offers one.
    expect(mockCheckoutCreate.mock.calls[0][0].subscription_data.trial_period_days).toBe(14);
  });

  it('opens a portal session for the firm own customer', async () => {
    await seedPlan(firm.id, { billingStatus: 'active', stripeCustomerId: 'cus_routes_1' });
    mockPortalCreate.mockResolvedValue({ url: 'https://stripe.test/portal/bps_1' });

    const res = await owner.api.post(url('/portal')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ portalUrl: 'https://stripe.test/portal/bps_1' });
    // The Stripe billing portal exposes payment methods and invoice history, so
    // the customer id it is opened against is the whole security boundary.
    expect(mockPortalCreate.mock.calls[0][0].customer).toBe('cus_routes_1');
  });

  it('refuses a portal session for a firm with no billing account', async () => {
    await seedPlan(firm.id, { billingStatus: 'comped' });

    const res = await owner.api.post(url('/portal')).send({});

    expect(res.status).toBe(400);
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });
});

describe('status', () => {
  it('reports the stored plan, usage and limits for this firm only', async () => {
    await seedPlan(firm.id, {
      planId: 'professional',
      billingStatus: 'active',
      billingInterval: 'annual',
      stripeSubscriptionId: 'sub_routes_1',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
    });
    // A second firm with a bigger world, so a query that lost its tenant scope
    // would report inflated usage here rather than the same numbers.
    const otherFirm = await createFirm();
    await ownerOf(otherFirm.id);
    await ownerOf(otherFirm.id);
    await testPool.query(
      `insert into matters (law_firm_id, name, matter_reference_id)
       values ($1, 'Other firm matter', 'M-OTHER-1')`,
      [otherFirm.id],
    );

    const res = await owner.api.get(url('/status'));

    expect(res.status).toBe(200);
    expect(res.body.planId).toBe('professional');
    expect(res.body.billingStatus).toBe('active');
    expect(res.body.billingInterval).toBe('annual');
    expect(res.body.currentPeriodEnd).toBe('2026-07-01T00:00:00.000Z');
    // Two members here (the owner and the baseline member), one matter there.
    expect(res.body.usage.members.activeMembers).toBe(2);
    expect(res.body.usage.matters.current).toBe(0);
  });

  it('stays readable after the workspace itself has been locked', async () => {
    await seedPlan(firm.id, { planId: 'professional', billingStatus: 'canceled' });

    const status = await owner.api.get(url('/status'));
    const workspace = await owner.api.get(`/api/lawfirms/${firm.id}/matters`);

    // `requireActiveBilling` closes the firm's data routes at 402 and exempts
    // /subscriptions so the firm can still see what it owes and pay. If this
    // endpoint ever fell behind the gate, a lapsed firm would face a lock screen
    // with no way to read its own plan or find its owner, and no way out.
    expect(workspace.status).toBe(402);
    expect(status.status).toBe(200);
    expect(status.body.billingStatus).toBe('canceled');
    // The owner's stored identity, read from the fixture rather than the code
    // under test: the paywall has to tell a reader who cannot pay who can.
    const { rows } = await testPool.query('select name, email from users where id = $1', [owner.uid]);
    expect(status.body.owner).toEqual({ name: rows[0].name, email: rows[0].email });
  });

  it('reports the trial end date the client gate expires a no-card trial on', async () => {
    // The frontend locks a trial with no `stripeSubscriptionId` once this date
    // passes (lib/plans/billingAccess.ts). It cannot do that if the date is absent.
    const trialEndsAt = '2026-08-30T12:00:00.000Z';
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'trialing', trialEndsAt });

    const res = await owner.api.get(url('/status'));

    expect(res.status).toBe(200);
    expect(res.body.billingStatus).toBe('trialing');
    expect(res.body.trialEndsAt).toBe(trialEndsAt);
    expect(res.body.stripeSubscriptionId).toBeNull();
  });

  it('counts a pending member invitation against the seat limit', async () => {
    await seedPlan(firm.id, { planId: 'professional', billingStatus: 'active' });
    await testPool.query(
      `insert into invitations (law_firm_id, email, invite_type, status, token, expires_at)
       values ($1, 'invitee@example.test', 'member', 'pending', $2, now() + interval '7 days')`,
      [firm.id, `tok-${firm.id}`],
    );

    const res = await owner.api.get(url('/status'));

    // Seats and enforcement have to agree. When this reported bare members, the
    // upgrade screen told a firm it had a free seat and the invite that tried to
    // use it was then rejected.
    expect(res.body.usage.members.activeMembers).toBe(2);
    expect(res.body.usage.members.pendingInvites).toBe(1);
    expect(res.body.usage.members.current).toBe(3);
  });
});
