/**
 * When a dispute takes money back, and how much it takes.
 *
 * - An inquiry (`warning_needs_response`) withdraws nothing from the merchant and
 *   closes as `warning_closed`, which the won-dispute restore never touches. So
 *   reversing on its `charge.dispute.created` would leave the payment reversed for
 *   good. Only a real dispute reverses.
 * - `charge.dispute.funds_withdrawn` is the moment Stripe actually debits the
 *   funds, including when an inquiry escalates. It performs the same reversal, and
 *   since the reversal converges on a cumulative target, receiving it beside
 *   `created` for the same dispute reverses once.
 * - Stripe's dispute amount is separate from what was already refunded on the
 *   charge. The reversal target is the charge's `amount_refunded` plus the
 *   disputed amount, capped at the charge, read from the charge itself on the
 *   account it lives on.
 *
 * Automatic recovery is off (the suite default), so the only Stripe call a case
 * may make is the charge read it stubs.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    charges: { retrieve: fn() },
    invoices: { create: fn(), retrieve: fn() },
    customers: { retrieve: fn() },
    paymentIntents: { create: fn(), retrieve: fn() },
    transfers: { create: fn(), retrieve: fn(), createReversal: fn() },
  };
});

import { randomUUID } from 'crypto';

import { testPool, createFirm, drainEvents, type Firm } from '../support/setupInProcess';
import {
  STRIPE_DEPOSIT_CENTS as DEPOSIT_CENTS,
  STRIPE_INVOICE_CENTS as INVOICE_CENTS,
  deliverSigned,
  newPaymentIntentId,
  seedStripePaidInvoice,
  seedStripeTrustDeposit,
  stripeInvoiceMoney as invoiceMoney,
  trustBookBalance as bookBalance,
} from '../support/stripeWebhook';

const PAYMENTS_SECRET = 'whsec_dispute_funds_payments';
const CONNECT_SECRET = 'whsec_dispute_funds_connect';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

function surfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'webhooks') continue;
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...surfaces(value, name));
  }
  return out;
}

async function deliver(type: string, object: unknown, account?: string) {
  const payload = JSON.stringify({
    id: `evt_dispute_${randomUUID().slice(0, 12)}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    ...(account ? { account } : {}),
    data: { object },
  });
  const res = await deliverSigned(payload, account ? CONNECT_SECRET : PAYMENTS_SECRET);
  await drainEvents();
  expect(res.status).toBe(200);
}

const dispute = (pi: string, amount: number, status: string, charge?: string) => ({
  id: `dp_${pi}`, object: 'dispute', payment_intent: pi, amount, status,
  ...(charge ? { charge } : {}), created: Math.floor(Date.now() / 1000),
});

/** Stripe's charge as it stands: `amount` charged, `amountRefunded` already refunded. */
function chargeIs(id: string, amount: number, amountRefunded: number) {
  fakeStripe().charges.retrieve.mockImplementation(async (requested: string) => {
    if (requested !== id) throw Object.assign(new Error(`No such charge: '${requested}'`), { code: 'resource_missing' });
    return { id, object: 'charge', amount, amount_refunded: amountRefunded };
  });
}

let firm: Firm;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = PAYMENTS_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
});

afterAll(() => {
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
});

beforeEach(async () => {
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  firm = await createFirm();
});

describe('an inquiry', () => {
  it('reverses nothing when it opens, so its warning_closed leaves the invoice paid', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);

    await deliver('charge.dispute.created', dispute(pi, INVOICE_CENTS, 'warning_needs_response'));
    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: INVOICE_CENTS, isPaid: true, paymentCents: INVOICE_CENTS, refundedCents: 0,
    });

    await deliver('charge.dispute.closed', dispute(pi, INVOICE_CENTS, 'warning_closed'));
    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: INVOICE_CENTS, isPaid: true, paymentCents: INVOICE_CENTS, refundedCents: 0,
    });
  });

  it('leaves a trust deposit in the ledger when it opens', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);

    await deliver('charge.dispute.created', dispute(pi, DEPOSIT_CENTS, 'warning_needs_response'));

    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });
});

describe('charge.dispute.funds_withdrawn', () => {
  it('reverses the disputed amount', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);

    await deliver('charge.dispute.funds_withdrawn', dispute(pi, 6_000, 'needs_response'));

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 19_000, isPaid: false, paymentCents: 19_000, refundedCents: 6_000,
    });
  });

  it('after created for the same dispute, reverses it once', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    const { accountId } = await seedStripeTrustDeposit(firm.id, `${pi}_trust`);

    await deliver('charge.dispute.created', dispute(pi, 6_000, 'needs_response'));
    await deliver('charge.dispute.funds_withdrawn', dispute(pi, 6_000, 'needs_response'));
    await deliver('charge.dispute.created', dispute(`${pi}_trust`, 5_500, 'needs_response'));
    await deliver('charge.dispute.funds_withdrawn', dispute(`${pi}_trust`, 5_500, 'needs_response'));

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 19_000, isPaid: false, paymentCents: 19_000, refundedCents: 6_000,
    });
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 5_500);
  });

  it('reverses an inquiry that escalated, which opened without reversing', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await deliver('charge.dispute.created', dispute(pi, INVOICE_CENTS, 'warning_needs_response'));

    await deliver('charge.dispute.funds_withdrawn', dispute(pi, INVOICE_CENTS, 'needs_response'));

    expect((await invoiceMoney(invoiceId)).amountPaid).toBe(0);
  });
});

describe('a dispute after a partial refund', () => {
  it('reverses the refund plus the disputed amount, and a win restores only the dispute', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await deliver('charge.refunded', { id: 'ch_partial', object: 'charge', payment_intent: pi, amount_refunded: 10_000 });
    chargeIs('ch_partial', INVOICE_CENTS, 10_000);

    // $250 charged, $100 refunded, the remaining $150 disputed: nothing is left.
    await deliver('charge.dispute.created', dispute(pi, 15_000, 'needs_response', 'ch_partial'));

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 0, isPaid: false, paymentCents: 0, refundedCents: INVOICE_CENTS,
    });
    // The charge is read on the platform, where a destination charge lives.
    expect(fakeStripe().charges.retrieve.mock.calls).toEqual([['ch_partial']]);

    await deliver('charge.dispute.closed', dispute(pi, 15_000, 'won', 'ch_partial'));

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 15_000, isPaid: false, paymentCents: 15_000, refundedCents: 10_000,
    });
  });

  it('never reverses past the charge, whatever the two add up to', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    chargeIs('ch_over', INVOICE_CENTS, 20_000);

    await deliver('charge.dispute.created', dispute(pi, 20_000, 'needs_response', 'ch_over'));

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 0, isPaid: false, paymentCents: 0, refundedCents: INVOICE_CENTS,
    });
  });

  it('takes a trust deposit down by the refund and the dispute together', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    await deliver('charge.refunded', { id: 'ch_trust', object: 'charge', payment_intent: pi, amount_refunded: 10_000 });
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 10_000);
    chargeIs('ch_trust', DEPOSIT_CENTS, 10_000);

    await deliver('charge.dispute.created', dispute(pi, DEPOSIT_CENTS - 10_000, 'needs_response', 'ch_trust'));

    expect(await bookBalance(accountId)).toBe(0);
  });

  it('reads a direct charge on the firm\'s own account', async () => {
    const account = `acct_dispute_${randomUUID().slice(0, 8)}`;
    const connected = await testPool.query(
      `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true, direct_charges_enabled = true
        where id = $1`, [firm.id, account]);
    expect(connected.rowCount).toBe(1);
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await testPool.query(`update invoice_payments set charge_model = 'direct' where invoice_id = $1`, [invoiceId]);
    chargeIs('ch_direct', INVOICE_CENTS, 10_000);

    await deliver('charge.dispute.created', dispute(pi, 15_000, 'needs_response', 'ch_direct'), account);

    expect(fakeStripe().charges.retrieve.mock.calls).toEqual([['ch_direct', {}, { stripeAccount: account }]]);
    expect((await invoiceMoney(invoiceId)).amountPaid).toBe(0);
  });
});
