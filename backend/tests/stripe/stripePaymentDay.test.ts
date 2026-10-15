/**
 * The day a Stripe payment, and a Stripe-driven trust entry, is dated on.
 *
 * A webhook has no person recording it, so the rows it writes are dated in the
 * firm's day: the zone saved on the firm owner. They used to take the UTC day
 * of Stripe's timestamp, which is tomorrow every evening in the Americas.
 */

const mockStripeCalls: string[] = [];

jest.mock('../../src/modules/stripe/stripe.config', () => {
  const StripeLib = require('stripe');
  const refuse = (name: string) => () => {
    mockStripeCalls.push(name);
    throw new Error(`stripe.${name} was called`);
  };
  return {
    webhooks: StripeLib.webhooks,
    invoices: { create: refuse('invoices.create'), retrieve: refuse('invoices.retrieve'), voidInvoice: refuse('invoices.voidInvoice') },
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
  type Firm,
} from '../support/setupInProcess';
import {
  newPaymentIntentId,
  seedStripeTrustDeposit,
  stripeWebhookSender,
} from '../support/stripeWebhook';
import { freezeClockAt } from '../support/clock';

const WEBHOOK_SECRET = 'whsec_payment_day_spec_secret';
const { deliver, refunded } = stripeWebhookSender(WEBHOOK_SECRET);

/** 8pm Pacific on the 27th, which is 03:00 UTC on the 28th. */
const EVENING_PACIFIC = '2026-09-27T20:00:00-07:00';

let firm: Firm;
let originalSecret: string | undefined;

beforeAll(() => {
  originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
});

beforeEach(async () => {
  mockStripeCalls.length = 0;
  firm = await createFirm();
  const owner = await ownerOf(firm.id);
  await testPool.query(`update users set timezone = 'America/Los_Angeles' where id = $1`, [owner.uid]);
});

describe('a Stripe payment in the evening, Pacific', () => {
  /** Goes red if the payment takes the UTC day of Stripe's timestamp. */
  it('is dated the firm\'s day', async () => {
    const client = await createPersonClient(firm.id, { email: 'pays@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 250_00 });
    freezeClockAt(EVENING_PACIFIC);

    await deliver('checkout.session.completed', {
      id: `cs_${randomUUID().slice(0, 8)}`, object: 'checkout.session', payment_status: 'paid',
      created: Math.floor(Date.now() / 1000),
      amount_total: 100_00, payment_intent: newPaymentIntentId(),
      metadata: { lawFirmId: firm.id, invoiceId: invoice.id, contextType: 'client', entityId: client.id },
    });

    const { rows } = await testPool.query(
      `select payment_date::text as day from invoice_payments where invoice_id = $1`, [invoice.id],
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-09-27']);
  });

  /**
   * A paid date is a day, stored at its noon-UTC anchor as a manual payment's
   * is. Goes red if Stripe's is stored at UTC midnight, the day before in
   * every zone behind UTC.
   */
  it('paying in full, stores the paid date at the day anchor', async () => {
    const client = await createPersonClient(firm.id, { email: 'full@example.test' });
    const invoice = await createInvoice(firm.id, client.id, { totalCents: 100_00 });
    freezeClockAt(EVENING_PACIFIC);

    await deliver('checkout.session.completed', {
      id: `cs_${randomUUID().slice(0, 8)}`, object: 'checkout.session', payment_status: 'paid',
      created: Math.floor(Date.now() / 1000),
      amount_total: 100_00, payment_intent: newPaymentIntentId(),
      metadata: { lawFirmId: firm.id, invoiceId: invoice.id, contextType: 'client', entityId: client.id },
    });

    const { rows } = await testPool.query(`select paid_date from invoices where id = $1`, [invoice.id]);
    expect(rows[0].paid_date.toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  /** Goes red if a refund's trust reversal takes the UTC day. */
  it('refunded, reverses the trust deposit on the firm\'s day', async () => {
    const pi = newPaymentIntentId();
    const { accountId } = await seedStripeTrustDeposit(firm.id, pi);
    freezeClockAt(EVENING_PACIFIC);

    await refunded(pi, 100_00);

    const { rows } = await testPool.query(
      `select txn_date::text as day from trust_transactions
        where trust_account_id = $1 and reverses_transaction_id is not null`, [accountId],
    );
    expect(rows.map((r) => r.day)).toEqual(['2026-09-27']);
  });
});
