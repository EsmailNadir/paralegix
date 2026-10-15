/**
 * Refunds, disputes and the events that undo them, delivered the way Stripe
 * delivers them: a genuinely-signed payload through the real payments webhook
 * route, into real Postgres. The assertion is always the persisted money state.
 *
 * `stripe.service.test.ts` pins the invoice-reversal arithmetic by calling the
 * handler directly against an in-memory repository. That proves the maths and
 * nothing about the route: which handler each event type reaches, the argument
 * the route builds for a dispute, or what the trust ledger does. This file is
 * that other half.
 *
 * Automatic cash recovery (reversing the connected transfer, charging the firm's
 * card for a shortfall) is OFF here, its production default, which
 * `tests/support/db.ts` forces whatever the developer's `.env` says. Every Stripe
 * SDK surface records its name before it throws. The recovery code catches its
 * own errors, so a throw alone would pass unnoticed; the `afterEach` below fails
 * any case in which a Stripe call was attempted at all.
 * `stripeAutoRecovery.test.ts` covers recovery switched on.
 */

/** Every Stripe SDK surface a handler reached for. Must stay empty. */
const mockStripeCalls: string[] = [];

jest.mock('../../src/modules/stripe/stripe.config', () => {
  // `require`, not `import`: the package's ESM entry does not parse under Jest.
  const StripeLib = require('stripe');
  const refuse = (name: string) => () => {
    mockStripeCalls.push(name);
    throw new Error(`stripe.${name} was called; recovery is off, so no Stripe call may happen`);
  };
  return {
    webhooks: StripeLib.webhooks,
    invoices: { create: refuse('invoices.create'), retrieve: refuse('invoices.retrieve') },
    customers: { retrieve: refuse('customers.retrieve') },
    paymentIntents: { create: refuse('paymentIntents.create'), retrieve: refuse('paymentIntents.retrieve') },
    transfers: {
      create: refuse('transfers.create'),
      retrieve: refuse('transfers.retrieve'),
      createReversal: refuse('transfers.createReversal'),
    },
  };
});

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createPersonClient,
  createInvoice,
  ownerOf,
  memberWith,
  type Firm,
} from '../support/setupInProcess';
import {
  STRIPE_DEPOSIT_CENTS as DEPOSIT_CENTS,
  STRIPE_INVOICE_CENTS as INVOICE_CENTS,
  newPaymentIntentId,
  seedStripePaidInvoice,
  seedStripeTrustDeposit,
  stripeInvoiceMoney as invoiceMoney,
  stripeWebhookSender,
  trustBookBalance as bookBalance,
  trustRowsFor as trustRows,
} from '../support/stripeWebhook';

const WEBHOOK_SECRET = 'whsec_reversal_webhooks_spec_secret';
const { deliver, refunded, disputed, disputeClosed, refundUpdated } = stripeWebhookSender(WEBHOOK_SECRET);

let firm: Firm;

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  firm = await createFirm();
  mockStripeCalls.length = 0;
});

afterEach(() => {
  // With recovery off, reversing and restoring money is a database-only decision.
  expect(mockStripeCalls).toEqual([]);
});

describe('charge.refunded on an invoice payment', () => {
  it('reverses a full refund: the payment nets to zero and the invoice is no longer paid', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);

    await refunded(pi, INVOICE_CENTS);

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 0, isPaid: false, paymentCents: 0, refundedCents: INVOICE_CENTS,
    });
  });

  it('converges on the cumulative refunded amount across partials and a replay', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);

    await refunded(pi, 10_000);
    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 15_000, isPaid: false, paymentCents: 15_000, refundedCents: 10_000,
    });

    // Stripe re-reports the same cumulative total (a replay, new event id): no second reversal.
    await refunded(pi, 10_000);
    expect((await invoiceMoney(invoiceId)).paymentCents).toBe(15_000);

    // A second partial: Stripe's figure is cumulative, so only the 8,000 difference comes off.
    await refunded(pi, 18_000);
    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 7_000, isPaid: false, paymentCents: 7_000, refundedCents: 18_000,
    });
  });

  it('ignores an older, smaller cumulative total that arrives after a larger one', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);

    await refunded(pi, 18_000);
    await refunded(pi, 10_000);

    expect((await invoiceMoney(invoiceId)).refundedCents).toBe(18_000);
    expect((await invoiceMoney(invoiceId)).paymentCents).toBe(7_000);
  });

  it('leaves another firm\'s invoice untouched when the payment intent is not its own', async () => {
    const pi = newPaymentIntentId();
    const other = await createFirm();
    const { invoiceId } = await seedStripePaidInvoice(other.id, pi);

    await refunded(`pi_unrelated_${randomUUID().slice(0, 8)}`, INVOICE_CENTS);

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: INVOICE_CENTS, isPaid: true, paymentCents: INVOICE_CENTS, refundedCents: 0,
    });
  });
});

describe('charge.dispute.created on an invoice payment', () => {
  it('reverses only the disputed portion of a partial dispute', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);

    await disputed(pi, 6_000);

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 19_000, isPaid: false, paymentCents: 19_000, refundedCents: 6_000,
    });

    // A redelivery of the same dispute (a new event id) converges on the same
    // figures rather than reversing the disputed amount a second time.
    await disputed(pi, 6_000);

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 19_000, isPaid: false, paymentCents: 19_000, refundedCents: 6_000,
    });
  });
});

describe('charge.dispute.closed on an invoice payment', () => {
  it('restores the reversed payment when the dispute is won', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await disputed(pi, INVOICE_CENTS);
    expect((await invoiceMoney(invoiceId)).isPaid).toBe(false);

    await disputeClosed(pi, INVOICE_CENTS, 'won');

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: INVOICE_CENTS, isPaid: true, paymentCents: INVOICE_CENTS, refundedCents: 0,
    });
  });

  it('leaves the reversal in place when the dispute is lost', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await disputed(pi, INVOICE_CENTS);

    await disputeClosed(pi, INVOICE_CENTS, 'lost');

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: 0, isPaid: false, paymentCents: 0, refundedCents: INVOICE_CENTS,
    });
  });
});

describe('charge.refund.updated on an invoice payment', () => {
  it('restores a refund that failed after it was reversed', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await refunded(pi, 10_000);

    await refundUpdated(pi, 10_000, 'failed');

    expect(await invoiceMoney(invoiceId)).toEqual({
      amountPaid: INVOICE_CENTS, isPaid: true, paymentCents: INVOICE_CENTS, refundedCents: 0,
    });
  });

  it('changes nothing for a refund update that did not fail', async () => {
    const pi = newPaymentIntentId();
    const { invoiceId } = await seedStripePaidInvoice(firm.id, pi);
    await refunded(pi, 10_000);

    await refundUpdated(pi, 10_000, 'succeeded');

    expect((await invoiceMoney(invoiceId)).paymentCents).toBe(15_000);
  });
});

describe('reversals on a trust deposit', () => {
  it('voids the deposit on a full refund and takes the balance to zero', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);

    await refunded(pi, DEPOSIT_CENTS);

    expect((await trustRows(accountId))[0]).toMatchObject({ type: 'deposit', status: 'void', cents: DEPOSIT_CENTS });
    expect(await bookBalance(accountId)).toBe(0);
  });

  it('posts a reversing withdrawal for a partial refund, once, however often it is replayed', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);

    await refunded(pi, 20_000);
    await refunded(pi, 20_000);

    const rows = await trustRows(accountId);
    expect(rows[0]).toMatchObject({ type: 'deposit', status: 'completed', cents: DEPOSIT_CENTS });
    expect(rows.filter((r) => r.type === 'withdrawal')).toEqual([
      expect.objectContaining({ status: 'completed', cents: 20_000 }),
    ]);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 20_000);
  });

  it('refuses to reverse a refund the client has already spent, and alerts the firm with the exact shortfall', async () => {
    // The deposit funded a disbursement before Stripe clawed part of it back.
    // Reversing now would drive the client's trust balance negative, so the
    // ledger refuses; the balance is then overstated, and the only thing that
    // gets a human to correct it is the alert.
    const owner = await ownerOf(firm.id);
    const pi = newPaymentIntentId();
    const { accountId, clientId, depositId } = await seedStripeTrustDeposit(firm.id, pi);
    const disbursed = await owner.api.post(`/api/lawfirms/${firm.id}/trust/transactions`).send({
      trustAccountId: accountId, clientId, clientName: 'Trust Client', type: 'withdrawal',
      amountCents: 50_000, date: '2026-03-15',
    });
    expect(disbursed.status).toBe(201);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await refunded(pi, 20_001);
    } finally {
      errorSpy.mockRestore();
    }

    expect((await trustRows(accountId)).map((r) => [r.type, r.status, r.cents])).toEqual([
      ['deposit', 'completed', DEPOSIT_CENTS],
      ['withdrawal', 'completed', 50_000],
    ]);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 50_000);
    const { rows } = await testPool.query(
      `select user_id, title, body from notifications
        where law_firm_id = $1 and type = 'trust_reversal_failed'`,
      [firm.id],
    );
    expect(rows).toEqual([{
      user_id: owner.uid,
      title: 'Trust deposit clawback needs attention',
      body: 'A returned or disputed trust deposit of $200.01 could not be reversed automatically (ACH return / refund). '
        + 'The client\'s trust balance may be overstated. '
        + `Review and correct it manually (transaction ${depositId}).`,
    }]);
  });

  it('re-credits the full deposit when the dispute that voided it is won', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    await disputed(pi, DEPOSIT_CENTS);
    expect(await bookBalance(accountId)).toBe(0);

    await disputeClosed(pi, DEPOSIT_CENTS, 'won');

    const live = (await trustRows(accountId)).filter((r) => r.type === 'deposit' && r.status === 'completed');
    expect(live).toEqual([expect.objectContaining({ cents: DEPOSIT_CENTS, pi })]);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);

    // A replayed win must not credit the client twice.
    await disputeClosed(pi, DEPOSIT_CENTS, 'won');
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });

  it('restores a partial reversal when the refund behind it fails', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    await refunded(pi, 20_000);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 20_000);

    await refundUpdated(pi, 20_000, 'failed');

    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });

  it('restores only the failed part of two partial reversals, re-posting the rest as one withdrawal', async () => {
    // 200.00 then a cumulative 300.00 refunded: two reversing withdrawals. A
    // refund of 123.45 then fails, so 123.45 came back and 176.55 is still
    // gone. Both reversals are voided and ONE withdrawal for the remainder is
    // re-posted; restoring the whole 300.00 would credit the client with money
    // Stripe still holds.
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedStripeTrustDeposit(firm.id, pi);
    await refunded(pi, 20_000);
    await refunded(pi, 30_000);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 30_000);

    await refundUpdated(pi, 12_345, 'failed');

    const live = (await trustRows(accountId)).filter((r) => r.status === 'completed');
    expect(live.map((r) => [r.type, r.cents])).toEqual([
      ['deposit', DEPOSIT_CENTS],
      ['withdrawal', 17_655],
    ]);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS - 17_655);
    const owner = await ownerOf(firm.id);
    const balance = await owner.api.get(`/api/lawfirms/${firm.id}/trust/clients/${clientId}/balance`);
    expect(Number(balance.body.totalBalanceCents)).toBe(DEPOSIT_CENTS - 17_655);
  });
});

describe('payment_intent.payment_failed on a trust deposit', () => {
  it('tells the firm\'s trust managers the deposit failed, and posts nothing to the ledger', async () => {
    const owner = await ownerOf(firm.id);
    // A member without trust access, who must not be among the recipients below.
    await memberWith(firm.id, ['matters.view']);
    const pi = newPaymentIntentId();
    const { accountId, clientId } = await seedStripeTrustDeposit(firm.id, `pi_other_${randomUUID().slice(0, 8)}`);
    await testPool.query(`update clients set name = 'Dana Reyes' where id = $1`, [clientId]);
    const before = await trustRows(accountId);

    await deliver('payment_intent.payment_failed', {
      id: pi,
      object: 'payment_intent',
      amount: 30_000,
      last_payment_error: { message: 'account closed' },
      metadata: { depositType: 'trust', lawFirmId: firm.id, trustAccountId: accountId, clientId },
    });

    const { rows } = await testPool.query(
      `select user_id, title, body, action_url from notifications
        where law_firm_id = $1 and type = 'trust_deposit_failed'`,
      [firm.id],
    );
    expect(rows.map((r: any) => r.user_id)).toEqual([owner.uid]);
    expect(rows[0].title).toBe('Trust deposit failed');
    expect(rows[0].body).toContain('$300.00');
    expect(rows[0].body).toContain('Dana Reyes');
    expect(rows[0].body).toContain('account closed');
    expect(rows[0].action_url).toContain(`/lawfirm/${firm.id}/trust`);

    // An ACH deposit is only posted on success, so the ledger is exactly as it was.
    expect(await trustRows(accountId)).toEqual(before);
    expect(await bookBalance(accountId)).toBe(DEPOSIT_CENTS);
  });

  it('notifies nobody for a payment intent that is not a trust deposit', async () => {
    await ownerOf(firm.id);

    await deliver('payment_intent.payment_failed', {
      id: newPaymentIntentId(), object: 'payment_intent', amount: 30_000,
      metadata: { lawFirmId: firm.id },
    });

    const { rows } = await testPool.query(
      `select 1 from notifications where law_firm_id = $1 and type = 'trust_deposit_failed'`, [firm.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('checkout.session.async_payment_succeeded', () => {
  it('records a delayed bank payment on the invoice, like a completed checkout', async () => {
    const client = await createPersonClient(firm.id, { email: 'ach-payer@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: INVOICE_CENTS });
    const pi = newPaymentIntentId();

    await deliver('checkout.session.async_payment_succeeded', {
      id: `cs_${randomUUID().slice(0, 8)}`,
      object: 'checkout.session',
      payment_status: 'paid',
      amount_total: INVOICE_CENTS,
      payment_intent: pi,
      metadata: { lawFirmId: firm.id, invoiceId: invoice.id, contextType: 'client', entityId: client.id },
    });

    const { rows } = await testPool.query(
      `select i.amount_paid_cents, i.is_paid, p.amount_cents, p.stripe_payment_intent_id
         from invoices i join invoice_payments p on p.invoice_id = i.id where i.id = $1`,
      [invoice.id],
    );
    expect(rows).toEqual([
      expect.objectContaining({ amount_cents: String(INVOICE_CENTS), stripe_payment_intent_id: pi, is_paid: true }),
    ]);
  });
});
