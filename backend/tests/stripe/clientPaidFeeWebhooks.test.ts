/**
 * A checkout the client paid with a processing fee on top.
 *
 * The fee rides on the same Stripe charge as the invoice money, so the charge
 * total is larger than what the invoice is owed. Counting the whole charge
 * would show the invoice overpaid, tell the firm it owes a refund, and spill
 * the fee onto the next installment. None of that looks wrong on any one
 * screen, which is why it is pinned here through the real signed webhook.
 */
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
    transfers: { createReversal: refuse('transfers.createReversal') },
  };
});

import { randomUUID } from 'crypto';

import {
  createFirm,
  createInvoice,
  createPersonClient,
  drainEvents,
  emailsMatching,
  resetEmails,
  testPool,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';

const Stripe = require('stripe');

const WEBHOOK_SECRET = 'whsec_client_paid_fee_suite';
const INVOICE_CENTS = 250_00;
// clientSurchargeCents('card', 25000) with the default fee schedule.
const CARD_SURCHARGE = 1_019;

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
  // A refused delivery ran no handler, which would turn every assertion below
  // about what was recorded into a false green.
  expect(res.status).toBe(200);
  return res;
}

const send = (type: string, object: unknown) => deliver(eventPayload(`evt_${randomUUID().slice(0, 12)}`, type, object));

async function invoiceMoney(id: string) {
  const { rows } = await testPool.query('select amount_paid_cents, is_paid from invoices where id = $1', [id]);
  return { paidCents: Number(rows[0].amount_paid_cents), isPaid: rows[0].is_paid };
}

async function paymentAmounts(id: string) {
  const { rows } = await testPool.query(
    'select amount_cents, stripe_refunded_cents, surcharge_cents from invoice_payments where invoice_id = $1', [id],
  );
  return rows.map((row: any) => ({
    amountCents: Number(row.amount_cents),
    refundedCents: Number(row.stripe_refunded_cents),
    surchargeCents: Number(row.surcharge_cents),
  }));
}

let firm: Firm;
let invoiceId: string;
let clientId: string;

function checkoutSession(o: { amountCents?: number; paymentIntent?: string; metadata?: Record<string, string> } = {}) {
  return {
    id: `cs_${randomUUID().slice(0, 10)}`,
    object: 'checkout.session',
    payment_status: 'paid',
    amount_total: o.amountCents ?? INVOICE_CENTS,
    payment_intent: o.paymentIntent ?? `pi_${randomUUID().slice(0, 10)}`,
    created: Math.floor(Date.now() / 1000),
    metadata: {
      lawFirmId: firm.id,
      invoiceId,
      contextType: 'client',
      entityId: clientId,
      clientId,
      ...(o.metadata ?? {}),
    },
  };
}

const surchargedCardSession = (paymentIntent?: string) => checkoutSession({
  amountCents: INVOICE_CENTS + CARD_SURCHARGE,
  paymentIntent,
  metadata: { paymentMethod: 'card', invoiceAmountCents: String(INVOICE_CENTS), surchargeCents: String(CARD_SURCHARGE) },
});

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  resetEmails();
  firm = await createFirm();
  const client = await createPersonClient(firm.id, { email: 'payer@example.test' });
  clientId = client.id;
  invoiceId = (await createInvoice(firm.id, client.id, { totalCents: INVOICE_CENTS })).id;
  await testPool.query(`update invoices set invoice_name = 'INV-FEE-9' where id = $1`, [invoiceId]);
});

it('pins the surcharge this spec assumes to the fee module', () => {
  const { clientSurchargeCents } = require('../../src/modules/stripe/processingFees');
  expect(clientSurchargeCents('card', INVOICE_CENTS)).toBe(CARD_SURCHARGE);
});

describe('recording the payment', () => {
  it('credits the invoice with the invoice amount only', async () => {
    await send('checkout.session.completed', surchargedCardSession());

    // Breaks if the surcharge is counted as invoice money: paid would be 26017
    // and the invoice would read as overpaid with a refund due.
    expect(await invoiceMoney(invoiceId)).toEqual({ paidCents: INVOICE_CENTS, isPaid: true });
    expect(await paymentAmounts(invoiceId)).toEqual([{ amountCents: INVOICE_CENTS, refundedCents: 0, surchargeCents: CARD_SURCHARGE }]);
  });

  it('records a session with no fee as the whole charge', async () => {
    await send('checkout.session.completed', checkoutSession());

    expect(await paymentAmounts(invoiceId)).toEqual([{ amountCents: INVOICE_CENTS, refundedCents: 0, surchargeCents: 0 }]);
  });

  it('never credits more than was charged when the surcharge metadata is malformed', async () => {
    await send('checkout.session.completed', checkoutSession({
      amountCents: INVOICE_CENTS, metadata: { surchargeCents: String(INVOICE_CENTS * 2) },
    }));

    // The surcharge is clamped to the charge, so nothing is left for the invoice.
    expect((await invoiceMoney(invoiceId)).paidCents).toBe(0);
  });
});

describe('the receipt', () => {
  it('shows the invoice payment and the processing fee apart', async () => {
    await send('checkout.session.completed', surchargedCardSession());

    const [receipt] = emailsMatching(/Payment received: Invoice #INV-FEE-9/);
    // The subject names the invoice payment, not the gross charge.
    expect(receipt.subject).toBe('Payment received: Invoice #INV-FEE-9 ($250.00)');
    expect(receipt.text).toContain('Credit card fee: $10.19. Total charged: $260.19.');
    expect(receipt.text).toContain('This invoice is now paid in full.');
  });

  it('labels a fee on a bank transfer as the bank transfer fee', async () => {
    const { clientSurchargeCents } = require('../../src/modules/stripe/processingFees');
    const bankFee = clientSurchargeCents('bank', INVOICE_CENTS);
    await send('checkout.session.completed', checkoutSession({
      amountCents: INVOICE_CENTS + bankFee,
      metadata: { paymentMethod: 'bank', invoiceAmountCents: String(INVOICE_CENTS), surchargeCents: String(bankFee) },
    }));

    const [receipt] = emailsMatching(/Payment received: Invoice #INV-FEE-9/);
    const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    expect(receipt.text).toContain(`Bank transfer fee: ${dollars(bankFee)}. Total charged: ${dollars(INVOICE_CENTS + bankFee)}.`);
    expect(receipt.text).not.toContain('Credit card fee');
  });

  it('mentions no fee when none was charged', async () => {
    await send('checkout.session.completed', checkoutSession());

    const [receipt] = emailsMatching(/Payment received: Invoice #INV-FEE-9/);
    expect(receipt.text).toContain('We received your payment of $250.00');
    expect(receipt.text).not.toMatch(/ fee: |Total charged/);
  });
});

describe('reversing the payment', () => {
  const PI = 'pi_surcharged_fixture';

  beforeEach(async () => {
    await send('checkout.session.completed', surchargedCardSession(PI));
  });

  it('a full refund reverses exactly the invoice amount', async () => {
    await send('charge.refunded', {
      id: 'ch_full', object: 'charge', payment_intent: PI, amount_refunded: INVOICE_CENTS + CARD_SURCHARGE,
    });

    expect(await invoiceMoney(invoiceId)).toEqual({ paidCents: 0, isPaid: false });
    // The refunded total is the invoice money, never the gross charge.
    expect(await paymentAmounts(invoiceId)).toEqual([{ amountCents: 0, refundedCents: INVOICE_CENTS, surchargeCents: CARD_SURCHARGE }]);
  });

  it('a partial refund reduces invoice money first', async () => {
    await send('charge.refunded', { id: 'ch_part', object: 'charge', payment_intent: PI, amount_refunded: 50_00 });

    expect((await invoiceMoney(invoiceId)).paidCents).toBe(INVOICE_CENTS - 50_00);
  });
});
