/**
 * The platform application fee, pinned to the cent.
 *
 * Every client payment collected through a firm's connected account is a
 * destination charge: the platform is the merchant of record, Stripe debits the
 * processing cost from the PLATFORM balance, and `application_fee_amount` is the
 * only thing the platform keeps back to cover it. Compute it too low and
 * Paralegix collects every payment at a loss; compute it too high and a firm is
 * silently overcharged on money that belongs to its client.
 *
 * Nothing about that number is visible on screen. It is one line of arithmetic
 * whose only observable effect is the field handed to Stripe, which is what this
 * file asserts: the exact integer the app puts on the request.
 *
 * WHERE THE FEE IS CHARGED. A payment request, for the whole balance or for one
 * installment, makes only a pay link and touches no Stripe object; the fee is set
 * on the Checkout Session the client starts from that link, once a method is
 * chosen, and is computed on what that link asks for. Both requests are pinned
 * here: the rounding edges on an installment link, and the same pricing on a
 * whole-balance link.
 *
 * WHY THE PRICING CONSTANTS ARE NOT SET HERE. `APPLICATION_FEE_RATE` and
 * `APPLICATION_FEE_FIXED_CENTS` are read once at module load from
 * `STRIPE_APPLICATION_FEE_RATE` / `STRIPE_APPLICATION_FEE_FIXED_CENTS`, which
 * are absent from `.env`. The environment variables are deleted in `beforeAll`
 * so the DEFAULTS are unambiguously what runs, and the expectations below are
 * the production pricing those defaults encode. `stripePaymentGuards.test.ts`
 * sets them to non-default values in its own module registry and pins the
 * override path.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. `stripe.config` is replaced wholesale by
 * the object built in the `jest.mock` factory below, so the real `Stripe` client
 * is never constructed in this module registry and `STRIPE_SECRET_KEY` from
 * `.env` is never read. Every SDK surface is a `jest.fn`, and the ones a test
 * does not deliberately stub throw rather than return, so an unexpected reach
 * for the API fails loudly.
 */

jest.mock('../../src/modules/stripe/stripe.config', () => {
  /** Any SDK surface this spec does not stub. Loud, not silent. */
  const refuse = (name: string) => jest.fn(() => {
    throw new Error(`stripe.${name} was called; this spec must not reach the Stripe API`);
  });

  return {
    invoices: {
      create: refuse('invoices.create'),
      retrieve: refuse('invoices.retrieve'),
      voidInvoice: refuse('invoices.voidInvoice'),
      finalizeInvoice: refuse('invoices.finalizeInvoice'),
    },
    invoiceItems: { create: refuse('invoiceItems.create') },
    customers: { create: refuse('customers.create') },
    accounts: {
      create: refuse('accounts.create'),
      retrieve: refuse('accounts.retrieve'),
      update: refuse('accounts.update'),
      createLoginLink: refuse('accounts.createLoginLink'),
    },
    accountLinks: { create: refuse('accountLinks.create') },
    checkout: {
      sessions: {
        create: refuse('checkout.sessions.create'),
        retrieve: refuse('checkout.sessions.retrieve'),
        expire: refuse('checkout.sessions.expire'),
      },
    },
    paymentIntents: { create: refuse('paymentIntents.create'), list: refuse('paymentIntents.list') },
  };
});

import {
  testPool,
  request,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

/** Mirrors the defaults in processingFees.ts: 3.8% of the charge plus 30 cents. */
const RATE = 0.038;
const FIXED_CENTS = 30;

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

let firm: Firm;
let owner: Actor;

beforeAll(() => {
  // Deleted, not assigned. The pricing constants are read once at module load,
  // and this file's expectations are the DEFAULTS; a value inherited from the
  // environment would silently change what is being asserted.
  delete process.env.STRIPE_APPLICATION_FEE_RATE;
  delete process.env.STRIPE_APPLICATION_FEE_FIXED_CENTS;
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);

  // The firm must be fully onboarded or a request refuses before it ever
  // computes a fee.
  const connected = await testPool.query(
    `update law_firms
        set stripe_account_id = 'acct_fee_spec',
            stripe_charges_enabled = true,
            stripe_onboarding_complete = true
      where id = $1`,
    [firm.id],
  );
  expect(connected.rowCount).toBe(1);

  const stripe = fakeStripe();
  stripe.customers.create.mockReset().mockResolvedValue({ id: 'cus_fee_spec' });
  stripe.checkout.sessions.create.mockReset().mockResolvedValue({
    id: 'cs_fee_spec',
    url: 'https://checkout.stripe.test/cs_fee_spec',
  });
});

/**
 * A client invoice of `totalCents` with `paidCents` and `writtenOffCents`
 * already applied, on a one-installment plan asking for `installmentCents`.
 */
async function seedInvoice(
  { totalCents, installmentCents = totalCents, paidCents = 0, writtenOffCents = 0 }:
  { totalCents: number; installmentCents?: number; paidCents?: number; writtenOffCents?: number },
) {
  const client = await createPersonClient(firm.id, { email: 'billing@example.test' });
  const invoice = await createInvoice(firm.id, client.id, { totalCents });
  const seeded = await testPool.query(
    `update invoices
        set amount_paid_cents = $2, total_written_off_cents = $3, payment_plan_enabled = true
      where id = $1`,
    [invoice.id, paidCents, writtenOffCents],
  );
  expect(seeded.rowCount).toBe(1);
  const plan = await testPool.query(
    `insert into invoice_expected_payments
       (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
     values ($1, $2, 0, 'inst-0', current_date + 30, $3, 'pending')`,
    [invoice.id, firm.id, installmentCents],
  );
  expect(plan.rowCount).toBe(1);
  return { clientId: client.id, invoiceId: invoice.id };
}

/**
 * Request payment for the plan's one installment, then start a card checkout
 * from the emailed pay link as the client would, and return the session
 * parameters. The request itself must reach no Stripe object.
 *
 * The response statuses are asserted first. A failed request would leave the
 * mock uncalled, and "the fee was not wrong" is not the same claim as "the fee
 * was right".
 */
async function checkoutInstallmentByCard(seed: Parameters<typeof seedInvoice>[0]) {
  const { clientId, invoiceId } = await seedInvoice(seed);
  const stripe = fakeStripe();

  const res = await owner.api
    .post(`/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/request`)
    .send({ installmentId: 'inst-0' });
  expect(res.status).toBe(200);
  expect(stripe.invoices.create).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();

  const token = new URL(res.body.paymentUrl).pathname.split('/').pop();
  const checkout = await request().post(`/api/pay/${token}/checkout`).send({ method: 'card' });
  expect(checkout.status).toBe(200);

  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  const params = stripe.checkout.sessions.create.mock.calls[0][0];
  // The session belongs to the installment, so the webhook credits that row.
  expect(params.metadata.installmentId).toBe('inst-0');
  return params;
}

/**
 * Request payment for the whole invoice, then start a card checkout from the
 * emailed pay link as the client would, and return the session parameters.
 * The request itself must reach no Stripe object: the fee is set here, at
 * checkout, and nowhere earlier.
 */
async function checkoutByCard(seed: Parameters<typeof seedInvoice>[0]) {
  const { clientId, invoiceId } = await seedInvoice(seed);
  const stripe = fakeStripe();

  const res = await owner.api.post(`/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/request`);
  expect(res.status).toBe(200);
  expect(stripe.invoices.create).not.toHaveBeenCalled();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();

  const token = new URL(res.body.paymentUrl).pathname.split('/').pop();
  const checkout = await request().post(`/api/pay/${token}/checkout`).send({ method: 'card' });
  expect(checkout.status).toBe(200);
  expect(checkout.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_fee_spec' });

  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  return stripe.checkout.sessions.create.mock.calls[0][0];
}

describe('application fee on a card checkout from an installment link', () => {
  // Each invoice owes twice what its installment asks for, so a fee computed on
  // the balance instead of the installment produces a different integer.

  it('is 3.8% of the charge plus 30 cents', async () => {
    // $250.00 of a $500.00 balance. round(25000 * 0.038) = 950, plus the 30 cent
    // fixed component. On the balance it would be 1930.
    const params = await checkoutInstallmentByCard({ totalCents: 500_00, installmentCents: 250_00 });

    expect(params.payment_intent_data.application_fee_amount).toBe(980);
    expect(params.payment_intent_data.application_fee_amount).toBe(Math.round(25000 * RATE) + FIXED_CENTS);
  });

  it('bills the client the full installment, with the fee taken on top of it', async () => {
    const params = await checkoutInstallmentByCard({ totalCents: 500_00, installmentCents: 250_00 });

    // The line item is what the client pays. The application fee is what the
    // platform withholds from the transfer to the firm, so subtracting it from
    // the charge would silently short the installment and leave a balance behind.
    expect(params.line_items).toHaveLength(1);
    expect(params.line_items[0].price_data.unit_amount).toBe(25000);
    expect(params.payment_intent_data.transfer_data).toEqual({ destination: 'acct_fee_spec' });
  });

  it('rounds the percentage component DOWN when it falls below the half cent', async () => {
    // $10.13. 1013 * 0.038 = 38.494, which rounds to 38.
    const params = await checkoutInstallmentByCard({ totalCents: 20_26, installmentCents: 10_13 });

    expect(params.payment_intent_data.application_fee_amount).toBe(68);
  });

  it('rounds the percentage component UP when it falls above the half cent', async () => {
    // $10.26. 1026 * 0.038 = 38.988, which rounds to 39. Paired with the case
    // above so neither a truncation nor a ceiling can satisfy both.
    const params = await checkoutInstallmentByCard({ totalCents: 20_52, installmentCents: 10_26 });

    expect(params.payment_intent_data.application_fee_amount).toBe(69);
  });

  it('never charges a fee larger than the payment itself', async () => {
    // One cent. The fixed 30 cent component alone already exceeds the charge, and
    // Stripe rejects an application fee greater than the amount, so the whole
    // checkout would fail at the API rather than merely being mispriced.
    const params = await checkoutInstallmentByCard({ totalCents: 2, installmentCents: 1 });

    expect(params.payment_intent_data.application_fee_amount).toBe(1);
    expect(params.line_items[0].price_data.unit_amount).toBe(1);
  });

  it('computes the fee on the REMAINING balance, not the installment or invoice total', async () => {
    // $100 already paid and $50 written off leave $100 collectable, below the
    // $250.00 the installment asks for.
    const params = await checkoutInstallmentByCard({
      totalCents: 250_00, installmentCents: 250_00, paidCents: 100_00, writtenOffCents: 50_00,
    });

    // Charging the full installment would take money the client does not owe;
    // taking the fee off it while charging the remainder would overcharge the
    // firm. Both numbers have to follow the balance.
    expect(params.line_items[0].price_data.unit_amount).toBe(10000);
    expect(params.payment_intent_data.application_fee_amount).toBe(Math.round(10000 * RATE) + FIXED_CENTS);
    expect(params.payment_intent_data.application_fee_amount).toBe(410);
  });
});

describe('application fee on a card checkout from a payment link', () => {
  it('is 3.8% of the charge plus 30 cents, withheld from the transfer to the firm', async () => {
    const params = await checkoutByCard({ totalCents: 250_00 });

    // The firm pays the card fee by default, so the client is charged the bare
    // $250.00 and the platform keeps 950 + 30 of it. Breaks if the fee moved
    // back onto the request (the request asserted no Stripe call) or is dropped.
    expect(params.line_items).toHaveLength(1);
    expect(params.line_items[0].price_data.unit_amount).toBe(25000);
    expect(params.payment_intent_data).toEqual({
      application_fee_amount: Math.round(25000 * RATE) + FIXED_CENTS,
      transfer_data: { destination: 'acct_fee_spec' },
    });
    expect(params.payment_intent_data.application_fee_amount).toBe(980);
  });

  it('never charges a fee larger than the payment itself', async () => {
    const params = await checkoutByCard({ totalCents: 1 });

    expect(params.line_items[0].price_data.unit_amount).toBe(1);
    expect(params.payment_intent_data.application_fee_amount).toBe(1);
  });

  it('computes the fee on the REMAINING balance, not the invoice total', async () => {
    const params = await checkoutByCard({ totalCents: 250_00, paidCents: 100_00, writtenOffCents: 50_00 });

    expect(params.line_items[0].price_data.unit_amount).toBe(10000);
    expect(params.payment_intent_data.application_fee_amount).toBe(410);
  });
});

export {};
