/**
 * The payments webhook also accepts the Connect endpoint's signing secret.
 *
 * Stripe will not send platform events and connected-account events through one
 * snapshot endpoint, so `account.updated` for a firm's connected account arrives
 * on a SEPARATE endpoint with its own secret, pointed at the same route. The route
 * therefore verifies against `STRIPE_WEBHOOK_SECRET` and, failing that,
 * `STRIPE_CONNECT_WEBHOOK_SECRET`.
 *
 * The second secret is narrower on purpose: an event it verifies must name the
 * connected account it came from (`event.account`, which Stripe sets on every
 * Connect event). Without that rule a leaked Connect secret could forge a
 * platform `checkout.session.completed` and mark an invoice paid.
 *
 * Both secrets are read per request, so each case sets exactly what it needs.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const refuse = (name: string) => () => {
    throw new Error(`stripe.${name} was called; this spec must not reach the Stripe API`);
  };
  return {
    webhooks: require('stripe').webhooks,
    accounts: { retrieve: refuse('accounts.retrieve') },
    paymentIntents: { retrieve: refuse('paymentIntents.retrieve') },
  };
});

import { randomUUID } from 'crypto';

import { testPool, createFirm, createPersonClient, createInvoice } from '../support/setupInProcess';
import { deliverSigned } from '../support/stripeWebhook';

const PAYMENTS_SECRET = 'whsec_connect_spec_payments_secret';
const CONNECT_SECRET = 'whsec_connect_spec_connect_secret';

function eventPayload(type: string, object: unknown, account?: string) {
  return JSON.stringify({
    id: `evt_connect_${randomUUID().slice(0, 12)}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    ...(account ? { account } : {}),
    data: { object },
  });
}

const post = (payload: string, secret: string) => deliverSigned(payload, secret);

async function firmWithConnectedAccount() {
  const firm = await createFirm();
  const accountId = `acct_firm_${randomUUID().slice(0, 8)}`;
  const seeded = await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true
      where id = $1`,
    [firm.id, accountId],
  );
  expect(seeded.rowCount).toBe(1);
  return { firm, accountId };
}

async function chargesEnabled(lawFirmId: string) {
  const { rows } = await testPool.query('select stripe_charges_enabled from law_firms where id = $1', [lawFirmId]);
  return rows[0].stripe_charges_enabled;
}

const disabledAccount = (accountId: string) => ({
  id: accountId, object: 'account', charges_enabled: false, details_submitted: false,
});

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = PAYMENTS_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
});

afterAll(() => {
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
});

describe('the Connect endpoint secret', () => {
  it('verifies a connected-account event and the handler applies it', async () => {
    const { firm, accountId } = await firmWithConnectedAccount();

    const res = await post(eventPayload('account.updated', disabledAccount(accountId), accountId), CONNECT_SECRET);

    expect(res.status).toBe(200);
    expect(await chargesEnabled(firm.id)).toBe(false);
  });

  it('refuses an event it verifies that names no connected account', async () => {
    const client = await createPersonClient((await createFirm()).id);
    const firmId = (await testPool.query('select law_firm_id from clients where id = $1', [client.id])).rows[0].law_firm_id;
    const invoice = await createInvoice(firmId, client.id, { totalCents: 25_000 });

    // A platform event forged with the Connect secret: it must not mark the invoice paid.
    const res = await post(eventPayload('checkout.session.completed', {
      id: 'cs_forged', object: 'checkout.session', payment_status: 'paid', amount_total: 25_000,
      payment_intent: 'pi_forged',
      metadata: { lawFirmId: firmId, invoiceId: invoice.id, contextType: 'client', entityId: client.id },
    }), CONNECT_SECRET);

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select amount_paid_cents, is_paid from invoices where id = $1', [invoice.id]);
    expect(rows[0]).toEqual({ amount_paid_cents: '0', is_paid: false });
  });

  it('is not accepted when STRIPE_CONNECT_WEBHOOK_SECRET is unset', async () => {
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    const { firm, accountId } = await firmWithConnectedAccount();

    const res = await post(eventPayload('account.updated', disabledAccount(accountId), accountId), CONNECT_SECRET);

    expect(res.status).toBe(400);
    expect(await chargesEnabled(firm.id)).toBe(true);
  });
});

describe('the platform secret', () => {
  it('still verifies a platform event exactly as before', async () => {
    const { firm, accountId } = await firmWithConnectedAccount();

    const res = await post(eventPayload('account.updated', disabledAccount(accountId)), PAYMENTS_SECRET);

    expect(res.status).toBe(200);
    expect(await chargesEnabled(firm.id)).toBe(false);
  });

  it('rejects a signature made with neither secret', async () => {
    const { firm, accountId } = await firmWithConnectedAccount();

    const res = await post(eventPayload('account.updated', disabledAccount(accountId), accountId), 'whsec_some_other_secret');

    expect(res.status).toBe(400);
    expect(await chargesEnabled(firm.id)).toBe(true);
  });
});
