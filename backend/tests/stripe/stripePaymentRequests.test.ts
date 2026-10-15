/**
 * Voiding a whole-invoice payment request, and the client portal's checkout,
 * driven through the real routes.
 *
 * Each of these mints or kills a PAYABLE SURFACE: the invoice's Checkout
 * Session, started from its pay link or the portal, that a client outside the
 * firm can pay. Two things go wrong silently here and never look wrong on
 * screen:
 *
 *   - The money on the Stripe object. The line item is what the client is
 *     charged, `application_fee_amount` is what the platform withholds, and
 *     `transfer_data.destination` is whose bank the rest lands in. All three are
 *     asserted in integer cents against hard-coded values.
 *   - The pointer left behind in Postgres. The invoice records its checkout
 *     session; a void expires it at Stripe and clears it. Leave a stale pointer
 *     and the portal resurrects a session the firm cancelled.
 *
 * The fee defaults (3.8% + 30 cents) are pinned in `stripeApplicationFee.test.ts`;
 * the env overrides are deleted below so those defaults are what run here too.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. `stripe.config` is replaced by the object
 * in the `jest.mock` factory below. Every surface is a `jest.fn` that THROWS
 * unless a case stubs it, and `beforeEach` restores the throw on every one.
 */

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const refuse = () => jest.fn();
  return {
    accounts: { create: refuse(), retrieve: refuse(), update: refuse(), createLoginLink: refuse() },
    accountLinks: { create: refuse() },
    balance: { retrieve: refuse() },
    customers: { create: refuse(), retrieve: refuse(), update: refuse() },
    invoices: { create: refuse(), retrieve: refuse(), voidInvoice: refuse(), finalizeInvoice: refuse() },
    invoiceItems: { create: refuse() },
    checkout: { sessions: { create: refuse(), retrieve: refuse(), expire: refuse() } },
    paymentIntents: { create: refuse(), retrieve: refuse(), list: refuse() },
  };
});

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  memberWith,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { portalPath, portalPerson, seedClientInvoice, type PortalPerson } from '../clients/portalWorld';

// Read once at module load. Deleted before the first request loads the app so
// the production defaults are what the hard-coded fees below describe.
delete process.env.STRIPE_APPLICATION_FEE_RATE;
delete process.env.STRIPE_APPLICATION_FEE_FIXED_CENTS;

const FIRM_ACCOUNT = 'acct_firm_requests';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

function fakeSurfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...fakeSurfaces(value, name));
  }
  return out;
}

/** Total calls across every Stripe surface. Zero means Stripe was never reached. */
const stripeCallCount = () => fakeSurfaces().reduce((sum, [, fn]) => sum + fn.mock.calls.length, 0);

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  for (const [name, fn] of fakeSurfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }

  firm = await createFirm({ name: 'Requests LLP' });
  owner = await ownerOf(firm.id);
  const connected = await testPool.query(
    `update law_firms
        set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true
      where id = $1`,
    [firm.id, FIRM_ACCOUNT],
  );
  expect(connected.rowCount).toBe(1);
});

async function invoiceStripeState(invoiceId: string) {
  const { rows } = await testPool.query(
    `select stripe_invoice_id, stripe_checkout_session_id, stripe_payment_status, stripe_payment_requested
       from invoices where id = $1`,
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/* ------------------------------------------------------------------ */
/*  POST .../:invoiceId/void                                            */
/* ------------------------------------------------------------------ */

describe('voiding a whole-invoice payment request', () => {
  const url = (clientId: string, invoiceId: string) =>
    `/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/void`;

  async function requestedInvoice(overrides: { status?: string } = {}) {
    const client = await createPersonClient(firm.id, { email: 'void@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 480_00 });
    const res = await testPool.query(
      `update invoices
          set stripe_checkout_session_id = 'cs_whole_open',
              stripe_payment_status = $2, stripe_payment_requested = true
        where id = $1`,
      [invoice.id, overrides.status ?? 'pending'],
    );
    expect(res.rowCount).toBe(1);
    return { clientId: client.id, invoiceId: invoice.id };
  }

  const LIVE = {
    stripe_invoice_id: null,
    stripe_checkout_session_id: 'cs_whole_open',
    stripe_payment_status: 'pending',
    stripe_payment_requested: true,
  };

  it('refuses the owner of another firm and leaves the request live', async () => {
    const { clientId, invoiceId } = await requestedInvoice();
    const outsider = await ownerOf((await createFirm()).id);

    const res = await outsider.api.post(url(clientId, invoiceId));

    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect(await invoiceStripeState(invoiceId)).toEqual(LIVE);
  });

  it('refuses a member without billing.recordPayments', async () => {
    const { clientId, invoiceId } = await requestedInvoice();
    const viewer = await memberWith(firm.id, ['billing.viewInvoices']);

    const res = await viewer.api.post(url(clientId, invoiceId));

    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect(await invoiceStripeState(invoiceId)).toEqual(LIVE);
  });

  it('refuses to void a request the client has already paid at Stripe, and keeps it live', async () => {
    const { clientId, invoiceId } = await requestedInvoice();
    const stripe = fakeStripe();
    // Paid at Stripe, but the checkout.session.completed webhook has not landed yet.
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_whole_open', status: 'complete', payment_status: 'paid' });

    const res = await owner.api.post(url(clientId, invoiceId));

    // Breaks if the void clears the request anyway: the firm is told the request is
    // cancelled while the client has paid it, and the late webhook lands on an
    // invoice whose Stripe pointer is gone.
    expect(res.status).toBe(400);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(await invoiceStripeState(invoiceId)).toEqual(LIVE);
  });

  it('expires the open checkout at Stripe and clears every payable pointer locally', async () => {
    const { clientId, invoiceId } = await requestedInvoice();
    const stripe = fakeStripe();
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_whole_open', status: 'open' });
    stripe.checkout.sessions.expire.mockResolvedValue({ id: 'cs_whole_open', status: 'expired' });

    const res = await owner.api.post(url(clientId, invoiceId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Payment request voided' });
    // Breaks if the open session survives: the client could finish paying a
    // request the firm cancelled.
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_whole_open');
    // Breaks if the checkout session pointer survives: the portal would
    // resurrect that session as a live pay link after the firm cancelled.
    expect(await invoiceStripeState(invoiceId)).toEqual({
      stripe_invoice_id: null,
      stripe_checkout_session_id: null,
      stripe_payment_status: 'voided',
      stripe_payment_requested: false,
    });
  });

  it('refuses to void a completed payment and touches nothing', async () => {
    const { clientId, invoiceId } = await requestedInvoice({ status: 'completed' });

    const res = await owner.api.post(url(clientId, invoiceId));

    // Breaks if the completed guard is removed: the record of how the invoice
    // was paid would be wiped and it would read as voided.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Cannot void a completed payment');
    expect(stripeCallCount()).toBe(0);
    expect(await invoiceStripeState(invoiceId)).toEqual({ ...LIVE, stripe_payment_status: 'completed' });
  });

  it('answers 400 when no payment was ever requested', async () => {
    const client = await createPersonClient(firm.id, { email: 'never@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 10_00 });

    const res = await owner.api.post(url(client.id, invoice.id));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('No active Stripe payment request found');
    expect(stripeCallCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /api/client-portal/.../billing/pay/:invoiceId                   */
/* ------------------------------------------------------------------ */

describe('the client portal pay link (getClientCheckoutUrl)', () => {
  let payer: PortalPerson;

  beforeEach(async () => {
    payer = await portalPerson(firm.id, 'Paula Payer');
  });

  const payUrl = (invoiceId: string, lawFirmId = firm.id) => portalPath(lawFirmId, `billing/pay/${invoiceId}`);

  /** $480.00 billed, $100.00 already paid, so $380.00 is collectable. */
  async function requestedPortalInvoice(stripe: { sessionId?: string } = {}) {
    const invoice = await seedClientInvoice(firm.id, payer.clientId, {
      totalCents: 480_00, invoiceNumber: 'INV-PORTAL-3', stripePaymentRequested: true,
    });
    const res = await testPool.query(
      `update invoices
          set amount_paid_cents = 100_00, invoice_name = 'INV-PORTAL-3',
              stripe_checkout_session_id = $2,
              stripe_payment_status = 'pending'
        where id = $1`,
      [invoice.id, stripe.sessionId ?? null],
    );
    expect(res.rowCount).toBe(1);
    return invoice.id;
  }

  function stubNewSession() {
    const stripe = fakeStripe();
    stripe.customers.create.mockResolvedValue({ id: 'cus_paula' });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_minted', url: 'https://checkout.stripe.test/cs_minted',
    });
  }

  it("refuses a portal client of another firm and mints no session", async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice();
    const otherFirm = await createFirm();
    const outsider = await portalPerson(otherFirm.id, 'Oscar Outsider');

    const res = await outsider.api.get(payUrl(invoiceId));

    expect(res.status).toBe(403);
    expect(stripeCallCount()).toBe(0);
    expect((await invoiceStripeState(invoiceId)).stripe_checkout_session_id).toBeNull();
  });

  it('mints a Checkout Session for the remaining balance, fee and destination in cents', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice();

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_minted' });

    const stripe = fakeStripe();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    // $380.00 remaining. Breaks if the session charges the $480.00 total and
    // takes money the client already paid.
    expect(params.line_items).toEqual([{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Invoice #INV-PORTAL-3', description: 'Payment for Invoice #INV-PORTAL-3' },
        unit_amount: 38_000,
      },
      quantity: 1,
    }]);
    // round(38000 * 0.038) = 1444, plus 30 = 1474. Breaks if the fee or the
    // destination is dropped from the portal path.
    expect(params.payment_intent_data).toEqual({
      application_fee_amount: 1474,
      transfer_data: { destination: FIRM_ACCOUNT },
    });
    expect(params.mode).toBe('payment');
    expect(params.customer).toBe('cus_paula');
    // `invoiceId` in the metadata is how `checkout.session.completed` finds
    // the invoice to credit.
    expect(params.metadata).toEqual({
      lawFirmId: firm.id,
      invoiceId,
      contextType: 'client',
      entityId: payer.clientId,
      clientId: payer.clientId,
      clientUserId: payer.uid,
      paymentMethod: 'card',
      invoiceAmountCents: '38000',
      surchargeCents: '0',
    });
    expect(params.payment_method_types).toEqual(['card']);

    // Breaks if the new session id is not stored: every later visit would mint
    // another live session for the same balance.
    expect(await invoiceStripeState(invoiceId)).toMatchObject({
      stripe_checkout_session_id: 'cs_minted',
      stripe_payment_status: 'pending',
    });
  });

  it('does not mint a second session when Stripe fails transiently on the current one', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice({ sessionId: 'cs_maybe_open' });
    fakeStripe().checkout.sessions.retrieve.mockRejectedValue(
      Object.assign(new Error('Too many requests'), { code: 'rate_limit', statusCode: 429 }),
    );

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    // Breaks if every retrieve error falls through to session creation: a
    // still-open session plus a new one is two ways to pay once. The rethrown
    // error keeps Stripe's own 429, so the portal is told to retry.
    expect(res.status).toBe(429);
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
    expect((await invoiceStripeState(invoiceId)).stripe_checkout_session_id).toBe('cs_maybe_open');
  });

  it('mints a session when the current one is genuinely gone at Stripe', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice({ sessionId: 'cs_deleted' });
    fakeStripe().checkout.sessions.retrieve.mockRejectedValue(
      Object.assign(new Error('No such checkout session'), { code: 'resource_missing', statusCode: 404 }),
    );

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    expect(res.status).toBe(200);
    expect(fakeStripe().checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect((await invoiceStripeState(invoiceId)).stripe_checkout_session_id).toBe('cs_minted');
  });

  it('reuses an open session whose amount still matches the balance', async () => {
    const invoiceId = await requestedPortalInvoice({ sessionId: 'cs_current' });
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_current', status: 'open', url: 'https://checkout.stripe.test/cs_current', amount_total: 38_000,
      success_url: `${FRONTEND_URL}/client/lawfirm/${firm.id}/billing?payment=success`,
      cancel_url: `${FRONTEND_URL}/client/lawfirm/${firm.id}/billing?payment=cancelled`,
      metadata: { paymentMethod: 'card', invoiceAmountCents: '38000', surchargeCents: '0' },
    });

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_current' });
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
    expect(fakeStripe().checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it('expires a session for a stale amount and mints one for the current balance', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice({ sessionId: 'cs_stale_total' });
    const stripe = fakeStripe();
    // Minted before the $100.00 payment landed, so it still asks for $480.00.
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_stale_total', status: 'open', url: 'https://checkout.stripe.test/cs_stale_total', amount_total: 48_000,
      metadata: { paymentMethod: 'card', invoiceAmountCents: '48000', surchargeCents: '0' },
    });
    stripe.checkout.sessions.expire.mockResolvedValue({ id: 'cs_stale_total', status: 'expired' });

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    // Breaks if an open session is reused regardless of amount: the client
    // would be charged $100.00 they no longer owe.
    expect(res.status).toBe(200);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_stale_total');
    expect(stripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(38_000);
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_minted' });
    expect((await invoiceStripeState(invoiceId)).stripe_checkout_session_id).toBe('cs_minted');
  });

  it('refuses while the firm cannot yet accept charges', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice();
    await testPool.query('update law_firms set stripe_charges_enabled = false where id = $1', [firm.id]);

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STRIPE_NOT_READY');
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
  });

  /** Records who pays each method's fee on this invoice, as the firm's request does. */
  async function passFees(invoiceId: string, fees: { card?: boolean; bank?: boolean }) {
    const res = await testPool.query(
      'update invoices set is_card_fee_passed_on = $2, is_bank_fee_passed_on = $3 where id = $1',
      [invoiceId, fees.card === true, fees.bank === true],
    );
    expect(res.rowCount).toBe(1);
  }

  it('adds no card fee line on a card checkout even when the client pays the card fee', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice();
    await passFees(invoiceId, { card: true });

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    expect(res.status).toBe(200);
    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(['card']);
    // Checkout cannot tell credit from debit, so a card fee is only ever
    // charged through the card form; this session is the $380.00 owed alone.
    expect(params.line_items).toEqual([
      {
        price_data: {
          currency: 'usd',
          product_data: { name: 'Invoice #INV-PORTAL-3', description: 'Payment for Invoice #INV-PORTAL-3' },
          unit_amount: 38_000,
        },
        quantity: 1,
      },
    ]);
    // round(38000 * 0.038) + 30: the firm pays the card fee on this charge.
    expect(params.payment_intent_data).toEqual({
      application_fee_amount: 1_474,
      transfer_data: { destination: FIRM_ACCOUNT },
    });
    expect(params.metadata).toEqual(expect.objectContaining({
      paymentMethod: 'card', invoiceAmountCents: '38000', surchargeCents: '0',
    }));
  });

  it('charges no fee line and the lower bank fee when the firm pays the bank fee', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice();
    await passFees(invoiceId, { card: true, bank: false });

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=bank`);

    expect(res.status).toBe(200);
    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(['us_bank_account']);
    expect(params.line_items).toHaveLength(1);
    // min(304, 500) + 342. Breaks if a bank transfer still takes the 3.8% + 30c card fee (1474).
    expect(params.payment_intent_data.application_fee_amount).toBe(646);
    expect(params.metadata).toEqual(expect.objectContaining({
      paymentMethod: 'bank', invoiceAmountCents: '38000', surchargeCents: '0',
    }));
  });

  it('grosses up a client-paid bank fee too', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice();
    await passFees(invoiceId, { bank: true });

    await payer.api.get(`${payUrl(invoiceId)}?method=bank`).expect(200);

    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.line_items[1]).toEqual({
      price_data: { currency: 'usd', product_data: { name: 'Bank transfer processing fee' }, unit_amount: 657 },
      quantity: 1,
    });
    expect(params.payment_intent_data.application_fee_amount).toBe(657);
  });

  it('refuses a checkout with no method', async () => {
    const invoiceId = await requestedPortalInvoice();

    const res = await payer.api.get(payUrl(invoiceId));

    // A session is only ever minted for one method, so its fee is known.
    expect(res.status).toBe(400);
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('charges by the invoice choice, not the firm setting', async () => {
    stubNewSession();
    await testPool.query(
      `update law_firms
          set settings = jsonb_set(
            jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', coalesce(settings->'billing', '{}'::jsonb), true),
            '{billing,processingFees}', '{"card":"client","bank":"client"}'::jsonb, true)
        where id = $1`,
      [firm.id],
    );
    const invoiceId = await requestedPortalInvoice();

    await payer.api.get(`${payUrl(invoiceId)}?method=card`).expect(200);

    // The firm chose not to pass the fee on for this request, so the firm-wide
    // default must not add one at checkout.
    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.line_items).toHaveLength(1);
    expect(params.metadata.surchargeCents).toBe('0');
  });

  it('rejects an unknown method before reaching Stripe', async () => {
    const invoiceId = await requestedPortalInvoice();

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=crypto`);

    expect(res.status).toBe(400);
    expect(stripeCallCount()).toBe(0);
  });

  it('does not reuse an open session minted for the other method', async () => {
    stubNewSession();
    const invoiceId = await requestedPortalInvoice({ sessionId: 'cs_bank_open' });
    await passFees(invoiceId, { card: true });
    const stripe = fakeStripe();
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_bank_open', status: 'open', url: 'https://checkout.stripe.test/cs_bank_open',
      amount_total: 38_000, metadata: { paymentMethod: 'bank', invoiceAmountCents: '38000', surchargeCents: '0' },
    });
    stripe.checkout.sessions.expire.mockResolvedValue({ id: 'cs_bank_open', status: 'expired' });

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=card`);

    // Breaks if reuse only compares amounts: the card payer would land on a
    // bank-only session with no fee.
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_minted' });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_bank_open');
  });

  it('reuses an open session for the same method and amounts', async () => {
    const invoiceId = await requestedPortalInvoice({ sessionId: 'cs_bank_open' });
    await passFees(invoiceId, { bank: true });
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_bank_open', status: 'open', url: 'https://checkout.stripe.test/cs_bank_open',
      success_url: `${FRONTEND_URL}/client/lawfirm/${firm.id}/billing?payment=success`,
      cancel_url: `${FRONTEND_URL}/client/lawfirm/${firm.id}/billing?payment=cancelled`,
      amount_total: 38_657, metadata: { paymentMethod: 'bank', invoiceAmountCents: '38000', surchargeCents: '657' },
    });

    const res = await payer.api.get(`${payUrl(invoiceId)}?method=bank`);

    // Breaks if reuse still compares amount_total to the bare balance (38000):
    // every visit would expire and re-mint the session.
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_bank_open' });
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
  });
});

export {};

/* ------------------------------------------------------------------ */
/*  GET /api/client-portal/.../billing/pay/:invoiceId/options           */
/* ------------------------------------------------------------------ */

describe('the client portal payment options', () => {
  let payer: PortalPerson;

  beforeEach(async () => {
    payer = await portalPerson(firm.id, 'Olive Options');
  });

  const optionsUrl = (invoiceId: string, lawFirmId = firm.id) => portalPath(lawFirmId, `billing/pay/${invoiceId}/options`);

  /** $380.00 collectable, payment requested, no Stripe link yet. */
  async function requestedInvoice() {
    const invoice = await seedClientInvoice(firm.id, payer.clientId, {
      totalCents: 380_00, invoiceNumber: 'INV-OPTIONS-1', stripePaymentRequested: true,
    });
    return invoice.id;
  }

  it('refuses a portal client of another firm', async () => {
    const invoiceId = await requestedInvoice();
    const otherFirm = await createFirm();
    const outsider = await portalPerson(otherFirm.id, 'Oscar Outsider');

    const res = await outsider.api.get(optionsUrl(invoiceId));

    expect(res.status).toBe(403);
    expect(res.body.methods).toBeUndefined();
  });

  it('quotes each method by who pays it on this invoice', async () => {
    const invoiceId = await requestedInvoice();
    await testPool.query('update invoices set is_card_fee_passed_on = true where id = $1', [invoiceId]);

    const res = await payer.api.get(optionsUrl(invoiceId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invoiceCents: 38_000,
      // This firm may not pass the card fee on (no state on file), so card
      // payments go through hosted checkout, and a card fee is never quoted as
      // one amount because it depends on the card.
      card: { flow: 'checkout' },
      methods: [
        { method: 'card', feeCents: 0, totalCents: 38_000 },
        { method: 'bank', feeCents: 0, totalCents: 38_000 },
      ],
    });
    // A quote creates no Stripe object.
    expect(stripeCallCount()).toBe(0);
  });

  it('quotes no fee on either method while the firm pays both on this invoice', async () => {
    const invoiceId = await requestedInvoice();

    const res = await payer.api.get(optionsUrl(invoiceId));

    expect(res.body.methods).toEqual([
      { method: 'card', feeCents: 0, totalCents: 38_000 },
      { method: 'bank', feeCents: 0, totalCents: 38_000 },
    ]);
  });

  it('offers a new method-specific checkout for the remaining balance after a hosted payment was refunded', async () => {
    const invoiceId = await requestedInvoice();
    await testPool.query(`insert into invoice_payments (invoice_id, law_firm_id, amount_cents, stripe_refunded_cents, stripe_invoice_id, stripe_payment_intent_id)
      values ($1, $2, 28000, 10000, 'in_refunded', 'pi_refunded')`, [invoiceId, firm.id]);
    await testPool.query("update invoices set amount_paid_cents = 28000, stripe_invoice_id = 'in_refunded' where id = $1", [invoiceId]);
    const options = await payer.api.get(optionsUrl(invoiceId)).expect(200);
    expect(options.body.invoiceCents).toBe(10000);
    fakeStripe().customers.create.mockResolvedValue({ id: 'cus_refunded' });
    fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_refunded_balance', url: 'https://checkout.stripe.test/cs_refunded_balance' });
    const res = await payer.api.get(portalPath(firm.id, `billing/pay/${invoiceId}?method=bank`));
    expect(res.status).toBe(200);
    expect(fakeStripe().checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(10000);
  });

});
