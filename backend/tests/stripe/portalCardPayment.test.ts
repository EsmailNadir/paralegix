/**
 * The card form in the client portal: the same card check and charge as the
 * pay link, reached by a signed-in client for an invoice billed to them. The
 * charge names the client who paid, and returns to their billing page.
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

import { testPool, createFirm, drainEvents, type Firm } from '../support/setupInProcess';
import { portalPath, portalPerson, seedClientInvoice, type PortalPerson } from '../clients/portalWorld';

const ACCOUNT = 'acct_portal_card';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const fake = () => require('../../src/modules/stripe/stripe.config');

let firm: Firm;
let payer: PortalPerson;
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
  id: 'ctoken_portal', object: 'confirmation_token',
  payment_method_preview: { type: 'card', card: { brand: 'mastercard', last4: '4444', funding, country } },
});

const cardPath = (step: string) => portalPath(firm.id, `billing/pay/${invoiceId}/card/${step}`);

beforeEach(async () => {
  for (const [name, mock] of stripeSurfaces()) {
    mock.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  firm = await createFirm({ name: 'Portal Card LLP' });
  await testPool.query(
    `update law_firms
        set stripe_account_id = $2, stripe_charges_enabled = true, stripe_onboarding_complete = true,
            direct_charges_enabled = true, state = 'Texas',
            settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{billing}', $3::jsonb, true)
      where id = $1`,
    [firm.id, ACCOUNT, JSON.stringify({
      cardFees: {
        debitCards: 'decline', internationalCards: 'absorb', ratePercent: 2.9, fixedCents: 30,
        confirmation: {
          stripeNotifiedOn: '2026-08-01', engagementLetterConfirmed: true, confirmedBy: 'owner', confirmedAt: '2026-08-01T12:00:00.000Z',
        },
      },
    })],
  );
  payer = await portalPerson(firm.id, 'Paula Portal');
  invoiceId = (await seedClientInvoice(firm.id, payer.clientId, {
    totalCents: 380_00, invoiceNumber: 'INV-PORTAL-CARD', stripePaymentRequested: true,
  })).id;
  await testPool.query(
    `update invoices set invoice_name = 'INV-PORTAL-CARD', is_card_fee_passed_on = true where id = $1`, [invoiceId]);
});

it('offers the card form in the payment options, with no single card fee', async () => {
  const res = await payer.api.get(portalPath(firm.id, `billing/pay/${invoiceId}/options`));

  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    invoiceCents: 380_00,
    // 3% of 38000 caps the fee below the 2.9% + 30c gross-up (1,163).
    card: { flow: 'card_form', stripeAccountId: ACCOUNT, creditFeeCents: 11_40, debitCards: 'decline', internationalCards: 'absorb' },
    methods: [
      { method: 'card', feeCents: 0, totalCents: 380_00 },
      { method: 'bank', feeCents: 0, totalCents: 380_00 },
    ],
  });
});

it('quotes the card the client entered', async () => {
  fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));

  const res = await payer.api.post(cardPath('quote')).send({ confirmationTokenId: 'ctoken_portal' });

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ outcome: 'credit_fee', feeCents: 11_40, invoiceCents: 380_00, totalCents: 391_40 });
});

it('turns away a declined debit card and says how to pay instead', async () => {
  fake().confirmationTokens.retrieve.mockResolvedValue(token('debit'));

  const res = await payer.api.post(cardPath('quote')).send({ confirmationTokenId: 'ctoken_portal' });

  expect(res.body).toMatchObject({
    outcome: 'refused', reason: 'debit_not_accepted',
    message: "Debit cards aren't accepted. Use a credit card or pay by bank transfer.",
  });
});

it('charges the card, naming the client who paid, and returns to their billing page', async () => {
  fake().confirmationTokens.retrieve.mockResolvedValue(token('credit'));
  fake().paymentIntents.create.mockImplementation((params: any) => ({
    id: 'pi_portal_1', status: 'succeeded', amount: params.amount, amount_received: params.amount,
    created: 1_790_000_000, metadata: params.metadata,
  }));

  const res = await payer.api.post(cardPath('confirm')).send({ confirmationTokenId: 'ctoken_portal', expectedTotalCents: 391_40 });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'succeeded' });
  const [params, opts] = fake().paymentIntents.create.mock.calls[0];
  expect(opts).toMatchObject({ stripeAccount: ACCOUNT });
  // Where hosted checkout already returns a portal client.
  expect(params.return_url).toBe(`${FRONTEND_URL}/client/lawfirm/${firm.id}/billing?payment=success`);
  expect(params.metadata).toMatchObject({ clientId: payer.clientId, clientUserId: payer.uid, surchargeCents: '1140' });
  const { rows } = await testPool.query(
    'select amount_cents, surcharge_cents from invoice_payments where invoice_id = $1', [invoiceId]);
  expect(rows).toEqual([{ amount_cents: '38000', surcharge_cents: '1140' }]);
  await drainEvents();
});

it('records a payment finished after bank verification', async () => {
  await testPool.query(
    `update invoices set stripe_card_payment_intent_id = 'pi_portal_2', stripe_card_payment_intent_account_id = $2 where id = $1`,
    [invoiceId, ACCOUNT]);
  fake().paymentIntents.retrieve.mockResolvedValue({
    id: 'pi_portal_2', status: 'succeeded', amount: 391_40, amount_received: 391_40, created: 1_790_000_000,
    metadata: {
      chargeModel: 'direct', payChannel: 'card_form', lawFirmId: firm.id, invoiceId, contextType: 'client',
      entityId: payer.clientId, clientId: payer.clientId, clientUserId: payer.uid, surchargeCents: '1140',
    },
  });

  const res = await payer.api.post(cardPath('complete')).send({ paymentIntentId: 'pi_portal_2' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'succeeded' });
  const { rows } = await testPool.query(
    'select is_paid, stripe_card_payment_intent_id from invoices where id = $1', [invoiceId]);
  expect(rows[0]).toEqual({ is_paid: true, stripe_card_payment_intent_id: null });
  await drainEvents();
});
