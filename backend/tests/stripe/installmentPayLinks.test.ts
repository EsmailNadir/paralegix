/**
 * One secure payment link per invoice, asking for either the full balance or
 * one payment-plan installment.
 *
 * The firm names the installment by its stable id (`installment_id`, exposed as
 * the row's `id`), never by position: a plan edit deletes and reinserts the rows,
 * so a position can name a different installment by the time the client pays.
 * What a link asks for is the REQUESTED AMOUNT: the full balance, or the target
 * row's amount capped at that balance. A link whose row has been paid or is gone
 * is no longer payable and answers like a dead link.
 *
 * Every amount here is asserted in integer cents against hard-coded figures:
 * the request email, the fee quote, the pay page, the checkout line item and the
 * webhook credit each read the requested amount, and a slip in any one of them
 * charges the client the wrong money without anything looking wrong on screen.
 *
 * Stripe is replaced wholesale; any surface a case does not stub throws.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    customers: { create: fn(), retrieve: fn(), update: fn(), list: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    invoiceItems: { create: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn(), list: fn() },
    transfers: { createReversal: fn() },
  };
});

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createInvoice,
  ownerOf,
  emailsMatching,
  resetEmails,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';
import { stripeWebhookSender } from '../support/stripeWebhook';
import { portalPath, portalPerson, type PortalPerson } from '../clients/portalWorld';

const { estimatedCostCents } = require('../../src/modules/stripe/processingFees');

const FIRM_ACCOUNT = 'acct_installment_links';
const WEBHOOK_SECRET = 'whsec_installment_pay_links';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const fakeStripe = () => require('../../src/modules/stripe/stripe.config');
const webhook = stripeWebhookSender(WEBHOOK_SECRET);

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

let firm: Firm;
let owner: Actor;
let payer: PortalPerson;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  for (const [name, mock] of stripeSurfaces()) {
    mock.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  resetEmails();
  firm = await createFirm({ name: 'Installment Links LLP' });
  owner = await ownerOf(firm.id);
  const connected = await testPool.query(
    `update law_firms
        set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true
      where id = $1`,
    [firm.id, FIRM_ACCOUNT],
  );
  expect(connected.rowCount).toBe(1);
  payer = await portalPerson(firm.id, 'Iris Installment');
});

/* ------------------------------------------------------------------ */
/*  Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * A $300.00 client invoice on a three-part plan, $100.00 already paid:
 *   inst-a  $100.00  paid
 *   inst-b  $123.45  pending   (installment 2)
 *   inst-c   $76.55  pending   (installment 3)
 * so the balance is $200.00. The pending amounts are not round, so a fee or
 * an amount computed on the wrong figure produces a different integer.
 */
async function seedPlanInvoice(): Promise<string> {
  const invoice = await createInvoice(firm.id, payer.clientId, { totalCents: 300_00, invoiceNumber: 'INV-PLAN-7' });
  const header = await testPool.query(
    `update invoices
        set payment_plan_enabled = true, invoice_name = 'INV-PLAN-7', amount_paid_cents = 100_00,
            status = 'partially_paid'
      where id = $1`,
    [invoice.id],
  );
  expect(header.rowCount).toBe(1);
  const rows = [
    { id: 'inst-a', cents: 100_00, status: 'paid' },
    { id: 'inst-b', cents: 123_45, status: 'pending' },
    { id: 'inst-c', cents: 76_55, status: 'pending' },
  ];
  for (const [i, row] of rows.entries()) {
    const res = await testPool.query(
      `insert into invoice_expected_payments
         (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
       values ($1, $2, $3, $4, current_date + ($3::int * 30), $5, $6)`,
      [invoice.id, firm.id, i, row.id, row.cents, row.status],
    );
    expect(res.rowCount).toBe(1);
  }
  return invoice.id;
}

async function payLinkState(invoiceId: string) {
  const { rows } = await testPool.query(
    `select pay_link_token, pay_link_installment_id, stripe_payment_requested, stripe_payment_status
       from invoices where id = $1`,
    [invoiceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function rowStates(invoiceId: string) {
  const { rows } = await testPool.query(
    `select installment_id, amount_cents::int as amount_cents, status
       from invoice_expected_payments where invoice_id = $1 order by sort_order`,
    [invoiceId],
  );
  return rows;
}

/** Point the invoice at an open installment request, as a stored request would. */
async function openLink(invoiceId: string, installmentId: string | null, token = `tok_${randomUUID().replace(/-/g, '')}`) {
  const res = await testPool.query(
    `update invoices
        set stripe_payment_requested = true, stripe_payment_status = 'pending',
            pay_link_token = $2, pay_link_installment_id = $3, is_card_fee_passed_on = true
      where id = $1`,
    [invoiceId, token, installmentId],
  );
  expect(res.rowCount).toBe(1);
  return token;
}

/** The request email is sent without being awaited, so wait for it to land. */
async function requestEmail() {
  for (let i = 0; i < 50; i += 1) {
    const [email] = emailsMatching(/Payment Requested/);
    if (email) return email;
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error('no payment request email');
}

const requestUrl = (invoiceId: string, lawFirmId = firm.id) =>
  `/api/stripe/payment/${lawFirmId}/client/${payer.clientId}/${invoiceId}/request`;
const quoteUrl = (invoiceId: string) =>
  `/api/stripe/payment/${firm.id}/client/${payer.clientId}/${invoiceId}/fee-quote`;

/* ------------------------------------------------------------------ */
/*  Requesting                                                          */
/* ------------------------------------------------------------------ */

describe('requesting a payment link for one installment', () => {
  it('refuses the owner of another firm and stores no link', async () => {
    const invoiceId = await seedPlanInvoice();
    const outsider = await ownerOf((await createFirm()).id);

    const res = await outsider.api.post(requestUrl(invoiceId)).send({ installmentId: 'inst-b' });

    expect(res.status).toBe(403);
    expect(await payLinkState(invoiceId)).toMatchObject({ pay_link_token: null, pay_link_installment_id: null });
  });

  it('stores the target installment beside the new token and emails its amount', async () => {
    const invoiceId = await seedPlanInvoice();

    const res = await owner.api.post(requestUrl(invoiceId)).send({ installmentId: 'inst-b' });

    expect(res.status).toBe(200);
    const state = await payLinkState(invoiceId);
    expect(state).toMatchObject({
      pay_link_installment_id: 'inst-b', stripe_payment_requested: true, stripe_payment_status: 'pending',
    });
    expect(res.body).toEqual({ message: 'Payment link emailed', paymentUrl: `${FRONTEND_URL}/pay/${state.pay_link_token}` });
    // Breaks if the email quotes the $200.00 balance instead of the installment.
    const email = await requestEmail();
    expect(email.html).toContain('$123.45');
    expect(email.html).not.toContain('$200.00');
    expect(stripeCallCount()).toBe(0);
  });

  it('caps the emailed amount at what the invoice still owes', async () => {
    const invoiceId = await seedPlanInvoice();
    // A $150.00 check recorded outside the plan leaves $50.00 owed while the
    // installment itself still reads $123.45.
    await testPool.query('update invoices set amount_paid_cents = 250_00 where id = $1', [invoiceId]);

    const res = await owner.api.post(requestUrl(invoiceId)).send({ installmentId: 'inst-b' });

    expect(res.status).toBe(200);
    // Breaks on the old bug, where the installment email quoted the uncapped row.
    const email = await requestEmail();
    expect(email.html).toContain('$50.00');
    expect(email.html).not.toContain('$123.45');
  });

  it.each([
    ['already paid', 'inst-a', 'Installment is already paid'],
    ['not on the plan', 'inst-zz', 'Installment not found'],
  ])('refuses an installment that is %s and stores nothing', async (_label, installmentId, message) => {
    const invoiceId = await seedPlanInvoice();

    const res = await owner.api.post(requestUrl(invoiceId)).send({ installmentId });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(message);
    expect(await payLinkState(invoiceId)).toMatchObject({
      pay_link_token: null, pay_link_installment_id: null, stripe_payment_requested: false,
    });
  });

  it('refuses an installment on an invoice whose plan is switched off', async () => {
    const invoiceId = await seedPlanInvoice();
    await testPool.query('update invoices set payment_plan_enabled = false where id = $1', [invoiceId]);

    const res = await owner.api.post(requestUrl(invoiceId)).send({ installmentId: 'inst-b' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Invoice does not have a payment plan');
    expect((await payLinkState(invoiceId)).pay_link_token).toBeNull();
  });

  it('rejects an empty installment id at the boundary', async () => {
    const invoiceId = await seedPlanInvoice();

    const res = await owner.api.post(requestUrl(invoiceId)).send({ installmentId: '' });

    expect(res.status).toBe(400);
    expect((await payLinkState(invoiceId)).pay_link_token).toBeNull();
  });

  it('asks for the full balance again on a request that names no installment', async () => {
    const invoiceId = await seedPlanInvoice();
    await owner.api.post(requestUrl(invoiceId)).send({ installmentId: 'inst-b', sendEmail: false }).expect(200);
    const first = await payLinkState(invoiceId);
    expect(first.pay_link_installment_id).toBe('inst-b');

    const res = await owner.api.post(requestUrl(invoiceId)).send({ sendEmail: false });

    expect(res.status).toBe(200);
    const second = await payLinkState(invoiceId);
    // Breaks if the target survives the replacement: the new link would still
    // ask for one installment while the firm asked for the whole balance.
    expect(second.pay_link_installment_id).toBeNull();
    expect(second.pay_link_token).not.toBe(first.pay_link_token);
  });

  it('no longer serves the old per-installment request route', async () => {
    const invoiceId = await seedPlanInvoice();

    const res = await owner.api.post(
      `/api/stripe/payment/${firm.id}/client/${payer.clientId}/${invoiceId}/installment/1/request`,
    );

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Quoting                                                             */
/* ------------------------------------------------------------------ */

describe('the fee quote for an installment link', () => {
  it('quotes the installment amount, with each fee computed on it', async () => {
    const invoiceId = await seedPlanInvoice();
    // A Texas firm that told Stripe long enough ago may pass the card fee on.
    await testPool.query(
      `update law_firms set state = 'TX', settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', $2::jsonb, true)
        where id = $1`,
      [firm.id, JSON.stringify({ cardFees: { confirmation: {
        stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: 'owner', confirmedAt: '2026-08-01T12:00:00.000Z',
      } } })],
    );

    const res = await owner.api.get(`${quoteUrl(invoiceId)}?installmentId=inst-b&card=true`);

    expect(res.status).toBe(200);
    expect(res.body.invoiceCents).toBe(12_345);
    const bank = estimatedCostCents('bank', 12_345);
    // Breaks if either fee is computed on the $200.00 balance. The US credit
    // card fee is capped at 3% of 12,345 (370); Stripe takes 369 + 30 of 12,715.
    expect(res.body.methods).toEqual([
      {
        method: 'card',
        paidBy: 'client',
        cardRows: [
          { kind: 'us_credit', paidBy: 'client', feeCents: 370, clientPaysCents: 12_715, firmReceivesCents: 12_316 },
          { kind: 'debit', paidBy: 'firm', feeCents: 358 + 30 + 111, clientPaysCents: 12_345, firmReceivesCents: 12_345 - 499 },
          { kind: 'non_us_credit', paidBy: 'client', feeCents: 370, clientPaysCents: 12_715, firmReceivesCents: 12_715 - (559 + 30) },
        ],
      },
      { method: 'bank', paidBy: 'firm', feeCents: bank, clientPaysCents: 12_345, firmReceivesCents: 12_345 - bank },
    ]);
  });

  it('quotes the full balance when no installment is named', async () => {
    const invoiceId = await seedPlanInvoice();

    const res = await owner.api.get(quoteUrl(invoiceId));

    expect(res.status).toBe(200);
    expect(res.body.invoiceCents).toBe(20_000);
  });

  it('refuses to quote an installment that is already paid', async () => {
    const invoiceId = await seedPlanInvoice();

    const res = await owner.api.get(`${quoteUrl(invoiceId)}?installmentId=inst-a`);

    expect(res.status).toBe(400);
    expect(res.body.methods).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  The pay page                                                        */
/* ------------------------------------------------------------------ */

describe('the pay page for an installment link', () => {
  it('names the installment by its position and asks for its amount', async () => {
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-b');

    const res = await request().get(`/api/pay/${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isPaid: false,
      invoiceCents: 12_345,
      installmentNumber: 2,
      methods: [
        { method: 'card', feeCents: 0, totalCents: 12_345 },
        { method: 'bank', feeCents: 0, totalCents: 12_345 },
      ],
    });
  });

  it('carries no installment number on a full-balance link', async () => {
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, null);

    const res = await request().get(`/api/pay/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.installmentNumber).toBeNull();
    expect(res.body.invoiceCents).toBe(20_000);
  });

  it('answers 404 once the target installment is paid', async () => {
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-b');
    await testPool.query(
      `update invoice_expected_payments set status = 'paid' where invoice_id = $1 and installment_id = 'inst-b'`,
      [invoiceId],
    );

    const res = await request().get(`/api/pay/${token}`);

    expect(res.status).toBe(404);
    expect(res.body.invoiceCents).toBeUndefined();
  });

  it('answers 404 once the target installment is gone from the plan', async () => {
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-b');
    await testPool.query(
      `delete from invoice_expected_payments where invoice_id = $1 and installment_id = 'inst-b'`,
      [invoiceId],
    );

    expect((await request().get(`/api/pay/${token}`)).status).toBe(404);
  });

  it('follows the installment by id when a plan edit moves it', async () => {
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-c');
    // inst-c now falls due first among the rows, so it is installment 1.
    await testPool.query(
      `update invoice_expected_payments
          set sort_order = case installment_id when 'inst-c' then 0 when 'inst-a' then 1 else 2 end
        where invoice_id = $1`,
      [invoiceId],
    );

    const res = await request().get(`/api/pay/${token}`);

    expect(res.status).toBe(200);
    // Breaks if the link is addressed by position: it would now ask for $100.00
    // or $123.45 from a different row.
    expect(res.body).toMatchObject({ invoiceCents: 7_655, installmentNumber: 1 });
  });
});

/* ------------------------------------------------------------------ */
/*  Checkout                                                            */
/* ------------------------------------------------------------------ */

describe('checkout from an installment link', () => {
  function stubSession() {
    fakeStripe().customers.create.mockResolvedValue({ id: 'cus_iris' });
    fakeStripe().checkout.sessions.create.mockResolvedValue({ id: 'cs_inst', url: 'https://checkout.stripe.test/cs_inst' });
  }

  it('charges the installment amount and names the installment', async () => {
    stubSession();
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-b');

    const res = await request().post(`/api/pay/${token}/checkout`).send({ method: 'bank' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_inst' });
    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    // Breaks on a dollars-for-cents slip or if the $200.00 balance is charged.
    expect(params.line_items).toEqual([{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Invoice #INV-PLAN-7, Installment 2', description: 'Payment for Invoice #INV-PLAN-7, Installment 2' },
        unit_amount: 12_345,
      },
      quantity: 1,
    }]);
    // The stable id is how the webhook credits this row and no other.
    expect(params.metadata).toMatchObject({ installmentId: 'inst-b', invoiceAmountCents: '12345', surchargeCents: '0' });
  });

  it('caps the charge at what the invoice still owes', async () => {
    stubSession();
    const invoiceId = await seedPlanInvoice();
    await testPool.query('update invoices set amount_paid_cents = 250_00 where id = $1', [invoiceId]);
    const token = await openLink(invoiceId, 'inst-b');

    await request().post(`/api/pay/${token}/checkout`).send({ method: 'bank' }).expect(200);

    const params = fakeStripe().checkout.sessions.create.mock.calls[0][0];
    expect(params.line_items[0].price_data.unit_amount).toBe(5_000);
    expect(params.metadata.invoiceAmountCents).toBe('5000');
  });

  it('mints nothing once the target installment is paid', async () => {
    stubSession();
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-b');
    await testPool.query(
      `update invoice_expected_payments set status = 'paid' where invoice_id = $1 and installment_id = 'inst-b'`,
      [invoiceId],
    );

    const res = await request().post(`/api/pay/${token}/checkout`).send({ method: 'card' });

    expect(res.status).toBe(404);
    expect(stripeCallCount()).toBe(0);
  });

  it('refuses a portal checkout for an installment request whose row is gone', async () => {
    stubSession();
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, 'inst-b');
    await testPool.query(
      `delete from invoice_expected_payments where invoice_id = $1 and installment_id = 'inst-b'`,
      [invoiceId],
    );

    const res = await payer.api.get(portalPath(firm.id, `billing/pay/${invoiceId}?method=card`));

    expect(res.status).toBe(400);
    expect(stripeCallCount()).toBe(0);
  });

  it('offers the portal the installment amount, not the balance', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, 'inst-c');

    const res = await payer.api.get(portalPath(firm.id, `billing/pay/${invoiceId}/options`));

    expect(res.status).toBe(200);
    expect(res.body.invoiceCents).toBe(7_655);
  });

  it('does not reuse an open session minted for a different installment', async () => {
    stubSession();
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-b');
    await testPool.query(
      `update invoices set stripe_checkout_session_id = 'cs_other', stripe_checkout_session_account_id = 'platform' where id = $1`,
      [invoiceId],
    );
    // Same method and the same amount, but minted for inst-c.
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_other', status: 'open', url: 'https://checkout.stripe.test/cs_other', amount_total: 12_345,
      metadata: { paymentMethod: 'bank', invoiceAmountCents: '12345', installmentId: 'inst-c' },
    });
    fakeStripe().checkout.sessions.expire.mockResolvedValue({ id: 'cs_other', status: 'expired' });

    const res = await request().post(`/api/pay/${token}/checkout`).send({ method: 'bank' });

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe('https://checkout.stripe.test/cs_inst');
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/*  The webhook credit                                                  */
/* ------------------------------------------------------------------ */

describe('crediting a paid installment link', () => {
  function paidSession(invoiceId: string, cents: number, metadata: Record<string, string> = {}) {
    return {
      id: `cs_${randomUUID().slice(0, 10)}`,
      object: 'checkout.session',
      status: 'complete',
      payment_status: 'paid',
      amount_total: cents,
      payment_intent: `pi_${randomUUID().slice(0, 10)}`,
      created: Math.floor(Date.now() / 1000),
      metadata: {
        lawFirmId: firm.id,
        invoiceId,
        contextType: 'client',
        entityId: payer.clientId,
        clientId: payer.clientId,
        paymentMethod: 'card',
        invoiceAmountCents: String(cents),
        surchargeCents: '0',
        ...metadata,
      },
    };
  }

  it('marks the named installment paid, by id, and ends the request', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, 'inst-c');

    await webhook.deliver('checkout.session.completed', paidSession(invoiceId, 7_655, { installmentId: 'inst-c' }));

    // Breaks if the payment lands on the earliest open row (inst-b) instead.
    expect(await rowStates(invoiceId)).toEqual([
      { installment_id: 'inst-a', amount_cents: 100_00, status: 'paid' },
      { installment_id: 'inst-b', amount_cents: 123_45, status: 'pending' },
      { installment_id: 'inst-c', amount_cents: 76_55, status: 'paid' },
    ]);
    // The request is over, so the firm can send the next installment's link.
    expect(await payLinkState(invoiceId)).toEqual({
      pay_link_token: null, pay_link_installment_id: null, stripe_payment_requested: false, stripe_payment_status: 'completed',
    });
  });

  it('spreads from the earliest open installment when the named one is no longer open', async () => {
    const invoiceId = await seedPlanInvoice();
    await testPool.query(
      `update invoice_expected_payments set status = 'paid' where invoice_id = $1 and installment_id = 'inst-c'`,
      [invoiceId],
    );

    await webhook.deliver('checkout.session.completed', paidSession(invoiceId, 7_655, { installmentId: 'inst-c' }));

    // $76.55 against inst-b's $123.45 leaves $46.90 of it open.
    expect(await rowStates(invoiceId)).toEqual([
      { installment_id: 'inst-a', amount_cents: 100_00, status: 'paid' },
      { installment_id: 'inst-b', amount_cents: 46_90, status: 'pending' },
      { installment_id: 'inst-c', amount_cents: 76_55, status: 'paid' },
    ]);
    const { rows } = await testPool.query('select amount_cents::int as cents from invoice_payments where invoice_id = $1', [invoiceId]);
    expect(rows).toEqual([{ cents: 76_55 }]);
  });

  it('ends a full-balance request when its payment is recorded', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, null);

    await webhook.deliver('checkout.session.completed', paidSession(invoiceId, 20_000));

    expect(await payLinkState(invoiceId)).toEqual({
      pay_link_token: null, pay_link_installment_id: null, stripe_payment_requested: false, stripe_payment_status: 'completed',
    });
  });

  it('keeps the request open while a bank payment is still processing', async () => {
    const invoiceId = await seedPlanInvoice();
    const token = await openLink(invoiceId, 'inst-b');

    await webhook.deliver('checkout.session.completed', {
      ...paidSession(invoiceId, 12_345, { installmentId: 'inst-b', paymentMethod: 'bank' }),
      payment_status: 'unpaid',
    });

    expect(await payLinkState(invoiceId)).toEqual({
      pay_link_token: token, pay_link_installment_id: 'inst-b', stripe_payment_requested: true, stripe_payment_status: 'pending',
    });
    expect((await rowStates(invoiceId))[1].status).toBe('pending');
  });

  it('ends the request when a delayed bank payment settles', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, 'inst-b');

    await webhook.deliver('checkout.session.async_payment_succeeded',
      paidSession(invoiceId, 12_345, { installmentId: 'inst-b', paymentMethod: 'bank' }));

    expect((await rowStates(invoiceId))[1].status).toBe('paid');
    expect(await payLinkState(invoiceId)).toMatchObject({ pay_link_token: null, stripe_payment_requested: false });
  });

  it('acknowledges a hosted invoice.paid event without recording anything', async () => {
    const invoiceId = await seedPlanInvoice();

    await webhook.deliver('invoice.paid', {
      id: 'in_legacy', object: 'invoice', status: 'paid', amount_paid: 12_345,
      metadata: { lawFirmId: firm.id, invoiceId, contextType: 'client', entityId: payer.clientId, installmentIndex: '1' },
    });

    expect((await rowStates(invoiceId))[1].status).toBe('pending');
    const { rows } = await testPool.query('select count(*)::int as n from invoice_payments where invoice_id = $1', [invoiceId]);
    expect(rows[0].n).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Cancelling                                                          */
/* ------------------------------------------------------------------ */

describe('cancelling an installment link', () => {
  it('clears the target along with the token', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, 'inst-b');

    const res = await owner.api.post(`/api/stripe/payment/${firm.id}/client/${payer.clientId}/${invoiceId}/void`);

    expect(res.status).toBe(200);
    expect(await payLinkState(invoiceId)).toMatchObject({
      pay_link_token: null, pay_link_installment_id: null, stripe_payment_requested: false,
    });
  });

  it('clears the target when the invoice is voided', async () => {
    const invoiceId = await seedPlanInvoice();
    await testPool.query('update invoices set amount_paid_cents = 0 where id = $1', [invoiceId]);
    await openLink(invoiceId, 'inst-b');

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/billing/invoices/client/${payer.clientId}/${invoiceId}/void`);

    expect(res.status).toBe(200);
    expect(await payLinkState(invoiceId)).toMatchObject({ pay_link_token: null, pay_link_installment_id: null });
  });
});

/* ------------------------------------------------------------------ */
/*  What the firm and the client read back                              */
/* ------------------------------------------------------------------ */

describe('the invoice as the firm and the client read it', () => {
  async function seedSurchargedPayment(invoiceId: string) {
    const res = await testPool.query(
      `insert into invoice_payments (invoice_id, law_firm_id, sort_order, amount_cents, payment_source, surcharge_cents, stripe_payment_intent_id)
       values ($1, $2, 0, 100_00, 'stripe', 412, 'pi_fee_paid'),
              ($1, $2, 1, 25_00, null, 0, null)`,
      [invoiceId, firm.id],
    );
    // The second payment is a manual one with no fee, so "0 when none" has a row to show it.
    expect(res.rowCount).toBe(2);
  }

  it('names the target installment and each payment surcharge on the firm invoice', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, 'inst-b');
    await seedSurchargedPayment(invoiceId);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/client/${payer.clientId}`);

    expect(res.status).toBe(200);
    const invoice = res.body.invoices.find((inv: any) => inv.id === invoiceId);
    expect(invoice.payLinkInstallmentId).toBe('inst-b');
    expect(invoice.payments.map((p: any) => p.surchargeCents)).toEqual([412, 0]);
  });

  it('names the target installment and each payment surcharge on the firm invoice list', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, 'inst-c');
    await seedSurchargedPayment(invoiceId);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/firm?includeDetails=true`);

    expect(res.status).toBe(200);
    const invoice = res.body.invoices.find((inv: any) => inv.id === invoiceId);
    expect(invoice.payLinkInstallmentId).toBe('inst-c');
    expect(invoice.payments.map((p: any) => p.surchargeCents)).toEqual([412, 0]);
  });

  it('reports a null target on a full-balance request', async () => {
    const invoiceId = await seedPlanInvoice();
    await openLink(invoiceId, null);

    const res = await owner.api.get(`/api/lawfirms/${firm.id}/billing/invoices/firm`);

    const invoice = res.body.invoices.find((inv: any) => inv.id === invoiceId);
    expect(invoice).toHaveProperty('payLinkInstallmentId', null);
  });

  it('shows the client the fee each payment carried in the portal', async () => {
    const invoiceId = await seedPlanInvoice();
    await seedSurchargedPayment(invoiceId);

    const res = await payer.api.get(portalPath(firm.id, `invoices/${invoiceId}`));

    expect(res.status).toBe(200);
    const payments = (res.body.invoice ?? res.body).payments;
    expect(payments.map((p: any) => p.surchargeCents)).toEqual([412, 0]);
  });
});
