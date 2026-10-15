/**
 * `client_invoice_paid` reaches product analytics from the Stripe payments
 * webhook, driven through the real route against Postgres.
 *
 * A firm's client pays an invoice through a Checkout session opened from its
 * payment link (`checkout.session.completed`, or `async_payment_succeeded` for a
 * method that settles later). Both land in `applyStripeCandidateTransaction`,
 * which records the payment only if its Stripe identity (session or payment
 * intent) is not already on the invoice. The event fires exactly when that
 * recording happened.
 *
 * Stripe redelivers events, and sends more than one event for one payment (a
 * `completed` and an `async_payment_succeeded` for the same session). Neither
 * may be counted twice, and an unpaid session (the money has not arrived) must
 * not be counted at all. Each such absence is proven after the same test has
 * shown a first capture, so it cannot pass because nothing ran.
 *
 * NO AMOUNTS, NO NAMES. Whether the invoice is now fully paid is a boolean; how
 * much was paid never leaves. The property set is pinned exactly.
 *
 * `stripe.config` is the refuse-everything fake from stripeWebhookState.test.ts:
 * only `webhooks` is real, and these handlers reach no other Stripe surface.
 * The analytics module is a recording fake.
 */
const mockCapture = jest.fn();

jest.mock('../../src/shared/analytics/serverAnalytics', () => ({
  captureServerEvent: (...args: unknown[]) => mockCapture(...args),
}));

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeLib = require('stripe');
  const refuse = (name: string) => () => {
    throw new Error(`stripe.${name} was called; this spec must not reach the Stripe API`);
  };
  return {
    webhooks: StripeLib.webhooks,
    invoices: { retrieve: refuse('invoices.retrieve'), voidInvoice: refuse('invoices.voidInvoice') },
    checkout: { sessions: { retrieve: refuse('checkout.sessions.retrieve') } },
    paymentIntents: { retrieve: refuse('paymentIntents.retrieve') },
  };
});

import { randomUUID } from 'crypto';

import {
  createFirm,
  createInvoice,
  createPersonClient,
  drainEvents,
  testPool,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';

const Stripe = require('stripe');

const WEBHOOK_SECRET = 'whsec_client_invoice_paid_analytics_suite';
const INVOICE_CENTS = 250_00;

function eventPayload(id: string, type: string, object: unknown) {
  return JSON.stringify({ id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } });
}

async function deliver(payload: string) {
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const res = await request()
    .post('/api/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('content-type', 'application/json')
    .send(payload);
  await drainEvents();
  // A refused or failed delivery ran no handler to completion, which would turn
  // every absence below into a false green.
  expect(res.status).toBe(200);
  return res;
}

const send = (type: string, object: unknown) => deliver(eventPayload(`evt_${randomUUID().slice(0, 12)}`, type, object));

const paidCaptures = () => mockCapture.mock.calls
  .map(([input]) => input)
  .filter((input: any) => input.event === 'client_invoice_paid');

async function invoiceMoney(invoiceId: string) {
  const { rows } = await testPool.query('select amount_paid_cents, is_paid from invoices where id = $1', [invoiceId]);
  return { paidCents: Number(rows[0].amount_paid_cents), isPaid: rows[0].is_paid };
}

let firm: Firm;
let invoiceId: string;
let clientId: string;

function checkoutSession(o: { paymentStatus?: string; amountCents?: number; installmentId?: string; sessionId?: string } = {}) {
  return {
    id: o.sessionId ?? 'cs_analytics_session',
    object: 'checkout.session',
    payment_status: o.paymentStatus ?? 'paid',
    amount_total: o.amountCents ?? INVOICE_CENTS,
    payment_intent: `pi_${randomUUID().slice(0, 10)}`,
    customer_details: { name: 'Jane Client', email: 'jane@example.test' },
    metadata: {
      lawFirmId: firm.id,
      invoiceId,
      contextType: 'client',
      entityId: clientId,
      clientId,
      ...(o.installmentId !== undefined ? { installmentId: o.installmentId } : {}),
    },
  };
}

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  mockCapture.mockReset();
  firm = await createFirm();
  const client = await createPersonClient(firm.id, { email: 'payer@example.test' });
  clientId = client.id;
  invoiceId = (await createInvoice(firm.id, client.id, { totalCents: INVOICE_CENTS })).id;
});

describe('Checkout session payments', () => {
  it('captures a completed checkout that pays the invoice in full', async () => {
    await send('checkout.session.completed', checkoutSession());

    expect(await invoiceMoney(invoiceId)).toEqual({ paidCents: INVOICE_CENTS, isPaid: true });
    expect(paidCaptures()).toEqual([{
      event: 'client_invoice_paid',
      lawFirmId: firm.id,
      properties: {
        invoice_id: invoiceId,
        payment_flow: 'checkout',
        context_type: 'client',
        charge_model: 'destination',
        is_installment: false,
        is_fully_paid: true,
      },
    }]);
  });

  it('reports a partial installment payment as such, without the amount', async () => {
    // A two-installment plan; the session paid the first installment's link,
    // which stamps the installment's stable id into the session metadata.
    const plan = await testPool.query('update invoices set payment_plan_enabled = true where id = $1', [invoiceId]);
    expect(plan.rowCount).toBe(1);
    const rows = await testPool.query(
      `insert into invoice_expected_payments
         (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
       values ($1, $2, 0, 'inst-1', '2026-05-01', 100_00, 'pending'),
              ($1, $2, 1, 'inst-2', '2026-06-01', 150_00, 'pending')`,
      [invoiceId, firm.id],
    );
    expect(rows.rowCount).toBe(2);

    await send('checkout.session.completed', checkoutSession({ amountCents: 100_00, installmentId: 'inst-1' }));

    expect(await invoiceMoney(invoiceId)).toEqual({ paidCents: 100_00, isPaid: false });
    const [capture] = paidCaptures();
    // The exact set, so an amount field cannot ride along unnoticed.
    expect(capture.properties).toEqual({
      invoice_id: invoiceId,
      payment_flow: 'checkout',
      context_type: 'client',
      charge_model: 'destination',
      is_installment: true,
      is_fully_paid: false,
    });
    // The session carried the payer's name and email; neither is forwarded.
    // (Not hex, so a random uuid in the payload cannot match by accident.)
    expect(JSON.stringify(capture)).not.toMatch(/Jane|jane@/);
  });

  it('does not capture the same payment twice when Stripe redelivers the event', async () => {
    const payload = eventPayload('evt_checkout_replay', 'checkout.session.completed', checkoutSession());
    await deliver(payload);
    expect(paidCaptures()).toHaveLength(1);

    const second = await deliver(payload);

    expect(second.body.duplicate).toBe(true);
    expect(paidCaptures()).toHaveLength(1);
  });

  it('does not capture again when a second event reports the same session paid', async () => {
    const session = checkoutSession();
    await send('checkout.session.completed', session);
    expect(paidCaptures()).toHaveLength(1);

    // A distinct event id carrying the same, already-recorded session.
    await send('checkout.session.async_payment_succeeded', session);

    expect((await invoiceMoney(invoiceId)).paidCents).toBe(INVOICE_CENTS);
    expect(paidCaptures()).toHaveLength(1);
  });

  it('waits for a delayed method to settle before capturing', async () => {
    await send('checkout.session.completed', checkoutSession({ paymentStatus: 'unpaid' }));

    // The money has not arrived, so neither the invoice nor analytics records it.
    expect((await invoiceMoney(invoiceId)).paidCents).toBe(0);
    expect(paidCaptures()).toEqual([]);

    await send('checkout.session.async_payment_succeeded', checkoutSession({ paymentStatus: 'paid' }));

    expect(paidCaptures()).toEqual([expect.objectContaining({
      lawFirmId: firm.id,
      properties: expect.objectContaining({ payment_flow: 'checkout', is_fully_paid: true }),
    })]);
  });
});
