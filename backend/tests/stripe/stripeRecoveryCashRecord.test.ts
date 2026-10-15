/**
 * Where automatic recovery takes cash from, and that it gives back exactly that
 * cash, to exactly that place, when the money comes home.
 *
 * Recovery ON, as in `stripeAutoRecovery.test.ts`: the flag is forced off by the
 * harness and turned back on here before the app loads. Every case asserts the
 * exact Stripe call (amount, target, idempotency key) and, for trust, the
 * ledger balance afterwards.
 *
 * The trust connected account's Stripe balance pools every client's pending
 * deposits. A transfer reversal therefore takes money from that pool, not from
 * one client: it is only the right source when the ledger reversal for the same
 * cents succeeded, so the client's own balance carries it.
 */

const mockStripe = {
  paymentIntents: { retrieve: jest.fn(), create: jest.fn(), search: jest.fn() },
  refunds: { create: jest.fn() },
  transfers: { retrieve: jest.fn(), create: jest.fn(), createReversal: jest.fn() },
  customers: { retrieve: jest.fn() },
};

jest.mock('../../src/modules/stripe/stripe.config', () => ({
  webhooks: require('stripe').webhooks,
  paymentIntents: mockStripe.paymentIntents,
  transfers: mockStripe.transfers,
  customers: mockStripe.customers,
  refunds: mockStripe.refunds,
}));

import { testPool, createFirm, ownerOf, type Actor, type Firm } from '../support/setupInProcess';

// After the harness (which forces it off), before the app loads.
process.env.STRIPE_AUTO_RECOVERY_ENABLED = 'true';

import {
  STRIPE_DEPOSIT_CENTS as DEPOSIT_CENTS,
  STRIPE_INVOICE_CENTS as INVOICE_CENTS,
  newPaymentIntentId,
  seedStripePaidInvoice,
  seedStripeTrustDeposit,
  stripeWebhookSender,
  trustBookBalance,
  trustRowsFor,
} from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_recovery_cash_record_spec_secret';
const { refunded, disputed, disputeClosed, refundUpdated } = stripeWebhookSender(WEBHOOK_SECRET);

const FIRM_ACCOUNT = 'acct_firm_operating_fixture';
const FIRM_CUSTOMER = 'cus_firm_fixture';
const FIRM_CARD = 'pm_firm_card_fixture';
const TRUST_ACCOUNT = 'acct_trust_fixture';

let firm: Firm;
let owner: Actor;
let stripeIds = 0;

function givenTransfer(transferId: string, amount: number, reversed = 0) {
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ latest_charge: { transfer: transferId } });
  mockStripe.transfers.retrieve.mockResolvedValue({ id: transferId, amount, amount_reversed: reversed });
}

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  jest.clearAllMocks();
  // Real Stripe gives every object its own id; the record of what was recovered
  // is keyed on them.
  mockStripe.transfers.createReversal.mockImplementation(async () => ({ id: `trr_${++stripeIds}` }));
  mockStripe.transfers.create.mockImplementation(async () => ({ id: `tr_${++stripeIds}` }));
  mockStripe.paymentIntents.create.mockImplementation(async () => ({ id: `pi_clawback_${++stripeIds}`, status: 'succeeded' }));
  mockStripe.refunds.create.mockImplementation(async () => ({ id: `re_${++stripeIds}` }));
  mockStripe.customers.retrieve.mockResolvedValue({ id: FIRM_CUSTOMER, invoice_settings: { default_payment_method: FIRM_CARD } });
  mockStripe.paymentIntents.search.mockResolvedValue({ data: [] });

  firm = await createFirm();
  owner = await ownerOf(firm.id);
  await testPool.query(
    `update law_firms
        set stripe_account_id = $2,
            plan = coalesce(plan, '{}'::jsonb) || jsonb_build_object('stripeCustomerId', $3::text)
      where id = $1`,
    [firm.id, FIRM_ACCOUNT, FIRM_CUSTOMER],
  );
});

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    errors.mockRestore();
  }
}

/** The client spends `cents` of the deposit, so reversing it would go negative. */
async function disburse(accountId: string, clientId: string, cents: number) {
  const res = await owner.api.post(`/api/lawfirms/${firm.id}/trust/transactions`).send({
    trustAccountId: accountId, clientId, clientName: 'Trust Client', type: 'withdrawal',
    amountCents: cents, date: new Date().toISOString().slice(0, 10),
  });
  expect(res.status).toBe(201);
}

const firmCardCharges = () => mockStripe.paymentIntents.create.mock.calls.map((c) => [c[0].amount, c[1].idempotencyKey]);

describe('a clawback on trust money the client already spent', () => {
  it('bills the whole delta to the firm\'s card and never touches the pooled trust transfer', async () => {
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedStripeTrustDeposit(firm.id, pi);
    await disburse(accountId, clientId, 50_000);
    // The whole deposit is still reversible at Stripe: the pool holds other
    // clients' money. Reversing it would make them cover this client's shortfall.
    givenTransfer('tr_trust', DEPOSIT_CENTS);

    await quietly(() => refunded(pi, 20_001));

    expect(mockStripe.transfers.createReversal).not.toHaveBeenCalled();
    expect(firmCardCharges()).toEqual([[20_001, `trust_clawback_${pi}_20001`]]);
    expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: FIRM_CUSTOMER, payment_method: FIRM_CARD, off_session: true }),
      expect.anything(),
    );
    // The ledger refused, so the client still shows what they hold; the alert asks for a human.
    expect(await trustBookBalance(accountId)).toBe(DEPOSIT_CENTS - 50_000);
    const { rows } = await testPool.query(
      `select 1 from notifications where law_firm_id = $1 and type = 'trust_reversal_failed'`, [firm.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('charges the firm once when the same refused clawback is reported again', async () => {
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedStripeTrustDeposit(firm.id, pi);
    await disburse(accountId, clientId, 50_000);
    givenTransfer('tr_trust', DEPOSIT_CENTS);

    await quietly(() => refunded(pi, 20_001));
    await quietly(() => refunded(pi, 20_001));

    expect(firmCardCharges()).toEqual([[20_001, `trust_clawback_${pi}_20001`]]);
  });
});

describe('cash comes back after a clawback', () => {
  it('refunds the firm\'s card when a dispute the ledger refused to reverse is won', async () => {
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedStripeTrustDeposit(firm.id, pi);
    await disburse(accountId, clientId, 50_000);
    givenTransfer('tr_trust', DEPOSIT_CENTS);
    await quietly(() => disputed(pi, DEPOSIT_CENTS));
    expect(firmCardCharges()).toEqual([[DEPOSIT_CENTS, `trust_clawback_${pi}_${DEPOSIT_CENTS}`]]);
    const charged = await mockStripe.paymentIntents.create.mock.results[0].value;

    await quietly(() => disputeClosed(pi, DEPOSIT_CENTS, 'won'));

    // The firm paid the platform $555.00; all of it goes back to the card it came from.
    expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(mockStripe.refunds.create.mock.calls[0][0]).toEqual({
      payment_intent: charged.id, amount: DEPOSIT_CENTS, metadata: { trustClawbackPaymentIntentId: pi },
    });
    // Nothing was taken from trust, so nothing is pushed into it.
    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    // The ledger never reversed, so it has nothing to restore either.
    expect(await trustBookBalance(accountId)).toBe(DEPOSIT_CENTS - 50_000);

    // A replayed win sends nothing more.
    await quietly(() => disputeClosed(pi, DEPOSIT_CENTS, 'won'));
    expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it('returns a partial trust-transfer recovery to the trust account once when the refund fails', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    givenTransfer('tr_trust', DEPOSIT_CENTS);
    await refunded(pi, 20_000);
    expect(mockStripe.transfers.createReversal.mock.calls.map((c) => c[1].amount)).toEqual([20_000]);

    await refundUpdated(pi, 20_000, 'failed');
    await refundUpdated(pi, 20_000, 'failed');

    expect(mockStripe.transfers.create.mock.calls.map((c) => [c[0].amount, c[0].destination])).toEqual([
      [20_000, TRUST_ACCOUNT],
    ]);
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(await trustBookBalance(accountId)).toBe(DEPOSIT_CENTS);
    expect((await trustRowsFor(accountId)).filter((r) => r.status === 'completed').map((r) => [r.type, r.cents])).toEqual([
      ['deposit', DEPOSIT_CENTS],
    ]);
  });

  it('returns only the trust account\'s share when part of the clawback came from the firm\'s card', async () => {
    // $555.00 disputed. The ledger reversal succeeded, the trust transfer could
    // give back $300.00, and the firm's card covered the other $255.00.
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    givenTransfer('tr_trust', DEPOSIT_CENTS, 25_500);
    await disputed(pi, DEPOSIT_CENTS);
    const charged = await mockStripe.paymentIntents.create.mock.results[0].value;

    await disputeClosed(pi, DEPOSIT_CENTS, 'won');

    expect(mockStripe.paymentIntents.search).not.toHaveBeenCalled();
    expect(mockStripe.refunds.create.mock.calls.map((c) => [c[0].payment_intent, c[0].amount])).toEqual([
      [charged.id, 25_500],
    ]);
    expect(mockStripe.transfers.create.mock.calls.map((c) => [c[0].amount, c[0].destination])).toEqual([
      [30_000, TRUST_ACCOUNT],
    ]);
    expect(await trustBookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });
});

describe('a won dispute on an invoice paid by destination charge', () => {
  it('gives the firm back exactly what was taken from it, not the application fee too', async () => {
    // $250.00 invoice plus a $10.19 client-paid fee: a $260.19 charge. Paralegix
    // kept $10.19 as the application fee, so the firm's transfer was $250.00, and
    // that is all the dispute could take back from the firm.
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await testPool.query('update invoice_payments set surcharge_cents = 1019 where invoice_id = $1', [invoiceId]);
    givenTransfer('tr_invoice', INVOICE_CENTS);
    await disputed(pi, INVOICE_CENTS + 1_019);
    expect(mockStripe.transfers.createReversal.mock.calls.map((c) => c[1].amount)).toEqual([INVOICE_CENTS]);

    await disputeClosed(pi, INVOICE_CENTS + 1_019, 'won');
    await disputeClosed(pi, INVOICE_CENTS + 1_019, 'won');

    expect(mockStripe.transfers.create.mock.calls.map((c) => [c[0].amount, c[0].destination])).toEqual([
      [INVOICE_CENTS, FIRM_ACCOUNT],
    ]);
  });

  it('gives back nothing when recovery took nothing from the firm', async () => {
    const pi = newPaymentIntentId();
    await seedStripePaidInvoice(firm.id, pi);
    // The whole transfer had already been reversed elsewhere: nothing left to take.
    givenTransfer('tr_invoice', INVOICE_CENTS, INVOICE_CENTS);
    await disputed(pi, INVOICE_CENTS);
    expect(mockStripe.transfers.createReversal).not.toHaveBeenCalled();

    await disputeClosed(pi, INVOICE_CENTS, 'won');

    expect(mockStripe.transfers.create).not.toHaveBeenCalled();
  });
});
