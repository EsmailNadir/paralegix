/**
 * A payment plan instalment that Stripe settled through a pay-link checkout.
 *
 * Once the client pays an instalment online, its row is recorded money matched
 * to a Stripe payment. A later plan edit (a credit note rebalance, a schedule
 * replacement) has to keep that row exactly as it is and fit the open balance
 * around it, or the schedule stops agreeing with what Stripe collected.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE: stripe.config is replaced wholesale.
 * Settlement is delivered through the real signed webhook route.
 */
jest.mock('../../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    accounts: { create: fn(), retrieve: fn(), update: fn(), createLoginLink: fn() },
    customers: { create: fn(), list: fn(), retrieve: fn(), update: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn() },
    invoiceItems: { create: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn(), expire: fn() } },
    paymentIntents: { create: fn(), retrieve: fn(), search: fn() },
    transfers: { create: fn(), retrieve: fn(), createReversal: fn() },
    refunds: { create: fn() },
  };
});

import { testPool } from '../../support/setupInProcess';
import { stripeWebhookSender } from '../../support/stripeWebhook';
import { usePlanKit } from './planKit';

const WEBHOOK_SECRET = 'whsec_plan_stripe_links_spec';
const fakeStripe = () => require('../../../src/modules/stripe/stripe.config');

const k = usePlanKit(1200);

function surfaces(node: any = fakeStripe(), path = ''): Array<[string, jest.Mock]> {
  const out: Array<[string, jest.Mock]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'webhooks') continue;
    const name = path ? `${path}.${key}` : key;
    if (jest.isMockFunction(value)) out.push([name, value as jest.Mock]);
    else if (value && typeof value === 'object') out.push(...surfaces(value, name));
  }
  return out;
}

/** What Stripe sends when the client pays the instalment at `position` through its checkout session. */
async function stripePays(position: number, cents = 30_000) {
  const { rows } = await testPool.query(
    'select installment_id from invoice_expected_payments where invoice_id = $1 and sort_order = $2',
    [k.invoiceId, position],
  );
  expect(rows).toHaveLength(1);
  await stripeWebhookSender(WEBHOOK_SECRET).deliver('checkout.session.completed', {
    id: `cs_plan_${position}`, object: 'checkout.session', status: 'complete', payment_status: 'paid',
    amount_total: cents,
    created: Math.floor(Date.now() / 1000),
    payment_intent: `pi_plan_${position}`,
    metadata: {
      lawFirmId: k.firm.id, invoiceId: k.invoiceId, contextType: 'client', entityId: k.client.id,
      clientId: k.client.id, paymentMethod: 'card', invoiceAmountCents: String(cents), surchargeCents: '0',
      installmentId: rows[0].installment_id,
    },
  });
}

/** Four $300 instalments from 1 April 2026, the first settled through Stripe. */
async function planWithFirstSettledByStripe() {
  expect((await k.setPlan({ installmentAmount: 300 })).status).toBe(200);
  await stripePays(0);
  // Premise: the webhook recorded a Stripe payment and matched row 0 to it.
  const { rows } = await testPool.query(
    'select payment_source from invoice_payments where invoice_id = $1', [k.invoiceId]);
  expect(rows).toEqual([{ payment_source: 'stripe' }]);
  expect((await k.rows())[0]).toMatchObject({ status: 'paid', matched_payment_index: 0 });
}

beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET; });

beforeEach(() => {
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
});

describe('a plan edit after Stripe settled an instalment', () => {
  it('keeps a Stripe-settled row untouched through a credit note rebalance', async () => {
    await planWithFirstSettledByStripe();
    const paidBefore = (await k.rows())[0];

    const res = await k.owner.api.post(k.on('/credit-note')).send({ amount: 100, type: 'write_off' });
    expect(res.status).toBe(200);

    const after = await k.rows();
    expect(after[0]).toMatchObject({
      status: 'paid', amount_cents: paidBefore.amount_cents, matched_payment_index: 0, due_date: '2026-04-01',
    });
    expect(after.slice(1).map((r) => [Number(r.amount_cents), r.status])).toEqual([
      [30_000, 'pending'], [30_000, 'pending'], [20_000, 'pending'],
    ]);
    await k.expectScheduleMatchesBalance(undefined, 'rebalance after stripe');
  });

  it('keeps a Stripe-settled row untouched when the schedule is replaced', async () => {
    await planWithFirstSettledByStripe();

    const res = await k.owner.api.patch(k.on('/payment-plan/schedule')).send({
      installments: [{ dueDate: '2026-08-01', amount: 450 }, { dueDate: '2026-09-01', amount: 450 }],
    });
    expect(res.status).toBe(200);

    const rows = await k.rows();
    expect(rows[0]).toMatchObject({ status: 'paid', due_date: '2026-04-01', matched_payment_index: 0 });
    expect(rows.slice(1).map((r) => [r.due_date, Number(r.amount_cents)])).toEqual([
      ['2026-08-01', 45_000], ['2026-09-01', 45_000],
    ]);
    await k.expectScheduleMatchesBalance(undefined, 'replace after stripe');
  });

  it('leaves the unpaid remainder when a delayed checkout paid less than the installment now owes', async () => {
    await k.setPlan({ installmentAmount: 300 }).expect(200);
    await k.owner.api.patch(k.on('/payment-plan/installment/0')).send({ amount: 350 }).expect(200);
    await stripePays(0, 30_000);
    expect((await k.rows())[0]).toMatchObject({ amount_cents: '5000', status: 'pending', matched_payment_index: null });
    expect(await k.payments()).toEqual([{ amount_cents: '30000', payment_date: expect.any(String) }]);
    await k.expectScheduleMatchesBalance();
  });
});

describe('a plan edit while installment checkout is open', () => {
  async function openCheckout() {
    await k.setPlan({ installmentAmount: 300 }).expect(200);
    const rows = await testPool.query(
      'select installment_id from invoice_expected_payments where invoice_id = $1 and sort_order = 0', [k.invoiceId],
    );
    expect(rows.rows).toHaveLength(1);
    await testPool.query(`update invoices set stripe_payment_requested = true, stripe_payment_status = 'pending',
      pay_link_token = 'plan_checkout_token_0123456789', pay_link_installment_id = $2,
      stripe_checkout_session_id = 'cs_plan_open', stripe_checkout_session_account_id = 'platform' where id = $1`,
    [k.invoiceId, rows.rows[0].installment_id]);
    fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_plan_open', status: 'open' });
    fakeStripe().checkout.sessions.expire.mockResolvedValue({ id: 'cs_plan_open', status: 'expired' });
  }

  const edit = (action: string) => {
    if (action === 'remove') return k.owner.api.delete(k.on('/payment-plan'));
    if (action === 'replace') return k.owner.api.patch(k.on('/payment-plan/schedule')).send({
      installments: [{ dueDate: '2026-08-01', amount: 600 }, { dueDate: '2026-09-01', amount: 600 }],
    });
    if (action === 'reset') return k.setPlan({ installmentAmount: 400 });
    return k.owner.api.patch(k.on('/payment-plan/installment/0')).send({ amount: action === 'increase' ? 350 : 250 });
  };

  it.each(['increase', 'decrease', 'replace', 'remove', 'reset'])('expires the old checkout before a plan %s commits', async (action) => {
    await openCheckout();
    await edit(action).expect(200);
    expect(fakeStripe().checkout.sessions.expire).toHaveBeenCalledWith('cs_plan_open');
    const state = await testPool.query('select stripe_checkout_session_id, pay_link_token from invoices where id = $1', [k.invoiceId]);
    expect(state.rows[0]).toEqual({ stripe_checkout_session_id: null, pay_link_token: 'plan_checkout_token_0123456789' });
    await k.expectScheduleMatchesBalance();
  });

  it.each(['complete', 'unreachable'])('keeps the plan unchanged when checkout is %s', async (state) => {
    await openCheckout();
    const before = await k.rows();
    if (state === 'complete') fakeStripe().checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_plan_open', status: 'complete', payment_status: 'unpaid' });
    else fakeStripe().checkout.sessions.expire.mockRejectedValue(new Error('Stripe unavailable'));
    const res = await edit('increase');
    expect(res.status).toBe(state === 'complete' ? 409 : 502);
    expect(await k.rows()).toEqual(before);
    expect((await testPool.query('select stripe_checkout_session_id from invoices where id = $1', [k.invoiceId])).rows[0].stripe_checkout_session_id).toBe('cs_plan_open');
  });
});
