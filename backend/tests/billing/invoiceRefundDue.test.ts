/**
 * Money that Stripe collected onto an invoice that cannot keep it is flagged,
 * never left sitting on the invoice unannounced.
 *
 * RED IF: `refundDue` is missing from the client-scoped or firm-wide invoice
 * payload, is non-null for an ordinary invoice, reports the wrong cents, or
 * reasons 'voided' / 'overpaid' the wrong way round; a Stripe payment on a
 * voided or already-settled invoice stops notifying the firm's invoice managers
 * (or notifies a member without billing.manageInvoices, or notifies twice for
 * one payment); an ordinary payment raises a refund-due notification; a payment
 * on a voided invoice sends the client the standard receipt (or the neutral
 * notice is not sent, goes to the wrong address, or says "paid in full" or
 * carries a link); an overpayment loses its standard receipt.
 *
 * The Stripe SDK refuses every call, so a payment that triggers a lookup fails
 * loudly. Payments arrive as genuinely signed webhooks through the real route.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => require('./edge/lifecycleStripeKit').refuseAllStripe());

import {
  testPool,
  drainEvents,
  sentEmails,
  resetEmails,
  memberWith,
  type Actor,
} from '../support/setupInProcess';
import { seedWorld, type World } from './edge/lifecycleKit';
import { stripeHarness } from './edge/lifecycleStripeKit';
import { deliverSigned, stripeEventPayload, newPaymentIntentId } from '../support/stripeWebhook';

const SECRET = 'whsec_invoice_refund_due_secret';
const PAYER = 'lifecycle-client@example.test';

let w: World;
let h: ReturnType<typeof stripeHarness>;
let manager: Actor;
let viewerOnly: Actor;
let errorSpy: jest.SpyInstance;

beforeAll(() => {
  h = stripeHarness(() => w, SECRET);
  h.install();
});

beforeEach(async () => {
  w = await seedWorld(100_000);
  manager = await memberWith(w.firm.id, ['billing.manageInvoices', 'billing.viewInvoices']);
  viewerOnly = await memberWith(w.firm.id, ['billing.viewInvoices']);
  resetEmails();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

const voidInvoice = async () => expect((await w.owner.api.post(`${w.inv}/void`).send({})).status).toBe(200);

async function clientListEntry() {
  const res = await w.owner.api.get(`${w.base}`);
  expect(res.status).toBe(200);
  return res.body.invoices.find((i: any) => i.id === w.invoiceId);
}

async function firmListEntry() {
  const res = await w.owner.api.get(`/api/lawfirms/${w.firm.id}/billing/invoices/firm?limit=50`);
  expect(res.status).toBe(200);
  return res.body.invoices.find((i: any) => i.id === w.invoiceId);
}

async function refundDueNotifications() {
  const { rows } = await testPool.query(
    `select user_id, title, body, action_url, entity_id
       from notifications where law_firm_id = $1 and type = 'payment_refund_due' order by user_id`,
    [w.firm.id],
  );
  return rows;
}

const toPayer = () => sentEmails().filter((m) => [m.to].flat().includes(PAYER));

describe('refundDue on the invoice payload', () => {
  it('is null for an unpaid invoice and for one paid part-way, in both list shapes', async () => {
    expect((await clientListEntry()).refundDue).toBeNull();
    expect((await firmListEntry()).refundDue).toBeNull();

    await h.stripePaid(40_000);

    expect((await clientListEntry()).refundDue).toBeNull();
    expect((await firmListEntry()).refundDue).toBeNull();
  });

  it('is null for an invoice paid exactly to its total', async () => {
    await h.stripePaid(100_000);

    expect((await clientListEntry()).refundDue).toBeNull();
    expect((await firmListEntry()).refundDue).toBeNull();
  });

  it('is null for a voided invoice that never took a payment', async () => {
    await voidInvoice();

    expect((await clientListEntry()).refundDue).toBeNull();
  });

  it('is voided with the late payment amount, as exact dollars from cents', async () => {
    await voidInvoice();
    await h.stripePaid(12_345);

    const expected = { amount: 12_345 / 100, reason: 'voided' };
    expect(await clientListEntry()).toMatchObject({ status: 'voided', amountPaid: 123.45, refundDue: expected });
    expect((await firmListEntry()).refundDue).toEqual(expected);
  });

  it('is overpaid with the excess when Stripe lands on an invoice a manual payment settled', async () => {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 1000 })).status).toBe(200);
    expect((await clientListEntry()).refundDue).toBeNull();

    await h.stripePaid(12_345);

    // 100,000 + 12,345 collected against a 100,000 total: 12,345 cents excess.
    const expected = { amount: 123.45, reason: 'overpaid' };
    expect((await clientListEntry()).refundDue).toEqual(expected);
    expect((await firmListEntry()).refundDue).toEqual(expected);
  });
});

describe('the refund-due notification', () => {
  it('goes to the owner and invoice managers once per late payment on a voided invoice', async () => {
    await voidInvoice();

    await h.stripePaid(12_345);

    const rows = await refundDueNotifications();
    expect(rows.map((r: any) => r.user_id).sort()).toEqual([w.owner.uid, manager.uid].sort());
    expect(rows[0]).toMatchObject({ title: 'Refund due', entity_id: w.invoiceId });
    expect(rows[0].body).toContain('$123.45');
    expect(rows[0].body).toMatch(/received after the invoice was voided/);
    expect(rows[0].action_url).toContain(`/lawfirm/${w.firm.id}/clients/${w.clientId}/invoices/${w.invoiceId}`);
  });

  it('excludes a non-owner member without billing.manageInvoices', async () => {
    await voidInvoice();

    await h.stripePaid(12_345);

    expect((await refundDueNotifications()).map((r: any) => r.user_id)).not.toContain(viewerOnly.uid);
  });

  it('says the payment exceeds the invoice total when it overpays', async () => {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 1000 })).status).toBe(200);

    await h.stripePaid(12_345);

    const rows = await refundDueNotifications();
    expect(rows.map((r: any) => r.user_id).sort()).toEqual([w.owner.uid, manager.uid].sort());
    expect(rows[0].body).toContain('$123.45');
    expect(rows[0].body).toMatch(/exceeds the invoice total/);
  });

  it('is created once when the same webhook event is delivered twice', async () => {
    await voidInvoice();
    const pi = newPaymentIntentId();
    const object = h.checkout(12_345, pi);
    const id = 'evt_refund_due_twice';

    const first = await deliverSigned(stripeEventPayload(id, 'checkout.session.completed', object), SECRET);
    const second = await deliverSigned(stripeEventPayload(id, 'checkout.session.completed', object), SECRET);
    await drainEvents();

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await refundDueNotifications()).toHaveLength(2);
  });

  it('is created once when the same payment arrives under a second event id', async () => {
    await voidInvoice();
    const pi = newPaymentIntentId();

    await h.send('checkout.session.completed', h.checkout(12_345, pi));
    await h.send('checkout.session.completed', h.checkout(12_345, pi));

    expect(await refundDueNotifications()).toHaveLength(2);
  });

  it('is raised separately for each distinct payment', async () => {
    await voidInvoice();

    await h.stripePaid(12_345);
    await h.stripePaid(5_000);

    expect(await refundDueNotifications()).toHaveLength(4);
  });

  it('is not raised for an ordinary payment, partial or full', async () => {
    await h.stripePaid(40_000);
    await h.stripePaid(60_000);

    expect(await refundDueNotifications()).toHaveLength(0);
  });
});

describe('the client email for a Stripe payment', () => {
  it('sends the standard receipt for a payment on a live invoice', async () => {
    await h.stripePaid(40_000);

    const mails = toPayer();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^Payment received: Invoice/);
    expect(mails[0].text).toContain('received your payment of $400.00');
  });

  it('sends one neutral notice, not the receipt, when the invoice was voided', async () => {
    await voidInvoice();

    await h.stripePaid(12_345);

    const mails = toPayer();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('We received your payment');
    expect(mails[0].text).toContain('$123.45');
    expect(mails[0].text).toMatch(/no longer payable/);
    expect(mails[0].text).toMatch(/will contact you about the funds/);
    expect(mails[0].text).not.toMatch(/paid in full|remaining balance|thank you for your payment/i);
    // Beyond the compliance footer, nothing in the message points at a payment.
    expect((mails[0].text ?? '').split('\n---')[0]).not.toMatch(/https?:\/\//);
    expect(mails[0].html).not.toMatch(/href="[^"]*(pay|checkout|stripe|invoice)/i);
    expect(toPayer().filter((m) => /^Payment received: Invoice/.test(m.subject))).toHaveLength(0);
  });

  it('keeps the standard receipt for an overpayment', async () => {
    expect((await w.owner.api.put(`${w.inv}/payment`).send({ paymentAmount: 1000 })).status).toBe(200);
    await drainEvents();
    resetEmails();

    await h.stripePaid(12_345);

    const mails = toPayer();
    expect(mails.map((m) => m.subject)).toEqual([expect.stringMatching(/^Payment received: Invoice/)]);
    expect(mails[0].text).toContain('$123.45');
  });
});
