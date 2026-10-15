/**
 * The refusals that have to happen BEFORE Paralegix talks to Stripe.
 *
 * `requestPayment` and `requestTrustDeposit` each open with a ladder of
 * conditions, and the ordering is the point: a firm that has not finished
 * onboarding, an invoice with nothing left owing, a client with no email, a
 * trust account whose bank is not connected. Every one of them is checked before
 * the first SDK call, so the caller gets a plain explanation instead of a Stripe
 * error raised after a customer and a draft invoice already exist in a real
 * account.
 *
 * A guard that moved BELOW the first SDK call would still return an error, so
 * asserting the status alone would not notice. Each case therefore asserts two
 * things: the error the caller is given, and that no Stripe surface was reached.
 * The fake makes the second assertion mean something, because every method on it
 * throws rather than returning: a guard that slipped below the call would fail
 * the request with a 500 and a different body, not merely record an extra call.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. `stripe.config` is replaced wholesale by
 * the object built in the `jest.mock` factory below, so the real `Stripe` client
 * is never constructed in this module registry and `STRIPE_SECRET_KEY` from
 * `.env` is never read.
 *
 * This file also owns the ENV-OVERRIDE half of the application fee.
 * `STRIPE_APPLICATION_FEE_RATE` and `STRIPE_APPLICATION_FEE_FIXED_CENTS` are
 * read once at module load, so a spec can only pin one pricing configuration.
 * `stripeApplicationFee.test.ts` deletes them and pins the defaults; this file
 * sets them to values that are not the defaults, in its own module registry, and
 * pins that they are honoured.
 */

jest.mock('../../src/modules/stripe/stripe.config', () => {
  /**
   * Every SDK surface throws. A guard that stopped running before its Stripe
   * call would turn a clean 400 into a 500, which is what makes "no Stripe
   * surface was reached" an assertion with teeth rather than a mock-call count.
   */
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

import { randomUUID } from 'crypto';

import {
  testPool,
  request,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

/**
 * Deliberately NOT the built-in 0.038 / 30. The whole point of this pair is that
 * the pricing is operator-tunable without a redeploy, so a service that ignored
 * the environment and hardcoded the defaults has to fail here.
 */
const OVERRIDE_RATE = 0.052;
const OVERRIDE_FIXED_CENTS = 75;

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

/** Every Stripe method the fake carries, so a case can assert none of them ran. */
function stripeCallCount() {
  const s = fakeStripe();
  const fns = [
    s.invoices.create, s.invoices.retrieve, s.invoices.voidInvoice, s.invoices.finalizeInvoice,
    s.invoiceItems.create, s.customers.create,
    s.accounts.create, s.accounts.retrieve, s.accounts.update, s.accounts.createLoginLink,
    s.accountLinks.create,
    s.checkout.sessions.create, s.checkout.sessions.retrieve, s.checkout.sessions.expire,
    s.paymentIntents.create, s.paymentIntents.list,
  ];
  return fns.reduce((total, fn) => total + fn.mock.calls.length, 0);
}

let firm: Firm;
let owner: Actor;

beforeAll(() => {
  // Set before the first request, which is when the app graph is first required
  // and the pricing constants are read.
  process.env.STRIPE_APPLICATION_FEE_RATE = String(OVERRIDE_RATE);
  process.env.STRIPE_APPLICATION_FEE_FIXED_CENTS = String(OVERRIDE_FIXED_CENTS);
});

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  const s = fakeStripe();
  // The `mock.calls` arrays are what `stripeCallCount` reads, and nothing else
  // clears them between cases.
  [
    s.invoices.create, s.invoices.retrieve, s.invoices.voidInvoice, s.invoices.finalizeInvoice,
    s.invoiceItems.create, s.customers.create,
    s.accounts.create, s.accounts.retrieve, s.accounts.update, s.accounts.createLoginLink,
    s.accountLinks.create,
    s.checkout.sessions.create, s.checkout.sessions.retrieve, s.checkout.sessions.expire,
    s.paymentIntents.create, s.paymentIntents.list,
  ].forEach((fn: any) => fn.mockClear());
});

/** Mark the firm's operating connected account fully onboarded. */
async function connectFirm() {
  const res = await testPool.query(
    `update law_firms
        set stripe_account_id = 'acct_guard_spec',
            stripe_charges_enabled = true,
            stripe_onboarding_complete = true
      where id = $1`,
    [firm.id],
  );
  expect(res.rowCount).toBe(1);
}

const requestPaymentUrl = (clientId: string, invoiceId: string) =>
  `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/request`;

describe('requestPayment refuses before it reaches Stripe', () => {
  it('when the firm has no connected account at all', async () => {
    const client = await createPersonClient(firm.id, { email: 'a@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });

    const res = await owner.api.post(requestPaymentUrl(client.id, invoice.id));

    expect(res.status).toBe(400);
    // The content, not just the code. A firm reading "must connect and complete
    // Stripe onboarding" knows what to do; a generic 400 does not.
    expect(res.body.error).toMatch(/connect and complete Stripe onboarding/i);
    expect(stripeCallCount()).toBe(0);
  });

  it('when onboarding started but Stripe has not enabled charges', async () => {
    // The half-finished state a firm sits in between opening the onboarding link
    // and Stripe approving the account. It HAS an account id, so a check that
    // looked only at `stripe_account_id` would let it through and the charge
    // would be rejected at Stripe.
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_pending' where id = $1`,
      [firm.id],
    );
    const client = await createPersonClient(firm.id, { email: 'b@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });

    const res = await owner.api.post(requestPaymentUrl(client.id, invoice.id));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/connect and complete Stripe onboarding/i);
    expect(stripeCallCount()).toBe(0);
  });

  it('when the invoice is already marked paid', async () => {
    await connectFirm();
    const client = await createPersonClient(firm.id, { email: 'c@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });
    const seeded = await testPool.query(
      `update invoices set is_paid = true, amount_paid_cents = 100_00 where id = $1`,
      [invoice.id],
    );
    expect(seeded.rowCount).toBe(1);

    const res = await owner.api.post(requestPaymentUrl(client.id, invoice.id));

    // Issuing a second payment link for a settled invoice is how a client ends up
    // paying twice; the payments array sums without deduping across distinct
    // Stripe objects.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already paid/i);
    expect(stripeCallCount()).toBe(0);
  });

  it('when the balance is fully covered by payments and write-offs', async () => {
    await connectFirm();
    const client = await createPersonClient(firm.id, { email: 'd@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });
    // Not flagged `is_paid`, so the previous guard does not fire: $60 collected
    // and $40 written off leave nothing owing.
    const seeded = await testPool.query(
      `update invoices set amount_paid_cents = 60_00, total_written_off_cents = 40_00
        where id = $1`,
      [invoice.id],
    );
    expect(seeded.rowCount).toBe(1);

    const res = await owner.api.post(requestPaymentUrl(client.id, invoice.id));

    // A write-off is money the firm has forgiven. Billing it anyway would collect
    // from a client who owes nothing, and Stripe would reject a zero-amount
    // invoice item regardless.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no remaining balance/i);
    expect(stripeCallCount()).toBe(0);
  });

  it('when the client has no email to send the payment link to', async () => {
    await connectFirm();
    const client = await createPersonClient(firm.id, { email: null });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });

    const res = await owner.api.post(requestPaymentUrl(client.id, invoice.id));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_BILLING_RECIPIENT');
    // Creating the Stripe customer first would leave a permanent, emailless
    // customer in the live account for every such attempt.
    expect(stripeCallCount()).toBe(0);
  });

  it("when the caller is a member of another firm entirely", async () => {
    await connectFirm();
    const client = await createPersonClient(firm.id, { email: 'e@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });

    const otherFirm = await createFirm();
    const intruder = await ownerOf(otherFirm.id);

    const res = await intruder.api.post(requestPaymentUrl(client.id, invoice.id));

    // Owning a firm is not a credential anywhere else. This caller would
    // otherwise be issuing a payment request against another firm's connected
    // account, with the funds settling into that firm's bank.
    //
    // Two independent layers refuse this, and either alone is sufficient:
    // `requirePermission` on the route resolves the caller's role within
    // `:lawFirmId` and finds none, and `authorizeContext` in the service asserts
    // firm membership again. This case therefore goes red only when BOTH are
    // gone, which is exactly the property worth pinning: the refusal must not
    // depend on one of them being present.
    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
  });

  it('when the caller holds no payment permission', async () => {
    await connectFirm();
    const client = await createPersonClient(firm.id, { email: 'f@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });
    // Can see the invoice, cannot collect on it.
    const viewer = await memberWith(firm.id, ['billing.viewInvoices']);

    const res = await viewer.api.post(requestPaymentUrl(client.id, invoice.id));

    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
  });
});

describe('requestTrustDeposit refuses before it reaches Stripe', () => {
  /** A firm opted in to electronic trust deposits with a billable subscription. */
  async function enableElectronicTrust() {
    const res = await testPool.query(
      `update law_firms
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{trust}',
                                   '{"electronicTrustDepositsAllowed": true}'::jsonb, true),
              plan = coalesce(plan, '{}'::jsonb) || '{"stripeCustomerId": "cus_firm_sub"}'::jsonb
        where id = $1`,
      [firm.id],
    );
    expect(res.rowCount).toBe(1);
  }

  /** An active trust account whose own connected account can accept charges. */
  async function seedTrustAccount(overrides: {
    status?: string; connectedAccountId?: string | null; chargesEnabled?: boolean;
  } = {}) {
    const id = randomUUID();
    const res = await testPool.query(
      `insert into trust_accounts
         (id, law_firm_id, name, account_type, status,
          stripe_connected_account_id, stripe_charges_enabled)
       values ($1, $2, 'Guard IOLTA', 'iolta', $3, $4, $5)`,
      [
        id,
        firm.id,
        overrides.status ?? 'active',
        overrides.connectedAccountId === undefined ? 'acct_trust_guard' : overrides.connectedAccountId,
        overrides.chargesEnabled ?? true,
      ],
    );
    expect(res.rowCount).toBe(1);
    return id;
  }

  const post = (body: any) => owner.api.post(`/api/stripe/trust/${firm.id}/request-deposit`).send(body);

  it('on a matter that belongs to a different client', async () => {
    await enableElectronicTrust();
    const trustAccountId = await seedTrustAccount();
    const client = await createPersonClient(firm.id, { email: 'payer@example.test' });
    const otherClient = await createPersonClient(firm.id, { email: 'other@example.test' });
    const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
      name: 'Other Client Matter', clients: [{ clientId: otherClient.id, name: otherClient.id }],
    });
    expect(matter.status).toBe(201);

    // The manual deposit path enforces this; the Stripe path posts the deposit
    // through `createTrustDepositFromStripe` once the money lands and skipped it,
    // so a firm could attach one client's money to another's matter on an
    // append-only ledger.
    const res = await post({ trustAccountId, clientId: client.id, amountCents: 10_000, matterId: matter.body.matterId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_MATTER_CLIENT_MISMATCH');
    expect(stripeCallCount()).toBe(0);
  });

  it('on an amount above the money ceiling, with a sentence rather than a scrubbed 500', async () => {
    await enableElectronicTrust();
    const trustAccountId = await seedTrustAccount();
    const client = await createPersonClient(firm.id, { email: 'big@example.test' });
    const res = await post({ trustAccountId, clientId: client.id, amountCents: 1_000_000_000 * 100 + 1 });
    expect(res.status).toBe(400);
    expect(stripeCallCount()).toBe(0);
  });

  it('on a malformed trust account id', async () => {
    await enableElectronicTrust();
    const client = await createPersonClient(firm.id, { email: 'malformed@example.test' });
    const res = await post({ trustAccountId: 'not-a-uuid', clientId: client.id, amountCents: 10_000 });
    expect(res.status).toBe(400);
    expect(stripeCallCount()).toBe(0);
  });

  it('on a non-integer amount', async () => {
    await enableElectronicTrust();
    const trustAccountId = await seedTrustAccount();
    const client = await createPersonClient(firm.id, { email: 'trust@example.test' });

    // Trust money is integer cents everywhere. A float here would be rounded by
    // Stripe and the ledger entry would disagree with the bank by a fraction of
    // a cent, on funds the firm holds for someone else.
    const res = await post({ trustAccountId, clientId: client.id, amountCents: 100.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive amount/i);
    expect(stripeCallCount()).toBe(0);
  });

  it('on a zero or negative amount', async () => {
    await enableElectronicTrust();
    const trustAccountId = await seedTrustAccount();
    const client = await createPersonClient(firm.id, { email: 'trust@example.test' });

    const res = await post({ trustAccountId, clientId: client.id, amountCents: -5000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive amount/i);
    expect(stripeCallCount()).toBe(0);
  });

  it('when the firm has not opted in to electronic trust deposits', async () => {
    // The subscription customer is present, so only the jurisdiction
    // acknowledgement is missing.
    const seeded = await testPool.query(
      `update law_firms
          set plan = coalesce(plan, '{}'::jsonb) || '{"stripeCustomerId": "cus_firm_sub"}'::jsonb
        where id = $1`,
      [firm.id],
    );
    expect(seeded.rowCount).toBe(1);
    const trustAccountId = await seedTrustAccount();
    const client = await createPersonClient(firm.id, { email: 'trust@example.test' });

    const res = await post({ trustAccountId, clientId: client.id, amountCents: 500_00 });

    // Taking client trust funds electronically is a per-jurisdiction decision the
    // firm has to make explicitly. This is the opt-in.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_DEPOSITS_DISABLED');
    expect(stripeCallCount()).toBe(0);
  });

  it('when the firm has no subscription customer to bill the ACH fee to', async () => {
    const seeded = await testPool.query(
      `update law_firms
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{trust}',
                                   '{"electronicTrustDepositsAllowed": true}'::jsonb, true)
        where id = $1`,
      [firm.id],
    );
    expect(seeded.rowCount).toBe(1);
    const trustAccountId = await seedTrustAccount();
    const client = await createPersonClient(firm.id, { email: 'trust@example.test' });

    const res = await post({ trustAccountId, clientId: client.id, amountCents: 500_00 });

    // The deposit lands in trust in full and Paralegix fronts the ACH cost, so
    // without a billable customer the platform pays a fee it can never recover.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRUST_DEPOSIT_NO_BILLING');
    expect(stripeCallCount()).toBe(0);
  });

  it('when the trust account is closed', async () => {
    await enableElectronicTrust();
    const trustAccountId = await seedTrustAccount({ status: 'inactive' });
    const client = await createPersonClient(firm.id, { email: 'trust@example.test' });

    const res = await post({ trustAccountId, clientId: client.id, amountCents: 500_00 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not active/i);
    expect(stripeCallCount()).toBe(0);
  });

  it("when the trust account's own bank is not connected", async () => {
    await enableElectronicTrust();
    const trustAccountId = await seedTrustAccount({ connectedAccountId: null });
    const client = await createPersonClient(firm.id, { email: 'trust@example.test' });

    const res = await post({ trustAccountId, clientId: client.id, amountCents: 500_00 });

    // Without the trust connected account there is no destination for the
    // transfer, so the funds would settle into the PLATFORM balance: client money
    // sitting outside any IOLTA account.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STRIPE_TRUST_NOT_READY');
    expect(stripeCallCount()).toBe(0);
  });

  it("when the trust account's connected account cannot yet accept charges", async () => {
    await enableElectronicTrust();
    // Onboarding started, so the id exists, but Stripe has not enabled charges.
    const trustAccountId = await seedTrustAccount({ chargesEnabled: false });
    const client = await createPersonClient(firm.id, { email: 'trust@example.test' });

    const res = await post({ trustAccountId, clientId: client.id, amountCents: 500_00 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STRIPE_TRUST_NOT_READY');
    expect(stripeCallCount()).toBe(0);
  });

  it('when the named client belongs to another firm', async () => {
    await enableElectronicTrust();
    const trustAccountId = await seedTrustAccount();
    const otherFirm = await createFirm();
    const foreignClient = await createPersonClient(otherFirm.id, { email: 'other@example.test' });

    const res = await post({ trustAccountId, clientId: foreignClient.id, amountCents: 500_00 });

    // Client ids are uuids from one global space, so an id from another firm is a
    // well-formed value. Accepting it would post another firm's client into this
    // firm's trust ledger.
    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });
});

describe('application fee pricing from the environment', () => {
  // round(25000 * 0.052) = 1300, plus the 75 cent fixed component. Under the
  // built-in 3.8% + 30c this would be 980, so a service that ignored the
  // environment cannot pass.
  const OVERRIDE_FEE_ON_250 = 1375;

  it('prices a card checkout from an installment link by the configured rate and fixed component', async () => {
    await connectFirm();
    const client = await createPersonClient(firm.id, { email: 'override@example.test' });
    // $500.00 owed, so a fee priced on the balance rather than the $250.00
    // installment would be 2675, not 1375.
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 500_00 });
    await testPool.query('update invoices set payment_plan_enabled = true where id = $1', [invoice.id]);
    const plan = await testPool.query(
      `insert into invoice_expected_payments
         (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
       values ($1, $2, 0, 'inst-0', current_date + 30, 25000, 'pending')`,
      [invoice.id, firm.id],
    );
    expect(plan.rowCount).toBe(1);

    const requested = await owner.api.post(requestPaymentUrl(client.id, invoice.id)).send({ installmentId: 'inst-0' });
    expect(requested.status).toBe(200);
    expect(stripeCallCount()).toBe(0);

    const stripe = fakeStripe();
    stripe.customers.create.mockResolvedValue({ id: 'cus_override' });
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_override', url: 'https://checkout.stripe.test/cs_override' });

    const token = new URL(requested.body.paymentUrl).pathname.split('/').pop();
    const res = await request().post(`/api/pay/${token}/checkout`).send({ method: 'card' });
    expect(res.status).toBe(200);

    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.line_items[0].price_data.unit_amount).toBe(25000);
    expect(params.payment_intent_data.application_fee_amount).toBe(OVERRIDE_FEE_ON_250);
    expect(params.payment_intent_data.application_fee_amount)
      .toBe(Math.round(25000 * OVERRIDE_RATE) + OVERRIDE_FIXED_CENTS);
  });

  it('prices a card checkout from a payment link by the configured rate and fixed component', async () => {
    await connectFirm();
    const client = await createPersonClient(firm.id, { email: 'override@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });

    const requested = await owner.api.post(requestPaymentUrl(client.id, invoice.id));
    expect(requested.status).toBe(200);
    // The request itself prices nothing; the fee is set at checkout.
    expect(stripeCallCount()).toBe(0);

    const stripe = fakeStripe();
    stripe.customers.create.mockResolvedValue({ id: 'cus_override' });
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_override', url: 'https://checkout.stripe.test/cs_override' });

    const token = new URL(requested.body.paymentUrl).pathname.split('/').pop();
    const res = await request().post(`/api/pay/${token}/checkout`).send({ method: 'card' });
    expect(res.status).toBe(200);

    // The firm absorbs the card fee by default, so the whole configured estimate
    // is the application fee on the bare $250.00.
    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.line_items).toHaveLength(1);
    expect(params.payment_intent_data.application_fee_amount).toBe(OVERRIDE_FEE_ON_250);
  });
});

export {};
