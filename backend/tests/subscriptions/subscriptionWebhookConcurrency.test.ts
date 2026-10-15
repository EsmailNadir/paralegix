/**
 * A real overlap proof for duplicate subscription-webhook deliveries.
 *
 * A Promise.all of two deliveries, the obvious way to write this case, starts
 * two requests but cannot prove they reached the idempotency boundary at
 * the same time: the first can finish before the second begins its claim. This
 * test holds both requests inside the real claim function, then releases them
 * together. It therefore protects the atomic `stripe_events` claim rather than
 * merely sequential duplicate detection.
 */

// The subscription handler reads Stripe's current state; the support store
// answers it from the events this file delivers, so nothing reaches the network.
const mockSubscriptionRetrieve = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeCtor = require('stripe');
  const instance = new StripeCtor('sk_test_subscription_concurrency_spec');
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  return instance;
});

import { testPool, drainEvents, createFirm } from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import {
  ENTERPRISE_MONTHLY_PRICE,
  retrieveStripeSubscription,
  stripeSubscription,
  subscriptionEventPayload,
  subscriptionWebhookSender,
} from '../support/subscriptionWebhook';

const stripeService = require('../../src/modules/stripe/stripe.service');

const WEBHOOK_SECRET = 'whsec_subscription_concurrency_spec';

let gate: Gate | null = null;

const subscriptionCreatedPayload = (eventId: string, lawFirmId: string) => subscriptionEventPayload(
  eventId,
  'customer.subscription.created',
  stripeSubscription({ id: 'sub_concurrent_delivery', customer: 'cus_concurrent_delivery', lawFirmId }),
);

const { deliver } = subscriptionWebhookSender(WEBHOOK_SECRET);

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_subscription_concurrency_spec';
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY_PRICE;
});

beforeEach(() => {
  mockSubscriptionRetrieve.mockReset();
  mockSubscriptionRetrieve.mockImplementation(retrieveStripeSubscription);
});

afterEach(() => {
  gate?.restore();
  gate = null;
});

it('claims exactly once when duplicate subscription deliveries overlap inside the idempotency gate', async () => {
  const firm = await createFirm();
  const payload = subscriptionCreatedPayload('evt_subscription_gated_duplicate', firm.id);
  gate = gateMethod(stripeService, 'claimStripeEvent');

  const first = deliver(payload);
  const second = deliver(payload);

  // This is the race evidence: both public webhook requests are paused in the
  // claim, before either INSERT can win by simply arriving first.
  await gate.arrived(2);
  expect(gate.waiting()).toBe(2);

  gate.open();
  const [a, b] = await Promise.all([first, second]);
  await drainEvents();

  // The loser finds the winner's claim still processing and gets a 409, so
  // Stripe retries it instead of treating an unfinished attempt as done.
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect([a, b].filter((response) => response.status === 200 && response.body.duplicate === undefined)).toHaveLength(1);
  expect(gate.entered()).toBe(2);

  const { rows: claimed } = await testPool.query(
    'select event_id from stripe_events where event_id = $1',
    ['evt_subscription_gated_duplicate'],
  );
  expect(claimed).toEqual([{ event_id: 'evt_subscription_gated_duplicate' }]);

  const { rows: firms } = await testPool.query(
    'select billing_status, plan from law_firms where id = $1',
    [firm.id],
  );
  expect(firms[0].billing_status).toBe('active');
  expect(firms[0].plan.stripeSubscriptionId).toBe('sub_concurrent_delivery');
});

export {};
