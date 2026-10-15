/**
 * The six subscription mutations on the admin console, and the plan patch beside
 * them.
 *
 * `tests/admin/adminMutations.test.ts` reaches `subscription/comp` twice and
 * stops there, with a note at the top of the file saying the rest are avoided
 * because they talk to Stripe. That leaves create, cancel, extend-trial,
 * apply-coupon and refund entirely unexercised: five routes that move a paying
 * customer's money and billing state, reachable by anyone holding the
 * platform-admin flag.
 *
 * Stripe is replaced at the module boundary, which is what makes them testable.
 * The double records its arguments, so the assertions are about WHICH
 * subscription, WHICH customer and WHICH amount the console acted on. That is
 * the half a status code cannot tell you: an admin cancelling firm B's
 * subscription while looking at firm A's console page returns exactly the same
 * 200 as the correct call, and the two firms here are seeded with different
 * Stripe ids specifically so the wrong one is visible.
 *
 * The plan-price map is stubbed too, and deliberately leaves `enterprise/annual`
 * unmapped. The real map is built from env vars at module load, so a spec that
 * used it would assert one thing on a developer machine with a full `.env` and
 * another in CI, where none of the price ids are set.
 *
 * What is NOT re-tested here: the tier change, the storage-quota re-sync, and
 * the comp metadata, which `adminMutations.test.ts` already pins. What is added
 * for the plan patch is the neighbour firm and the absent firm, because
 * `mergePlan` takes the firm id from the path and nothing else.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => ({
  customers: { create: jest.fn() },
  subscriptions: {
    create: jest.fn(), cancel: jest.fn(), update: jest.fn(), retrieve: jest.fn(),
  },
  invoices: { list: jest.fn() },
  invoicePayments: { list: jest.fn() },
  refunds: { create: jest.fn() },
}));

jest.mock('../../src/shared/plans/stripePrices', () => {
  // `enterprise.annual` is null on purpose: it is the one configuration that
  // reaches `getPriceId`'s null branch through a body the route's own zod schema
  // accepts, and that branch is where the partial-write question lives.
  const PRICE_MAP: Record<string, Record<string, string | null>> = {
    basic: { monthly: 'price_basic_monthly', annual: 'price_basic_annual' },
    professional: { monthly: 'price_pro_monthly', annual: 'price_pro_annual' },
    enterprise: { monthly: 'price_ent_monthly', annual: null },
  };
  return {
    PRICE_MAP,
    getPriceId: (planId: string, interval: string) => PRICE_MAP[planId]?.[interval] || null,
    planFromPriceId: () => null,
  };
});

import {
  testPool,
  drainEvents,
  createFirm,
  type CallerAgent,
  type Firm,
} from '../support/setupInProcess';
import { firmRow, platformAdmin } from '../support/rows';

const stripe = require('../../src/modules/stripe/stripe.config');

/** A uuid that is well formed but names nothing. */
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

let firmA: Firm;
let firmB: Firm;
let admin: CallerAgent;
let adminUid: string;

/**
 * Seed a firm's billing state the way the application stores it since migration
 * 0200: `planId` and `billingStatus` are the typed COLUMNS, and every other key
 * is merged into the `plan` jsonb. Writing those two into the jsonb instead
 * would leave the columns on their table defaults, which is a state no code
 * path can produce -- `lawfirms.repository` routes both out of the patch on
 * every write.
 */
async function setPlan(lawFirmId: string, patch: Record<string, unknown>): Promise<void> {
  const { planId, billingStatus, ...jsonb } = patch;
  await testPool.query(
    `update law_firms
        set plan           = coalesce(plan, '{}'::jsonb) || $2::jsonb,
            plan_id        = coalesce($3, plan_id),
            billing_status = coalesce($4, billing_status)
      where id = $1`,
    [lawFirmId, JSON.stringify(jsonb), planId ?? null, billingStatus ?? null],
  );
}

/** Every Stripe call this file can make, so "nothing happened" is assertable. */
const stripeCallCount = () => [
  stripe.customers.create,
  stripe.subscriptions.create,
  stripe.subscriptions.cancel,
  stripe.subscriptions.update,
  stripe.subscriptions.retrieve,
  stripe.invoices.list,
  stripe.invoicePayments.list,
  stripe.refunds.create,
].reduce((total, fn) => total + fn.mock.calls.length, 0);

beforeEach(async () => {
  jest.clearAllMocks();
  stripe.customers.create.mockResolvedValue({ id: 'cus_new_from_stripe' });
  stripe.subscriptions.create.mockResolvedValue({ id: 'sub_new_from_stripe' });
  stripe.subscriptions.cancel.mockResolvedValue({ id: 'sub_cancelled' });
  stripe.subscriptions.update.mockResolvedValue({ id: 'sub_updated' });
  stripe.subscriptions.retrieve.mockResolvedValue({
    id: 'sub_a', status: 'trialing', trial_end: 1_800_000_000,
  });
  stripe.invoices.list.mockResolvedValue({ data: [] });
  stripe.invoicePayments.list.mockResolvedValue({ data: [] });
  stripe.refunds.create.mockResolvedValue({ id: 're_1', amount: 9900 });

  firmA = await createFirm({ name: 'Billing Firm Alpha' });
  firmB = await createFirm({ name: 'Billing Firm Beta' });

  // Different Stripe ids per firm. Identical fixtures would make an operation on
  // the wrong firm indistinguishable from the right one.
  await setPlan(firmA.id, {
    planId: 'professional',
    billingStatus: 'active',
    billingInterval: 'monthly',
    stripeCustomerId: 'cus_alpha',
    stripeSubscriptionId: 'sub_alpha',
  });
  await setPlan(firmB.id, {
    planId: 'professional',
    billingStatus: 'active',
    billingInterval: 'monthly',
    stripeCustomerId: 'cus_beta',
    stripeSubscriptionId: 'sub_beta',
  });

  const seeded = await platformAdmin('Billing Admin');
  adminUid = seeded.uid;
  admin = seeded.api;

  await drainEvents();
});

describe('creating a subscription', () => {
  it('reuses the firm existing Stripe customer instead of opening a second one', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/create`)
      .send({ planId: 'professional', interval: 'annual' });

    expect(res.status).toBe(200);
    expect(res.body.stripeSubscriptionId).toBe('sub_new_from_stripe');
    // A duplicate customer splits a firm's billing history in two, and the
    // second one is invisible from the console.
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.create).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_alpha',
      items: [{ price: 'price_pro_annual' }],
    }));
  });

  it('creates and PERSISTS a customer for a firm that has never billed', async () => {
    const fresh = await createFirm({ name: 'Never Billed' });

    const res = await admin.post(`/api/admin/lawfirms/${fresh.id}/subscription/create`)
      .send({ planId: 'professional', interval: 'monthly' });

    expect(res.status).toBe(200);
    // Persisting is the whole point: an unsaved customer id means the next
    // admin action opens yet another customer for the same firm.
    expect((await firmRow(fresh.id)).plan.stripeCustomerId).toBe('cus_new_from_stripe');
    expect(stripe.subscriptions.create).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_new_from_stripe',
      metadata: expect.objectContaining({ lawFirmId: fresh.id, createdBy: adminUid }),
    }));
  });

  it('passes the trial skip and the coupon through, and omits them otherwise', async () => {
    await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/create`)
      .send({ planId: 'professional', interval: 'monthly', skipTrial: true, coupon: 'LAUNCH50' });
    const withExtras = stripe.subscriptions.create.mock.calls[0][0];

    await admin.post(`/api/admin/lawfirms/${firmB.id}/subscription/create`)
      .send({ planId: 'professional', interval: 'monthly' });
    const without = stripe.subscriptions.create.mock.calls[1][0];

    expect(withExtras.trial_period_days).toBe(0);
    expect(withExtras.coupon).toBe('LAUNCH50');
    // Sending `trial_period_days: 0` when the admin did NOT ask to skip the
    // trial silently bills a firm that should have had one.
    expect(without).not.toHaveProperty('trial_period_days');
    expect(without).not.toHaveProperty('coupon');
  });

  it('refuses a plan id that is not sellable, without reaching Stripe', async () => {
    // `starter` is a real tier and not one the console can subscribe a firm to,
    // so this is the shape of a mistyped or stale request rather than a nonsense
    // one. It has to stop at the route's schema.
    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/create`)
      .send({ planId: 'starter', interval: 'monthly' });

    expect(res.status).toBe(400);
    expect(stripeCallCount()).toBe(0);
    expect((await firmRow(firmA.id)).plan.stripeCustomerId).toBe('cus_alpha');
  });

  it('refuses a firm id that names nothing, without reaching Stripe', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${ABSENT_ID}/subscription/create`)
      .send({ planId: 'professional', interval: 'monthly' });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });

  it('an unmapped price is rejected before any Stripe customer is opened', async () => {
    const fresh = await createFirm({ name: 'Unmapped Interval' });

    const res = await admin.post(`/api/admin/lawfirms/${fresh.id}/subscription/create`)
      .send({ planId: 'enterprise', interval: 'annual' });

    expect(res.status).toBe(400);
    expect(stripe.subscriptions.create).not.toHaveBeenCalled();
    // The claim that matters, and the reason this test exists. `getPriceId` used
    // to be looked up AFTER the customer was created and persisted, so a
    // configuration gap answered 400 having already written to Stripe and to the
    // firm row. Goes red if that lookup moves back below the customer creation.
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect((await firmRow(fresh.id)).plan.stripeCustomerId).toBeUndefined();
  });
});

describe('cancelling a subscription', () => {
  it('cancels the subscription of the firm in the path, not another firm', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/cancel`)
      .send({ immediate: true });

    expect(res.status).toBe(200);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_alpha', { prorate: true });
    // Firm B is the whole point of the assertion: an id read off the wrong row
    // returns the same 200 as the right one.
    expect((await firmRow(firmB.id)).plan.stripeSubscriptionId).toBe('sub_beta');
  });

  it('records the pending cancellation on the firm row when it is not immediate', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/cancel`)
      .send({ reason: 'Migrating to annual' });

    expect(res.status).toBe(200);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_alpha', {
      cancel_at_period_end: true,
      metadata: { cancelReason: 'Migrating to annual' },
    });
    // Without this the console keeps showing an active subscription until the
    // Stripe webhook lands, which is where the two sources of truth diverge.
    expect((await firmRow(firmA.id)).plan.cancelAtPeriodEnd).toBe(true);
    expect((await firmRow(firmB.id)).plan.cancelAtPeriodEnd).toBeUndefined();
  });

  it('refuses a firm with no subscription, without reaching Stripe', async () => {
    const bare = await createFirm({ name: 'No Subscription' });

    const res = await admin.post(`/api/admin/lawfirms/${bare.id}/subscription/cancel`)
      .send({ immediate: true });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });

  it('refuses a firm id that names nothing', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${ABSENT_ID}/subscription/cancel`)
      .send({ immediate: true });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });
});

describe('extending a trial', () => {
  it('pushes the trial end out by exactly the days asked for', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_alpha', status: 'trialing', trial_end: 1_800_000_000,
    });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/extend-trial`)
      .send({ days: 7 });

    expect(res.status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_alpha');
    // Seven days on top of the CURRENT trial end, not seven days from now. The
    // difference only shows up on a subscription whose trial has not started
    // today, which is every real one by the time an admin is asked to extend it.
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_alpha', {
      trial_end: 1_800_000_000 + 7 * 86400,
    });
    expect(res.body.newTrialEnd).toBe(new Date((1_800_000_000 + 7 * 86400) * 1000).toISOString());
  });

  it('refuses to extend a subscription that is not on a trial, and writes nothing', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_alpha', status: 'active', trial_end: null });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/extend-trial`)
      .send({ days: 30 });

    expect(res.status).toBe(400);
    // `trial_end` is null on an active subscription, so the arithmetic would
    // send NaN to Stripe. Not calling update at all is the only safe answer.
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('refuses a firm with no subscription, without reaching Stripe', async () => {
    const bare = await createFirm({ name: 'No Subscription' });

    const res = await admin.post(`/api/admin/lawfirms/${bare.id}/subscription/extend-trial`)
      .send({ days: 14 });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });
});

describe('applying a coupon', () => {
  it('applies it to the subscription of the firm in the path', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${firmB.id}/subscription/apply-coupon`)
      .send({ couponId: 'HALFOFF' });

    expect(res.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_beta', { coupon: 'HALFOFF' });
  });

  it('refuses a firm with no subscription, without reaching Stripe', async () => {
    const bare = await createFirm({ name: 'No Subscription' });

    const res = await admin.post(`/api/admin/lawfirms/${bare.id}/subscription/apply-coupon`)
      .send({ couponId: 'HALFOFF' });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });
});

describe('refunding', () => {
  const paidInvoice = { id: 'in_1', payment_intent: 'pi_alpha' };

  it('refunds the whole payment on the latest paid invoice of THAT firm', async () => {
    stripe.invoices.list.mockResolvedValue({ data: [paidInvoice] });
    stripe.refunds.create.mockResolvedValue({ id: 're_full', amount: 24_900 });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/refund`)
      .send({ full: true });

    expect(res.status).toBe(200);
    expect(stripe.invoices.list).toHaveBeenCalledWith({
      customer: 'cus_alpha', status: 'paid', limit: 1,
    });
    // No `amount` key at all. Sending one alongside `full` would cap a full
    // refund at whatever stale figure the console had on screen.
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_alpha' });
    expect(res.body.amountRefunded).toBe(249);
  });

  it('converts a partial amount from dollars to cents', async () => {
    stripe.invoices.list.mockResolvedValue({ data: [paidInvoice] });
    stripe.refunds.create.mockResolvedValue({ id: 're_partial', amount: 1999 });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/refund`)
      .send({ amount: 19.99, reason: 'Duplicate charge' });

    expect(res.status).toBe(200);
    // 19.99 chosen deliberately: `19.99 * 100` is 1998.9999999999998 in binary
    // floating point, so an unrounded amount hands Stripe a fractional number of
    // cents. Most dollar figures multiply cleanly and would let a missing
    // `Math.round` pass.
    expect(stripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 1999 }));
    expect(res.body.amountRefunded).toBe(19.99);
    // `reason` is normalised to Stripe's enum, with the admin's words kept as
    // metadata: Stripe rejects free text in that field.
    expect(stripe.refunds.create).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'requested_by_customer',
      metadata: { adminReason: 'Duplicate charge' },
    }));
  });

  it('finds the payment through the invoice-payments sublist when the old field is gone', async () => {
    stripe.invoices.list.mockResolvedValue({ data: [{ id: 'in_2' }] });
    stripe.invoicePayments.list.mockResolvedValue({
      data: [
        { status: 'open', payment: { payment_intent: 'pi_unpaid' } },
        { status: 'paid', payment: { payment_intent: 'pi_settled' } },
      ],
    });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/refund`)
      .send({ full: true });

    expect(res.status).toBe(200);
    // The unpaid payment is skipped. Refunding against it would either fail or,
    // worse, refund a different attempt than the one that settled.
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_settled' });
  });

  it('refuses when the latest paid invoice has no card payment behind it', async () => {
    stripe.invoices.list.mockResolvedValue({ data: [{ id: 'in_3' }] });
    stripe.invoicePayments.list.mockResolvedValue({ data: [] });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/refund`)
      .send({ full: true });

    expect(res.status).toBe(400);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('refuses when the firm has no paid invoice at all', async () => {
    stripe.invoices.list.mockResolvedValue({ data: [] });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/refund`)
      .send({ full: true });

    expect(res.status).toBe(404);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('refuses a firm with no billing account, without reaching Stripe', async () => {
    const bare = await createFirm({ name: 'No Billing Account' });

    const res = await admin.post(`/api/admin/lawfirms/${bare.id}/subscription/refund`)
      .send({ full: true });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });
});

describe('comping a firm', () => {
  it('cancels the Stripe subscription and clears it off the firm row', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/comp`)
      .send({ planId: 'enterprise', reason: 'Design partner' });

    expect(res.status).toBe(200);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_alpha', { prorate: true });

    const row = await firmRow(firmA.id);
    expect(row.billing_status).toBe('comped');
    expect(row.plan_id).toBe('enterprise');
    expect(row.plan.comped).toBe(true);
    expect(row.plan.compedBy).toBe(adminUid);
    // Leaving the id behind is what makes a comped firm get billed again the
    // next time anything reconciles against Stripe.
    expect(row.plan.stripeSubscriptionId).toBeNull();
    expect(row.plan.billingInterval).toBeNull();
    expect(row.plan.cancelAtPeriodEnd).toBe(false);
  });

  it('leaves the neighbouring firm on its paid plan', async () => {
    await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/comp`)
      .send({ reason: 'Design partner' });

    const other = await firmRow(firmB.id);
    expect(other.billing_status).toBe('active');
    expect(other.plan.stripeSubscriptionId).toBe('sub_beta');
    expect(other.plan.comped).toBeUndefined();
  });

  it('keeps the firm on its current tier when no plan id is named', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/comp`)
      .send({ reason: 'Design partner' });

    expect(res.status).toBe(200);
    // Defaulting to `professional` regardless would silently downgrade an
    // enterprise firm at the moment somebody did them a favour.
    expect((await firmRow(firmA.id)).plan_id).toBe('professional');
  });

  it('refuses a firm id that names nothing, without reaching Stripe', async () => {
    const res = await admin.post(`/api/admin/lawfirms/${ABSENT_ID}/subscription/comp`)
      .send({ reason: 'Design partner' });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });

  it('does not comp the firm when Stripe refuses to cancel its live subscription', async () => {
    stripe.subscriptions.cancel.mockRejectedValue(
      Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' }),
    );
    // Still live at Stripe, so it keeps billing.
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_alpha', status: 'active' });
    const before = await firmRow(firmA.id);

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/comp`)
      .send({ planId: 'enterprise', reason: 'Design partner' });

    // Comping while the subscription survives gives the firm free access and
    // charges it anyway, and with the pointer cleared nothing would ever notice.
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/subscription/i);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_alpha', { prorate: true });
    expect(await firmRow(firmA.id)).toEqual(before);
  });

  it('still comps the firm when the cancel fails because Stripe no longer has the subscription', async () => {
    stripe.subscriptions.cancel.mockRejectedValue(
      Object.assign(new Error('No such subscription'), { statusCode: 404, code: 'resource_missing' }),
    );
    stripe.subscriptions.retrieve.mockRejectedValue(
      Object.assign(new Error('No such subscription'), { statusCode: 404, code: 'resource_missing' }),
    );

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/comp`)
      .send({ reason: 'Design partner' });

    expect(res.status).toBe(200);
    const row = await firmRow(firmA.id);
    expect(row.billing_status).toBe('comped');
    expect(row.plan.stripeSubscriptionId).toBeNull();
  });

  it('still comps the firm when the cancel fails because the subscription already ended', async () => {
    stripe.subscriptions.cancel.mockRejectedValue(
      Object.assign(new Error('This subscription is already canceled'), { statusCode: 400, type: 'StripeInvalidRequestError' }),
    );
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_alpha', status: 'canceled' });

    const res = await admin.post(`/api/admin/lawfirms/${firmA.id}/subscription/comp`)
      .send({ reason: 'Design partner' });

    expect(res.status).toBe(200);
    expect((await firmRow(firmA.id)).billing_status).toBe('comped');
  });
});

describe('the plan patch', () => {
  it('changes only the firm in the path', async () => {
    const before = await firmRow(firmB.id);

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ planId: 'basic', billingStatus: 'suspended' });

    expect(res.status).toBe(200);
    const patched = await firmRow(firmA.id);
    // Since migration 0200 the typed columns are the only store for these two.
    expect(patched.plan_id).toBe('basic');
    // 'suspended' is the admin console's spelling; the column vocabulary calls
    // the same state 'canceled', which is also what the frontend labels it
    // (frontend/src/constants/statusMeta.ts renders suspended as Canceled).
    // Normalizing to anything else silently discards the admin decision.
    expect(patched.billing_status).toBe('canceled');
    // And the jsonb must not carry a second, now-stale copy. Before 0200 a
    // trigger wrote both, so a reader picking the jsonb saw the same answer; a
    // patch that put planId back in there would leave the two disagreeing the
    // moment the column changed on its own.
    expect(patched.plan).not.toHaveProperty('planId');
    expect(patched.plan).not.toHaveProperty('billingStatus');
    // The keys that DO belong to the jsonb are untouched by the patch.
    expect(patched.plan.stripeCustomerId).toBe('cus_alpha');
    expect(await firmRow(firmB.id)).toEqual(before);
  });

  it('rejects a firm id that names nothing, writing to no firm at all', async () => {
    const beforeA = await firmRow(firmA.id);
    const beforeB = await firmRow(firmB.id);

    const res = await admin.patch(`/api/admin/lawfirms/${ABSENT_ID}/plan`)
      .send({ planId: 'basic' });

    expect(res.status).toBe(404);
    // A `where id = $1` that matched nothing would also return 404. The two
    // firm rows are what tell a correct lookup apart from an unscoped update.
    expect(await firmRow(firmA.id)).toEqual(beforeA);
    expect(await firmRow(firmB.id)).toEqual(beforeB);
  });

  it('refuses comped: true while the firm has a live subscription, pointing at the comp action', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_alpha', status: 'active' });
    const before = await firmRow(firmA.id);

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ comped: true, compedReason: 'Design partner' });

    // The subscription would keep billing a firm marked free, and the next
    // renewal webhook writes comped back to false anyway.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/comp action/i);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_alpha');
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(await firmRow(firmA.id)).toEqual(before);
  });

  it('allows comped: true once Stripe has ended the stored subscription', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_alpha', status: 'canceled' });

    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ comped: true, compedReason: 'Design partner' });

    expect(res.status).toBe(200);
    expect((await firmRow(firmA.id)).plan.comped).toBe(true);
  });

  it('rejects a billing status outside the allowed set, leaving the old one', async () => {
    const res = await admin.patch(`/api/admin/lawfirms/${firmA.id}/plan`)
      .send({ planId: 'basic', billingStatus: 'free_forever' });

    expect(res.status).toBe(400);
    // The plan id in the same body must not land either: a partially applied
    // patch puts the firm on a tier nobody chose.
    const row = await firmRow(firmA.id);
    expect(row.plan_id).toBe('professional');
    expect(row.billing_status).toBe('active');
  });
});
