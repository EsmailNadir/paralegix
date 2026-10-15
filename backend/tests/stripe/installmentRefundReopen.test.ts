/**
 * A full refund of a Stripe payment reopens every installment that payment
 * settled, and the open schedule adds back up to the balance.
 *
 * One Stripe payment can settle more than the installment its link named: the
 * money runs on across the open rows, settling some and shrinking the next. A
 * refund of the whole payment has to undo all of that. Reopening only the first
 * row leaves the others marked paid by a payment that is now worth nothing, and
 * the open rows no longer add up to what the client owes.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn() },
    transfers: { createReversal: fn() },
  };
});

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { stripeWebhookSender } from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_installment_refund_reopen_spec';
const sender = stripeWebhookSender(WEBHOOK_SECRET);

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;

async function installments() {
  const { rows } = await testPool.query(
    `select amount_cents, status, matched_payment_index
       from invoice_expected_payments where invoice_id = $1 order by sort_order`, [invoiceId]);
  return rows.map((r: any) => ({ cents: Number(r.amount_cents), status: r.status, matched: r.matched_payment_index }));
}

async function balanceDue() {
  const { rows } = await testPool.query('select balance_due_cents from invoices where id = $1', [invoiceId]);
  return Number(rows[0].balance_due_cents);
}

/** A pay-link checkout naming installment 0 that collected `cents`. */
async function stripePaysFromFirstInstallment(cents: number, intent: string) {
  const { rows } = await testPool.query(
    `select installment_id from invoice_expected_payments where invoice_id = $1 and sort_order = 0`, [invoiceId]);
  await sender.deliver('checkout.session.completed', {
    id: `cs_spread_${intent}`, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
    amount_total: cents, created: Math.floor(Date.now() / 1000), payment_intent: intent,
    metadata: {
      lawFirmId: firm.id, invoiceId, contextType: 'client', entityId: client.id, clientId: client.id,
      paymentMethod: 'card', invoiceAmountCents: String(cents), surchargeCents: '0',
      installmentId: rows[0].installment_id,
    },
  });
}

beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET; });

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Spread Client', email: 'spread@example.test' });
  const created = await owner.api.post(B()).send({
    invoiceName: 'Spread Invoice', invoiceDate: '2026-03-01', dueDate: '2026-04-01',
    totalAmount: 1200, flatFeesAmount: 1200, flatFees: [{ description: 'Fixed fee', amount: 1200 }],
  });
  expect(created.status).toBe(201);
  invoiceId = created.body.invoice.id;
  await drainEvents();
  const plan = await owner.api.post(onInvoice('/payment-plan')).send({
    installmentAmount: 300, frequencyDays: 30, planStartDate: '2026-04-01',
  });
  expect(plan.status).toBe(200);
});

it('reopens every installment a fully refunded payment settled, and the open rows sum to the balance', async () => {
  await stripePaysFromFirstInstallment(75_000, 'pi_spread');
  // Premise: $750 settled the first two $300 rows and took $150 off the third.
  expect(await installments()).toEqual([
    { cents: 30_000, status: 'paid', matched: 0 },
    { cents: 30_000, status: 'paid', matched: 0 },
    { cents: 15_000, status: 'pending', matched: null },
    { cents: 30_000, status: 'pending', matched: null },
  ]);

  await sender.refunded('pi_spread', 75_000);

  const rows = await installments();
  expect(rows.every((r) => r.status !== 'paid')).toBe(true);
  expect(rows.every((r) => r.matched === null)).toBe(true);
  expect(await balanceDue()).toBe(120_000);
  expect(rows.reduce((sum, r) => sum + r.cents, 0)).toBe(120_000);
});

it('leaves the settled rows alone when the refund is only partial', async () => {
  await stripePaysFromFirstInstallment(75_000, 'pi_spread_partial');

  await sender.refunded('pi_spread_partial', 10_000);

  expect((await installments()).map((r) => r.status)).toEqual(['paid', 'paid', 'pending', 'pending']);
});
