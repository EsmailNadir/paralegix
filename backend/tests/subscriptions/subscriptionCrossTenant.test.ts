/**
 * Cross-tenant and malformed-event coverage for the Stripe SUBSCRIPTION webhook
 * (`/api/webhooks/stripe-subscriptions`), on top of the broad behavioral suite in
 * `subscriptionWebhook.test.ts`. Two questions this file exists to answer:
 *
 * 1. Can one firm's webhook event ever write another firm's `law_firms` row?
 *    The handlers key entirely off `subscription.metadata.lawFirmId`, embedded in
 *    the Stripe-signed event payload, never off `customer`/`subscription` id
 *    matching. That is safe IF AND ONLY IF nothing else in the write path can
 *    make the two diverge for a real firm. This file seeds two firms with
 *    distinct, real-looking customer/subscription ids and proves isolation
 *    holds even when a payload's `customer` field points at the WRONG firm.
 *
 * 2. `handleSubscriptionDeleted` (subscriptions.service.ts) unconditionally
 *    applies a `customer.subscription.deleted` event to whatever firm its
 *    metadata names, with no check that the subscription id in the event is
 *    still the firm's CURRENT one. `handleSubscriptionChange` has exactly this
 *    guard (`canceledSubscriptionId`) for its own stale-event problem, but the
 *    delete handler has no equivalent. A late `deleted` webhook for a
 *    subscription a firm has since REPLACED (cancel, then immediately
 *    resubscribe under a new subscription id) arrives under its own event id,
 *    so the idempotency claim table does not catch it -- and it cancels the
 *    firm's live, paid, replacement subscription. That is a real
 *    revenue/access bug: a paying firm gets locked out of the product by a
 *    webhook about a subscription that no longer represents their billing
 *    relationship.
 */

const mockSubscriptionRetrieve = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeCtor = require('stripe');
  const instance = new StripeCtor('sk_test_offline_subscription_crosstenant_suite');
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  return instance;
});

import { createFirm, type Firm } from '../support/setupInProcess';
import {
  ENTERPRISE_MONTHLY_PRICE,
  PERIOD_END,
  PERIOD_START,
  billingRow,
  retrieveStripeSubscription,
  seedPlan,
  setStripeSubscription,
  stripeSubscription as subscription,
  subscriptionWebhookSender,
} from '../support/subscriptionWebhook';

const WEBHOOK_SECRET = 'whsec_crosstenant_secret_for_the_offline_suite';

const { send } = subscriptionWebhookSender(WEBHOOK_SECRET);

let firmA: Firm;
let firmB: Firm;

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_subscription_crosstenant_suite';
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY_PRICE;
});

beforeEach(async () => {
  firmA = await createFirm();
  firmB = await createFirm();
  mockSubscriptionRetrieve.mockReset();
  mockSubscriptionRetrieve.mockImplementation(retrieveStripeSubscription);
});

describe('cross-tenant isolation', () => {
  it('applies an event only to the firm named in metadata, never the firm owning the customer id in the payload', async () => {
    // Firm A and Firm B each have their own real-looking Stripe identity.
    await seedPlan(firmA.id, {
      planId: 'enterprise', billingStatus: 'active',
      stripeCustomerId: 'cus_firm_a_real', stripeSubscriptionId: 'sub_firm_a_real',
    });
    await seedPlan(firmB.id, {
      planId: 'enterprise', billingStatus: 'active',
      stripeCustomerId: 'cus_firm_b_real', stripeSubscriptionId: 'sub_firm_b_real',
    });
    const beforeB = await billingRow(firmB.id);

    // Payload names firm A in metadata (the only field the handler trusts) but
    // carries firm B's customer id -- a mismatched-customer shape. If the
    // handler ever fell back to matching by customer id, this would corrupt
    // firm B's row instead of (or in addition to) firm A's.
    const res = await send('evt_xt_mismatch', 'customer.subscription.updated', subscription({
      lawFirmId: firmA.id,
      customer: 'cus_firm_b_real',
      id: 'sub_firm_a_real',
      status: 'past_due',
    }));

    expect(res.status).toBe(200);
    const afterA = await billingRow(firmA.id);
    const afterB = await billingRow(firmB.id);
    // Firm A, the metadata-named firm, is the one that moved. The typed column
    // is the store since migration 0200, not the plan jsonb.
    expect(afterA.billing_status).toBe('past_due');
    // Firm B, whose customer id was in the payload, is byte-for-byte untouched.
    expect(afterB).toEqual(beforeB);
  });

  it('cancelling one paying firm never cancels a second paying firm', async () => {
    await seedPlan(firmA.id, {
      planId: 'enterprise', billingStatus: 'active',
      stripeCustomerId: 'cus_firm_a_2', stripeSubscriptionId: 'sub_firm_a_2',
      currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END,
    });
    await seedPlan(firmB.id, {
      planId: 'enterprise', billingStatus: 'active',
      stripeCustomerId: 'cus_firm_b_2', stripeSubscriptionId: 'sub_firm_b_2',
      currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END,
    });
    const beforeB = await billingRow(firmB.id);

    const res = await send('evt_xt_delete_a', 'customer.subscription.deleted', subscription({
      lawFirmId: firmA.id,
      customer: 'cus_firm_a_2',
      id: 'sub_firm_a_2',
      status: 'canceled',
    }));

    expect(res.status).toBe(200);
    const afterA = await billingRow(firmA.id);
    const afterB = await billingRow(firmB.id);
    expect(afterA.billing_status).toBe('canceled');
    // Two firms on the identical plan/price/period, adjacent in time: firm B's
    // row must be completely unaffected by firm A's cancellation webhook.
    expect(afterB).toEqual(beforeB);
    expect(afterB.billing_status).toBe('active');
  });
});

describe('stale delete after resubscribe (real bug: old subscription cancellation after replacement is active)', () => {
  it('does not let a DIFFERENT delayed DELETE for a replaced subscription cancel the firm\'s current one', async () => {
    // The firm subscribes, cancels, and immediately resubscribes -- all
    // processed in order, same as any normal checkout-then-cancel-then-checkout
    // flow. Each event has its OWN event id, so idempotency dedupe (keyed on
    // event id) cannot be what protects the later state.
    await send('evt_xt_old_created', 'customer.subscription.created',
      subscription({ lawFirmId: firmA.id, id: 'sub_old', status: 'active' }));
    // The cancellation has happened at Stripe; only its webhook is late.
    setStripeSubscription(subscription({ lawFirmId: firmA.id, id: 'sub_old', status: 'canceled' }));
    await send('evt_xt_new_created', 'customer.subscription.created',
      subscription({ lawFirmId: firmA.id, id: 'sub_new', status: 'active' }));
    expect((await billingRow(firmA.id)).plan.stripeSubscriptionId).toBe('sub_new');

    // Stripe redelivers (or simply delays) the `deleted` event for the OLD
    // subscription -- a genuinely separate delivery, its own event id -- after
    // the firm is already live on the new one.
    const res = await send('evt_xt_old_deleted_late', 'customer.subscription.deleted',
      subscription({ lawFirmId: firmA.id, id: 'sub_old', status: 'canceled' }));

    expect(res.status).toBe(200);
    const after = await billingRow(firmA.id);
    // A firm paying on sub_new must not be locked out by a stale cancellation
    // of sub_old. Before the fix this handler applies the delete unconditionally
    // and wipes stripeSubscriptionId back to null, cancelling a paying firm.
    expect(after.billing_status).toBe('active');
    expect(after.plan.stripeSubscriptionId).toBe('sub_new');
  });

  // A DELETE naming the firm's actual current subscription still cancels it:
  // pinned in `subscriptionWebhook.test.ts` (customer.subscription.deleted).

  it('still locks out a firm with no prior stored subscription id at all', async () => {
    // A delete arriving for a firm that never got a matching `created`/`updated`
    // (e.g. that webhook was lost) has nothing to compare against; the safe
    // default is still to apply the cancellation rather than silently no-op.
    await seedPlan(firmA.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_xt_orphan_deleted', 'customer.subscription.deleted',
      subscription({ lawFirmId: firmA.id, id: 'sub_never_recorded', status: 'canceled' }));

    expect(res.status).toBe(200);
    expect((await billingRow(firmA.id)).billing_status).toBe('canceled');
  });
});

describe('malformed / partial event shapes', () => {
  it('skips a subscription item with no price object at all, without a 500', async () => {
    await seedPlan(firmA.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_xt_no_price_obj', 'customer.subscription.updated',
      subscription({ lawFirmId: firmA.id, noPriceObject: true, status: 'past_due' }));

    expect(res.status).toBe(200);
    // No price on the item is structurally different from an unrecognized price
    // id (already covered elsewhere): here `price` itself is undefined, so the
    // lookup chain (`price?.id`) must degrade to "no plan" instead of throwing.
    expect((await billingRow(firmA.id)).billing_status).toBe('active');
  });

  it('skips a subscription with an empty items list, without a 500', async () => {
    await seedPlan(firmA.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_xt_no_items', 'customer.subscription.updated',
      subscription({ lawFirmId: firmA.id, noItems: true, status: 'past_due' }));

    expect(res.status).toBe(200);
    expect((await billingRow(firmA.id)).billing_status).toBe('active');
  });

  it('treats an invoice missing subscription_details entirely as a one-off invoice', async () => {
    await seedPlan(firmA.id, { planId: 'enterprise', billingStatus: 'past_due' });

    // `parent` present, but without the `subscription_details` key at all --
    // not merely a null subscription -- which is the shape a genuinely one-off
    // invoice.parent can take.
    const res = await send('evt_xt_invoice_no_nested', 'invoice.paid', {
      id: 'in_test_xt_nested', object: 'invoice', amount_paid: 100_00, parent: {},
    });

    expect(res.status).toBe(200);
    expect(mockSubscriptionRetrieve).not.toHaveBeenCalled();
    // Firm subscription status must be untouched -- this must never be read as
    // "subscription invoice paid" and forced back to active.
    expect((await billingRow(firmA.id)).billing_status).toBe('past_due');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
