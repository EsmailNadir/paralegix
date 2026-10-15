/**
 * A won dispute returns only what that dispute took. Money a real refund sent
 * back to the customer stays reversed, so what an invoice can still hold after
 * the dispute closes is the charge less the refund, however the two overlapped.
 */
jest.mock('../../../src/modules/stripe/stripe.config', () => require('./lifecycleStripeKit').refuseAllStripe());

import { seedWorld, invoiceRow, paymentRows, assertInvoiceInvariants, type World } from './lifecycleKit';
import { stripeHarness } from './lifecycleStripeKit';

let w: World;
const stripe = stripeHarness(() => w);
beforeAll(stripe.install);
beforeEach(async () => { w = await seedWorld(100_000); });

async function money() {
  const row = await invoiceRow(w.invoiceId);
  const [payment] = await paymentRows(w.invoiceId);
  return { paid: Number(row.amount_paid_cents), payment: payment.cents, reversed: payment.refunded };
}

describe('a dispute won after a refund', () => {
  it('restores only the part the dispute took', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.refunded(pi, 40_000);
    await stripe.sender.disputed(pi, 60_000);
    expect(await money()).toEqual({ paid: 0, payment: 0, reversed: 100_000 });

    await stripe.sender.disputeClosed(pi, 60_000, 'won');

    expect(await money()).toEqual({ paid: 60_000, payment: 60_000, reversed: 40_000 });
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a redelivered win changes nothing further', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.refunded(pi, 40_000);
    await stripe.sender.disputed(pi, 60_000);
    await stripe.sender.disputeClosed(pi, 60_000, 'won');
    await stripe.sender.disputeClosed(pi, 60_000, 'won');

    expect(await money()).toEqual({ paid: 60_000, payment: 60_000, reversed: 40_000 });
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a dispute for the whole charge, won, leaves the refund reversed', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.refunded(pi, 40_000);
    await stripe.sender.disputed(pi, 100_000);
    expect((await money()).paid).toBe(0);

    await stripe.sender.disputeClosed(pi, 100_000, 'won');

    expect(await money()).toEqual({ paid: 60_000, payment: 60_000, reversed: 40_000 });
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a refund made after the dispute stands when the dispute is won', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.disputed(pi, 60_000);
    await stripe.sender.refunded(pi, 80_000);
    expect(await money()).toEqual({ paid: 20_000, payment: 20_000, reversed: 80_000 });

    await stripe.sender.disputeClosed(pi, 60_000, 'won');

    expect(await money()).toEqual({ paid: 80_000, payment: 80_000, reversed: 20_000 });
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a dispute that is lost leaves the reversal in place', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.refunded(pi, 40_000);
    await stripe.sender.disputed(pi, 60_000);

    await stripe.sender.disputeClosed(pi, 60_000, 'lost');

    expect(await money()).toEqual({ paid: 0, payment: 0, reversed: 100_000 });
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('a dispute won with no refund', () => {
  it('restores the whole disputed amount', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.disputed(pi, 60_000);
    expect((await money()).paid).toBe(40_000);

    await stripe.sender.disputeClosed(pi, 60_000, 'won');

    expect(await money()).toEqual({ paid: 100_000, payment: 100_000, reversed: 0 });
    await assertInvoiceInvariants(w.invoiceId);
  });
});

describe('a refund that fails after a dispute took the same money', () => {
  it('restores nothing, because the dispute still holds it', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.disputed(pi, 60_000);
    await stripe.sender.refunded(pi, 30_000);

    await stripe.sender.refundUpdated(pi, 30_000, 'failed');

    expect(await money()).toEqual({ paid: 40_000, payment: 40_000, reversed: 60_000 });
    await assertInvoiceInvariants(w.invoiceId);
  });

  it('a failed refund with no dispute restores exactly the refund', async () => {
    const pi = await stripe.stripePaid(100_000);
    await stripe.sender.refunded(pi, 30_000);

    await stripe.sender.refundUpdated(pi, 30_000, 'failed');

    expect(await money()).toEqual({ paid: 100_000, payment: 100_000, reversed: 0 });
    await assertInvoiceInvariants(w.invoiceId);
  });
});
