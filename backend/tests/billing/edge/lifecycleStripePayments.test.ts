/**
 * Stripe payments, refunds and disputes on an invoice, delivered the way Stripe
 * delivers them: genuinely signed payloads through the real webhook route into
 * real Postgres. Every spec ends with the invoice invariants recomputed from the
 * payment rows, with `allowExcess` only where a spec drives an overpayment on
 * purpose and asserts that outcome itself.
 *
 * Automatic cash recovery is off (its production default, forced by the test
 * environment), so every Stripe SDK surface refuses to run and the `afterEach`
 * fails any case that reached for one.
 */
const mockStripeCalls: string[] = [];

jest.mock('../../../src/modules/stripe/stripe.config', () => {
  const StripeLib = require('stripe');
  const refuse = (name: string) => () => {
    mockStripeCalls.push(name);
    throw new Error(`stripe.${name} was called; this spec must not reach the Stripe API`);
  };
  return {
    webhooks: StripeLib.webhooks,
    invoices: {
      create: refuse('invoices.create'),
      retrieve: refuse('invoices.retrieve'),
      voidInvoice: refuse('invoices.voidInvoice'),
    },
    customers: { retrieve: refuse('customers.retrieve') },
    checkout: { sessions: { retrieve: refuse('checkout.sessions.retrieve'), expire: refuse('checkout.sessions.expire') } },
    paymentIntents: { create: refuse('paymentIntents.create'), retrieve: refuse('paymentIntents.retrieve') },
    transfers: {
      create: refuse('transfers.create'),
      retrieve: refuse('transfers.retrieve'),
      createReversal: refuse('transfers.createReversal'),
    },
  };
});

import { randomUUID } from 'crypto';
import {
  testPool,
  drainEvents,
  sentEmails,
  resetEmails,
} from '../../support/setupInProcess';
import { gateMethod, type Gate } from '../../support/gate';
import {
  deliverSigned,
  stripeEventPayload,
  stripeWebhookSender,
  newPaymentIntentId,
  claimedEventIds,
} from '../../support/stripeWebhook';
import {
  seedWorld,
  invoiceRow,
  paymentRows,
  assertInvoiceInvariants,
  type World,
} from './lifecycleKit';

const bus = require('../../../src/shared/events/eventBus');
const invoicesRepo = require('../../../src/modules/billing/invoices/invoices.repository');
const stripeService = require('../../../src/modules/stripe/stripe.service');

const SECRET = 'whsec_lifecycle_stripe_payments_secret';
const sender = stripeWebhookSender(SECRET);

let w: World;
let gate: Gate | null = null;
let emitted: Array<{ name: string; payload: any }> = [];
let emitSpy: jest.SpyInstance;
let counter = 0;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

beforeEach(async () => {
  w = await seedWorld(100_000);
  mockStripeCalls.length = 0;
  emitted = [];
  const realEmit = bus.emit.bind(bus);
  emitSpy = jest.spyOn(bus, 'emit').mockImplementation((...args: any[]) => {
    emitted.push({ name: args[0], payload: args[1] });
    return realEmit(...args);
  });
  resetEmails();
});

afterEach(() => {
  gate?.restore();
  gate = null;
  emitSpy.mockRestore();
  expect(mockStripeCalls).toEqual([]);
});

const meta = () => ({ lawFirmId: w.firm.id, invoiceId: w.invoiceId, contextType: 'client', entityId: w.clientId });
const now = () => Math.floor(Date.now() / 1000);

const checkoutObject = (amountCents: number, pi: string, sessionId = `cs_${randomUUID().slice(0, 8)}`) => ({
  id: sessionId,
  object: 'checkout.session',
  payment_status: 'paid',
  amount_total: amountCents,
  payment_intent: pi,
  created: now(),
  metadata: meta(),
});

const eventId = () => `evt_lc_${counter++}_${randomUUID().slice(0, 8)}`;

async function send(type: string, object: unknown, id = eventId()) {
  const res = await deliverSigned(stripeEventPayload(id, type, object), SECRET);
  await drainEvents();
  return res;
}

const received = () => emitted.filter((e) => e.name === 'invoice.paymentReceived');
const reversed = () => emitted.filter((e) => e.name === 'invoice.paymentReversed');
const receipts = () => sentEmails().filter((e) => /received your payment/i.test(e.text || ''));

async function stripePaid(amountCents: number, pi = newPaymentIntentId()) {
  const res = await send('checkout.session.completed', checkoutObject(amountCents, pi));
  expect(res.status).toBe(200);
  return pi;
}

describe('the same payment delivered more than once', () => {
  it('one event id delivered twice records one payment, one event and one receipt', async () => {
    const pi = newPaymentIntentId();
    const id = eventId();
    const object = checkoutObject(100_000, pi);

    const first = await send('checkout.session.completed', object, id);
    const second = await send('checkout.session.completed', object, id);

    expect(first.body).toEqual({ received: true });
    expect(second.body).toEqual({ received: true, duplicate: true });
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([100_000]);
    expect(row.status).toBe('paid');
    expect(received()).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
    expect(await claimedEventIds()).toEqual([id]);
  });

  it('one event id delivered twice at the same instant records one payment', async () => {
    const pi = newPaymentIntentId();
    const id = eventId();
    const payload = stripeEventPayload(id, 'checkout.session.completed', checkoutObject(100_000, pi));
    gate = gateMethod(stripeService, 'claimStripeEvent');

    async function deliver() {
      return deliverSigned(payload, SECRET);
    }
    const a = deliver();
    const b = deliver();
    await gate.arrived(2);
    gate.open();
    const [ra, rb] = await Promise.all([a, b]);
    await drainEvents();

    // The loser finds the winner's claim still processing: a 409, retried later.
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect([ra, rb].filter((r) => r.status === 200 && r.body.duplicate === undefined)).toHaveLength(1);
    const { payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([100_000]);
    expect(received()).toHaveLength(1);
  });

  it('a completed and an async_payment_succeeded event for one session count the payment once', async () => {
    const object = checkoutObject(100_000, newPaymentIntentId());

    await send('checkout.session.completed', object);
    const res = await send('checkout.session.async_payment_succeeded', object);

    expect(res.status).toBe(200);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([100_000]);
    expect(Number(row.amount_paid_cents)).toBe(100_000);
    expect(received()).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
  });

  it('a completed and an async_payment_succeeded event for one session, raced, count it once', async () => {
    const object = checkoutObject(100_000, newPaymentIntentId());
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');

    async function deliver(type: string, object: unknown) {
      return deliverSigned(stripeEventPayload(eventId(), type, object), SECRET);
    }
    const a = deliver('checkout.session.completed', object);
    const b = deliver('checkout.session.async_payment_succeeded', object);
    await gate.arrived(2);
    gate.open();
    const [ra, rb] = await Promise.all([a, b]);
    await drainEvents();

    expect([ra.status, rb.status]).toEqual([200, 200]);
    const { payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([100_000]);
    expect(received()).toHaveLength(1);
  });

  it('payment_intent.succeeded for an invoice payment intent changes nothing', async () => {
    const pi = await stripePaid(40_000);
    const before = await invoiceRow(w.invoiceId);
    emitted.length = 0;

    const res = await send('payment_intent.succeeded', {
      id: pi, object: 'payment_intent', amount: 40_000, amount_received: 40_000, metadata: meta(),
    });

    expect(res.status).toBe(200);
    expect(await invoiceRow(w.invoiceId)).toEqual(before);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([40_000]);
    expect(received()).toHaveLength(0);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a checkout session that is not yet paid records nothing', async () => {
    const res = await send('checkout.session.completed', {
      ...checkoutObject(100_000, newPaymentIntentId()), payment_status: 'unpaid',
    });

    expect(res.status).toBe(200);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    expect(received()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('refunds', () => {
  it('a partial Stripe payment fully refunded nets to zero and reopens the invoice', async () => {
    const pi = await stripePaid(40_000);
    let state = await assertInvoiceInvariants(w.invoiceId);
    expect(state.row.status).toBe('partially_paid');

    await sender.refunded(pi, 40_000);

    state = await assertInvoiceInvariants(w.invoiceId);
    expect(state.row.status).toBe('outstanding');
    expect(Number(state.row.amount_paid_cents)).toBe(0);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0].cents).toBe(0);
    expect(state.payments[0].refunded).toBe(40_000);
    expect(reversed().map((e) => e.payload.reversedCents)).toEqual([40_000]);
  });

  it('refunding a paid invoice partially drops it to partially_paid and clears the paid date', async () => {
    const pi = await stripePaid(100_000);
    expect((await invoiceRow(w.invoiceId)).paid_date).not.toBeNull();

    await sender.refunded(pi, 15_050);

    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('partially_paid');
    expect(row.is_paid).toBe(false);
    expect(row.paid_date).toBeNull();
    expect(Number(row.amount_paid_cents)).toBe(84_950);
    expect(payments[0].refunded).toBe(15_050);
  });

  it('a refund larger than the payment is capped at the payment and never makes the paid figure negative', async () => {
    const pi = await stripePaid(40_000);

    await sender.refunded(pi, 99_999);

    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments[0].cents).toBe(0);
    expect(payments[0].refunded).toBe(40_000);
    expect(Number(row.amount_paid_cents)).toBe(0);
    expect(reversed().map((e) => e.payload.reversedCents)).toEqual([40_000]);
  });

  it('refunding an already fully reversed payment changes nothing and announces nothing', async () => {
    const pi = await stripePaid(40_000);
    await sender.refunded(pi, 40_000);
    const before = await paymentRows(w.invoiceId);
    emitted.length = 0;

    await sender.refunded(pi, 40_000);
    await sender.refunded(pi, 90_000);

    expect(await paymentRows(w.invoiceId)).toEqual(before);
    expect(reversed()).toHaveLength(0);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a refund beside a manual payment only takes back the Stripe share', async () => {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 600 })).status).toBe(200);
    const pi = await stripePaid(40_000);
    expect((await invoiceRow(w.invoiceId)).status).toBe('paid');

    await sender.refunded(pi, 10_000);

    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([60_000, 30_000]);
    expect(payments[1].payment_source).toBe('stripe');
    expect(Number(row.amount_paid_cents)).toBe(90_000);
    expect(row.status).toBe('partially_paid');
    expect(row.paid_date).toBeNull();
  });

  it('paying again after a full refund settles the invoice with a fresh paid date', async () => {
    const first = await stripePaid(100_000);
    await sender.refunded(first, 100_000);
    expect((await invoiceRow(w.invoiceId)).status).toBe('outstanding');

    await stripePaid(100_000);

    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(row.status).toBe('paid');
    expect(row.paid_date).not.toBeNull();
    expect(payments.map((p: any) => p.cents)).toEqual([0, 100_000]);
  });

  it('a refund for a payment intent the firm never recorded is acknowledged and changes nothing', async () => {
    await stripePaid(40_000);
    const before = await paymentRows(w.invoiceId);

    await sender.refunded(newPaymentIntentId(), 40_000);

    expect(await paymentRows(w.invoiceId)).toEqual(before);
    expect(reversed()).toHaveLength(0);
  });

  it('a failed refund restores exactly the reversed amount once, however often the failure is replayed', async () => {
    const pi = await stripePaid(40_000);
    await sender.refunded(pi, 40_000);

    await sender.refundUpdated(pi, 40_000, 'failed');
    await sender.refundUpdated(pi, 40_000, 'failed');

    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments[0].cents).toBe(40_000);
    expect(payments[0].refunded).toBe(0);
    expect(Number(row.amount_paid_cents)).toBe(40_000);
    expect(emitted.filter((e) => e.name === 'invoice.paymentRecredited')).toHaveLength(1);
  });
});

describe('refund events racing and refunds on a voided invoice', () => {
  it('two refund events carrying the same cumulative total, raced, reverse the payment once', async () => {
    const pi = await stripePaid(100_000);
    emitted.length = 0;
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');
    async function deliver() {
      return deliverSigned(stripeEventPayload(eventId(), 'charge.refunded', {
        id: 'ch_race', object: 'charge', payment_intent: pi, amount_refunded: 30_000,
      }), SECRET);
    }
    const a = deliver();
    const b = deliver();
    await gate.arrived(2);
    gate.open();
    const results = await Promise.all([a, b]);
    await drainEvents();

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => [p.cents, p.refunded])).toEqual([[70_000, 30_000]]);
    expect(Number(row.amount_paid_cents)).toBe(70_000);
    expect(reversed()).toHaveLength(1);
  });

  it('a refund of a payment that landed on a voided invoice reverses it and the invoice stays voided', async () => {
    expect((await w.owner.api.post(`${w.inv}/void`).send({})).status).toBe(200);
    const pi = newPaymentIntentId();
    expect((await send('checkout.session.completed', checkoutObject(100_000, pi))).status).toBe(200);
    expect(Number((await invoiceRow(w.invoiceId)).amount_paid_cents)).toBe(100_000);

    await sender.refunded(pi, 100_000);

    const row = await invoiceRow(w.invoiceId);
    expect(row.status).toBe('voided');
    expect(Number(row.amount_paid_cents)).toBe(0);
    const payments = await paymentRows(w.invoiceId);
    expect(payments.map((p: any) => [p.cents, p.refunded])).toEqual([[0, 100_000]]);
  });
});


describe('disputes', () => {
  it('opened then won restores the payment; opened then lost leaves it reversed', async () => {
    const won = await stripePaid(40_000);
    await sender.disputed(won, 40_000);
    let state = await assertInvoiceInvariants(w.invoiceId);
    expect(state.payments[0].cents).toBe(0);
    expect(Number(state.row.amount_paid_cents)).toBe(0);

    await sender.disputeClosed(won, 40_000, 'won');
    state = await assertInvoiceInvariants(w.invoiceId);
    expect(state.payments[0].cents).toBe(40_000);
    expect(Number(state.row.amount_paid_cents)).toBe(40_000);

    const lost = await stripePaid(20_000);
    await sender.disputed(lost, 20_000);
    await sender.disputeClosed(lost, 20_000, 'lost');
    state = await assertInvoiceInvariants(w.invoiceId);
    expect(state.payments.map((p: any) => p.cents)).toEqual([40_000, 0]);
    expect(Number(state.row.amount_paid_cents)).toBe(40_000);
  });

  it('a dispute event replayed or followed by a refund for the same amount reverses it once', async () => {
    const pi = await stripePaid(40_000);

    await sender.disputed(pi, 40_000);
    await sender.disputed(pi, 40_000);
    await sender.refunded(pi, 40_000);

    const { row, payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments[0].cents).toBe(0);
    expect(payments[0].refunded).toBe(40_000);
    expect(Number(row.amount_paid_cents)).toBe(0);
    expect(reversed()).toHaveLength(1);
  });

  it('a won dispute with nothing reversed changes nothing', async () => {
    const pi = await stripePaid(40_000);
    emitted.length = 0;

    await sender.disputeClosed(pi, 40_000, 'won');

    const { payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments[0].cents).toBe(40_000);
    expect(emitted.filter((e) => e.name === 'invoice.paymentRecredited')).toHaveLength(0);
  });
});

describe('a Stripe payment against an invoice that cannot take it', () => {
  it('lands on a voided invoice as a recorded payment and the invoice stays voided', async () => {
    expect((await w.owner.api.post(`${w.inv}/void`).send({})).status).toBe(200);

    const res = await send('checkout.session.completed', checkoutObject(100_000, newPaymentIntentId()));

    expect(res.status).toBe(200);
    const row = await invoiceRow(w.invoiceId);
    expect(row.status).toBe('voided');
    // Money moved, so the payment is on the record where a refund will find it.
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([100_000]);
    expect(Number(row.amount_paid_cents)).toBe(100_000);
  });

  it('a payment applied after a manual payment settled the invoice is recorded and the rows still add up', async () => {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 1000 })).status).toBe(200);

    const res = await send('checkout.session.completed', checkoutObject(100_000, newPaymentIntentId()));

    expect(res.status).toBe(200);
    // Policy: the webhook records money that really moved, so the excess is kept
    // rather than refused. The figures must stay internally consistent.
    const { row, payments } = await assertInvoiceInvariants(w.invoiceId, { allowExcess: true });
    expect(payments.map((p: any) => p.cents)).toEqual([100_000, 100_000]);
    expect(Number(row.amount_paid_cents)).toBe(200_000);
    expect(row.status).toBe('paid');
  });

  it('a manual payment and a Stripe payment racing for the whole balance leave amount_paid equal to the rows', async () => {
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');

    async function manual() {
      return w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 1000 });
    }
    async function stripeSide() {
      return deliverSigned(stripeEventPayload(eventId(), 'checkout.session.completed', checkoutObject(100_000, newPaymentIntentId())), SECRET);
    }
    const a = manual();
    const b = stripeSide();
    await gate.arrived(2);
    gate.open();
    const [m, s] = await Promise.all([a, b]);
    await drainEvents();

    // The webhook always acknowledges; the manual request either won or was refused.
    expect(s.status).toBe(200);
    expect([200, 400]).toContain(m.status);
    const { payments } = await assertInvoiceInvariants(w.invoiceId, { allowExcess: true });
    expect(payments.filter((p: any) => p.payment_source === 'stripe')).toHaveLength(1);
    // The manual response and the payment rows agree about whether it landed.
    expect(payments.filter((p: any) => p.payment_source !== 'stripe')).toHaveLength(m.status === 200 ? 1 : 0);
  });
});

describe('what a removal or edit may do to a Stripe payment', () => {
  it('a Stripe payment cannot be deleted or have its amount edited, but its note can', async () => {
    await stripePaid(40_000);

    const del = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);
    const amount = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, amount: 10 });
    const note = await w.owner.api.patch(`${w.inv}/payment`).send({ paymentIndex: 0, note: 'ack' });

    expect(del.status).toBe(409);
    expect(amount.status).toBe(400);
    expect(note.status).toBe(200);
    const { payments } = await assertInvoiceInvariants(w.invoiceId);
    expect(payments.map((p: any) => p.cents)).toEqual([40_000]);
  });

});

describe('receipts for Stripe payments', () => {
  it('each distinct Stripe payment sends one receipt with its own amount', async () => {
    await stripePaid(11_111);
    await stripePaid(22_222);

    const mails = receipts();
    expect(mails).toHaveLength(2);
    expect(mails[0].text).toContain('111.11');
    expect(mails[1].text).toContain('222.22');
  });
});
