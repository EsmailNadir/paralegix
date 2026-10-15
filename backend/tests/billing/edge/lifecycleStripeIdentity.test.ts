/**
 * Whether a payment is a Stripe payment is decided by what the row records about
 * Stripe (its source and its Stripe ids), never by what a person typed in its note.
 */
jest.mock('../../../src/modules/stripe/stripe.config', () => require('./lifecycleStripeKit').refuseAllStripe());

import { testPool } from '../../support/setupInProcess';
import { seedWorld, paymentRows, assertInvoiceInvariants, type World } from './lifecycleKit';
import { stripeHarness } from './lifecycleStripeKit';

let w: World;
const stripe = stripeHarness(() => w);
beforeAll(stripe.install);
beforeEach(async () => { w = await seedWorld(100_000); });
const pay = (b: any) => w.owner.api.put(`${w.inv}/payment`).send(b);

describe('a manual payment whose note mentions Stripe', () => {
  it('stays a manual payment, with its recorder, when a Stripe payment lands beside it', async () => {
    expect((await pay({ paymentAmount: 300, paymentNote: 'Could not use the Stripe link, paid by check' })).status).toBe(200);

    await stripe.stripePaid(20_000);

    const payments = await paymentRows(w.invoiceId);
    expect(payments.map((p: any) => p.payment_source)).toEqual([null, 'stripe']);
    const { rows } = await testPool.query(
      'select recorded_by, note from invoice_payments where invoice_id = $1 order by sort_order', [w.invoiceId]);
    expect(rows[0].recorded_by).toBe(w.owner.uid);
    expect(rows[0].note).toBe('Could not use the Stripe link, paid by check');
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('can still be deleted after the Stripe payment landed', async () => {
    expect((await pay({ paymentAmount: 300, paymentNote: 'Stripe was down, paid by check' })).status).toBe(200);
    await stripe.stripePaid(20_000);

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);

    expect(res.status).toBe(200);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.cents)).toEqual([20_000]);
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('a payment Stripe collected', () => {
  it('is recognised by its source and cannot be deleted', async () => {
    await stripe.stripePaid(20_000);

    const res = await w.owner.api.delete(`${w.inv}/payment?paymentIndex=0`);

    expect(res.status).toBe(409);
    expect((await paymentRows(w.invoiceId)).map((p: any) => p.payment_source)).toEqual(['stripe']);
  });
});
