/**
 * The secure payment link: a no-login pay page whose token is its only
 * credential. A client opens it from the request email, sees the invoice and
 * what card and bank transfer each cost, and starts checkout for one.
 *
 * These routes answer anyone holding a token, so the cases that matter are
 * what a wrong, withdrawn or spent token gets (nothing), and that the page
 * shows no more than a payer needs. Stripe is replaced wholesale.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    customers: { create: fn(), retrieve: fn(), update: fn(), list: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn(), list: fn() },
  };
});

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';
import { gateMethod } from '../support/gate';

const FIRM_ACCOUNT = 'acct_pay_link';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const TOKEN = 'pay_link_fixture_token_0123456789abcdefghijk';
const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

let firm: Firm;
let invoiceId: string;

function stripeSurfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...stripeSurfaces(value, name));
  }
  return out;
}
const stripeCallCount = () => stripeSurfaces().reduce((sum, [, fn]) => sum + fn.mock.calls.length, 0);

beforeEach(async () => {
  for (const [name, mock] of stripeSurfaces()) {
    mock.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  firm = await createFirm({ name: 'Pay Link LLP' });
  await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true
      where id = $1`,
    [firm.id, FIRM_ACCOUNT],
  );
  const client = await createPersonClient(firm.id, { name: 'Casey Client', email: 'casey@example.test' });
  invoiceId = (await createInvoice(firm.id, client.id, { totalCents: 250_00 })).id;
  const res = await testPool.query(
    `update invoices
        set invoice_name = 'INV-PAY-1', due_date = '2026-11-03',
            stripe_payment_requested = true, stripe_payment_status = 'pending',
            pay_link_token = $2, is_card_fee_passed_on = true, is_bank_fee_passed_on = false
      where id = $1`,
    [invoiceId, TOKEN],
  );
  expect(res.rowCount).toBe(1);
});

const pageUrl = (token = TOKEN) => `/api/pay/${token}`;
const checkoutUrl = (token = TOKEN) => `/api/pay/${token}/checkout`;

describe('the pay page', () => {
  it('shows the invoice and what each method costs, and nothing more', async () => {
    const res = await request().get(pageUrl());

    expect(res.status).toBe(200);
    // Exact: no client email, no ids, no line items reach a token holder.
    expect(res.body).toEqual({
      firmName: 'Pay Link LLP',
      invoiceName: 'INV-PAY-1',
      dueDate: '2026-11-03',
      // A full-balance link names no installment.
      installmentNumber: null,
      isPaid: false,
      invoiceCents: 25_000,
      // This firm may not pass the card fee on (no state on file), so card
      // payments go through hosted checkout with no fee.
      card: { flow: 'checkout' },
      methods: [
        // A card fee depends on the card, so the card option never names one.
        { method: 'card', feeCents: 0, totalCents: 25_000 },
        { method: 'bank', feeCents: 0, totalCents: 25_000 },
      ],
    });
    expect(stripeCallCount()).toBe(0);
  });

  it('answers 404 to a token that matches nothing', async () => {
    const res = await request().get(pageUrl('not_a_real_token_0123456789abcdefghijklmno'));

    expect(res.status).toBe(404);
    expect(res.body.invoiceCents).toBeUndefined();
  });

  it('answers 404 once the firm withdraws the request', async () => {
    await testPool.query('update invoices set stripe_payment_requested = false where id = $1', [invoiceId]);

    expect((await request().get(pageUrl())).status).toBe(404);
  });

  it('answers 404 for a voided invoice', async () => {
    await testPool.query(`update invoices set status = 'voided' where id = $1`, [invoiceId]);

    expect((await request().get(pageUrl())).status).toBe(404);
  });

  it('says a paid invoice is paid, with nothing to pay', async () => {
    await testPool.query(
      `update invoices set amount_paid_cents = total_cents, is_paid = true, status = 'paid' where id = $1`,
      [invoiceId],
    );

    const res = await request().get(pageUrl());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      firmName: 'Pay Link LLP', invoiceName: 'INV-PAY-1', dueDate: '2026-11-03', installmentNumber: null, isPaid: true, invoiceCents: 0,
      card: { flow: 'checkout' }, methods: [],
    });
  });
});

describe('starting checkout from the pay page', () => {
  function stubSession() {
    const stripe = fakeStripe();
    stripe.customers.create.mockResolvedValue({ id: 'cus_casey' });
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_pay', url: 'https://checkout.stripe.test/cs_pay' });
  }

  it('mints a card session with no card fee, returning to the pay page', async () => {
    stubSession();

    const res = await request().post(checkoutUrl()).send({ method: 'card' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_pay' });
    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(['card']);
    // Checkout cannot tell credit from debit, so it never carries a card fee.
    expect(params.line_items).toHaveLength(1);
    // Back to the link the client came from, not a portal they cannot open.
    expect(params.success_url).toBe(`${FRONTEND_URL}/pay/${TOKEN}?payment=success`);
    expect(params.cancel_url).toBe(`${FRONTEND_URL}/pay/${TOKEN}?payment=cancelled`);
    expect(params.metadata).toEqual(expect.objectContaining({ invoiceId, clientUserId: '', surchargeCents: '0' }));
  });

  it('rejects an unknown method before reaching Stripe', async () => {
    const res = await request().post(checkoutUrl()).send({ method: 'crypto' });

    expect(res.status).toBe(400);
    expect(stripeCallCount()).toBe(0);
  });

  it('replaces a cached portal checkout so a token holder returns to the public pay page', async () => {
    stubSession();
    await testPool.query("update invoices set stripe_checkout_session_id = 'cs_portal', stripe_checkout_session_account_id = 'platform' where id = $1", [invoiceId]);
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_portal', status: 'open', url: 'https://checkout.stripe.test/cs_portal', amount_total: 25000,
      metadata: { paymentMethod: 'card', invoiceAmountCents: '25000', surchargeCents: '0' },
      success_url: `${FRONTEND_URL}/client/lawfirm/${firm.id}/billing?payment=success`,
      cancel_url: `${FRONTEND_URL}/client/lawfirm/${firm.id}/billing?payment=cancelled`,
    });
    fakeStripe().checkout.sessions.expire.mockResolvedValue({ id: 'cs_portal', status: 'expired' });

    const res = await request().post(checkoutUrl()).send({ method: 'card' });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe('https://checkout.stripe.test/cs_pay');
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_portal');
    expect(fakeStripe().checkout.sessions.create.mock.calls[0][0]).toMatchObject({
      success_url: `${FRONTEND_URL}/pay/${TOKEN}?payment=success`,
      cancel_url: `${FRONTEND_URL}/pay/${TOKEN}?payment=cancelled`,
    });
  });

  it('mints nothing for a token that matches nothing', async () => {
    const res = await request().post(checkoutUrl('not_a_real_token_0123456789abcdefghijklmno')).send({ method: 'card' });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });
});


describe('checkout lifecycle protection', () => {
  async function state() {
    const { rows } = await testPool.query(
      'select stripe_payment_requested, stripe_checkout_session_id, pay_link_token from invoices where id = $1', [invoiceId],
    );
    return rows[0];
  }

  function sessionStubs() {
    fakeStripe().customers.create.mockResolvedValue({ id: 'cus_lifecycle' });
    fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_lifecycle', url: 'https://checkout.stripe.test/cs_lifecycle' });
    fakeStripe().checkout.sessions.expire.mockResolvedValue({ id: 'cs_lifecycle', status: 'expired' });
  }

  it.each(['withdraw', 'replace'])('refuses an in-flight checkout after the firm decides to %s its token', async (action) => {
    sessionStubs();
    const gate = gateMethod(fakeStripe().checkout.sessions, 'create');
    const checkout = (async () => request().post(checkoutUrl()).send({ method: 'card' }))();
    try {
      await gate.arrived(1);
      expect(gate.waiting()).toBe(1);
      const owner = await ownerOf(firm.id);
      const { rows } = await testPool.query('select client_id from invoices where id = $1', [invoiceId]);
      const path = `/api/stripe/payment/${firm.id}/client/${rows[0].client_id}/${invoiceId}`;
      if (action === 'withdraw') await owner.api.post(`${path}/void`).expect(200);
      else await owner.api.post(`${path}/request`).send({}).expect(200);
      const current = await state();
      expect(current.pay_link_token).not.toBe(TOKEN);
      gate.open();
      const res = await checkout;
      expect(res.status).toBe(404);
      expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_lifecycle');
      expect((await state()).stripe_checkout_session_id).toBeNull();
    } finally {
      gate.restore();
      await checkout;
    }
  });

  it.each(['card', 'bank'])('does not create another %s checkout while ACH is processing', async (method) => {
    sessionStubs();
    await testPool.query("update invoices set stripe_checkout_session_id = 'cs_processing', stripe_checkout_session_account_id = 'platform' where id = $1", [invoiceId]);
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_processing', status: 'complete', payment_status: 'unpaid' });
    const res = await request().post(checkoutUrl()).send({ method });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_PROCESSING');
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
    expect((await state()).stripe_checkout_session_id).toBe('cs_processing');
  });

  it.each(['retrieve', 'expire'])('preserves the existing checkout when Stripe %s fails', async (failure) => {
    sessionStubs();
    await testPool.query("update invoices set stripe_checkout_session_id = 'cs_open', stripe_checkout_session_account_id = 'platform' where id = $1", [invoiceId]);
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_open', status: 'open', url: 'https://checkout.stripe.test/cs_open', amount_total: 25000, metadata: { paymentMethod: 'bank', invoiceAmountCents: '25000' } });
    fakeStripe().checkout.sessions[failure].mockRejectedValue(new Error('temporary Stripe failure'));
    const res = await request().post(checkoutUrl()).send({ method: 'card' });
    expect(res.status).toBe(500);
    expect(fakeStripe().checkout.sessions.create).not.toHaveBeenCalled();
    expect((await state()).stripe_checkout_session_id).toBe('cs_open');
  });
});


it('uses the corrected invoice-only billing email for checkout', async () => {
  const owner = await ownerOf(firm.id);
  const { rows } = await testPool.query('select client_id from invoices where id = $1', [invoiceId]);
  await owner.api.put(`/api/lawfirms/${firm.id}/billing/invoices/client/${rows[0].client_id}/${invoiceId}/billing-email`)
    .send({ emails: ['corrected@example.test'] }).expect(200);
  fakeStripe().customers.create.mockResolvedValue({ id: 'cus_corrected' });
  fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_corrected', url: 'https://checkout.stripe.test/cs_corrected' });
  await request().post(checkoutUrl()).send({ method: 'card' }).expect(200);
  expect(fakeStripe().customers.create.mock.calls[0][0].email).toBe('corrected@example.test');
  const client = await testPool.query('select email from clients where id = $1', [rows[0].client_id]);
  expect(client.rows[0].email).toBe('casey@example.test');
});


it('reuses one checkout when two token holders start payment together', async () => {
  const service = require('../../src/modules/stripe/stripe.service');
  const arrivals = gateMethod(service, 'getClientCheckoutUrl');
  fakeStripe().customers.create.mockResolvedValue({ id: 'cus_concurrent' });
  fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_one', url: 'https://checkout.stripe.test/cs_one' });
  fakeStripe().checkout.sessions.retrieve.mockResolvedValue({
    id: 'cs_one', status: 'open', url: 'https://checkout.stripe.test/cs_one', amount_total: 25000,
    success_url: `${FRONTEND_URL}/pay/${TOKEN}?payment=success`,
    cancel_url: `${FRONTEND_URL}/pay/${TOKEN}?payment=cancelled`,
    metadata: { paymentMethod: 'card', invoiceAmountCents: '25000', surchargeCents: '0' },
  });
  const first = (async () => request().post(checkoutUrl()).send({ method: 'card' }))();
  const second = (async () => request().post(checkoutUrl()).send({ method: 'card' }))();
  try {
    await arrivals.arrived(2);
    expect(arrivals.waiting()).toBe(2);
    arrivals.open();
    const responses = await Promise.all([first, second]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect(responses.map((res) => res.body.checkoutUrl)).toEqual(['https://checkout.stripe.test/cs_one', 'https://checkout.stripe.test/cs_one']);
    expect(fakeStripe().checkout.sessions.create).toHaveBeenCalledTimes(1);
  } finally {
    arrivals.restore();
    await Promise.all([first, second]);
  }
});

it('allows another checkout after Stripe reports that the ACH attempt failed', async () => {
  await testPool.query("update invoices set stripe_checkout_session_id = 'cs_failed', stripe_checkout_session_account_id = 'platform' where id = $1", [invoiceId]);
  const { rows } = await testPool.query('select client_id from invoices where id = $1', [invoiceId]);
  const secret = 'whsec_paylink_lifecycle';
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  const payload = JSON.stringify({ id: `evt_failed_${invoiceId}`, object: 'event', type: 'checkout.session.async_payment_failed', data: { object: {
    id: 'cs_failed', metadata: { lawFirmId: firm.id, invoiceId, contextType: 'client', entityId: rows[0].client_id },
  } } });
  const signature = require('stripe').webhooks.generateTestHeaderString({ payload, secret });
  await request().post('/api/webhooks/stripe').set('stripe-signature', signature).set('content-type', 'application/json').send(payload).expect(200);
  fakeStripe().customers.create.mockResolvedValue({ id: 'cus_retry' });
  fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_retry', url: 'https://checkout.stripe.test/cs_retry' });
  await request().post(checkoutUrl()).send({ method: 'card' }).expect(200);
  const current = await testPool.query('select stripe_checkout_session_id from invoices where id = $1', [invoiceId]);
  expect(current.rows[0].stripe_checkout_session_id).toBe('cs_retry');
  expect(fakeStripe().checkout.sessions.create).toHaveBeenCalledTimes(1);
});


it('rejects a token replaced between lookup and the invoice read', async () => {
  const repo = require('../../src/modules/billing/invoices/invoices.repository');
  const gate = gateMethod(repo, 'findById');
  const load = (async () => request().get(pageUrl()))();
  try {
    await gate.arrived(1);
    expect(gate.waiting()).toBe(1);
    await testPool.query('update invoices set pay_link_token = $2 where id = $1', [invoiceId, `${TOKEN}_new`]);
    gate.open();
    const res = await load;
    expect(res.status).toBe(404);
    expect(res.body.invoiceCents).toBeUndefined();
  } finally {
    gate.restore();
    await load;
  }
});


it('collects only the remaining balance after a recorded checkout was partially refunded', async () => {
  await testPool.query(`insert into invoice_payments (invoice_id, law_firm_id, amount_cents, stripe_refunded_cents, stripe_session_id, stripe_payment_intent_id)
    values ($1, $2, 15000, 10000, 'cs_refunded', 'pi_refunded')`, [invoiceId, firm.id]);
  await testPool.query("update invoices set amount_paid_cents = 15000, is_paid = false, stripe_checkout_session_id = 'cs_refunded' where id = $1", [invoiceId]);
  fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_refunded', status: 'complete', payment_status: 'paid', payment_intent: 'pi_refunded' });
  fakeStripe().customers.create.mockResolvedValue({ id: 'cus_refund' });
  fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_balance', url: 'https://checkout.stripe.test/cs_balance' });
  const res = await request().post(checkoutUrl()).send({ method: 'bank' });
  expect(res.status).toBe(200);
  expect(fakeStripe().checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(10000);
  expect(fakeStripe().checkout.sessions.create).toHaveBeenCalledTimes(1);
});
