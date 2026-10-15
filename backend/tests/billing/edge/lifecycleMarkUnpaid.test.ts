/**
 * "Mark unpaid" resets an invoice's payment history. It may only remove money the
 * firm recorded itself: a payment Stripe collected has a refund or dispute that
 * can still arrive, and those handlers find it by its payment intent id.
 */
jest.mock('../../../src/modules/stripe/stripe.config', () => require('./lifecycleStripeKit').refuseAllStripe());

import { createTrustDeposit, testPool } from '../../support/setupInProcess';
import { seedWorld, invoiceRow, paymentRows, assertInvoiceInvariants, type World } from './lifecycleKit';
import { stripeHarness } from './lifecycleStripeKit';

let w: World;
const stripe = stripeHarness(() => w);
beforeAll(stripe.install);
beforeEach(async () => { w = await seedWorld(100_000); });
const pay = (b: any) => w.owner.api.put(`${w.inv}/payment`).send(b);

describe('mark unpaid on an invoice that holds a Stripe payment', () => {
  it('is refused with 409 and the Stripe payment stays where a refund finds it', async () => {
    const pi = await stripe.stripePaid(40_000);

    const res = await pay({ isPaid: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/collected through Stripe/i);
    const payments = await paymentRows(w.invoiceId);
    expect(payments.filter((p: any) => p.stripe_payment_intent_id === pi)).toHaveLength(1);
    expect(Number((await invoiceRow(w.invoiceId)).amount_paid_cents)).toBe(40_000);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('refuses without removing the manual payment recorded beside the Stripe one', async () => {
    expect((await pay({ paymentAmount: 300 })).status).toBe(200);
    await stripe.stripePaid(20_000);

    const res = await pay({ isPaid: false });

    expect(res.status).toBe(409);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([30_000, 20_000]);
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a refund that arrives after the refused reset still reverses the payment', async () => {
    const pi = await stripe.stripePaid(100_000);
    expect((await pay({ isPaid: false })).status).toBe(409);

    await stripe.sender.refunded(pi, 100_000);

    const row = await invoiceRow(w.invoiceId);
    expect(Number(row.amount_paid_cents)).toBe(0);
    expect(row.is_paid).toBe(false);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('mark unpaid on an invoice with no Stripe payment', () => {
  it('clears manual payments and the paid date', async () => {
    expect((await pay({ paymentAmount: 300 })).status).toBe(200);
    expect((await pay({ isPaid: true })).status).toBe(200);

    const res = await pay({ isPaid: false });

    expect(res.status).toBe(200);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    const { row } = await assertInvoiceInvariants(w.invoiceId);
    expect(Number(row.amount_paid_cents)).toBe(0);
    expect(row.paid_date).toBeNull();
  });

  it('clears a trust payment and reverses its withdrawal', async () => {
    const { accountId } = await createTrustDeposit(w.firm.id, w.clientId, { amountCents: 500_000 });
    expect((await pay({ paymentAmount: 400, paymentSource: 'trust', trustAccountId: accountId })).status).toBe(200);

    const res = await pay({ isPaid: false });

    expect(res.status).toBe(200);
    expect(await paymentRows(w.invoiceId)).toEqual([]);
    const { rows } = await testPool.query(
      "select count(*)::int as live from trust_transactions where type = 'withdrawal' and status = 'completed'");
    expect(rows[0].live).toBe(0);
    await assertInvoiceInvariants(w.invoiceId);
  });
});
