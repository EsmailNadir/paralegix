/**
 * Direct charges on a firm's Standard connected account.
 *
 * Stripe only lets a connected account pay its own processing fees and leave
 * negative-balance liability with Stripe (not Paralegix) when it has the full
 * Stripe Dashboard, a "Standard" account; with the Express dashboard the platform
 * must pay fees and carry losses whatever the charge type. So a firm that connects
 * now gets a Standard account, `law_firms.direct_charges_enabled` is set, and every
 * invoice payment for it is created ON the firm's account (`{ stripeAccount }`):
 * no `transfer_data`, and Paralegix's cut is a 0.9% application fee with no fixed
 * part. Refunds and disputes are then Stripe debiting the firm, so the recovery that
 * claws money back for destination charges must not run. Express firms keep the
 * destination model until they reconnect; trust deposits never change (a Standard
 * account would take Stripe's fee out of client money).
 *
 * Every SDK surface is a jest.fn that throws unless a case stubs it.
 * Automatic recovery is switched ON here, so the "no recovery for direct charges"
 * case proves the branch rather than the flag.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    accounts: { create: fn(), retrieve: fn(), update: fn(), createLoginLink: fn() },
    accountLinks: { create: fn() },
    customers: { create: fn(), list: fn(), retrieve: fn(), update: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    invoiceItems: { create: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn(), search: fn() },
    transfers: { create: fn(), retrieve: fn(), createReversal: fn() },
    refunds: { create: fn() },
  };
});

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';
import { portalPath, portalPerson, seedClientInvoice } from '../clients/portalWorld';

// After the harness (which forces it off), before the app loads: recovery ON, so
// skipping it for a direct charge is the code's decision, not the flag's.
process.env.STRIPE_AUTO_RECOVERY_ENABLED = 'true';
delete process.env.STRIPE_DIRECT_APPLICATION_FEE_RATE;
delete process.env.STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS;

const Stripe = require('stripe');
const PAYMENTS_SECRET = 'whsec_direct_spec_payments';
const CONNECT_SECRET = 'whsec_direct_spec_connect';
const FIRM_ACCOUNT = 'acct_firm_standard';
const ON_FIRM = { stripeAccount: FIRM_ACCOUNT };

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

function fakeSurfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'webhooks') continue;
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...fakeSurfaces(value, name));
  }
  return out;
}

let firm: Firm;
let owner: Actor;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = PAYMENTS_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
});

beforeEach(async () => {
  for (const [name, fn] of fakeSurfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  firm = await createFirm({ name: 'Direct & Co' });
  owner = await ownerOf(firm.id);
});

/** A firm already onboarded onto a Standard account and able to charge. */
async function makeDirectFirm(lawFirmId = firm.id) {
  const res = await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true,
            stripe_onboarding_complete = true, direct_charges_enabled = true
      where id = $1`,
    [lawFirmId, FIRM_ACCOUNT],
  );
  expect(res.rowCount).toBe(1);
}

async function firmFlags(lawFirmId = firm.id) {
  const { rows } = await testPool.query(
    'select stripe_account_id, direct_charges_enabled from law_firms where id = $1', [lawFirmId],
  );
  return rows[0];
}

/**
 * A client invoice of `totalCents` on a one-installment plan for the same
 * amount, so its pay link can name that installment.
 */
async function seedPlanInvoice(clientId: string, totalCents: number) {
  const invoice = await createInvoice(firm.id, clientId, { totalCents });
  const header = await testPool.query('update invoices set payment_plan_enabled = true where id = $1', [invoice.id]);
  expect(header.rowCount).toBe(1);
  const plan = await testPool.query(
    `insert into invoice_expected_payments
       (invoice_id, law_firm_id, sort_order, installment_id, due_date, amount_cents, status)
     values ($1, $2, 0, 'inst-0', current_date + 30, $3, 'pending')`,
    [invoice.id, firm.id, totalCents],
  );
  expect(plan.rowCount).toBe(1);
  return invoice;
}

/**
 * Request payment for the plan's installment, then start a card checkout from
 * the emailed pay link as the client would. Returns the session parameters and
 * the request options Stripe was called with.
 */
async function checkoutInstallmentLink(clientId: string, invoiceId: string) {
  const stripe = fakeStripe();
  stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_pay_link', url: 'https://checkout.stripe.test/cs_pay_link' });

  const requested = await owner.api
    .post(`/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/request`)
    .send({ installmentId: 'inst-0' });
  expect(requested.status).toBe(200);
  const token = new URL(requested.body.paymentUrl).pathname.split('/').pop();

  const res = await request().post(`/api/pay/${token}/checkout`).send({ method: 'card' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_pay_link' });
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  const [params, opts] = stripe.checkout.sessions.create.mock.calls[0];
  return { params, opts };
}

function signedConnectPost(type: string, object: unknown, account = FIRM_ACCOUNT) {
  const payload = JSON.stringify({
    id: `evt_direct_${randomUUID().slice(0, 12)}`, object: 'event', type, account,
    created: Math.floor(Date.now() / 1000), data: { object },
  });
  return request()
    .post('/api/webhooks/stripe')
    .set('stripe-signature', Stripe.webhooks.generateTestHeaderString({ payload, secret: CONNECT_SECRET }))
    .set('content-type', 'application/json')
    .send(payload);
}

describe('connecting a firm', () => {
  it('creates a Standard account where the firm pays fees and Stripe carries losses', async () => {
    const stripe = fakeStripe();
    stripe.accounts.create.mockResolvedValue({ id: FIRM_ACCOUNT });
    stripe.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.test/onboard' });

    const res = await owner.api.post(`/api/stripe/connect/${firm.id}/create-account`);

    expect(res.status).toBe(200);
    const params = stripe.accounts.create.mock.calls[0][0];
    // Breaks if onboarding goes back to Express: Stripe then requires the platform
    // to pay fees and carry losses, which is the exposure this removes.
    expect(params.controller).toEqual({
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      stripe_dashboard: { type: 'full' },
      requirement_collection: 'stripe',
    });
    expect(params.type).toBeUndefined();
    expect(params.metadata).toEqual({ lawFirmId: firm.id });
    // The platform cannot change a Standard account's payout settings.
    expect(stripe.accounts.update).not.toHaveBeenCalled();
    expect(await firmFlags()).toEqual({ stripe_account_id: FIRM_ACCOUNT, direct_charges_enabled: true });
  });

  it('reports direct charges in the connect status, so the app shows the right fee', async () => {
    await makeDirectFirm();
    fakeStripe().accounts.retrieve.mockResolvedValue({
      id: FIRM_ACCOUNT, charges_enabled: true, payouts_enabled: true, details_submitted: true,
    });

    const res = await owner.api.get(`/api/stripe/connect/${firm.id}/status`);

    expect(res.status).toBe(200);
    // Breaks if the flag is dropped: the invoice screens would quote the 3.8% + 30c
    // destination fee to a firm paying 0.9%.
    expect(res.body).toMatchObject({ connected: true, chargesEnabled: true, directCharges: true });
  });

  it('sends a Standard firm to its own Stripe Dashboard instead of an Express login link', async () => {
    await makeDirectFirm();

    const res = await owner.api.get(`/api/stripe/connect/${firm.id}/dashboard-link`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://dashboard.stripe.com/' });
    expect(fakeStripe().accounts.createLoginLink).not.toHaveBeenCalled();
  });

  it('clears the direct-charge flag on disconnect, so a reconnect decides afresh', async () => {
    await makeDirectFirm();

    const res = await owner.api.delete(`/api/stripe/connect/${firm.id}`);

    expect(res.status).toBe(200);
    expect(await firmFlags()).toEqual({ stripe_account_id: null, direct_charges_enabled: false });
  });
});

describe('requesting payment from a direct-charge firm', () => {
  it('makes a pay link and creates no Stripe object, not even a firm-side customer', async () => {
    await makeDirectFirm();
    const client = await createPersonClient(firm.id, { name: 'Dana Direct', email: 'dana@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 480_00 });

    const res = await owner.api.post(`/api/stripe/payment/${firm.id}/client/${client.id}/${invoice.id}/request`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Payment link emailed', paymentUrl: expect.stringMatching(/\/pay\/[A-Za-z0-9_-]{20,}$/) });
    // The fee is set on the checkout the client starts from the link (pinned
    // below), so nothing on either account exists until then. Breaks if the
    // request goes back to minting a hosted invoice or a customer.
    const calls = fakeSurfaces().filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);
    expect(calls).toEqual([]);
    const { rows } = await testPool.query('select pay_link_token from invoices where id = $1', [invoice.id]);
    expect(res.body.paymentUrl.endsWith(`/pay/${rows[0].pay_link_token}`)).toBe(true);
  });

  it('mints the pay-link checkout on the firm\'s account with a 0.9% fee and no transfer', async () => {
    await makeDirectFirm();
    const stripe = fakeStripe();
    stripe.customers.list.mockResolvedValue({ data: [] });
    stripe.customers.create.mockResolvedValue({ id: 'cus_on_firm' });
    const client = await createPersonClient(firm.id, { name: 'Dana Direct', email: 'dana@example.test' });
    const invoice = await seedPlanInvoice(client.id, 480_00);

    const { params, opts } = await checkoutInstallmentLink(client.id, invoice.id);

    // The customer lives on the firm's account; a platform customer cannot pay a direct charge.
    expect(stripe.customers.list).toHaveBeenCalledWith({ email: 'dana@example.test', limit: 100 }, ON_FIRM);
    expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({ email: 'dana@example.test' }), ON_FIRM);
    expect(opts).toEqual(ON_FIRM);
    // round(48000 * 0.009) = 432. Breaks if the destination 3.8% + 30c fee is used.
    expect(params.payment_intent_data).toEqual({ application_fee_amount: 432, metadata: { chargeModel: 'direct' } });
    expect(params.metadata).toMatchObject({ chargeModel: 'direct', installmentId: 'inst-0' });
    expect(params.line_items[0].price_data.unit_amount).toBe(48_000);
    expect(params.customer).toBe('cus_on_firm');
  });

  it('reuses the firm-side customer that already exists for that client', async () => {
    await makeDirectFirm();
    const client = await createPersonClient(firm.id, { name: 'Dana Direct', email: 'dana@example.test' });
    fakeStripe().customers.list.mockResolvedValue({
      data: [{ id: 'cus_existing', metadata: { paralegixClientId: client.id } }],
    });
    const invoice = await seedPlanInvoice(client.id, 100_00);

    const { params } = await checkoutInstallmentLink(client.id, invoice.id);

    expect(fakeStripe().customers.create).not.toHaveBeenCalled();
    expect(params.customer).toBe('cus_existing');
  });

  it('mints the portal Checkout Session on the firm\'s account with the direct fee', async () => {
    await makeDirectFirm();
    const payer = await portalPerson(firm.id, 'Paula Payer');
    const invoice = await seedClientInvoice(firm.id, payer.clientId, {
      totalCents: 480_00, invoiceNumber: 'INV-D-1', stripePaymentRequested: true,
    });
    await testPool.query(`update invoices set invoice_name = 'INV-D-1', stripe_payment_status = 'pending' where id = $1`, [invoice.id]);
    const stripe = fakeStripe();
    stripe.customers.list.mockResolvedValue({ data: [] });
    stripe.customers.create.mockResolvedValue({ id: 'cus_paula_on_firm' });
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_direct', url: 'https://checkout.stripe.test/cs_direct' });

    const res = await payer.api.get(`${portalPath(firm.id, `billing/pay/${invoice.id}`)}?method=card`);

    expect(res.status).toBe(200);
    const [params, opts] = stripe.checkout.sessions.create.mock.calls[0];
    expect(opts).toEqual(ON_FIRM);
    expect(params.payment_intent_data).toEqual({ application_fee_amount: 432, metadata: { chargeModel: 'direct' } });
    expect(params.metadata.chargeModel).toBe('direct');
    expect(params.customer).toBe('cus_paula_on_firm');
  });

  it('takes only the 0.9% margin and adds no card fee on a direct card checkout', async () => {
    await makeDirectFirm();
    const payer = await portalPerson(firm.id, 'Paula Payer');
    const invoice = await seedClientInvoice(firm.id, payer.clientId, {
      totalCents: 480_00, invoiceNumber: 'INV-D-2', stripePaymentRequested: true,
    });
    await testPool.query('update invoices set is_card_fee_passed_on = true where id = $1', [invoice.id]);
    const stripe = fakeStripe();
    stripe.customers.list.mockResolvedValue({ data: [] });
    stripe.customers.create.mockResolvedValue({ id: 'cus_paula_on_firm' });
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_direct', url: 'https://checkout.stripe.test/cs_direct' });

    const res = await payer.api.get(`${portalPath(firm.id, `billing/pay/${invoice.id}`)}?method=card`);

    expect(res.status).toBe(200);
    const [params, opts] = stripe.checkout.sessions.create.mock.calls[0];
    expect(opts).toEqual(ON_FIRM);
    // Checkout cannot tell credit from debit, so it carries no card fee even
    // on an invoice whose card fee the client pays. Paralegix takes 0.9% of
    // the 48000. Breaks if a direct charge takes the destination fee (1854).
    expect(params.line_items).toHaveLength(1);
    expect(params.payment_intent_data).toEqual({ application_fee_amount: 432, metadata: { chargeModel: 'direct' } });
  });

  it('voids a direct payment request by expiring its checkout on the firm\'s account', async () => {
    await makeDirectFirm();
    const client = await createPersonClient(firm.id, { email: 'v@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });
    await testPool.query(
      `update invoices set stripe_checkout_session_id = 'cs_direct_open', stripe_checkout_session_account_id = $2,
              stripe_payment_status = 'pending', stripe_payment_requested = true where id = $1`,
      [invoice.id, FIRM_ACCOUNT],
    );
    const stripe = fakeStripe();
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_direct_open', status: 'open' });
    stripe.checkout.sessions.expire.mockResolvedValue({ id: 'cs_direct_open', status: 'expired' });

    const res = await owner.api.post(`/api/stripe/payment/${firm.id}/client/${client.id}/${invoice.id}/void`);

    expect(res.status).toBe(200);
    // Breaks if the session is addressed on the platform: Stripe would not find
    // it there and the client's checkout would stay payable.
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_direct_open', {}, ON_FIRM);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_direct_open', {}, ON_FIRM);
  });

  it('leaves an Express firm on destination charges until it reconnects', async () => {
    await testPool.query(
      `update law_firms set stripe_account_id = 'acct_express_old', stripe_charges_enabled = true, stripe_onboarding_complete = true where id = $1`,
      [firm.id],
    );
    fakeStripe().customers.create.mockResolvedValue({ id: 'cus_platform' });
    const client = await createPersonClient(firm.id, { email: 'e@example.test' });
    const invoice = await seedPlanInvoice(client.id, 480_00);

    const { params, opts } = await checkoutInstallmentLink(client.id, invoice.id);

    expect(opts).toBeUndefined();
    expect(params.payment_intent_data).toEqual({
      application_fee_amount: 1854, // round(48000 * 0.038) + 30
      transfer_data: { destination: 'acct_express_old' },
    });
    expect(params.metadata.chargeModel).toBeUndefined();
  });
});

describe('webhooks for a direct charge', () => {
  async function paidByDirectCheckout() {
    await makeDirectFirm();
    const client = await createPersonClient(firm.id, { email: 'w@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });
    const pi = `pi_direct_${randomUUID().slice(0, 8)}`;
    const res = await signedConnectPost('checkout.session.completed', {
      id: `cs_${randomUUID().slice(0, 8)}`, object: 'checkout.session', payment_status: 'paid',
      amount_total: 250_00, payment_intent: pi,
      metadata: { lawFirmId: firm.id, invoiceId: invoice.id, contextType: 'client', entityId: client.id, chargeModel: 'direct' },
    });
    await drainEvents();
    expect(res.status).toBe(200);
    return { invoiceId: invoice.id, pi };
  }

  it('records a payment made on the firm\'s account as a direct charge', async () => {
    const { invoiceId } = await paidByDirectCheckout();

    const { rows } = await testPool.query(
      'select amount_cents, charge_model from invoice_payments where invoice_id = $1', [invoiceId],
    );
    expect(rows).toEqual([{ amount_cents: '25000', charge_model: 'direct' }]);
  });

  it('reopens the invoice on a refund but never claws money back, because Stripe already debited the firm', async () => {
    const { invoiceId, pi } = await paidByDirectCheckout();

    const res = await signedConnectPost('charge.refunded', {
      id: 'ch_direct', object: 'charge', payment_intent: pi, amount_refunded: 250_00,
    });
    await drainEvents();

    expect(res.status).toBe(200);
    const { rows } = await testPool.query(
      `select i.is_paid, p.amount_cents, p.stripe_refunded_cents, p.charge_model
         from invoices i join invoice_payments p on p.invoice_id = i.id where i.id = $1`, [invoiceId],
    );
    expect(rows).toEqual([{ is_paid: false, amount_cents: '0', stripe_refunded_cents: '25000', charge_model: 'direct' }]);
    // Breaks if recovery runs for a direct charge: there is no transfer, and pulling
    // the money from the firm again would take it twice.
    const stripe = fakeStripe();
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
  });
});
