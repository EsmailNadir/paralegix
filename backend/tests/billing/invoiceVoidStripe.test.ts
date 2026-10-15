/**
 * Voiding an invoice closes every way to pay it, and a Stripe payment that
 * lands anyway does not un-void it.
 *
 * RED IF: voidInvoice stops expiring an open checkout session; it leaves the
 * pay link token in place; it voids even though Stripe already reports the
 * session collecting; it drops the firm's charge scope; it starts reading a
 * hosted invoice id left on an installment row by the retired per-installment
 * path; a payment request can be made on a voided invoice; or a late
 * checkout.session.completed rewrites status to 'paid'.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeLib = require('stripe');
  return {
    webhooks: StripeLib.webhooks,
    invoices: {
      retrieve: jest.fn(), voidInvoice: jest.fn(), create: jest.fn(), finalizeInvoice: jest.fn(),
    },
    invoiceItems: { create: jest.fn() },
    customers: { create: jest.fn() },
    checkout: { sessions: { retrieve: jest.fn(), expire: jest.fn(), create: jest.fn() } },
    paymentIntents: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
    transfers: { createReversal: jest.fn() },
    accounts: { retrieve: jest.fn() },
  };
});

import {
  testPool, createFirm, createPersonClient, createInvoice, ownerOf, type Actor, type Firm,
} from '../support/setupInProcess';
import { stripeWebhookSender } from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_invoice_void_stripe_spec';
const fake = () => require('../../src/modules/stripe/stripe.config');

/** What Stripe reports for each object id; anything missing is a 404. */
let stripeInvoiceStatus: Record<string, string>;
let sessionState: Record<string, { status: string; payment_status: string }>;

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

const voidRoute = () => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}/void`;

async function invoiceRow() {
  const { rows } = await testPool.query(
    `select status, pay_link_token, stripe_checkout_session_id, stripe_payment_requested,
            stripe_payment_status, amount_paid_cents
       from invoices where id = $1`, [invoiceId]);
  return rows[0];
}

/** An open whole-invoice payment request: a pay link, and the checkout session opened from it if any. */
async function seedPaymentRequest(session?: string) {
  const res = await testPool.query(
    `update invoices set pay_link_token = 'tok_void_spec', stripe_checkout_session_id = $2,
            stripe_payment_requested = true, stripe_payment_status = 'pending'
      where id = $1`,
    [invoiceId, session ?? null]);
  expect(res.rowCount).toBe(1);
}

async function seedInstallment(hosted: string) {
  await testPool.query('update invoices set payment_plan_enabled = true where id = $1', [invoiceId]);
  await testPool.query(
    `insert into invoice_expected_payments
       (invoice_id, law_firm_id, sort_order, due_date, amount_cents, status, stripe_invoice_id, stripe_payment_status)
     values ($1, $2, 0, current_date + 10, 25000, 'pending', $3, 'pending')`,
    [invoiceId, firm.id, hosted]);
}

beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET; });

beforeEach(async () => {
  const s = fake();
  [s.invoices.retrieve, s.invoices.voidInvoice, s.checkout.sessions.retrieve, s.checkout.sessions.expire,
    s.invoices.create, s.invoiceItems.create, s.customers.create].forEach((fn: any) => fn.mockReset());
  stripeInvoiceStatus = {};
  sessionState = {};
  s.invoices.retrieve.mockImplementation(async (id: string) => {
    if (!stripeInvoiceStatus[id]) throw Object.assign(new Error('No such invoice'), { code: 'resource_missing' });
    return { id, status: stripeInvoiceStatus[id] };
  });
  s.invoices.voidInvoice.mockImplementation(async (id: string) => ({ id, status: 'void' }));
  s.checkout.sessions.retrieve.mockImplementation(async (id: string) => {
    if (!sessionState[id]) throw Object.assign(new Error('No such session'), { code: 'resource_missing' });
    return { id, ...sessionState[id] };
  });
  s.checkout.sessions.expire.mockImplementation(async (id: string) => ({ id, status: 'expired' }));

  firm = await createFirm();
  owner = await ownerOf(firm.id);
  clientId = (await createPersonClient(firm.id, { email: 'payer@example.test' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 25_000 })).id;
});

describe('voiding closes the payment surface', () => {
  it('expires the open checkout session and clears the pay link', async () => {
    sessionState.cs_open = { status: 'open', payment_status: 'unpaid' };
    await seedPaymentRequest('cs_open');

    const res = await owner.api.post(voidRoute());

    expect(res.status).toBe(200);
    expect(fake().checkout.sessions.expire).toHaveBeenCalledWith('cs_open');
    expect(await invoiceRow()).toMatchObject({
      status: 'voided', pay_link_token: null, stripe_checkout_session_id: null,
      stripe_payment_requested: false, stripe_payment_status: 'voided',
    });
  });

  it('clears a pay link the client never opened, without calling Stripe', async () => {
    await seedPaymentRequest();
    expect((await invoiceRow()).pay_link_token).toBe('tok_void_spec');

    expect((await owner.api.post(voidRoute())).status).toBe(200);

    expect(fake().checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(fake().invoices.retrieve).not.toHaveBeenCalled();
    expect(await invoiceRow()).toMatchObject({
      status: 'voided', pay_link_token: null, stripe_payment_requested: false,
    });
  });

  it('ignores a hosted invoice id left on an installment row, even one Stripe reports paid', async () => {
    stripeInvoiceStatus.in_legacy = 'paid';
    await seedInstallment('in_legacy');

    expect((await owner.api.post(voidRoute())).status).toBe(200);

    expect(fake().invoices.retrieve).not.toHaveBeenCalled();
    expect(fake().invoices.voidInvoice).not.toHaveBeenCalled();
    expect((await invoiceRow()).status).toBe('voided');
  });

  it('makes no Stripe call for an invoice that never had a payment link', async () => {
    expect((await owner.api.post(voidRoute())).status).toBe(200);
    expect(fake().invoices.retrieve).not.toHaveBeenCalled();
    expect(fake().checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect((await invoiceRow()).status).toBe('voided');
  });

  it('still voids locally when Stripe cannot be reached', async () => {
    fake().checkout.sessions.retrieve.mockRejectedValue(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
    await seedPaymentRequest('cs_unreachable');

    expect((await owner.api.post(voidRoute())).status).toBe(200);
    expect(fake().checkout.sessions.retrieve).toHaveBeenCalled();
    expect(await invoiceRow()).toMatchObject({
      status: 'voided', pay_link_token: null, stripe_checkout_session_id: null,
    });
  });

  it('puts every call on the firm\'s own account for a direct-charge firm', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_direct_void', direct_charges_enabled = true where id = $1`, [firm.id]);
    sessionState.cs_direct = { status: 'open', payment_status: 'unpaid' };
    await seedPaymentRequest('cs_direct');

    expect((await owner.api.post(voidRoute())).status).toBe(200);
    const onAccount = { stripeAccount: 'acct_direct_void' };
    expect(fake().checkout.sessions.retrieve).toHaveBeenCalledWith('cs_direct', {}, onAccount);
    expect(fake().checkout.sessions.expire).toHaveBeenCalledWith('cs_direct', {}, onAccount);
  });
});

describe('voiding refuses a bill Stripe has already collected', () => {
  it('when a checkout payment is in flight, and changes nothing', async () => {
    sessionState.cs_ach = { status: 'complete', payment_status: 'unpaid' };
    await seedPaymentRequest('cs_ach');
    const before = await invoiceRow();

    const res = await owner.api.post(voidRoute());

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already paid|payment is in progress/i);
    expect(fake().checkout.sessions.expire).not.toHaveBeenCalled();
    expect(await invoiceRow()).toEqual(before);
  });
});

describe('a voided invoice cannot be put back in front of the client', () => {
  it('refuses a new payment request before any Stripe call', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_void_spec', stripe_charges_enabled = true,
              stripe_onboarding_complete = true where id = $1`, [firm.id]);
    expect((await owner.api.post(voidRoute())).status).toBe(200);

    const res = await owner.api.post(`/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/request`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/voided/i);
    expect(fake().invoices.create).not.toHaveBeenCalled();
    expect(fake().customers.create).not.toHaveBeenCalled();
  });
});

describe('a Stripe payment that lands after the void', () => {
  let errorSpy: jest.SpyInstance;
  afterEach(() => errorSpy.mockRestore());

  it('is recorded against the payment intent, and the invoice stays voided', async () => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await owner.api.post(voidRoute())).status).toBe(200);
    // A direct charge is reported by the firm's own connected account.
    await testPool.query(`update law_firms set stripe_account_id = 'acct_raced_void' where id = $1`, [firm.id]);
    const send = stripeWebhookSender(WEBHOOK_SECRET, { account: 'acct_raced_void' });

    await send.deliver('checkout.session.completed', {
      id: 'cs_raced', object: 'checkout.session', status: 'complete', payment_status: 'paid',
      amount_total: 25_000,
      created: Math.floor(Date.now() / 1000),
      payment_intent: 'pi_raced_void',
      // Direct charge, so the refund leg below needs no platform transfer reversal.
      metadata: {
        lawFirmId: firm.id, invoiceId, contextType: 'client', entityId: clientId, clientId,
        paymentMethod: 'card', invoiceAmountCents: '25000', surchargeCents: '0', chargeModel: 'direct',
      },
    });

    // Money moved, so the record of it exists, keyed on what a refund looks up.
    const { rows } = await testPool.query(
      'select amount_cents, stripe_payment_intent_id from invoice_payments where invoice_id = $1', [invoiceId]);
    expect(rows).toEqual([{ amount_cents: '25000', stripe_payment_intent_id: 'pi_raced_void' }]);
    expect(await invoiceRow()).toMatchObject({ status: 'voided', amount_paid_cents: '25000' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/voided invoice/i), expect.objectContaining({ invoiceId }));

    // The cancelled bill is still nobody's receivable.
    const wb = await owner.api.get(`/api/lawfirms/${firm.id}/billing/workbench`);
    expect(wb.body.summary.awaitingCount).toBe(0);

    // And the firm's refund in Stripe reverses it without un-voiding it.
    await send.refunded('pi_raced_void', 25_000);
    expect(await invoiceRow()).toMatchObject({ status: 'voided', amount_paid_cents: '0' });
  });
});
