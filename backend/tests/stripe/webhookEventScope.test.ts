/**
 * Which Stripe events the payments webhook is willing to act on at all.
 *
 * A verified signature only proves Stripe sent the event. It does not prove the
 * event is about money Paralegix collected for the firm it names:
 *
 * - Stripe delivers TEST-mode Connect events to LIVE Connect endpoints. A firm on
 *   a Standard account can create a test-mode checkout on its own account and
 *   write any metadata it likes, including another firm's invoice id. So an
 *   event whose `livemode` disagrees with `STRIPE_SECRET_KEY` is acknowledged
 *   and ignored.
 * - A Connect event (`event.account` set) is about that connected account's own
 *   objects. An invoice checkout on it is honoured only when it is a direct
 *   charge AND the firm its metadata names owns that account. A trust deposit
 *   is a platform destination charge and never carries `event.account`. A
 *   refund or dispute on it reverses an invoice payment only when that payment
 *   was a direct charge. It is not compared with the firm's current account:
 *   payment intent ids are unique across Stripe, so the event can only come
 *   from the account the charge was made on, even after the firm reconnects.
 * - A platform event never describes a direct charge, which lives on the firm's
 *   account, so a platform checkout claiming `chargeModel: 'direct'` is ignored.
 * - A checkout session that is not an invoice payment (a subscription checkout,
 *   or a firm's own checkout with none of our metadata) is acknowledged rather
 *   than failed, so Stripe does not retry it for three days.
 *
 * Every SDK surface is a jest.fn that throws unless a case stubs it.
 */
jest.mock('../../src/modules/stripe/stripe.config', () => {
  const fn = () => jest.fn();
  return {
    webhooks: require('stripe').webhooks,
    accounts: { retrieve: fn() },
    charges: { retrieve: fn() },
    customers: { create: fn(), list: fn(), retrieve: fn() },
    invoices: { create: fn(), retrieve: fn(), voidInvoice: fn(), finalizeInvoice: fn(), pay: fn() },
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
  drainEvents,
} from '../support/setupInProcess';
import { claimedEventIds, deliverSigned, newPaymentIntentId, seedStripePaidInvoice } from '../support/stripeWebhook';

const PAYMENTS_SECRET = 'whsec_event_scope_payments';
const CONNECT_SECRET = 'whsec_event_scope_connect';
const TEST_KEY = 'sk_test_offline_event_scope_suite';
const LIVE_KEY = 'sk_live_offline_event_scope_suite';

const fakeStripe = () => require('../../src/modules/stripe/stripe.config');

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

/**
 * Deliver one event. `account` makes it a Connect event signed with the Connect
 * secret; `livemode` is left off (as the other fixtures do) unless a case sets it.
 */
async function deliver(type: string, object: unknown, opts: { account?: string; livemode?: boolean } = {}) {
  const eventId = `evt_scope_${randomUUID().slice(0, 12)}`;
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    ...(opts.account ? { account: opts.account } : {}),
    ...(opts.livemode !== undefined ? { livemode: opts.livemode } : {}),
    data: { object },
  });
  const res = await deliverSigned(payload, opts.account ? CONNECT_SECRET : PAYMENTS_SECRET);
  await drainEvents();
  return { res, eventId };
}

/** A firm on direct charges through its own Standard account. */
async function directFirm() {
  const firm = await createFirm();
  const account = `acct_scope_${randomUUID().slice(0, 8)}`;
  const res = await testPool.query(
    `update law_firms set stripe_account_id = $2, stripe_charges_enabled = true,
            stripe_onboarding_complete = true, direct_charges_enabled = true
      where id = $1`,
    [firm.id, account],
  );
  expect(res.rowCount).toBe(1);
  const client = await createPersonClient(firm.id, { email: `scope-${randomUUID().slice(0, 6)}@example.test` });
  const invoice = await createInvoice(firm.id, client.id, { totalCents: 25_000 });
  return { firmId: firm.id, account, clientId: client.id, invoiceId: invoice.id };
}

type FirmWorld = Awaited<ReturnType<typeof directFirm>>;

function invoiceCheckout(w: FirmWorld, extra: Record<string, string> = { chargeModel: 'direct' }) {
  return {
    id: `cs_${randomUUID().slice(0, 8)}`,
    object: 'checkout.session',
    mode: 'payment',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 25_000,
    payment_intent: newPaymentIntentId(),
    created: Math.floor(Date.now() / 1000),
    metadata: { lawFirmId: w.firmId, invoiceId: w.invoiceId, contextType: 'client', entityId: w.clientId, ...extra },
  };
}

async function invoiceMoney(invoiceId: string) {
  const { rows } = await testPool.query(
    `select i.amount_paid_cents, i.is_paid,
            (select count(*) from invoice_payments p where p.invoice_id = i.id) as payment_count
       from invoices i where i.id = $1`,
    [invoiceId],
  );
  return { paid: Number(rows[0].amount_paid_cents), isPaid: rows[0].is_paid, payments: Number(rows[0].payment_count) };
}

const UNPAID = { paid: 0, isPaid: false, payments: 0 };
const PAID = { paid: 25_000, isPaid: true, payments: 1 };

let warnSpy: jest.SpyInstance;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = PAYMENTS_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
});

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = TEST_KEY;
  for (const [name, fn] of surfaces()) {
    fn.mockReset().mockImplementation(() => {
      throw new Error(`stripe.${name} was called; this spec did not expect it`);
    });
  }
  warnSpy = jest.spyOn(console, 'warn');
});

afterEach(() => {
  warnSpy.mockRestore();
});

afterAll(() => {
  process.env.STRIPE_SECRET_KEY = TEST_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
});

/** The warning logged for an ignored event, found by its event id or the payment intent it names. */
function ignoredLogFor(id: string) {
  return warnSpy.mock.calls.find((args) => JSON.stringify(args).includes(id));
}

describe('a Connect checkout event', () => {
  it('records a direct charge on the account of the firm it names', async () => {
    const a = await directFirm();

    const { res } = await deliver('checkout.session.completed', invoiceCheckout(a), { account: a.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(a.invoiceId)).toEqual(PAID);
  });

  it('is ignored when it names another firm\'s invoice, and that invoice stays unpaid', async () => {
    const a = await directFirm();
    const b = await directFirm();

    // Firm A's own account sends a checkout whose metadata names firm B.
    const { res, eventId } = await deliver('checkout.session.completed', invoiceCheckout(b), { account: a.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(b.invoiceId)).toEqual(UNPAID);
    expect(ignoredLogFor(eventId)).toBeDefined();
  });

  it('is ignored when it is not a direct charge, even on the firm\'s own account', async () => {
    const a = await directFirm();

    const { res } = await deliver('checkout.session.completed', invoiceCheckout(a, {}), { account: a.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(a.invoiceId)).toEqual(UNPAID);
  });

  it('does not let an async settlement from another firm\'s account mark an invoice paid', async () => {
    const a = await directFirm();
    const b = await directFirm();

    const { res } = await deliver('checkout.session.async_payment_succeeded', invoiceCheckout(b), { account: a.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(b.invoiceId)).toEqual(UNPAID);
  });
});

describe('a platform checkout event', () => {
  it('is ignored when it claims to be a direct charge', async () => {
    const a = await directFirm();

    const { res, eventId } = await deliver('checkout.session.completed', invoiceCheckout(a));

    expect(res.status).toBe(200);
    expect(await invoiceMoney(a.invoiceId)).toEqual(UNPAID);
    expect(ignoredLogFor(eventId)).toBeDefined();
  });

  it('still records a destination charge', async () => {
    const a = await directFirm();

    const { res } = await deliver('checkout.session.completed', invoiceCheckout(a, {}));

    expect(res.status).toBe(200);
    expect(await invoiceMoney(a.invoiceId)).toEqual(PAID);
  });
});

describe('an event from the other Stripe mode', () => {
  it('is acknowledged and ignored when a test-mode event reaches a live key', async () => {
    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    const a = await directFirm();

    const { res, eventId } = await deliver(
      'checkout.session.completed', invoiceCheckout(a), { account: a.account, livemode: false },
    );

    expect(res.status).toBe(200);
    expect(await invoiceMoney(a.invoiceId)).toEqual(UNPAID);
    expect(ignoredLogFor(eventId)).toBeDefined();
  });

  it('is acted on when its mode matches a live key', async () => {
    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    const a = await directFirm();

    const { res } = await deliver(
      'checkout.session.completed', invoiceCheckout(a), { account: a.account, livemode: true },
    );

    expect(res.status).toBe(200);
    expect(await invoiceMoney(a.invoiceId)).toEqual(PAID);
  });

  it('is acknowledged and ignored when a live event reaches a test key', async () => {
    const a = await directFirm();

    const { res } = await deliver('checkout.session.completed', invoiceCheckout(a, {}), { livemode: true });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(a.invoiceId)).toEqual(UNPAID);
  });
});

describe('a trust payment event on a connected account', () => {
  it('posts no deposit, because a trust deposit is never a Connect event', async () => {
    const a = await directFirm();
    const accountId = randomUUID();
    await testPool.query(
      `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents, stripe_connected_account_id)
       values ($1, $2, 'Scope IOLTA', 'iolta', 'active', 0, $3)`,
      [accountId, a.firmId, a.account],
    );
    const pi = newPaymentIntentId();

    const { res, eventId } = await deliver('payment_intent.succeeded', {
      id: pi, object: 'payment_intent', amount: 55_500, amount_received: 55_500,
      metadata: { depositType: 'trust', lawFirmId: a.firmId, trustAccountId: accountId, clientId: a.clientId },
    }, { account: a.account });

    expect(res.status).toBe(200);
    const { rows } = await testPool.query('select count(*)::int as n from trust_transactions where stripe_payment_intent_id = $1', [pi]);
    expect(rows[0].n).toBe(0);
    expect(ignoredLogFor(eventId)).toBeDefined();
  });
});

describe('a Connect refund or dispute', () => {
  async function directPaidInvoice() {
    const w = await directFirm();
    const pi = newPaymentIntentId();
    const seeded = await seedStripePaidInvoice(w.firmId, pi);
    const marked = await testPool.query(
      `update invoice_payments set charge_model = 'direct' where invoice_id = $1`, [seeded.invoiceId],
    );
    expect(marked.rowCount).toBe(1);
    return { ...w, invoiceId: seeded.invoiceId, pi };
  }

  it('ignores a Connect refund for a payment that was not a direct charge', async () => {
    const a = await directFirm();
    const pi = newPaymentIntentId();
    const seeded = await seedStripePaidInvoice(a.firmId, pi);
    // Premise: the seeded payment is a destination charge, which lives on the platform.
    const { rows } = await testPool.query(
      `select charge_model from invoice_payments where invoice_id = $1`, [seeded.invoiceId],
    );
    expect(rows[0].charge_model).not.toBe('direct');

    const { res } = await deliver('charge.refunded', {
      id: 'ch_scope', object: 'charge', payment_intent: pi, amount_refunded: 25_000,
    }, { account: a.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(seeded.invoiceId)).toEqual(PAID);
    expect(ignoredLogFor(pi)).toBeDefined();
  });

  it('reverses the payment when the refund comes from the account that owns it', async () => {
    const b = await directPaidInvoice();

    const { res } = await deliver('charge.refunded', {
      id: 'ch_scope', object: 'charge', payment_intent: b.pi, amount_refunded: 25_000,
    }, { account: b.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(b.invoiceId)).toEqual({ paid: 0, isPaid: false, payments: 1 });
  });

  it('still reverses a charge made on the firm\'s previous account after it reconnects', async () => {
    const b = await directPaidInvoice();
    const reconnected = await testPool.query(
      `update law_firms set stripe_account_id = $2 where id = $1`,
      [b.firmId, `acct_scope_new_${randomUUID().slice(0, 8)}`],
    );
    expect(reconnected.rowCount).toBe(1);

    const { res } = await deliver('charge.refunded', {
      id: 'ch_scope', object: 'charge', payment_intent: b.pi, amount_refunded: 25_000,
    }, { account: b.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(b.invoiceId)).toEqual({ paid: 0, isPaid: false, payments: 1 });
  });

  it('restores a won dispute reported by the firm\'s previous account after it reconnects', async () => {
    const b = await directPaidInvoice();
    await deliver('charge.dispute.created', {
      id: 'dp_scope', object: 'dispute', payment_intent: b.pi, amount: 25_000, status: 'needs_response',
    }, { account: b.account });
    // Premise: the dispute reversed the payment.
    expect(await invoiceMoney(b.invoiceId)).toEqual({ paid: 0, isPaid: false, payments: 1 });
    await testPool.query(
      `update law_firms set stripe_account_id = $2 where id = $1`,
      [b.firmId, `acct_scope_new_${randomUUID().slice(0, 8)}`],
    );

    const { res } = await deliver('charge.dispute.closed', {
      id: 'dp_scope', object: 'dispute', payment_intent: b.pi, amount: 25_000, status: 'won',
      created: Math.floor(Date.now() / 1000),
    }, { account: b.account });

    expect(res.status).toBe(200);
    expect(await invoiceMoney(b.invoiceId)).toEqual(PAID);
  });
});

describe('a checkout session that is not an invoice payment', () => {
  const subscriptionSession = (lawFirmId: string) => ({
    id: `cs_sub_${randomUUID().slice(0, 8)}`,
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 9_900,
    subscription: 'sub_scope',
    created: Math.floor(Date.now() / 1000),
    metadata: { lawFirmId, userId: 'user_scope', planId: 'professional', interval: 'month' },
  });

  it.each([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
  ])('a subscription-mode %s is acknowledged and stays claimed', async (type) => {
    const firm = await createFirm();

    const { res, eventId } = await deliver(type, subscriptionSession(firm.id));

    // A 500 releases the claim and Stripe retries for days.
    expect(res.status).toBe(200);
    expect(await claimedEventIds()).toContain(eventId);
  });

  it('a payment-mode session with none of the invoice metadata is acknowledged', async () => {
    const { res } = await deliver('checkout.session.completed', {
      id: `cs_other_${randomUUID().slice(0, 8)}`, object: 'checkout.session', mode: 'payment',
      status: 'complete', payment_status: 'paid', amount_total: 1_000, payment_intent: newPaymentIntentId(),
      created: Math.floor(Date.now() / 1000), metadata: {},
    });

    expect(res.status).toBe(200);
  });
});
