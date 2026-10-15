/**
 * The offline Stripe reconciler writes under the invoice row lock.
 *
 * It reads every Stripe-backed invoice, asks Stripe about its checkout session
 * (slow, a network call per invoice), then repairs the invoice. Computing the
 * repair from the invoice it read BEFORE the Stripe call and writing it back
 * blind overwrites anything that landed in between, such as a manual payment
 * recorded while it waited. The repair has to be recomputed from the row as it
 * stands under the lock, the way the webhook path applies a payment.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    customers: { retrieve: fn() },
    invoices: { create: fn(), retrieve: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { retrieve: fn() },
  };
});

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  drainEvents,
} from '../support/setupInProcess';

const stripeService = require('../../src/modules/stripe/stripe.service');
const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

const SESSION = 'cs_reconcile_paid';

it('keeps a manual payment recorded while it was reading Stripe', async () => {
  const firm = await createFirm();
  const owner = await ownerOf(firm.id);
  const clientId = (await createPersonClient(firm.id, { email: 'reconcile@example.test' })).id;
  const invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 25_000 })).id;
  const linked = await testPool.query(
    `update invoices set stripe_checkout_session_id = $2, stripe_checkout_session_account_id = 'platform',
            stripe_payment_requested = true, stripe_payment_status = 'pending', pay_link_token = $3
      where id = $1`, [invoiceId, SESSION, `tok_${invoiceId}`]);
  expect(linked.rowCount).toBe(1);

  // Stripe says the client paid $150 through the session. While the reconciler
  // waits on that answer, the firm records a $100 cheque.
  const paidSession = {
    id: SESSION, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
    amount_total: 15_000, payment_intent: 'pi_reconcile_paid', created: Math.floor(Date.now() / 1000),
    metadata: { lawFirmId: firm.id, invoiceId, contextType: 'client', entityId: clientId },
  };
  let recordedDuringRead = false;
  fakeStripe().checkout.sessions.retrieve.mockImplementation(async () => {
    if (!recordedDuringRead) {
      recordedDuringRead = true;
      const manual = await owner.api
        .put(`/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/payment`)
        .send({ paymentAmount: 100 });
      expect(manual.status).toBe(200);
    }
    return paidSession;
  });

  const summary = await stripeService.reconcileStripeInvoices({ dryRun: false });
  await drainEvents();

  expect(recordedDuringRead).toBe(true);
  expect(summary).toMatchObject({ repaired: 1, failures: [] });
  const { rows } = await testPool.query(
    `select amount_cents, payment_source from invoice_payments where invoice_id = $1 order by sort_order`, [invoiceId]);
  expect(rows.map((r: any) => [Number(r.amount_cents), r.payment_source]).sort()).toEqual([
    // A manual payment carries no source; only a Stripe one is tagged.
    [10_000, null],
    [15_000, 'stripe'],
  ]);
  const invoice = await testPool.query('select amount_paid_cents, is_paid from invoices where id = $1', [invoiceId]);
  expect(invoice.rows[0]).toEqual({ amount_paid_cents: '25000', is_paid: true });
});
