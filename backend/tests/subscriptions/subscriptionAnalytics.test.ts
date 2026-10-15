/**
 * Subscription lifecycle events reach product analytics from the Stripe
 * SUBSCRIPTION webhook, driven through the real route against Postgres.
 *
 * Each transition of a firm's subscription produces exactly one lifecycle event:
 *
 *   subscription_started         the first write of a subscription id the firm
 *                                did not already have (a checkout, a resubscribe)
 *   subscription_status_changed  `law_firms.billing_status` moved on a
 *                                subscription the firm already had, whichever
 *                                handler moved it
 *   subscription_cancelled       the subscription ended and the firm was locked out
 *
 * plus `subscription_payment_failed`, once per dunning episode.
 *
 * STRIPE REPEATS ITSELF. It redelivers an event until it gets a 2xx, and it
 * sends several distinct events for one change (`created` then `updated`, a
 * `payment_failed` for every dunning retry). An event here is captured only
 * when a handler actually changed the firm's stored state, so a redelivery, a
 * repeat of the same state, or a guarded stale event captures nothing. Every
 * "captures nothing" case first proves, in the same test, that the first
 * delivery DID capture, so an absence cannot pass because nothing ran.
 *
 * NO AMOUNTS. Invoice and payment events carry `amount_paid`; the assertions
 * pin the exact property set so a money field cannot ride along unnoticed.
 *
 * `stripe.config` is mocked exactly as in subscriptionWebhook.test.ts: a real
 * Stripe instance from a placeholder key, with only `subscriptions.retrieve`
 * replaced, so signature verification stays real. The analytics module is a
 * recording fake.
 */
const mockSubscriptionRetrieve = jest.fn();
const mockCapture = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeCtor = require('stripe');
  const instance = new StripeCtor('sk_test_offline_subscription_analytics');
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  return instance;
});

jest.mock('../../src/shared/analytics/serverAnalytics', () => ({
  captureServerEvent: (...args: unknown[]) => mockCapture(...args),
}));

import {
  createFirm,
  drainEvents,
  setFirmPlan,
  testPool,
  type Firm,
} from '../support/setupInProcess';
import {
  ENTERPRISE_MONTHLY_PRICE as ENTERPRISE_MONTHLY,
  PERIOD_END,
  PERIOD_START,
  retrieveStripeSubscription,
  stripeSubscription as subscription,
  subscriptionEventPayload as eventPayload,
  subscriptionInvoice,
  subscriptionWebhookSender,
} from '../support/subscriptionWebhook';

const WEBHOOK_SECRET = 'whsec_subscription_analytics_offline_suite';
const PROFESSIONAL_ANNUAL = 'price_test_professional_annual';

const invoice = (amountPaid = 249_00) => subscriptionInvoice({ amountPaid });

const signed = subscriptionWebhookSender(WEBHOOK_SECRET);

async function deliver(payload: string) {
  const res = await signed.deliver(payload);
  await drainEvents();
  // A refused delivery ran no handler, which would turn every absence below
  // into a false green.
  expect(res.status).toBe(200);
  return res;
}

const send = (id: string, type: string, object: unknown) => deliver(eventPayload(id, type, object));

const captures = (event?: string) => mockCapture.mock.calls
  .map(([input]) => input)
  .filter((input: any) => !event || input.event === event);

const billingStatus = async (lawFirmId: string) => {
  const { rows } = await testPool.query('select billing_status from law_firms where id = $1', [lawFirmId]);
  return rows[0].billing_status;
};

/** A firm already on `sub_test_1`, Enterprise monthly, in the given status. */
const seedSubscribed = (lawFirmId: string, status: string) => setFirmPlan(lawFirmId, {
  planId: 'enterprise',
  billingStatus: status,
  comped: false,
  stripeSubscriptionId: 'sub_test_1',
  stripePriceId: ENTERPRISE_MONTHLY,
  billingInterval: 'monthly',
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
}, { replace: true });

let firm: Firm;

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_subscription_analytics';
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY;
  process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID = PROFESSIONAL_ANNUAL;
});

beforeEach(async () => {
  firm = await createFirm();
  mockSubscriptionRetrieve.mockReset();
  mockSubscriptionRetrieve.mockImplementation(retrieveStripeSubscription);
  mockCapture.mockReset();
});

describe('subscription_started', () => {
  beforeEach(async () => {
    // A new firm's in-app trial: no Stripe subscription yet.
    await setFirmPlan(firm.id, { planId: 'professional', billingStatus: 'trialing', comped: false }, { replace: true });
  });

  it('captures once when a firm on its in-app trial subscribes', async () => {
    await send('evt_start', 'customer.subscription.created', subscription({ lawFirmId: firm.id, status: 'active' }));

    expect(captures()).toEqual([{
      event: 'subscription_started',
      lawFirmId: firm.id,
      properties: { plan_id: 'enterprise', billing_interval: 'monthly', status: 'active', from_status: 'trialing' },
    }]);
  });

  it('does not capture again for the updated event that follows for the same subscription', async () => {
    await send('evt_start_created', 'customer.subscription.created', subscription({ lawFirmId: firm.id }));
    expect(captures('subscription_started')).toHaveLength(1);

    await send('evt_start_updated', 'customer.subscription.updated', subscription({ lawFirmId: firm.id }));

    // Same subscription, same status: nothing changed, so nothing new is reported.
    expect(captures()).toHaveLength(1);
  });

  it('does not capture again when Stripe redelivers the same event', async () => {
    const payload = eventPayload('evt_start_replay', 'customer.subscription.created', subscription({ lawFirmId: firm.id }));
    await deliver(payload);
    expect(captures('subscription_started')).toHaveLength(1);

    const second = await deliver(payload);

    expect(second.body.duplicate).toBe(true);
    expect(captures()).toHaveLength(1);
  });

  it('captures a resubscribe on a new subscription id after a cancellation', async () => {
    await seedSubscribed(firm.id, 'active');
    await send('evt_resub_delete', 'customer.subscription.deleted', subscription({ lawFirmId: firm.id, status: 'canceled' }));
    mockCapture.mockReset();

    await send('evt_resub_create', 'customer.subscription.created',
      subscription({ id: 'sub_test_2', lawFirmId: firm.id, priceId: PROFESSIONAL_ANNUAL }));

    expect(captures()).toEqual([{
      event: 'subscription_started',
      lawFirmId: firm.id,
      properties: { plan_id: 'professional', billing_interval: 'annual', status: 'active', from_status: 'canceled' },
    }]);
  });

  it('captures nothing for a subscription whose price is not in the plan map', async () => {
    await send('evt_start_unknown_price', 'customer.subscription.created',
      subscription({ lawFirmId: firm.id, priceId: 'price_not_mapped' }));

    // The handler wrote nothing; the firm is still on its trial.
    expect(await billingStatus(firm.id)).toBe('trialing');
    expect(captures()).toEqual([]);
  });

  it('captures nothing for a subscription naming a firm that does not exist', async () => {
    await send('evt_start_ghost', 'customer.subscription.created',
      subscription({ lawFirmId: '00000000-0000-4000-8000-000000000000' }));

    expect(captures()).toEqual([]);
  });
});

describe('subscription_status_changed', () => {
  it('captures the transition when an update moves the status', async () => {
    await seedSubscribed(firm.id, 'active');

    await send('evt_status_past_due', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'past_due' }));

    expect(captures()).toEqual([{
      event: 'subscription_status_changed',
      lawFirmId: firm.id,
      properties: { from_status: 'active', to_status: 'past_due', plan_id: 'enterprise', billing_interval: 'monthly' },
    }]);
  });

  it('captures nothing for an update that leaves the status where it was', async () => {
    await seedSubscribed(firm.id, 'active');
    await send('evt_status_move', 'customer.subscription.updated', subscription({ lawFirmId: firm.id, status: 'past_due' }));
    expect(captures('subscription_status_changed')).toHaveLength(1);

    // A second, distinct event for the same state: a cancel_at_period_end toggle.
    await send('evt_status_same', 'customer.subscription.updated',
      subscription({ lawFirmId: firm.id, status: 'past_due', cancelAtPeriodEnd: true }));

    expect(captures()).toHaveLength(1);
  });

  it('captures a recovery when a paid invoice takes a past_due firm back to active, with no amount', async () => {
    await seedSubscribed(firm.id, 'past_due');
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'active' }));

    await send('evt_invoice_recovered', 'invoice.paid', invoice(249_00));

    expect(await billingStatus(firm.id)).toBe('active');
    expect(captures()).toEqual([{
      event: 'subscription_status_changed',
      lawFirmId: firm.id,
      properties: { from_status: 'past_due', to_status: 'active', plan_id: 'enterprise', billing_interval: 'monthly' },
    }]);
  });

  it('captures nothing for a routine renewal on an already active firm', async () => {
    await seedSubscribed(firm.id, 'past_due');
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'active' }));
    await send('evt_renewal_first', 'invoice.paid', invoice());
    expect(captures()).toHaveLength(1);

    await send('evt_renewal_next', 'invoice.paid', invoice());

    expect(captures()).toHaveLength(1);
  });
});

describe('subscription_cancelled', () => {
  it('captures once when the subscription ends, and not for a second delete of it', async () => {
    await seedSubscribed(firm.id, 'active');

    await send('evt_cancel', 'customer.subscription.deleted', subscription({ lawFirmId: firm.id, status: 'canceled' }));

    expect(captures()).toEqual([{
      event: 'subscription_cancelled',
      lawFirmId: firm.id,
      properties: { plan_id: 'enterprise', billing_interval: 'monthly', from_status: 'active' },
    }]);

    // A distinct event id for the same, already-ended subscription.
    await send('evt_cancel_again', 'customer.subscription.deleted', subscription({ lawFirmId: firm.id, status: 'canceled' }));

    expect(captures()).toHaveLength(1);
  });

  it('captures nothing for a stale delete of a subscription the firm has replaced', async () => {
    await seedSubscribed(firm.id, 'active');

    await send('evt_cancel_stale', 'customer.subscription.deleted',
      subscription({ id: 'sub_old', lawFirmId: firm.id, status: 'canceled' }));

    // The guard held: the firm is still paying.
    expect(await billingStatus(firm.id)).toBe('active');
    expect(captures()).toEqual([]);
  });
});

describe('subscription_payment_failed', () => {
  it('captures the failure and the move to past_due, with no amount', async () => {
    await seedSubscribed(firm.id, 'active');
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));

    await send('evt_failed', 'invoice.payment_failed', invoice(0));

    expect(captures()).toEqual(expect.arrayContaining([
      {
        event: 'subscription_payment_failed',
        lawFirmId: firm.id,
        properties: { plan_id: 'enterprise', billing_interval: 'monthly', from_status: 'active' },
      },
      {
        event: 'subscription_status_changed',
        lawFirmId: firm.id,
        properties: { from_status: 'active', to_status: 'past_due', plan_id: 'enterprise', billing_interval: 'monthly' },
      },
    ]));
    expect(captures()).toHaveLength(2);
  });

  it('captures nothing for a dunning retry while the firm is already past_due', async () => {
    await seedSubscribed(firm.id, 'active');
    mockSubscriptionRetrieve.mockResolvedValue(subscription({ lawFirmId: firm.id, status: 'past_due' }));
    await send('evt_failed_first', 'invoice.payment_failed', invoice(0));
    expect(captures('subscription_payment_failed')).toHaveLength(1);
    mockCapture.mockReset();

    await send('evt_failed_retry', 'invoice.payment_failed', invoice(0));

    expect(captures()).toEqual([]);
  });
});
