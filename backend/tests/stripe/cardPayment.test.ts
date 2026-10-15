/**
 * Card payments through the card form on the pay page, for an invoice whose
 * card fee the client pays. The card is read before any charge: a credit card
 * carries the fee, a debit or prepaid card never does, and a card the firm
 * declines is turned away before Stripe is asked to charge anything. A charge
 * that carries a fee takes no Paralegix application fee.
 *
 * Stripe is replaced wholesale; any surface a case does not stub throws.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    customers: { create: fn(), retrieve: fn(), update: fn(), list: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    confirmationTokens: { retrieve: fn() },
    paymentIntents: { create: fn(), retrieve: fn(), cancel: fn(), list: fn() },
  };
});

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  drainEvents,
  emailsMatching,
  resetEmails,
  type Firm,
} from '../support/setupInProcess';
import { request } from '../support/app';
import { refusalMessage } from '../../src/modules/stripe/cardFeeCopy';

const ACCOUNT = 'acct_card';
const TOKEN = 'card_form_fixture_token_0123456789abcdefghij';
const fake = () => require('../../src/modules/stripe/stripe.config');

let firm: Firm;
let invoiceId: string;

function stripeSurfaces(node: any = fake(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...stripeSurfaces(value, name));
  }
  return out;
}

const token = (funding: string, country = 'US') => ({
  id: 'ctoken_1', object: 'confirmation_token',
  payment_method_preview: { type: 'card', card: { brand: 'visa', last4: '4242', funding, country } },
});

/** A PaymentIntent as Stripe answers `create`: the params echoed back with an outcome. */
function intentFrom(id: string, status: string, extra: Record<string, unknown> = {}) {
  return (params: any) => ({
    id, object: 'payment_intent', status, amount: params.amount,
    amount_received: status === 'succeeded' ? params.amount : 0,
    created: 1_790_000_000, metadata: params.metadata, ...extra,
  });
}

async function setCardFees(cardFees: Record<string, unknown>) {
  await testPool.query(
    `update law_firms set settings = jsonb_set(settings, '{billing,cardFees}', (settings->'billing'->'cardFees') || $2::jsonb)
      where id = $1`,
    [firm.id, JSON.stringify(cardFees)],
  );
}

async function payments() {
  const { rows } = await testPool.query(
    `select amount_cents, surcharge_cents, stripe_payment_intent_id, charge_model
       from invoice_payments where invoice_id = $1 order by sort_order`, [invoiceId]);
  return rows;
}

async function invoiceState() {
  const { rows } = await testPool.query(
    `select is_paid, pay_link_token, stripe_payment_requested, stripe_card_payment_intent_id, stripe_card_payment_intent_account_id
       from invoices where id = $1`, [invoiceId]);
  return rows[0];
}

const quote = (body: any = { confirmationTokenId: 'ctoken_1' }) => request().post(`/api/pay/${TOKEN}/card/quote`).send(body);
const confirm = (expectedTotalCents: number) =>
  request().post(`/api/pay/${TOKEN}/card/confirm`).send({ confirmationTokenId: 'ctoken_1', expectedTotalCents });
const complete = (paymentIntentId: string) => request().post(`/api/pay/${TOKEN}/card/complete`).send({ paymentIntentId });

beforeEach(async () => {
  for (const [name, mock] of stripeSurfaces()) {
    mock.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  resetEmails();
  firm = await createFirm({ name: 'Pay Link LLP' });
  await testPool.query(
    `update law_firms
        set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true,
            direct_charges_enabled = true, state = 'TX',
            settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', $3::jsonb, true)
      where id = $1`,
    [firm.id, ACCOUNT, JSON.stringify({
      processingFees: { card: 'client', bank: 'firm' },
      cardFees: {
        debitCards: 'absorb', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30,
        confirmation: {
          stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: 'owner', confirmedAt: '2026-08-01T12:00:00.000Z',
        },
      },
    })],
  );
  const client = await createPersonClient(firm.id, { name: 'Casey Client', email: 'casey@example.test' });
  invoiceId = (await createInvoice(firm.id, client.id, { totalCents: 250_00 })).id;
  await testPool.query(
    `update invoices
        set invoice_name = 'INV-CARD-1', stripe_payment_requested = true, stripe_payment_status = 'pending',
            pay_link_token = $2, is_card_fee_passed_on = true, is_bank_fee_passed_on = false
      where id = $1`,
    [invoiceId, TOKEN],
  );
});

describe('the pay page card setup', () => {
  it('sends a card-fee invoice to the card form with the US credit card fee', async () => {
    const res = await request().get(`/api/pay/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.card).toEqual({
      flow: 'card_form', stripeAccountId: ACCOUNT, creditFeeCents: 7_50, debitCards: 'absorb', internationalCards: 'absorb',
    });
    // The card option names no single fee: it depends on the card.
    expect(res.body.methods).toEqual([
      { method: 'card', feeCents: 0, totalCents: 250_00 },
      { method: 'bank', feeCents: 0, totalCents: 250_00 },
    ]);
  });

  it('uses hosted checkout for card when the client does not pay the card fee', async () => {
    await testPool.query('update invoices set is_card_fee_passed_on = false where id = $1', [invoiceId]);

    const res = await request().get(`/api/pay/${TOKEN}`);

    expect(res.body.card).toEqual({ flow: 'checkout' });
    expect(res.body.methods[0]).toEqual({ method: 'card', feeCents: 0, totalCents: 250_00 });
  });

  it('falls back to hosted checkout for a firm no longer allowed to pass the fee on', async () => {
    await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);

    const res = await request().get(`/api/pay/${TOKEN}`);

    expect(res.body.card).toEqual({ flow: 'checkout' });
  });
});

describe('checking a card', () => {
  it('quotes a US credit card with the capped fee and touches no PaymentIntent', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));

    const res = await quote();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'credit_fee', feeCents: 7_50, invoiceCents: 250_00, totalCents: 257_50,
      card: { brand: 'visa', last4: '4242', funding: 'credit', country: 'US' },
    });
    expect(fake().confirmationTokens.retrieve).toHaveBeenCalledWith('ctoken_1', {}, { stripeAccount: ACCOUNT });
    expect(fake().paymentIntents.create).not.toHaveBeenCalled();
  });

  it('quotes a debit card with no fee', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('debit'));

    const res = await quote();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'no_fee', reason: 'debit', feeCents: 0, invoiceCents: 250_00, totalCents: 250_00,
      card: { brand: 'visa', last4: '4242', funding: 'debit', country: 'US' },
    });
  });

  it('quotes a card of unknown funding type with no fee', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('mystery'));

    const res = await quote();

    expect(res.body).toMatchObject({ outcome: 'no_fee', reason: 'unknown_funding', feeCents: 0, totalCents: 250_00 });
    expect(res.body.card.funding).toBe('unknown');
  });

  it('refuses a debit card when the firm declines them, with the wording-guide message', async () => {
    await setCardFees({ debitCards: 'decline' });
    fake().confirmationTokens.retrieve.mockResolvedValue(token('debit'));

    const res = await quote();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'refused', reason: 'debit_not_accepted',
      message: refusalMessage('debit_not_accepted'),
      invoiceCents: 250_00,
      card: { brand: 'visa', last4: '4242', funding: 'debit', country: 'US' },
    });
    expect(res.body.message).toBe(
      "Debit cards aren't accepted. Use a credit card or pay by bank transfer.");
  });

  it('refuses a non-US card when the firm declines them', async () => {
    await setCardFees({ internationalCards: 'decline' });
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit', 'GB'));

    const res = await quote();

    expect(res.body).toMatchObject({
      outcome: 'refused', reason: 'non_us_not_accepted',
      message: 'Only US cards are accepted. Use a US card or pay by bank transfer.',
    });
  });

  it('refuses something that is not a confirmation token before reaching Stripe', async () => {
    const res = await quote({ confirmationTokenId: 'pm_not_a_token' });

    expect(res.status).toBe(400);
    expect(fake().confirmationTokens.retrieve).not.toHaveBeenCalled();
  });

  it('answers 404 to a token that matches nothing', async () => {
    const res = await request().post('/api/pay/not_a_real_token_0123456789abcdefghijklmno/card/quote')
      .send({ confirmationTokenId: 'ctoken_1' });

    expect(res.status).toBe(404);
    expect(fake().confirmationTokens.retrieve).not.toHaveBeenCalled();
  });

  it('refuses to quote once the firm may no longer pass the fee on', async () => {
    await testPool.query(`update law_firms set state = 'CT' where id = $1`, [firm.id]);

    const res = await quote();

    expect(res.status).toBe(409);
    expect(fake().confirmationTokens.retrieve).not.toHaveBeenCalled();
  });
});

describe('paying by card', () => {
  it('charges the quoted total with no application fee on a credit card', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
    fake().paymentIntents.create.mockImplementation(intentFrom('pi_card_1', 'succeeded'));

    const res = await confirm(257_50);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'succeeded' });
    const [params, opts] = fake().paymentIntents.create.mock.calls[0];
    expect(params).toMatchObject({
      amount: 257_50, currency: 'usd', confirm: true, confirmation_token: 'ctoken_1', payment_method_types: ['card'],
    });
    expect(params.application_fee_amount).toBeUndefined();
    expect(params.metadata).toMatchObject({
      chargeModel: 'direct', payChannel: 'card_form', lawFirmId: firm.id, invoiceId,
      surchargeCents: '750', invoiceAmountCents: '25000', cardFunding: 'credit', cardCountry: 'US', paymentMethod: 'card',
    });
    expect(opts).toMatchObject({ stripeAccount: ACCOUNT });
    // Recorded immediately: $250.00 paid, the $7.50 fee kept out of it.
    expect(await payments()).toEqual([
      { amount_cents: '25000', surcharge_cents: '750', stripe_payment_intent_id: 'pi_card_1', charge_model: 'direct' },
    ]);
    expect(await invoiceState()).toMatchObject({ is_paid: true, pay_link_token: null, stripe_payment_requested: false });
    await drainEvents();
  });

  it('lists the credit card fee apart on the receipt', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
    fake().paymentIntents.create.mockImplementation(intentFrom('pi_card_receipt', 'succeeded'));

    await confirm(257_50).expect(200);
    await drainEvents();

    const [receipt] = emailsMatching(/Payment received: Invoice #INV-CARD-1/);
    expect(receipt.to).toEqual(['casey@example.test']);
    expect(receipt.subject).toBe('Payment received: Invoice #INV-CARD-1 ($250.00)');
    expect(receipt.text).toContain('Credit card fee: $7.50. Total charged: $257.50.');
  });

  it('takes the Paralegix margin on an absorbed debit card', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('debit'));
    fake().paymentIntents.create.mockImplementation(intentFrom('pi_card_debit', 'succeeded'));

    const res = await confirm(250_00);

    expect(res.status).toBe(200);
    const [params] = fake().paymentIntents.create.mock.calls[0];
    expect(params.amount).toBe(250_00);
    // 0.9% of 25000.
    expect(params.application_fee_amount).toBe(2_25);
    expect(params.metadata).toMatchObject({ surchargeCents: '0', cardFunding: 'debit' });
    expect(await payments()).toEqual([
      { amount_cents: '25000', surcharge_cents: '0', stripe_payment_intent_id: 'pi_card_debit', charge_model: 'direct' },
    ]);
    await drainEvents();
  });

  it('refuses to charge when the total the client saw is not the total now', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));

    const res = await confirm(250_00);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FEE_CHANGED');
    expect(res.body.error).toBe('Your total changed. Please review it.');
    expect(fake().paymentIntents.create).not.toHaveBeenCalled();
    expect(await payments()).toEqual([]);
  });

  it('refuses a declined card type at confirm even if the client skipped the quote', async () => {
    await setCardFees({ debitCards: 'decline' });
    fake().confirmationTokens.retrieve.mockResolvedValue(token('debit'));

    const res = await confirm(250_00);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CARD_NOT_ACCEPTED');
    expect(res.body.error).toBe(refusalMessage('debit_not_accepted'));
    expect(fake().paymentIntents.create).not.toHaveBeenCalled();
  });

  it("shows the bank's decline message and records nothing", async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
    fake().paymentIntents.create.mockRejectedValue(Object.assign(new Error('Your card has insufficient funds.'), {
      type: 'StripeCardError', code: 'card_declined',
    }));

    const res = await confirm(257_50);

    // 422, never 402: the app reads every 402 as the firm's subscription lapsing.
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CARD_DECLINED', error: 'Your card has insufficient funds.' });
    expect(await payments()).toEqual([]);
    expect(await invoiceState()).toMatchObject({ is_paid: false, pay_link_token: TOKEN, stripe_card_payment_intent_id: null });
  });

  it('answers 422 CARD_NOT_CHARGED when Stripe leaves the card uncharged without a decline', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
    fake().paymentIntents.create.mockImplementation(intentFrom('pi_card_unpaid', 'requires_payment_method'));

    const res = await confirm(257_50);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CARD_NOT_CHARGED');
    expect(await payments()).toEqual([]);
  });

  it('returns the client secret when the bank asks for verification, and holds the invoice', async () => {
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
    fake().paymentIntents.create.mockImplementation(
      intentFrom('pi_card_2', 'requires_action', { client_secret: 'pi_card_2_secret_x' }));

    const res = await confirm(257_50);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'requires_action', clientSecret: 'pi_card_2_secret_x' });
    expect(await invoiceState()).toMatchObject({
      is_paid: false, stripe_card_payment_intent_id: 'pi_card_2', stripe_card_payment_intent_account_id: ACCOUNT,
    });
    expect(await payments()).toEqual([]);
  });

  it('cancels the verification the client abandoned before charging the card again', async () => {
    await testPool.query(
      `update invoices set stripe_card_payment_intent_id = 'pi_card_old', stripe_card_payment_intent_account_id = $2 where id = $1`,
      [invoiceId, ACCOUNT]);
    fake().paymentIntents.retrieve.mockResolvedValue({ id: 'pi_card_old', status: 'requires_action' });
    fake().paymentIntents.cancel.mockResolvedValue({ id: 'pi_card_old', status: 'canceled' });
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
    fake().paymentIntents.create.mockImplementation(intentFrom('pi_card_new', 'succeeded'));

    const res = await confirm(257_50);

    expect(res.status).toBe(200);
    expect(fake().paymentIntents.cancel).toHaveBeenCalledWith('pi_card_old', {}, { stripeAccount: ACCOUNT });
    // Breaks if the cancelled PaymentIntent is left holding the paid invoice.
    expect(await invoiceState()).toMatchObject({ is_paid: true, stripe_card_payment_intent_id: null });
    await drainEvents();
  });

  it('refuses another card payment while an earlier one is processing', async () => {
    await testPool.query(
      `update invoices set stripe_card_payment_intent_id = 'pi_card_old', stripe_card_payment_intent_account_id = $2 where id = $1`,
      [invoiceId, ACCOUNT]);
    fake().paymentIntents.retrieve.mockResolvedValue({ id: 'pi_card_old', status: 'processing' });
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));

    const res = await confirm(257_50);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_PROCESSING');
    expect(fake().paymentIntents.create).not.toHaveBeenCalled();
  });

  it('refuses a second card payment while a bank checkout is processing', async () => {
    await testPool.query(
      `update invoices set stripe_checkout_session_id = 'cs_ach', stripe_checkout_session_account_id = $2 where id = $1`,
      [invoiceId, ACCOUNT]);
    fake().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_ach', status: 'complete', payment_status: 'unpaid' });
    fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));

    const res = await confirm(257_50);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_PROCESSING');
    expect(fake().paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe('finishing a payment after bank verification', () => {
  async function holdForVerification(id = 'pi_card_2') {
    await testPool.query(
      `update invoices set stripe_card_payment_intent_id = $2, stripe_card_payment_intent_account_id = $3 where id = $1`,
      [invoiceId, id, ACCOUNT]);
  }
  let entityId: string;
  beforeEach(async () => {
    const { rows } = await testPool.query('select client_context_id from invoices where id = $1', [invoiceId]);
    entityId = rows[0].client_context_id;
  });
  const succeeded = (overrides: Record<string, unknown> = {}) => ({
    id: 'pi_card_2', object: 'payment_intent', status: 'succeeded', amount: 257_50, amount_received: 257_50,
    created: 1_790_000_000,
    metadata: {
      chargeModel: 'direct', payChannel: 'card_form', lawFirmId: firm.id, invoiceId,
      contextType: 'client', entityId, paymentMethod: 'card', invoiceAmountCents: '25000', surchargeCents: '750',
    },
    ...overrides,
  });

  it('records on complete once verification succeeds, and releases the invoice', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(succeeded());

    const res = await complete('pi_card_2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'succeeded' });
    expect(fake().paymentIntents.retrieve).toHaveBeenCalledWith('pi_card_2', {}, { stripeAccount: ACCOUNT });
    expect(await payments()).toEqual([
      { amount_cents: '25000', surcharge_cents: '750', stripe_payment_intent_id: 'pi_card_2', charge_model: 'direct' },
    ]);
    expect(await invoiceState()).toMatchObject({
      is_paid: true, stripe_card_payment_intent_id: null, stripe_card_payment_intent_account_id: null,
    });
    await drainEvents();
  });

  it("refuses complete for a PaymentIntent that is not this invoice's", async () => {
    const pi = succeeded();
    pi.metadata.invoiceId = '00000000-0000-4000-8000-000000000000';
    fake().paymentIntents.retrieve.mockResolvedValue(pi);

    const res = await complete('pi_card_2');

    expect(res.status).toBe(404);
    expect(await payments()).toEqual([]);
  });

  it('reports a verification that failed, cancels it and releases the invoice, recording nothing', async () => {
    await holdForVerification();
    fake().paymentIntents.retrieve.mockResolvedValue(succeeded({ status: 'requires_payment_method', amount_received: 0 }));
    fake().paymentIntents.cancel.mockResolvedValue({ id: 'pi_card_2', status: 'canceled' });

    const res = await complete('pi_card_2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'failed' });
    expect(await payments()).toEqual([]);
    // Breaks if the PaymentIntent stays confirmable: its client secret could
    // still pay it with another card at a total priced for this one.
    expect(fake().paymentIntents.cancel).toHaveBeenCalledWith('pi_card_2', {}, { stripeAccount: ACCOUNT });
    expect(await invoiceState()).toMatchObject({ stripe_card_payment_intent_id: null, pay_link_token: TOKEN });
  });

  it('answers succeeded when the webhook already recorded the payment and ended the link', async () => {
    await testPool.query(
      `insert into invoice_payments (invoice_id, law_firm_id, amount_cents, surcharge_cents, stripe_payment_intent_id, charge_model)
       values ($1, $2, 25000, 750, 'pi_card_2', 'direct')`, [invoiceId, firm.id]);
    await testPool.query(
      `update invoices set pay_link_token = null, stripe_payment_requested = false, amount_paid_cents = 25000, is_paid = true
        where id = $1`, [invoiceId]);

    const res = await complete('pi_card_2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'succeeded' });
    expect(fake().paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('answers 404 after the link ended for a PaymentIntent that was never recorded', async () => {
    await testPool.query('update invoices set pay_link_token = null where id = $1', [invoiceId]);

    const res = await complete('pi_unknown');

    expect(res.status).toBe(404);
  });
});
