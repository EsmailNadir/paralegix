/**
 * A card-form payment lives on the firm's own Stripe account, so Stripe tells
 * us about it through Connect `payment_intent.*` events. A succeeded one is
 * recorded once, with the client-paid fee kept out of the invoice money; one
 * that failed or was cancelled releases the invoice it was holding. And while
 * a card payment waits on the client's bank, nothing that closes the invoice's
 * payment surfaces may leave it confirmable, or void the invoice under a
 * payment that is processing.
 *
 * Every SDK surface is a jest.fn that throws unless a case stubs it.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    customers: { create: fn(), list: fn(), retrieve: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    confirmationTokens: { retrieve: fn() },
    paymentIntents: { create: fn(), retrieve: fn(), cancel: fn(), search: fn() },
  };
});

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  request,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { stripeWebhookSender } from '../support/stripeWebhook';

const PAYMENTS_SECRET = 'whsec_card_form_payments';
const CONNECT_SECRET = 'whsec_card_form_connect';
const ACCOUNT = 'acct_card';
const PI = 'pi_card_hook';
const TOKEN = 'card_form_webhook_token_0123456789abcdefghij';
const fake = () => require('../../src/modules/stripe/stripe.config');

let firm: Firm;
let owner: Actor;
let clientId: string;
let invoiceId: string;

function surfaces(node: any = fake(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'webhooks') continue;
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...surfaces(value, name));
  }
  return out;
}

const fromFirm = () => stripeWebhookSender(CONNECT_SECRET, { account: ACCOUNT });

function cardIntent(status: string, overrides: Record<string, unknown> = {}, metadata: Record<string, string> = {}) {
  return {
    id: PI, object: 'payment_intent', status, amount: 257_50,
    amount_received: status === 'succeeded' ? 257_50 : 0, created: 1_790_000_000,
    metadata: {
      chargeModel: 'direct', payChannel: 'card_form', lawFirmId: firm.id, invoiceId, contextType: 'client',
      entityId: clientId, clientId, clientUserId: '', paymentMethod: 'card', invoiceAmountCents: '25000',
      surchargeCents: '750', cardFunding: 'credit', cardCountry: 'US', ...metadata,
    },
    ...overrides,
  };
}

async function payments() {
  const { rows } = await testPool.query(
    'select amount_cents, surcharge_cents, stripe_payment_intent_id from invoice_payments where invoice_id = $1', [invoiceId]);
  return rows;
}

async function pointer() {
  const { rows } = await testPool.query(
    `select stripe_card_payment_intent_id as id, stripe_card_payment_intent_account_id as account, status, is_paid
       from invoices where id = $1`, [invoiceId]);
  return rows[0];
}

async function holdForVerification() {
  await testPool.query(
    `update invoices set stripe_card_payment_intent_id = $2, stripe_card_payment_intent_account_id = $3 where id = $1`,
    [invoiceId, PI, ACCOUNT]);
}

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = PAYMENTS_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
});

beforeEach(async () => {
  for (const [name, mock] of surfaces()) {
    mock.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  firm = await createFirm({ name: 'Card Hook LLP' });
  owner = await ownerOf(firm.id);
  await testPool.query(
    `update law_firms
        set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true,
            direct_charges_enabled = true, state = 'TX',
            settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', $3::jsonb, true)
      where id = $1`,
    [firm.id, ACCOUNT, JSON.stringify({ cardFees: { confirmation: {
      stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: 'owner', confirmedAt: '2026-08-01T12:00:00.000Z',
    } } })],
  );
  clientId = (await createPersonClient(firm.id, { email: 'hook@example.test' })).id;
  invoiceId = (await createInvoice(firm.id, clientId, { totalCents: 250_00 })).id;
  await testPool.query(
    `update invoices set invoice_name = 'INV-HOOK-1', stripe_payment_requested = true, stripe_payment_status = 'pending',
            pay_link_token = $2, is_card_fee_passed_on = true where id = $1`, [invoiceId, TOKEN]);
});

describe('Connect payment_intent events for a card-form payment', () => {
  it('records a card-form payment from a Connect payment_intent.succeeded, the fee kept apart', async () => {
    await holdForVerification();

    await fromFirm().deliver('payment_intent.succeeded', cardIntent('succeeded'));

    expect(await payments()).toEqual([{ amount_cents: '25000', surcharge_cents: '750', stripe_payment_intent_id: PI }]);
    expect(await pointer()).toMatchObject({ id: null, account: null, is_paid: true });
  });

  it('records it once when the event arrives twice', async () => {
    const sender = fromFirm();
    await sender.deliver('payment_intent.succeeded', cardIntent('succeeded'));
    await sender.deliver('payment_intent.succeeded', cardIntent('succeeded'));

    expect(await payments()).toHaveLength(1);
  });

  it('ignores a card-form PaymentIntent from an account that is not the firm', async () => {
    await stripeWebhookSender(CONNECT_SECRET, { account: 'acct_other' })
      .deliver('payment_intent.succeeded', cardIntent('succeeded'));

    expect(await payments()).toEqual([]);
    expect(await pointer()).toMatchObject({ is_paid: false });
  });

  it('ignores a platform event that claims to be a card-form payment', async () => {
    await stripeWebhookSender(PAYMENTS_SECRET).deliver('payment_intent.succeeded', cardIntent('succeeded'));

    expect(await payments()).toEqual([]);
  });

  it('releases the invoice and cancels the PaymentIntent on payment_intent.payment_failed', async () => {
    await holdForVerification();
    fake().paymentIntents.cancel.mockResolvedValue({ id: PI, status: 'canceled' });

    await fromFirm().deliver('payment_intent.payment_failed', cardIntent('requires_payment_method'));

    expect(fake().paymentIntents.cancel).toHaveBeenCalledWith(PI, {}, { stripeAccount: ACCOUNT });
    expect(await pointer()).toMatchObject({ id: null, account: null });
    expect(await payments()).toEqual([]);
  });

  it('releases the invoice on payment_intent.canceled', async () => {
    await holdForVerification();

    await fromFirm().deliver('payment_intent.canceled', cardIntent('canceled'));

    expect(await pointer()).toMatchObject({ id: null, account: null });
  });

  it('leaves a newer card payment holding the invoice alone', async () => {
    await testPool.query(
      `update invoices set stripe_card_payment_intent_id = 'pi_newer', stripe_card_payment_intent_account_id = $2 where id = $1`,
      [invoiceId, ACCOUNT]);

    await fromFirm().deliver('payment_intent.canceled', cardIntent('canceled'));

    expect(await pointer()).toMatchObject({ id: 'pi_newer' });
  });

  it('still ignores a Connect event that claims to be a trust deposit', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fromFirm().deliver('payment_intent.succeeded', cardIntent('succeeded', {}, { depositType: 'trust', payChannel: '' }));
      expect(await payments()).toEqual([]);
      expect(warn.mock.calls.some(([, ctx]) => ctx?.reason === 'a trust deposit is never a connected-account event')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('closing the payment surfaces of an invoice with a card payment in flight', () => {
  const onInvoice = (suffix: string) => `/api/lawfirms/${firm.id}/billing/invoices/client/${clientId}/${invoiceId}${suffix}`;

  it('cancels a card payment waiting on verification when the invoice is voided', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(cardIntent('requires_action'));
    fake().paymentIntents.cancel.mockResolvedValue({ id: PI, status: 'canceled' });

    const res = await owner.api.post(onInvoice('/void'));

    expect(res.status).toBe(200);
    expect(fake().paymentIntents.retrieve).toHaveBeenCalledWith(PI, {}, { stripeAccount: ACCOUNT });
    expect(fake().paymentIntents.cancel).toHaveBeenCalledWith(PI, {}, { stripeAccount: ACCOUNT });
    expect(await pointer()).toMatchObject({ id: null, account: null, status: 'voided' });
  });

  it('keeps the invoice from being voided while a card payment is processing', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(cardIntent('processing'));

    const res = await owner.api.post(onInvoice('/void'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/payment is in progress/);
    expect(fake().paymentIntents.cancel).not.toHaveBeenCalled();
    expect(await pointer()).toMatchObject({ id: PI, status: 'outstanding' });
  });

  it('cancels an abandoned card payment when a manual payment changes the balance', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(cardIntent('requires_action'));
    fake().paymentIntents.cancel.mockResolvedValue({ id: PI, status: 'canceled' });

    const res = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 100 });

    expect(res.status).toBe(200);
    expect(fake().paymentIntents.cancel).toHaveBeenCalledWith(PI, {}, { stripeAccount: ACCOUNT });
    expect(await pointer()).toMatchObject({ id: null, account: null });
  });

  it('keeps the pointer when the abandoned card payment cannot be cancelled', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(cardIntent('requires_action'));
    fake().paymentIntents.cancel.mockRejectedValue(new Error('Stripe is down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await owner.api.put(onInvoice('/payment')).send({ paymentAmount: 100 });

      expect(res.status).toBe(200);
      expect(await pointer()).toMatchObject({ id: PI });
    } finally {
      error.mockRestore();
    }
  });

  it('refuses hosted checkout while a card payment is processing', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(cardIntent('processing'));

    const res = await request().post(`/api/pay/${TOKEN}/checkout`).send({ method: 'bank' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_PROCESSING');
    expect(fake().checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('cancels an abandoned card payment before starting hosted checkout', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(cardIntent('requires_action'));
    fake().paymentIntents.cancel.mockResolvedValue({ id: PI, status: 'canceled' });
    fake().customers.list.mockResolvedValue({ data: [] });
    fake().customers.create.mockResolvedValue({ id: 'cus_hook' });
    fake().checkout.sessions.create.mockResolvedValue({ id: 'cs_hook', url: 'https://checkout.stripe.test/cs_hook' });

    const res = await request().post(`/api/pay/${TOKEN}/checkout`).send({ method: 'bank' });

    expect(res.status).toBe(200);
    expect(fake().paymentIntents.cancel).toHaveBeenCalledWith(PI, {}, { stripeAccount: ACCOUNT });
    expect(await pointer()).toMatchObject({ id: null, account: null });
  });

  it('cancels an abandoned card payment when the firm sends a new payment request', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(cardIntent('requires_action'));
    fake().paymentIntents.cancel.mockResolvedValue({ id: PI, status: 'canceled' });

    const res = await owner.api.post(`/api/stripe/payment/${firm.id}/client/${clientId}/${invoiceId}/request`).send({ sendEmail: false });

    expect(res.status).toBe(200);
    expect(fake().paymentIntents.cancel).toHaveBeenCalledWith(PI, {}, { stripeAccount: ACCOUNT });
    expect(await pointer()).toMatchObject({ id: null, account: null });
  });
});
