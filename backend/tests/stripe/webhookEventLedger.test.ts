/**
 * The `stripe_events` ledger that both Stripe webhook endpoints claim from.
 *
 * Two things this file pins that the per-endpoint idempotency specs cannot:
 *
 * 1. THE ENDPOINTS ARE SEPARATE LEDGERS. The payments endpoint
 *    (`/api/webhooks/stripe`) and the subscription endpoint
 *    (`/api/webhooks/stripe-subscriptions`) are both subscribed to
 *    `invoice.paid`, and Stripe delivers the SAME event id to each. Keyed on the
 *    event id alone, whichever endpoint claimed first won and the other answered
 *    "duplicate", so a subscription renewal could be dropped by the payments
 *    endpoint's no-op acknowledgement of it.
 *
 * 2. A CLAIM IS NOT A RESULT. The claim commits before the handler runs. A
 *    second delivery that arrives while the first is still running must not be
 *    told "already done" (Stripe would stop retrying an event that may yet
 *    fail); it gets a 409 so Stripe tries again later. A claim whose holder died
 *    mid-handler (deploy, OOM) is reclaimed once it is older than the stale
 *    threshold, so the event is never stranded.
 *
 * Offline: signature verification is an HMAC compare, `new Stripe(key)` does no
 * I/O, and the one outbound call the subscription handler makes
 * (`subscriptions.retrieve`) is replaced.
 */

const mockSubscriptionRetrieve = jest.fn();

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeCtor = require('stripe');
  const instance = new StripeCtor('sk_test_offline_ledger_suite');
  instance.subscriptions.retrieve = (...args: any[]) => mockSubscriptionRetrieve(...args);
  return instance;
});

import { testPool, drainEvents, createFirm } from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import { deliverSigned, stripeEventPayload } from '../support/stripeWebhook';
import {
  ENTERPRISE_MONTHLY_PRICE,
  SUBSCRIPTION_WEBHOOK_PATH,
  billingRow,
  secs,
  seedPlan,
  stripeSubscription,
  subscriptionInvoice,
} from '../support/subscriptionWebhook';

const stripeService = require('../../src/modules/stripe/stripe.service');

const PAYMENTS_SECRET = 'whsec_ledger_payments_secret';
const SUBSCRIPTIONS_SECRET = 'whsec_ledger_subscriptions_secret';

let gate: Gate | null = null;

const expiredEvent = (id: string) => stripeEventPayload(id, 'checkout.session.expired', {
  id: 'cs_ledger_session', object: 'checkout.session', metadata: {},
});

async function ledgerRows(eventId: string) {
  const { rows } = await testPool.query(
    'select endpoint, status from stripe_events where event_id = $1 order by endpoint',
    [eventId],
  );
  return rows;
}

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_offline_ledger_suite';
  process.env.STRIPE_WEBHOOK_SECRET = PAYMENTS_SECRET;
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = SUBSCRIPTIONS_SECRET;
  process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID = ENTERPRISE_MONTHLY_PRICE;
});

beforeEach(() => {
  mockSubscriptionRetrieve.mockReset();
});

afterEach(() => {
  gate?.restore();
  gate = null;
});

describe('one event id delivered to both endpoints', () => {
  it('is processed by the subscription endpoint even after the payments endpoint acknowledged it', async () => {
    const firm = await createFirm();
    await seedPlan(firm.id, {
      planId: 'enterprise', billingStatus: 'active', stripeSubscriptionId: 'sub_ledger_1',
    });
    mockSubscriptionRetrieve.mockResolvedValue(
      stripeSubscription({ id: 'sub_ledger_1', lawFirmId: firm.id, status: 'active' }),
    );
    const paidAt = secs('2026-06-02T09:00:00.000Z');
    const payload = stripeEventPayload('evt_ledger_shared_invoice_paid', 'invoice.paid',
      subscriptionInvoice({ subscriptionId: 'sub_ledger_1', amountPaid: 249_00, paidAt }));

    const payments = await deliverSigned(payload, PAYMENTS_SECRET);
    const subscriptions = await deliverSigned(payload, SUBSCRIPTIONS_SECRET, SUBSCRIPTION_WEBHOOK_PATH);
    await drainEvents();

    expect(payments.status).toBe(200);
    expect(payments.body.duplicate).toBeUndefined();
    // The half that used to be lost: the payments endpoint's claim of the same
    // id made this one a "duplicate", so the renewal was never recorded.
    expect(subscriptions.status).toBe(200);
    expect(subscriptions.body.duplicate).toBeUndefined();
    const row = await billingRow(firm.id);
    expect(row.plan.lastPaymentAmount).toBe(249_00);
    expect(row.plan.lastPaymentAt).toBe('2026-06-02T09:00:00.000Z');
    expect(await ledgerRows('evt_ledger_shared_invoice_paid')).toEqual([
      { endpoint: 'payments', status: 'done' },
      { endpoint: 'subscriptions', status: 'done' },
    ]);
  });

  it('still dedupes a redelivery to the SAME endpoint', async () => {
    const payload = expiredEvent('evt_ledger_same_endpoint');

    const first = await deliverSigned(payload, PAYMENTS_SECRET);
    const second = await deliverSigned(payload, PAYMENTS_SECRET);

    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(await ledgerRows('evt_ledger_same_endpoint')).toEqual([
      { endpoint: 'payments', status: 'done' },
    ]);
  });
});

describe('a delivery that arrives while the first is still being processed', () => {
  it('is refused with a 409 so Stripe retries it, and the first still completes', async () => {
    gate = gateMethod(stripeService, 'handleCheckoutExpired');
    const payload = expiredEvent('evt_ledger_in_flight');

    // The first delivery is held INSIDE its handler, after its claim committed.
    const first = deliverSigned(payload, PAYMENTS_SECRET);
    await gate.arrived(1);
    expect(await ledgerRows('evt_ledger_in_flight')).toEqual([
      { endpoint: 'payments', status: 'processing' },
    ]);

    const second = await deliverSigned(payload, PAYMENTS_SECRET);

    // A 200 here would tell Stripe the event is handled while the only attempt
    // at it might still fail, and Stripe would never send it again.
    expect(second.status).toBe(409);
    expect(second.body.duplicate).toBeUndefined();
    // The control: the second delivery never reached the handler.
    expect(gate.entered()).toBe(1);

    gate.open();
    expect((await first).status).toBe(200);
    expect(await ledgerRows('evt_ledger_in_flight')).toEqual([
      { endpoint: 'payments', status: 'done' },
    ]);

    // Once the first finished, a retry is an ordinary duplicate.
    const third = await deliverSigned(payload, PAYMENTS_SECRET);
    expect(third.status).toBe(200);
    expect(third.body.duplicate).toBe(true);
    expect(gate.entered()).toBe(1);
  });

  it('is refused on the subscription endpoint too', async () => {
    await testPool.query(
      `insert into stripe_events (endpoint, event_id, status, claimed_at)
       values ('subscriptions', 'evt_ledger_sub_in_flight', 'processing', now() - interval '1 minute')`,
    );

    const res = await deliverSigned(
      stripeEventPayload('evt_ledger_sub_in_flight', 'customer.subscription.trial_will_end', stripeSubscription({})),
      SUBSCRIPTIONS_SECRET,
      SUBSCRIPTION_WEBHOOK_PATH,
    );

    expect(res.status).toBe(409);
    expect(await ledgerRows('evt_ledger_sub_in_flight')).toEqual([
      { endpoint: 'subscriptions', status: 'processing' },
    ]);
  });
});

describe('a claim whose holder never finished', () => {
  it('is reclaimed and processed once it is older than the stale threshold', async () => {
    // What a process killed mid-handler leaves behind: a processing row that
    // nothing will ever mark done or release.
    await testPool.query(
      `insert into stripe_events (endpoint, event_id, status, claimed_at)
       values ('payments', 'evt_ledger_stale', 'processing', now() - interval '11 minutes')`,
    );
    gate = gateMethod(stripeService, 'handleCheckoutExpired');
    gate.open();

    const res = await deliverSigned(expiredEvent('evt_ledger_stale'), PAYMENTS_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBeUndefined();
    expect(gate.entered()).toBe(1);
    expect(await ledgerRows('evt_ledger_stale')).toEqual([
      { endpoint: 'payments', status: 'done' },
    ]);
  });

  it('is released when the handler fails, so the next retry processes it at once', async () => {
    gate = gateMethod(stripeService, 'handleCheckoutExpired');
    gate.open();
    gate.failNext(new Error('simulated handler failure'));

    const failed = await deliverSigned(expiredEvent('evt_ledger_released'), PAYMENTS_SECRET);
    expect(failed.status).toBe(500);
    expect(await ledgerRows('evt_ledger_released')).toEqual([]);

    const retried = await deliverSigned(expiredEvent('evt_ledger_released'), PAYMENTS_SECRET);
    expect(retried.status).toBe(200);
    expect(retried.body.duplicate).toBeUndefined();
    expect(gate.entered()).toBe(2);
  });

  it('a late release from a superseded holder does not drop the claim that replaced it', async () => {
    await testPool.query(
      `insert into stripe_events (endpoint, event_id, status, claimed_at)
       values ('payments', 'evt_ledger_superseded', 'processing', now() - interval '11 minutes')`,
    );
    const { rows: [{ token: oldToken }] } = await testPool.query(
      `select claimed_at::text as token from stripe_events where event_id = 'evt_ledger_superseded'`,
    );

    const reclaim = await stripeService.claimStripeEvent('evt_ledger_superseded', 'payments');
    expect(reclaim.status).toBe('claimed');
    // The original holder wakes up, fails, and releases with ITS token.
    await stripeService.releaseStripeEvent('evt_ledger_superseded', 'payments', oldToken);

    expect(await ledgerRows('evt_ledger_superseded')).toEqual([
      { endpoint: 'payments', status: 'processing' },
    ]);
  });
});

export {};
