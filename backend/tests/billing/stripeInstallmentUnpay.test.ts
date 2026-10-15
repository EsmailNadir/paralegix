/**
 * An installment Stripe settled cannot be un-paid by hand.
 *
 * Un-paying an installment removes the payment it is matched to. When Stripe
 * collected that payment, the row carries the payment intent id that the
 * refund and dispute handlers look up; removing it means a later refund at
 * Stripe returns the money while this invoice still shows it collected. The
 * refusal is per payment: a manually recorded installment payment on the same
 * plan is still reversible, as it always was.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale.
 * The Stripe settlement is a pay-link checkout session for one installment,
 * delivered through the real signed webhook, so the payment row is the one
 * production writes, not a hand-built copy.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    invoiceItems: { create: fn() },
    customers: { create: fn(), list: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn(), list: fn() },
    transfers: { createReversal: fn() },
    accounts: { retrieve: fn() },
  };
});

import {
  testPool,
  drainEvents,
  createFirm,
  createPersonClient,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
  type ClientRecord,
} from '../support/setupInProcess';
import { stripeWebhookSender } from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_stripe_installment_unpay_spec';
const REFUSAL =
  'This payment was collected through Stripe and cannot be removed here. Refund it in Stripe, '
  + 'which reverses it on this invoice.';

let firm: Firm;
let owner: Actor;
let client: ClientRecord;
let invoiceId: string;

const B = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${client.id}`;
const onInvoice = (suffix = '') => `${B()}/${invoiceId}${suffix}`;
const unpay = (actor: Actor, index: number) =>
  actor.api.delete(onInvoice(`/payment-plan/installment/${index}/payment`));

async function money() {
  const { rows } = await testPool.query(
    'select amount_paid_cents, balance_due_cents from invoices where id = $1', [invoiceId]);
  return { paid: Number(rows[0].amount_paid_cents), balance: Number(rows[0].balance_due_cents) };
}

async function payments() {
  const { rows } = await testPool.query(
    `select amount_cents, payment_source, stripe_payment_intent_id
       from invoice_payments where invoice_id = $1 order by sort_order`, [invoiceId]);
  return rows.map((r: any) => ({ cents: Number(r.amount_cents), source: r.payment_source, intent: r.stripe_payment_intent_id }));
}

async function installments() {
  const { rows } = await testPool.query(
    `select amount_cents, status, matched_payment_index
       from invoice_expected_payments where invoice_id = $1 order by sort_order`, [invoiceId]);
  return rows.map((r: any) => ({ cents: Number(r.amount_cents), status: r.status, matched: r.matched_payment_index }));
}

/**
 * What Stripe sends when the client pays installment `index` through a pay-link
 * checkout session that names it by its stable installment id.
 */
async function stripeSettlesInstallment(index: number, intent: string) {
  const { rows } = await testPool.query(
    `select installment_id from invoice_expected_payments where invoice_id = $1 and sort_order = $2`,
    [invoiceId, index]);
  expect(rows).toHaveLength(1);
  await stripeWebhookSender(WEBHOOK_SECRET).deliver('checkout.session.completed', {
    id: `cs_inst_${index}_${intent}`, object: 'checkout.session', status: 'complete', payment_status: 'paid',
    amount_total: 30_000,
    created: Math.floor(Date.now() / 1000),
    payment_intent: intent,
    metadata: {
      lawFirmId: firm.id, invoiceId, contextType: 'client', entityId: client.id, clientId: client.id,
      paymentMethod: 'card', invoiceAmountCents: '30000', surchargeCents: '0',
      installmentId: rows[0].installment_id,
    },
  });
}

beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET; });

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  client = await createPersonClient(firm.id, { name: 'Plan Client', email: 'plan@example.test' });
  const created = await owner.api.post(B()).send({
    invoiceName: 'Plan Invoice', invoiceDate: '2026-03-01', dueDate: '2026-04-01',
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

/** RED IF unpayInstallment does not check the matched payment's source: 200, and the Stripe row is gone. */
it('refuses to un-pay an installment Stripe settled, and keeps the payment where a refund will find it', async () => {
  await stripeSettlesInstallment(0, 'pi_inst_0');
  // Premise: the webhook settled installment 0 against a Stripe payment.
  expect(await payments()).toEqual([{ cents: 30_000, source: 'stripe', intent: 'pi_inst_0' }]);
  expect((await installments())[0]).toEqual({ cents: 30_000, status: 'paid', matched: 0 });

  const res = await unpay(owner, 0);

  expect(res.status).toBe(409);
  expect(res.body.error).toBe(REFUSAL);
  expect(await payments()).toEqual([{ cents: 30_000, source: 'stripe', intent: 'pi_inst_0' }]);
  expect((await installments())[0]).toEqual({ cents: 30_000, status: 'paid', matched: 0 });
  expect(await money()).toEqual({ paid: 30_000, balance: 90_000 });
});

/** RED IF the refusal is per invoice (any Stripe payment blocks every un-pay) rather than per payment. */
it('still un-pays a manually paid installment on the same plan', async () => {
  await stripeSettlesInstallment(0, 'pi_inst_mixed');
  const manual = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 300, installmentIndex: 1 });
  expect(manual.status).toBe(200);
  expect(await money()).toEqual({ paid: 60_000, balance: 60_000 });

  const res = await unpay(owner, 1);

  expect(res.status).toBe(200);
  expect(await payments()).toEqual([{ cents: 30_000, source: 'stripe', intent: 'pi_inst_mixed' }]);
  expect((await installments()).map((i) => i.status)).toEqual(['paid', 'pending', 'pending', 'pending']);
  expect(await money()).toEqual({ paid: 30_000, balance: 90_000 });
});

/** RED IF the route's billing.manageInvoices gate is lost while adding the refusal. */
it('answers a member without billing.manageInvoices with 403 and changes nothing', async () => {
  await stripeSettlesInstallment(0, 'pi_inst_gate');
  const reader = await memberWith(firm.id, ['billing.viewInvoices', 'clients.view']);

  const res = await unpay(reader, 0);

  expect(res.status).toBe(403);
  expect(await payments()).toEqual([{ cents: 30_000, source: 'stripe', intent: 'pi_inst_gate' }]);
});
