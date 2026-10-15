/**
 * The client's "payment refunded / returned" email goes out only when the money
 * really went back to them.
 *
 * A refund sends it. A dispute does not when it opens: the outcome is unknown, and
 * if the firm wins the money stays with the firm, so telling the client it was
 * returned would be wrong. It goes out when the dispute closes as lost, which is
 * when the cardholder keeps the money. The firm's own in-app alert is unaffected:
 * the invoice balance reopens the moment the dispute takes the funds.
 *
 * Recovery is off (the suite default), so no Stripe call is possible.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const refuse = (name: string) => () => {
    throw new Error(`stripe.${name} was called; this spec must not reach the Stripe API`);
  };
  return {
    webhooks: require('stripe').webhooks,
    invoices: { create: refuse('invoices.create'), retrieve: refuse('invoices.retrieve') },
    paymentIntents: { retrieve: refuse('paymentIntents.retrieve') },
    transfers: { retrieve: refuse('transfers.retrieve'), createReversal: refuse('transfers.createReversal') },
  };
});

import { testPool, createFirm, ownerOf, emailsMatching, resetEmails, type Firm } from '../support/setupInProcess';
import {
  STRIPE_INVOICE_CENTS as INVOICE_CENTS,
  newPaymentIntentId,
  seedStripePaidInvoice,
  stripeWebhookSender,
} from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_reversal_client_email_spec';
const { refunded, disputed, disputeClosed } = stripeWebhookSender(WEBHOOK_SECRET);

const refundEmails = () => emailsMatching(/^Payment refunded:/);
const returnedEmails = () => emailsMatching(/^Payment returned:/);

let firm: Firm;

beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET; });

beforeEach(async () => {
  firm = await createFirm();
  // The firm's in-app reversal alert goes to its owner.
  await ownerOf(firm.id);
  resetEmails();
});

async function firmAlerts() {
  const { rows } = await testPool.query(
    `select count(*)::int as n from notifications where law_firm_id = $1 and type = 'invoice_payment_reversed'`, [firm.id]);
  return rows[0].n;
}

it('a refund emails the client', async () => {
  const pi = newPaymentIntentId();
  await seedStripePaidInvoice(firm.id, pi);

  await refunded(pi, 10_000);

  expect(refundEmails().map((e) => e.to)).toEqual([['payer@example.test']]);
});

it('an opened dispute emails no one outside the firm, though the firm is alerted', async () => {
  const pi = newPaymentIntentId();
  await seedStripePaidInvoice(firm.id, pi);

  await disputed(pi, INVOICE_CENTS);

  expect(await firmAlerts()).toBe(1);
  expect(refundEmails()).toEqual([]);
  expect(returnedEmails()).toEqual([]);
});

it('a dispute closed as lost tells the client the payment was returned', async () => {
  const pi = newPaymentIntentId();
  await seedStripePaidInvoice(firm.id, pi);
  await disputed(pi, INVOICE_CENTS);
  expect(returnedEmails()).toEqual([]);

  await disputeClosed(pi, INVOICE_CENTS, 'lost');

  expect(returnedEmails().map((e) => [e.to, e.subject])).toEqual([
    [['payer@example.test'], expect.stringContaining('($250.00)')],
  ]);
  expect(refundEmails()).toEqual([]);
});

it('a dispute the firm won emails the client nothing', async () => {
  const pi = newPaymentIntentId();
  await seedStripePaidInvoice(firm.id, pi);
  await disputed(pi, INVOICE_CENTS);

  await disputeClosed(pi, INVOICE_CENTS, 'won');

  expect(refundEmails()).toEqual([]);
  expect(returnedEmails()).toEqual([]);
});
