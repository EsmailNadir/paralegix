/**
 * The Stripe SUBSCRIPTION webhook, driven through the REAL app against Postgres.
 *
 * `/api/webhooks/stripe-subscriptions` is the only thing that writes
 * `law_firms.billing_status` and `law_firms.plan_id` from Stripe. Every gate in
 * the product reads those two columns, so a handler that answers 200 and writes
 * nothing locks a paying firm out of its own matters, and a handler that writes
 * the wrong direction leaves a cancelled firm with full access forever. Neither
 * shows up on a screen, and neither shows up in a status-code assertion, so
 * every case below reads the ROW back and most of them read it BEFORE the
 * delivery too, so a handler that never ran cannot pass.
 *
 * WHY THIS RUNS OFFLINE. Signature verification is an offline HMAC-SHA256
 * compare through Node's crypto, and `Stripe.webhooks.generateTestHeaderString`
 * is a static, so a spec can mint a genuinely valid signature from a fake
 * secret. That half is exercised for real, exactly as tests/stripe/
 * webhookIdempotency.test.ts does it for the payments webhook.
 *
 * The one thing that is stubbed is `stripe.subscriptions.retrieve`. The two
 * invoice handlers call it to resolve the invoice back to a subscription, and
 * that is a genuine HTTPS call; a developer's `.env` carries a real
 * STRIPE_SECRET_KEY, so leaving it live would have this file talking to Stripe.
 * `stripe.config` is therefore mocked with a REAL Stripe instance built from a
 * placeholder key (so `webhooks.constructEvent` stays the real implementation
 * and the route's `if (!stripe)` 503 guard stays satisfied) with only that one
 * method replaced.
 */

// Hoisted above the imports by Jest. The `mock` prefix is what lets the factory
// close over the spy.
const mockSubscriptionRetrieve = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  // `require`, not `import`: the package's ESM entry does not parse under Jest,
  // and `stripe.config.ts` in the app requires it the same way.
  const StripeCtor = require('stripe');
  // `new Stripe(key)` performs no I/O at construction, so a fake key is enough.
  const instance = new StripeCtor('sk_test_offline_subscription_suite');
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  return instance;
});

import {
  createFirm,
  drainEvents,
  memberWith,
  ownerOf,
  testPool,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';
import { claimedEventIds } from '../support/stripeWebhook';
import {
  ENTERPRISE_MONTHLY_PRICE as ENTERPRISE_MONTHLY,
  PERIOD_END,
  PERIOD_START,
  billingRow,
  removeStripeSubscription,
  retrieveStripeSubscription,
  secs,
  seedPlan,
  setStripeSubscription,
  stripeSubscription as subscription,
  subscriptionEventPayload as eventPayload,
  subscriptionInvoice as invoice,
  subscriptionWebhookSender,
} from '../support/subscriptionWebhook';

const Stripe = require('stripe');

const WEBHOOK_SECRET = 'whsec_subscription_secret_for_the_offline_suite';
const PROFESSIONAL_ANNUAL = 'price_test_professional_annual';

const { deliver, send } = subscriptionWebhookSender(WEBHOOK_SECRET);

async function notificationsFor(lawFirmId: string, type: string) {
  const { rows } = await testPool.query(
    `select user_id, action_url from notifications where law_firm_id = $1 and type = $2 order by user_id`,
    [lawFirmId, type],
  );
  return rows;
}

let firm: Firm;

beforeAll(() => {
  // Set BEFORE the first request, which is when the app graph is first required
  // and `stripePrices.ts` freezes PRICE_MAP into a module constant. Assigned
  // rather than defaulted: whatever an untracked `.env` holds must not decide
  // which prices this file maps or which secret it signs with, and CI has no
  // `.env` at all.
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_subscription_suite';
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY;
  process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID = PROFESSIONAL_ANNUAL;
});

beforeEach(async () => {
  firm = await createFirm();
  mockSubscriptionRetrieve.mockReset();
  mockSubscriptionRetrieve.mockImplementation(retrieveStripeSubscription);
});

describe('signature verification', () => {
  it('refuses an event signed with the WRONG secret and writes NOTHING', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    const before = await billingRow(firm.id);

    const res = await deliver(
      eventPayload('evt_wrong_secret', 'customer.subscription.deleted', subscription({ lawFirmId: firm.id })),
      'whsec_not_the_real_secret',
    );
    await drainEvents();

    // This endpoint is unauthenticated and publicly reachable. The signature is
    // the only thing between it and anyone who can POST JSON, and the payload
    // above would lock the firm out of the entire product.
    expect(res.status).toBe(400);
    expect(await billingRow(firm.id)).toEqual(before);
    // Claiming before verifying would let anyone who guesses an event id poison
    // the dedupe table, so Stripe's genuine delivery of that id is answered
    // "duplicate" and dropped. That is a way to make a real cancellation, or a
    // real reactivation, never apply.
    expect(await claimedEventIds()).toEqual([]);
  });

  it('refuses an event with NO signature header and writes NOTHING', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    const before = await billingRow(firm.id);

    const res = await request()
      .post('/api/webhooks/stripe-subscriptions')
      .set('content-type', 'application/json')
      .send(eventPayload('evt_no_sig', 'customer.subscription.deleted', subscription({ lawFirmId: firm.id })));
    await drainEvents();

    expect(res.status).toBe(400);
    expect(await billingRow(firm.id)).toEqual(before);
  });

  it('refuses a payload that does not match its signature', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    const signed = eventPayload('evt_signed', 'customer.subscription.created', subscription({ lawFirmId: firm.id }));
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: signed, secret: WEBHOOK_SECRET });

    const res = await request()
      .post('/api/webhooks/stripe-subscriptions')
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      // Signed one body, sent another: a valid signature over substituted content.
      .send(eventPayload('evt_swapped', 'customer.subscription.deleted', subscription({ lawFirmId: firm.id })));
    await drainEvents();

    expect(res.status).toBe(400);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });
});

describe('customer.subscription.created / updated', () => {
  it('writes plan and billing status onto the firm', async () => {
    const before = await billingRow(firm.id);
    expect(before.billing_status).toBe('comped');

    const res = await send('evt_created', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, status: 'active' }));

    expect(res.status).toBe(200);
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('active');
    expect(after.plan_id).toBe('enterprise');
    expect(after.plan.stripeSubscriptionId).toBe('sub_test_1');
    expect(after.plan.stripePriceId).toBe(ENTERPRISE_MONTHLY);
    expect(after.plan.billingInterval).toBe('monthly');
    expect(after.plan.currentPeriodStart).toBe(PERIOD_START);
    expect(after.plan.currentPeriodEnd).toBe(PERIOD_END);
    expect(after.plan.assignedBy).toBe('stripe');
  });

  it('maps a trialing subscription onto trialing, not active', async () => {
    const trialEnd = '2026-06-15T00:00:00.000Z';

    await send('evt_trialing', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, status: 'trialing', trialEnd }));

    const after = await billingRow(firm.id);
    // The service maps Stripe's `trialing` to its own `trial`, and the
    // repository normalizes that back to `trialing` on the way to the column. A
    // firm shown as `active` on a trial would never be prompted to add a card.
    expect(after.billing_status).toBe('trialing');
    // The column is the only store since migration 0200; a second copy in the
    // jsonb would go stale the moment Stripe moved the firm on.
    expect(after.plan).not.toHaveProperty('billingStatus');
    expect(after.plan.trialEndsAt).toBe(trialEnd);
    // Durable: once a firm has consumed a trial it can never be granted another.
    expect(after.plan.trialConsumed).toBe(true);
  });

  it('takes an ACTIVE firm to past_due', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', currentPeriodStart: PERIOD_START,
    });
    expect((await billingRow(firm.id)).billing_status).toBe('active');

    await send('evt_past_due', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'past_due' }));

    // The column is what the billing gate queries, and since migration 0200 it
    // is also the only store -- the API's `plan.billingStatus` is rebuilt from
    // it by `toEntity` rather than read from the jsonb.
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('past_due');
    expect(after.plan).not.toHaveProperty('billingStatus');
  });

  it('records a plan change onto a different tier and interval', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', currentPeriodStart: PERIOD_START,
    });

    await send('evt_downgrade', 'customer.subscription.updated', subscription({
      lawFirmId: firm.id, priceId: PROFESSIONAL_ANNUAL, periodStart: PERIOD_START,
    }));

    const after = await billingRow(firm.id);
    expect(after.plan_id).toBe('professional');
    expect(after.plan.billingInterval).toBe('annual');
  });

  it('records cancel_at_period_end without locking the firm out yet', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    await send('evt_cancel_flag', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'active', cancelAtPeriodEnd: true }));

    const after = await billingRow(firm.id);
    // A firm that has asked to cancel has paid through the period and keeps
    // access until Stripe actually ends the subscription.
    expect(after.plan.cancelAtPeriodEnd).toBe(true);
    expect(after.billing_status).toBe('active');
  });

  it('reactivates a CANCELED firm on a new subscription', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'canceled', comped: false });
    expect((await billingRow(firm.id)).billing_status).toBe('canceled');

    await send('evt_reactivate', 'customer.subscription.created', subscription({
      lawFirmId: firm.id, id: 'sub_test_new', status: 'active',
    }));

    // The paying-again direction. A guard that refused to move a canceled firm
    // would leave a firm that just handed over a card staring at the paywall.
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('active');
    expect(after.plan.stripeSubscriptionId).toBe('sub_test_new');
  });

  it('does NOT resurrect a canceled subscription from an update event', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'canceled' });

    await send('evt_canceled_update', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'canceled' }));

    // A terminal status is owned by the deleted handler. Writing it here would
    // re-stamp the subscription pointers onto a firm whose subscription is gone,
    // which is what the reconciliation sweep then uses to grant access.
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('canceled');
    expect(after.plan.stripeSubscriptionId).toBeUndefined();
  });

  it('does NOT resurrect a firm from a STALE update delivered after the delete', async () => {
    // The order Stripe actually delivers under retry: the subscription is
    // deleted, then an `updated` generated BEFORE the cancellation arrives late.
    // It carries status 'active', because at the moment Stripe built it the
    // subscription was active.
    await send('evt_live', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, id: 'sub_stale', status: 'active' }));
    await send('evt_gone', 'customer.subscription.deleted',
      subscription({ lawFirmId: firm.id, id: 'sub_stale', status: 'canceled' }));
    expect((await billingRow(firm.id)).billing_status).toBe('canceled');

    await send('evt_stale', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, id: 'sub_stale', status: 'active' }));

    // Neither existing guard catches this. The terminal guard tests the
    // INCOMING status, which is 'active'. The ordering guard compares against
    // the stored currentPeriodStart, which the delete handler set to null, so it
    // is disarmed exactly when it is needed. The firm went back to a paying
    // state with a dead subscription id restored, and kept the product.
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('canceled');
    expect(after.plan.stripeSubscriptionId).toBeNull();
  });

  it('still reactivates on a DIFFERENT subscription id after a cancellation', async () => {
    await send('evt_live2', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, id: 'sub_old', status: 'active' }));
    await send('evt_gone2', 'customer.subscription.deleted',
      subscription({ lawFirmId: firm.id, id: 'sub_old', status: 'canceled' }));

    await send('evt_new_sub', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, id: 'sub_brand_new', status: 'active' }));

    // The half that keeps the fix honest. Dropping every update for a canceled
    // firm would also lock out a firm that just handed over a new card, so the
    // discriminator has to be the subscription IDENTITY, not the firm state.
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('active');
    expect(after.plan.stripeSubscriptionId).toBe('sub_brand_new');
  });

  it('reads the period off the LEGACY subscription-root shape too', async () => {
    // Webhook payloads are rendered at whatever API version the endpoint is
    // pinned to, so an endpoint on a pre-2025-03-31 version still sends the
    // period on the root. Losing it there left firms with no renewal date and
    // disarmed the out-of-order guard below, which is the whole reason the
    // fallback exists.
    await send('evt_legacy_period', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, legacyPeriodShape: true }));

    const after = await billingRow(firm.id);
    expect(after.plan.currentPeriodStart).toBe(PERIOD_START);
    expect(after.plan.currentPeriodEnd).toBe(PERIOD_END);
  });

  it('ignores a subscription whose price is not in the plan map', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_unknown_price', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, priceId: 'price_rotated_or_legacy', status: 'past_due' }));

    // A rotated price id must not be able to write a half-known plan, and must
    // not 500 either: Stripe would retry that forever.
    expect(res.status).toBe(200);
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('active');
    expect(after.plan.stripePriceId).toBeUndefined();
  });

  it('ignores a subscription carrying no lawFirmId', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_no_metadata', 'customer.subscription.updated',
      subscription({ lawFirmId: undefined, status: 'past_due' }));

    expect(res.status).toBe(200);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });
});

describe('out-of-order delivery', () => {
  it('ignores an update whose period starts BEFORE the stored one', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    });

    const res = await send('evt_stale', 'customer.subscription.updated', subscription({
      lawFirmId: firm.id,
      status: 'past_due',
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-06-01T00:00:00.000Z',
    }));

    // Stripe does not guarantee ordering. A delayed past_due event from last
    // month arriving after this month's successful renewal would lock a firm
    // that is fully paid up.
    expect(res.status).toBe(200);
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('active');
    expect(after.plan.currentPeriodStart).toBe(PERIOD_START);
  });

  it('applies an update for the SAME period', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', currentPeriodStart: PERIOD_START,
    });

    await send('evt_same_period', 'customer.subscription.updated', subscription({
      lawFirmId: firm.id, status: 'past_due', periodStart: PERIOD_START,
    }));

    // The negative half of the guard. Equal is not stale: a cancel toggle or a
    // failed renewal inside the current period must still land, or the guard is
    // just a way to drop events.
    expect((await billingRow(firm.id)).billing_status).toBe('past_due');
  });

  it('applies an update whose period starts AFTER the stored one', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'past_due', currentPeriodStart: PERIOD_START,
    });

    await send('evt_next_period', 'customer.subscription.updated', subscription({
      lawFirmId: firm.id,
      status: 'active',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
    }));

    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('active');
    expect(after.plan.currentPeriodStart).toBe('2026-07-01T00:00:00.000Z');
  });

  it('applies what Stripe holds NOW, not an older status retried inside the same period', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', stripeSubscriptionId: 'sub_test_1',
      currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END,
    });
    // The card was declined and then retried successfully. Stripe's first
    // attempt to deliver the past_due event failed, and its retry lands an hour
    // after the active one. Both carry the same period, so the ordering guard
    // cannot tell them apart; only Stripe's current state can.
    setStripeSubscription(subscription({ lawFirmId: firm.id, status: 'active' }));

    const res = await send('evt_same_period_late_past_due', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'past_due' }));

    expect(res.status).toBe(200);
    expect(mockSubscriptionRetrieve).toHaveBeenCalledWith('sub_test_1');
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });

  it('applies Stripe\'s current plan when the payload is behind it', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active', stripeSubscriptionId: 'sub_test_1' });
    setStripeSubscription(subscription({ lawFirmId: firm.id, status: 'active', priceId: PROFESSIONAL_ANNUAL }));

    await send('evt_payload_behind', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'active' }));

    const after = await billingRow(firm.id);
    expect(after.plan_id).toBe('professional');
    expect(after.plan.billingInterval).toBe('annual');
  });

  it('writes nothing for a subscription Stripe no longer has', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'past_due' });
    removeStripeSubscription('sub_test_1');

    const res = await send('evt_update_for_gone_sub', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'active' }));

    // The deleted event owns a subscription's end. An update for one Stripe has
    // already removed must not hand the firm access back.
    expect(res.status).toBe(200);
    expect(mockSubscriptionRetrieve).toHaveBeenCalledWith('sub_test_1');
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('past_due');
    expect(after.plan.stripeSubscriptionId).toBeUndefined();
  });

  it('answers 500 and releases the claim when Stripe cannot be reached, so the event is retried', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active', currentPeriodStart: PERIOD_START });
    mockSubscriptionRetrieve.mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { type: 'StripeConnectionError' }));

    const res = await send('evt_update_stripe_down', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'past_due' }));

    // Falling back to the payload is exactly the stale write this read exists to
    // prevent. Stripe retries for three days, which outlasts an outage.
    expect(res.status).toBe(500);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
    expect(await claimedEventIds()).toEqual([]);
  });
});

describe('an event about a subscription other than the firm\'s live one', () => {
  // Two checkouts completed for one firm, or a late event from a subscription
  // the firm has since replaced. Whichever event lands last used to decide the
  // firm's subscription id, plan and status.
  async function seedLiveOn(subscriptionId: string) {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', billingInterval: 'monthly',
      stripeSubscriptionId: subscriptionId, stripePriceId: ENTERPRISE_MONTHLY,
      currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END,
    });
    setStripeSubscription(subscription({ id: subscriptionId, lawFirmId: firm.id, status: 'active' }));
  }

  it('ignores an update for a second subscription while the stored one is still live', async () => {
    await seedLiveOn('sub_first');
    const before = await billingRow(firm.id);

    const res = await send('evt_second_sub_created', 'customer.subscription.created', subscription({
      id: 'sub_second', lawFirmId: firm.id, status: 'past_due', priceId: PROFESSIONAL_ANNUAL,
    }));

    expect(res.status).toBe(200);
    // The control: the handler did look at the stored subscription in Stripe.
    expect(mockSubscriptionRetrieve).toHaveBeenCalledWith('sub_first');
    expect(await billingRow(firm.id)).toEqual(before);
  });

  it('ignores a paid invoice of a second subscription while the stored one is still live', async () => {
    await seedLiveOn('sub_first');
    setStripeSubscription(subscription({ id: 'sub_second', lawFirmId: firm.id, status: 'active' }));
    await seedPlan(firm.id, {
      ...(await billingRow(firm.id)).plan, planId: 'enterprise', billingStatus: 'past_due',
    });
    const before = await billingRow(firm.id);

    const res = await send('evt_second_sub_paid', 'invoice.paid',
      invoice({ subscriptionId: 'sub_second', amountPaid: 99_00 }));

    expect(res.status).toBe(200);
    expect(mockSubscriptionRetrieve).toHaveBeenCalledWith('sub_first');
    expect(await billingRow(firm.id)).toEqual(before);
  });

  it('ignores a late payment failure from an old subscription while the firm pays on its new one', async () => {
    await seedLiveOn('sub_new');
    setStripeSubscription(subscription({ id: 'sub_old', lawFirmId: firm.id, status: 'past_due' }));

    const res = await send('evt_old_sub_failed', 'invoice.payment_failed',
      invoice({ subscriptionId: 'sub_old', amountPaid: 0 }));

    expect(res.status).toBe(200);
    expect(mockSubscriptionRetrieve).toHaveBeenCalledWith('sub_new');
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });

  it('still moves the firm onto a new subscription once Stripe has ended the stored one', async () => {
    // The replacement path: the firm cancelled and resubscribed, and the new
    // subscription's event lands before the old one's deletion does.
    await seedLiveOn('sub_old');
    setStripeSubscription(subscription({ id: 'sub_old', lawFirmId: firm.id, status: 'canceled' }));

    const res = await send('evt_replacement_created', 'customer.subscription.created',
      subscription({ id: 'sub_replacement', lawFirmId: firm.id, status: 'active', priceId: PROFESSIONAL_ANNUAL }));

    expect(res.status).toBe(200);
    const after = await billingRow(firm.id);
    expect(after.plan.stripeSubscriptionId).toBe('sub_replacement');
    expect(after.plan_id).toBe('professional');
  });

  it('still moves the firm onto a new subscription when Stripe no longer has the stored one', async () => {
    await seedLiveOn('sub_vanished');
    removeStripeSubscription('sub_vanished');

    await send('evt_replacement_after_missing', 'customer.subscription.created',
      subscription({ id: 'sub_replacement', lawFirmId: firm.id, status: 'active' }));

    expect((await billingRow(firm.id)).plan.stripeSubscriptionId).toBe('sub_replacement');
  });
});

describe('customer.subscription.deleted', () => {
  it('locks the firm out and clears the subscription pointers', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise',
      billingStatus: 'active',
      comped: false,
      stripeSubscriptionId: 'sub_test_1',
      stripePriceId: ENTERPRISE_MONTHLY,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    });
    expect((await billingRow(firm.id)).billing_status).toBe('active');

    const res = await send('evt_deleted', 'customer.subscription.deleted',
      subscription({ lawFirmId: firm.id, status: 'canceled' }));

    expect(res.status).toBe(200);
    const after = await billingRow(firm.id);
    // There is no free self-serve tier: a firm without a subscription reverts to
    // the paywall. Leaving `active` here is indefinite free access.
    expect(after.billing_status).toBe('canceled');
    expect(after.plan.comped).toBe(false);
    // Cleared so the reconciliation sweep stops pulling this firm from Stripe.
    expect(after.plan.stripeSubscriptionId).toBeNull();
    expect(after.plan.stripePriceId).toBeNull();
    expect(after.plan.currentPeriodEnd).toBeNull();
  });

  it('does not clear the trial marker, so a canceled firm cannot re-trial', async () => {
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', trialConsumed: true,
    });

    await send('evt_deleted_trial', 'customer.subscription.deleted',
      subscription({ lawFirmId: firm.id, status: 'canceled' }));

    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('canceled');
    // Clearing this would let a firm cancel and re-subscribe for a free trial on
    // a loop, forever.
    expect(after.plan.trialConsumed).toBe(true);
  });

  it('ignores a deletion carrying no lawFirmId', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_deleted_no_meta', 'customer.subscription.deleted',
      subscription({ lawFirmId: undefined, status: 'canceled' }));

    expect(res.status).toBe(200);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });
});

describe('customer.subscription.trial_will_end', () => {
  it('acknowledges without changing the firm billing state', async () => {
    await seedPlan(firm.id, {
      // 'trialing' is the column vocabulary's spelling. The legacy 'trial' this
      // used to seed only ever reached the column through the mirror trigger's
      // translation, and since migration 0200 the CHECK rejects it outright.
      planId: 'enterprise', billingStatus: 'trialing', currentPeriodStart: PERIOD_START,
    });
    const before = await billingRow(firm.id);

    const res = await send('evt_trial_end', 'customer.subscription.trial_will_end',
      subscription({ lawFirmId: firm.id, status: 'trialing', trialEnd: '2026-06-15T00:00:00.000Z' }));

    expect(res.status).toBe(200);
    // This handler is a notification only. Writing a status here would end the
    // trial three days early, which is when Stripe sends the event.
    expect(await billingRow(firm.id)).toEqual(before);
  });

  it('notifies the owner but not a member holding no admin role, with a deep link to billing settings', async () => {
    const owner = await ownerOf(firm.id);
    const plainMember = await memberWith(firm.id, ['matters.view']);

    const res = await send('evt_trial_end_notify', 'customer.subscription.trial_will_end',
      subscription({ lawFirmId: firm.id, status: 'trialing', trialEnd: '2026-06-15T00:00:00.000Z' }));

    expect(res.status).toBe(200);
    const rows = await notificationsFor(firm.id, 'subscription_trial_ending');
    expect(rows.map((r: any) => r.user_id)).toEqual([owner.uid]);
    expect(rows.map((r: any) => r.user_id)).not.toContain(plainMember.uid);
    expect(rows[0].action_url).toBe(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/lawfirm/${firm.id}/settings/billing`);
  });

  it('never notifies a different firm', async () => {
    const { id: otherFirmId } = await createFirm();
    await ownerOf(otherFirmId);

    await send('evt_trial_end_isolated', 'customer.subscription.trial_will_end',
      subscription({ lawFirmId: firm.id, status: 'trialing', trialEnd: '2026-06-15T00:00:00.000Z' }));

    const otherFirmRows = await notificationsFor(otherFirmId, 'subscription_trial_ending');
    expect(otherFirmRows).toHaveLength(0);
  });
});

describe('invoice.paid', () => {
  it('stamps the payment and takes a past_due firm back to active', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'past_due' });
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'active' }));

    const res = await send('evt_invoice_paid', 'invoice.paid', invoice({ amountPaid: 249_00 }));

    expect(res.status).toBe(200);
    expect(mockSubscriptionRetrieve).toHaveBeenCalledWith('sub_test_1');
    const after = await billingRow(firm.id);
    // The recovery direction. A firm whose card finally cleared and is still
    // shown past_due is locked out of work it has paid for.
    expect(after.billing_status).toBe('active');
    expect(after.plan.lastPaymentAmount).toBe(249_00);
    expect(typeof after.plan.lastPaymentAt).toBe('string');
  });

  it('dates the payment when Stripe collected it, not when the webhook arrived', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'active' }));
    // A delayed or replayed delivery would otherwise stamp today.
    const paidAt = Math.floor(Date.parse('2026-08-20T09:15:00Z') / 1000);

    await send('evt_invoice_paid_dated', 'invoice.paid', invoice({ amountPaid: 249_00, paidAt }));

    expect((await billingRow(firm.id)).plan.lastPaymentAt).toBe('2026-08-20T09:15:00.000Z');
  });

  it('does NOT force active when Stripe still reports past_due', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'past_due' });
    // A partial dunning payment: the invoice is paid, the subscription is not
    // yet recovered. Trusting the invoice alone would grant access on a
    // subscription Stripe is still about to cancel.
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));

    await send('evt_invoice_paid_stale', 'invoice.paid', invoice());

    expect((await billingRow(firm.id)).billing_status).toBe('past_due');
  });

  it('does not stamp a payment for a fully discounted invoice', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'active' }));

    await send('evt_invoice_zero', 'invoice.paid', invoice({ amountPaid: 0 }));

    const after = await billingRow(firm.id);
    // A 100%-coupon invoice would otherwise record a $0 "last payment", which is
    // what the billing screen shows the firm as their most recent charge.
    expect(after.plan.lastPaymentAt).toBeUndefined();
    expect(after.plan.lastPaymentAmount).toBeUndefined();
    expect(after.billing_status).toBe('active');
  });

  it('ignores a one-off invoice with no subscription', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'past_due' });

    const res = await send('evt_invoice_oneoff', 'invoice.paid', invoice({ subscriptionId: null }));

    expect(res.status).toBe(200);
    // A client paying a legal bill through the payments webhook must never move
    // the firm's own Paralegix subscription.
    expect(mockSubscriptionRetrieve).not.toHaveBeenCalled();
    expect((await billingRow(firm.id)).billing_status).toBe('past_due');
  });

  it('acknowledges when the subscription no longer exists at Stripe', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    const missing: any = new Error('No such subscription');
    missing.statusCode = 404;
    missing.code = 'resource_missing';
    mockSubscriptionRetrieve.mockRejectedValue(missing);

    const res = await send('evt_invoice_gone', 'invoice.paid', invoice());

    // Terminal, not retryable. A 500 here is an event Stripe redelivers until it
    // gives up and disables the endpoint, taking the events that DO matter down.
    expect(res.status).toBe(200);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });
});

describe('invoice.payment_failed', () => {
  it('moves an ACTIVE firm to past_due', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    expect((await billingRow(firm.id)).billing_status).toBe('active');
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));

    const res = await send('evt_failed', 'invoice.payment_failed', invoice({ amountPaid: 0 }));

    expect(res.status).toBe(200);
    const after = await billingRow(firm.id);
    expect(after.billing_status).toBe('past_due');
    expect(after.plan).not.toHaveProperty('billingStatus');
  });

  it('ignores a one-off invoice with no subscription', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_failed_oneoff', 'invoice.payment_failed', invoice({ subscriptionId: null }));

    expect(res.status).toBe(200);
    // A client's card bouncing on a legal invoice must not past_due the FIRM.
    expect(mockSubscriptionRetrieve).not.toHaveBeenCalled();
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });

  it('acknowledges when the subscription no longer exists at Stripe', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    const missing: any = new Error('No such subscription');
    missing.statusCode = 404;
    mockSubscriptionRetrieve.mockRejectedValue(missing);

    const res = await send('evt_failed_gone', 'invoice.payment_failed', invoice());

    expect(res.status).toBe(200);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });

  it('notifies the owner but not a member holding no admin role, with a deep link to billing settings', async () => {
    const owner = await ownerOf(firm.id);
    const plainMember = await memberWith(firm.id, ['matters.view']);
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));

    const res = await send('evt_failed_notify', 'invoice.payment_failed', invoice({ amountPaid: 0 }));

    expect(res.status).toBe(200);
    const rows = await notificationsFor(firm.id, 'subscription_payment_failed');
    expect(rows.map((r: any) => r.user_id)).toEqual([owner.uid]);
    expect(rows.map((r: any) => r.user_id)).not.toContain(plainMember.uid);
    expect(rows[0].action_url).toBe(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/lawfirm/${firm.id}/settings/billing`);
  });

  it('does not alert again on a retry that keeps the firm past_due (one alert per dunning episode)', async () => {
    const owner = await ownerOf(firm.id);
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'past_due' });
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));

    await send('evt_failed_retry', 'invoice.payment_failed', invoice({ amountPaid: 0 }));

    const rows = await notificationsFor(firm.id, 'subscription_payment_failed');
    expect(rows.map((r: any) => r.user_id)).not.toContain(owner.uid);
  });

  it('never notifies a different firm', async () => {
    const { id: otherFirmId } = await createFirm();
    await ownerOf(otherFirmId);
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));

    await send('evt_failed_isolated', 'invoice.payment_failed', invoice({ amountPaid: 0 }));

    const otherFirmRows = await notificationsFor(otherFirmId, 'subscription_payment_failed');
    expect(otherFirmRows).toHaveLength(0);
  });
});

describe('idempotency', () => {
  it('answers a redelivery as a duplicate without re-running the handler', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));
    const payload = eventPayload('evt_idem_repeat', 'invoice.payment_failed', invoice({ amountPaid: 0 }));

    await deliver(payload);
    await drainEvents();
    mockSubscriptionRetrieve.mockClear();
    const second = await deliver(payload);
    await drainEvents();

    // Stripe retries until it gets a 2xx, so a redelivery is normal traffic and
    // must be acknowledged, not refused. What proves the guard held is that the
    // handler did not reach Stripe again on the second delivery.
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(mockSubscriptionRetrieve).not.toHaveBeenCalled();
    expect(await claimedEventIds()).toEqual(['evt_idem_repeat']);
  });

  it('does not let a redelivered DELETE re-cancel a reactivated firm', async () => {
    // The sequence that costs a customer their account: cancel, resubscribe,
    // then Stripe redelivers the cancellation.
    const cancelPayload = eventPayload('evt_idem_cancel', 'customer.subscription.deleted',
      subscription({ lawFirmId: firm.id, status: 'canceled' }));
    await deliver(cancelPayload);
    await drainEvents();
    await send('evt_idem_resub', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, id: 'sub_test_new', status: 'active' }));
    expect((await billingRow(firm.id)).billing_status).toBe('active');

    const redelivered = await deliver(cancelPayload);
    await drainEvents();

    expect(redelivered.status).toBe(200);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });

  it('treats two DIFFERENT event ids independently', async () => {
    await send('evt_idem_a', 'customer.subscription.created', subscription({ lawFirmId: firm.id }));
    const second = await send('evt_idem_b', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'past_due' }));

    // Deduping on anything coarser than the event id, the subscription id say,
    // would drop every genuine follow-up event about one subscription.
    expect(second.body.duplicate).toBeUndefined();
    expect(await claimedEventIds()).toEqual(['evt_idem_a', 'evt_idem_b']);
    expect((await billingRow(firm.id)).billing_status).toBe('past_due');
  });

  // Two deliveries of one event in flight together are pinned, with a gate that
  // proves they overlapped, in `subscriptionWebhookConcurrency.test.ts`.

  it('releases the claim when processing fails, so Stripe can retry', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });
    mockSubscriptionRetrieve.mockRejectedValue(new Error('stripe unreachable'));

    const res = await send('evt_idem_failed', 'invoice.paid', invoice());

    // A non-terminal failure has to be retryable. Keeping the claim would make
    // Stripe's retry answer "duplicate" and the payment would never be recorded.
    expect(res.status).toBe(500);
    expect(await claimedEventIds()).toEqual([]);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });
});

describe('unknown firm and unhandled events', () => {
  it('does not create a firm for a subscription naming one that does not exist', async () => {
    const { rows: before } = await testPool.query('select id from law_firms order by id');

    const res = await send('evt_unknown_firm', 'customer.subscription.created',
      subscription({ lawFirmId: '00000000-0000-4000-8000-000000000000', status: 'active' }));

    // Answering anything but 2xx here makes Stripe retry an event that can never
    // succeed, forever, and eventually disable the endpoint.
    expect(res.status).toBe(200);
    const { rows: after } = await testPool.query('select id from law_firms order by id');
    expect(after).toEqual(before);
  });

  it('acknowledges an event type it does not handle', async () => {
    await seedPlan(firm.id, { planId: 'enterprise', billingStatus: 'active' });

    const res = await send('evt_unhandled', 'customer.created', { id: 'cus_test_1', object: 'customer' });

    expect(res.status).toBe(200);
    expect((await billingRow(firm.id)).billing_status).toBe('active');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so its
// top-level bindings stay file-scoped rather than colliding across specs.
export {};
