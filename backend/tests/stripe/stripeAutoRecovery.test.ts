/**
 * Automatic cash recovery, switched ON: when Stripe debits the platform for a
 * refund or dispute on a destination charge, the platform takes the money back
 * from the connected account, and gives it back when the dispute is won.
 *
 * This is money moving between the platform, a firm's operating account and a
 * firm's trust account, so every case asserts the exact call made to Stripe:
 * which transfer, how many cents, to which account, under which idempotency key.
 * A wrong amount here is a real over- or under-collection from a law firm.
 *
 * `tests/support/db.ts` forces `STRIPE_AUTO_RECOVERY_ENABLED` off for the suite.
 * This file turns it back on after importing the harness and before the first
 * request loads the app, because `stripe.service.ts` reads it into a const at
 * load. `stripeReversalWebhooks.test.ts` covers the same events with it off.
 */

const mockStripe = {
  paymentIntents: { retrieve: jest.fn(), create: jest.fn(), search: jest.fn() },
  refunds: { create: jest.fn() },
  transfers: { retrieve: jest.fn(), create: jest.fn(), createReversal: jest.fn() },
  customers: { retrieve: jest.fn() },
};

jest.mock('../../src/modules/stripe/stripe.config', () => ({
  // The one real Stripe surface: an HMAC compare with no network.
  webhooks: require('stripe').webhooks,
  paymentIntents: mockStripe.paymentIntents,
  transfers: mockStripe.transfers,
  customers: mockStripe.customers,
  refunds: mockStripe.refunds,
}));

import { testPool, createFirm, type Firm } from '../support/setupInProcess';

// After the harness (which forces it off), before the app loads.
process.env.STRIPE_AUTO_RECOVERY_ENABLED = 'true';

import {
  STRIPE_DEPOSIT_CENTS as DEPOSIT_CENTS,
  STRIPE_INVOICE_CENTS as INVOICE_CENTS,
  newPaymentIntentId,
  seedStripePaidInvoice,
  seedStripeTrustDeposit,
  stripeInvoiceMoney,
  stripeWebhookSender,
  trustBookBalance,
} from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_auto_recovery_spec_secret';
const { refunded, disputed, disputeClosed, refundUpdated } = stripeWebhookSender(WEBHOOK_SECRET);

const FIRM_ACCOUNT = 'acct_firm_operating_fixture';
const FIRM_CUSTOMER = 'cus_firm_fixture';
const FIRM_CARD = 'pm_firm_card_fixture';
const TRUST_ACCOUNT = 'acct_trust_fixture';

/**
 * Point the payment intent at a destination transfer of `amount` cents, of which
 * `reversed` has already been taken back. Recovery reverses at most the rest.
 */
function givenTransfer(transferId: string, amount: number, reversed = 0) {
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ latest_charge: { transfer: transferId } });
  mockStripe.transfers.retrieve.mockResolvedValue({ id: transferId, amount, amount_reversed: reversed });
}

let firm: Firm;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockStripe.transfers.createReversal.mockResolvedValue({ id: 'trr_fixture' });
  mockStripe.transfers.create.mockResolvedValue({ id: 'tr_restore_fixture' });
  mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_clawback_fixture', status: 'succeeded' });
  mockStripe.customers.retrieve.mockResolvedValue({ id: FIRM_CUSTOMER, invoice_settings: { default_payment_method: FIRM_CARD } });
  // No earlier charge to the firm's card unless a case says otherwise.
  mockStripe.paymentIntents.search.mockResolvedValue({ data: [] });
  mockStripe.refunds.create.mockResolvedValue({ id: 're_fixture' });

  firm = await createFirm();
  await testPool.query(
    `update law_firms
        set stripe_account_id = $2,
            plan = coalesce(plan, '{}'::jsonb) || jsonb_build_object('stripeCustomerId', $3::text)
      where id = $1`,
    [firm.id, FIRM_ACCOUNT, FIRM_CUSTOMER],
  );
});

describe('recovery is switched on for this file', () => {
  it('reads the flag the service captured at load', () => {
    expect(process.env.STRIPE_AUTO_RECOVERY_ENABLED).toBe('true');
  });
});

describe('an invoice payment is refunded or disputed', () => {
  it('reverses the refunded cents out of the firm\'s transfer', async () => {
    const pi = newPaymentIntentId();
    await seedStripePaidInvoice(firm.id, pi);
    givenTransfer('tr_invoice', 24_000);

    await refunded(pi, 10_000);

    expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith(pi, { expand: ['latest_charge'] });
    expect(mockStripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_invoice',
      { amount: 10_000, metadata: { paymentIntentId: pi, reason: 'invoice refund' } },
      undefined,
    );
  });

  it('never reverses more than is left on the transfer', async () => {
    const pi = newPaymentIntentId();
    await seedStripePaidInvoice(firm.id, pi);
    // A $240 transfer (the $250 charge less the application fee), $200 already taken back.
    givenTransfer('tr_invoice', 24_000, 20_000);

    await refunded(pi, INVOICE_CENTS);

    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_invoice', expect.objectContaining({ amount: 4_000 }), undefined,
    );
  });

  it('takes back the client-paid fee too when the whole charge is refunded', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    // The client paid a $10.19 card fee on top of the $250.00 invoice.
    await testPool.query('update invoice_payments set surcharge_cents = 1019 where invoice_id = $1', [invoiceId]);
    givenTransfer('tr_invoice', 30_000);

    await refunded(pi, INVOICE_CENTS + 1_019);

    // Stripe debited the platform the whole $260.19. Breaks if only the
    // invoice part is recovered and the fee is left with the firm.
    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_invoice', expect.objectContaining({ amount: INVOICE_CENTS + 1_019 }), undefined,
    );
  });

  it('leaves the client-paid fee alone on a partial refund of invoice money', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await testPool.query('update invoice_payments set surcharge_cents = 1019 where invoice_id = $1', [invoiceId]);
    givenTransfer('tr_invoice', 30_000);

    await refunded(pi, 10_000);

    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_invoice', expect.objectContaining({ amount: 10_000 }), undefined,
    );
  });

  it('pays the firm back in full when the dispute is won', async () => {
    const pi = newPaymentIntentId();
    await seedStripePaidInvoice(firm.id, pi);
    givenTransfer('tr_invoice', 24_000);
    await disputed(pi, INVOICE_CENTS);

    await disputeClosed(pi, INVOICE_CENTS, 'won');

    expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
    // The $240.00 the dispute took back from the firm's transfer, not the $250.00
    // charge: the other $10.00 was the application fee, which the firm never had.
    expect(mockStripe.transfers.create).toHaveBeenCalledWith({
      amount: 24_000,
      currency: 'usd',
      destination: FIRM_ACCOUNT,
      metadata: { paymentIntentId: pi, reason: 'invoice restore' },
    }, { idempotencyKey: 'restore_trr_fixture_0_24000' });
  });

  it('still reverses the invoice when Stripe refuses the transfer reversal', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    givenTransfer('tr_invoice', 24_000);
    mockStripe.transfers.createReversal.mockRejectedValue(new Error('insufficient connected balance'));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await refunded(pi, INVOICE_CENTS);
    } finally {
      logged.mockRestore();
    }

    // Recovery is best-effort: the webhook still answered 200 and the books still moved.
    expect(mockStripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(await stripeInvoiceMoney(invoiceId)).toEqual({
      amountPaid: 0, isPaid: false, paymentCents: 0, refundedCents: INVOICE_CENTS,
    });
  });
});

describe('an ACH trust deposit is refunded or disputed', () => {
  it('reverses the whole deposit out of the trust transfer and charges the firm nothing', async () => {
    const pi = newPaymentIntentId();
    await seedStripeTrustDeposit(firm.id, pi);
    // Trust deposits carry no application fee, so the transfer is the full deposit.
    givenTransfer('tr_trust', DEPOSIT_CENTS);

    await refunded(pi, DEPOSIT_CENTS);

    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_trust',
      { amount: DEPOSIT_CENTS, metadata: { paymentIntentId: pi, reason: 'trust ACH return / refund' } },
      { idempotencyKey: `trust-recover-${pi}-${DEPOSIT_CENTS}` },
    );
    expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('charges the firm\'s operating card for what the trust transfer can no longer cover', async () => {
    const pi = newPaymentIntentId();
    await seedStripeTrustDeposit(firm.id, pi);
    // $255 of the $555 transfer was already reversed, so only $300 is left to
    // reverse. `amount_reversed` says nothing about whether THIS client's money is
    // still in the trust account's balance (that balance pools every client's
    // deposits); only the ledger knows that, which is why a transfer reversal runs
    // only after the ledger reversal succeeded. The ledger reverses here: the
    // client spent nothing.
    givenTransfer('tr_trust', DEPOSIT_CENTS, 25_500);

    await disputed(pi, DEPOSIT_CENTS);

    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_trust', expect.objectContaining({ amount: 30_000 }), { idempotencyKey: `trust-recover-${pi}-${DEPOSIT_CENTS}` },
    );
    expect(mockStripe.customers.retrieve).toHaveBeenCalledWith(FIRM_CUSTOMER);
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 25_500,
        currency: 'usd',
        customer: FIRM_CUSTOMER,
        payment_method: FIRM_CARD,
        off_session: true,
        confirm: true,
      }),
      { idempotencyKey: `trust_clawback_${pi}_${DEPOSIT_CENTS}` },
    );
  });

  it('recovers each partial refund once, keyed by its cumulative total', async () => {
    const pi = newPaymentIntentId();
    await seedStripeTrustDeposit(firm.id, pi);
    givenTransfer('tr_trust', DEPOSIT_CENTS);

    await refunded(pi, 20_000);
    await refunded(pi, 20_000); // replay: nothing new to recover
    await refunded(pi, 35_000);

    expect(mockStripe.transfers.createReversal.mock.calls.map((c) => [c[1].amount, c[2].idempotencyKey])).toEqual([
      [20_000, `trust-recover-${pi}-20000`],
      [15_000, `trust-recover-${pi}-35000`],
    ]);
  });

  it('puts the cash back in the trust account when the dispute is won', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    givenTransfer('tr_trust', DEPOSIT_CENTS);
    await disputed(pi, DEPOSIT_CENTS);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await disputeClosed(pi, DEPOSIT_CENTS, 'won');
    } finally {
      logged.mockRestore();
    }

    expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
    expect(mockStripe.transfers.create).toHaveBeenCalledWith({
      amount: DEPOSIT_CENTS,
      currency: 'usd',
      destination: TRUST_ACCOUNT,
      metadata: { paymentIntentId: pi, reason: 'trust restore dispute won' },
    }, { idempotencyKey: `restore_trr_fixture_0_${DEPOSIT_CENTS}` });
    expect(await trustBookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });
  it('refunds the firm\'s card first when a won dispute returns a deposit it had to cover', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    // Only $300 of the $555 transfer was left to reverse, so the dispute took $300
    // from the trust transfer and charged the firm's card the other $255.
    givenTransfer('tr_trust', DEPOSIT_CENTS, 25_500);
    await disputed(pi, DEPOSIT_CENTS);
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 25_500 }), expect.anything(),
    );

    await disputeClosed(pi, DEPOSIT_CENTS, 'won');

    // The charge to refund is the one recovery recorded making, not a Stripe search.
    expect(mockStripe.paymentIntents.search).not.toHaveBeenCalled();
    // The firm gets its $255 back ...
    expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_clawback_fixture', amount: 25_500, metadata: { trustClawbackPaymentIntentId: pi } },
      { idempotencyKey: `trust_clawback_refund_pi_clawback_fixture_0_25500` },
    );
    // ... and the trust account gets back only what was taken out of it.
    expect(mockStripe.transfers.create).toHaveBeenCalledTimes(1);
    expect(mockStripe.transfers.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 30_000, destination: TRUST_ACCOUNT,
    }), { idempotencyKey: 'restore_trr_fixture_0_30000' });
    expect(await trustBookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });
});


describe('client-paid fee recovery sequences', () => {
  async function surchargedPayment() {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await testPool.query('update invoice_payments set surcharge_cents = 1019 where invoice_id = $1', [invoiceId]);
    givenTransfer('tr_fee', INVOICE_CENTS + 1019);
    return { pi, invoiceId };
  }

  it('recovers a fee refunded after all invoice money, once across replays', async () => {
    const { pi, invoiceId } = await surchargedPayment();
    await refunded(pi, INVOICE_CENTS);
    await refunded(pi, INVOICE_CENTS + 500);
    await refunded(pi, INVOICE_CENTS + 500);
    await refunded(pi, INVOICE_CENTS + 1019);
    await refunded(pi, INVOICE_CENTS);
    expect(mockStripe.transfers.createReversal.mock.calls.map((c) => c[1].amount)).toEqual([INVOICE_CENTS, 500, 519]);
    expect(await stripeInvoiceMoney(invoiceId)).toEqual({ amountPaid: 0, isPaid: false, paymentCents: 0, refundedCents: INVOICE_CENTS });
  });

  it('restores principal and fee after a won dispute without crediting the fee to the invoice', async () => {
    const { pi, invoiceId } = await surchargedPayment();
    await disputed(pi, INVOICE_CENTS + 1019);
    await disputeClosed(pi, INVOICE_CENTS + 1019, 'won');
    await disputeClosed(pi, INVOICE_CENTS + 1019, 'won');
    expect(mockStripe.transfers.createReversal.mock.calls.map((c) => c[1].amount)).toEqual([INVOICE_CENTS + 1019]);
    expect(mockStripe.transfers.create.mock.calls.map((c) => c[0].amount)).toEqual([INVOICE_CENTS + 1019]);
    expect(await stripeInvoiceMoney(invoiceId)).toEqual({ amountPaid: INVOICE_CENTS, isPaid: true, paymentCents: INVOICE_CENTS, refundedCents: 0 });
  });

  it('restores the fee when a full refund fails', async () => {
    const { pi, invoiceId } = await surchargedPayment();
    await refunded(pi, INVOICE_CENTS + 1019);
    await refundUpdated(pi, INVOICE_CENTS + 1019, 'failed');
    expect(mockStripe.transfers.create.mock.calls.map((c) => c[0].amount)).toEqual([INVOICE_CENTS + 1019]);
    expect((await stripeInvoiceMoney(invoiceId)).amountPaid).toBe(INVOICE_CENTS);
  });

  it('restores only the fee when a separately issued fee refund fails', async () => {
    const { pi, invoiceId } = await surchargedPayment();
    await refunded(pi, INVOICE_CENTS);
    await refunded(pi, INVOICE_CENTS + 1019);
    await refundUpdated(pi, 1019, 'failed');
    expect(mockStripe.transfers.create.mock.calls.map((c) => c[0].amount)).toEqual([1019]);
    expect((await stripeInvoiceMoney(invoiceId)).amountPaid).toBe(0);
  });
});
