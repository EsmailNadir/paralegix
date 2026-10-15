/**
 * Deliver signed Stripe events to the payments webhook, and seed the money they
 * act on: an invoice paid through Stripe and an ACH trust deposit posted from a
 * payment intent.
 *
 * Delivery is the way Stripe does it: the payload is signed with the real
 * `Stripe.webhooks` static (an HMAC compare, no network) and POSTed to the real
 * route, so signature verification, the `stripe_events` claim and the handler
 * dispatch all run. A spec sets `process.env.STRIPE_WEBHOOK_SECRET` to the same
 * secret before its first request.
 *
 * Seeding is plain SQL, like every other fixture here.
 */
import { randomUUID } from 'crypto';

import { testPool } from './db';
import { request } from './app';
import { drainEvents } from './events';
import { createInvoice, createPersonClient } from './factories';

// `require`, not `import`: the package's ESM entry does not parse under Jest.
const Stripe = require('stripe');

/** $250.00 invoice, paid in full through Stripe. */
export const STRIPE_INVOICE_CENTS = 25_000;
/** $555.00 trust deposit, posted from an ACH payment intent. */
export const STRIPE_DEPOSIT_CENTS = 55_500;

let eventCounter = 0;

export const newPaymentIntentId = () => `pi_fixture_${randomUUID().slice(0, 12)}`;

/**
 * Senders bound to one webhook secret. Each delivery gets a fresh event id, so
 * the `stripe_events` claim never dedupes one case into another; a REPLAY in the
 * Stripe sense (the same figures sent again) is therefore a second call.
 *
 * `account` makes every event a Connect event from that connected account, the
 * way Stripe reports a direct charge on a firm's own account.
 */
export function stripeWebhookSender(secret: string, { account }: { account?: string } = {}) {
  async function deliver(type: string, object: unknown) {
    const payload = JSON.stringify({
      id: `evt_fixture_${eventCounter++}_${randomUUID().slice(0, 8)}`,
      object: 'event',
      type,
      created: Math.floor(Date.now() / 1000),
      ...(account ? { account } : {}),
      data: { object },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const res = await request()
      .post('/api/webhooks/stripe')
      .set('stripe-signature', signature)
      // The STRING, not a Buffer: supertest re-encodes a Buffer, so the bytes
      // `express.raw()` hands to `constructEvent` would no longer match the signature.
      .set('content-type', 'application/json')
      .send(payload);
    await drainEvents();
    // A 400 means verification rejected it and no handler ran, which would turn
    // every "unchanged" assertion into a false green.
    if (res.status !== 200) throw new Error(`webhook ${type} answered ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const now = () => Math.floor(Date.now() / 1000);
  // What each charge has had refunded so far, as Stripe would report it. A
  // dispute's reversal target adds this to the disputed amount, so `disputed`
  // carries the charge, expanded, the way a retrieve would return it.
  const refundedByIntent = new Map<string, number>();
  return {
    deliver,
    refunded: (paymentIntentId: string, amountRefundedCents: number) => {
      refundedByIntent.set(paymentIntentId, amountRefundedCents);
      return deliver('charge.refunded', {
        id: `ch_${randomUUID().slice(0, 8)}`, object: 'charge', payment_intent: paymentIntentId, amount_refunded: amountRefundedCents,
      });
    },
    disputed: (paymentIntentId: string, amountCents: number) => deliver('charge.dispute.created', {
      id: `dp_${randomUUID().slice(0, 8)}`, object: 'dispute', payment_intent: paymentIntentId, amount: amountCents, status: 'needs_response',
      charge: {
        id: `ch_${paymentIntentId}`, object: 'charge', payment_intent: paymentIntentId,
        amount_refunded: refundedByIntent.get(paymentIntentId) || 0,
      },
    }),
    disputeClosed: (paymentIntentId: string, amountCents: number, status: 'won' | 'lost') => deliver('charge.dispute.closed', {
      id: `dp_${randomUUID().slice(0, 8)}`, object: 'dispute', payment_intent: paymentIntentId, amount: amountCents, status, created: now(),
    }),
    refundUpdated: (paymentIntentId: string, amountCents: number, status: 'failed' | 'succeeded') => deliver('charge.refund.updated', {
      id: `re_${randomUUID().slice(0, 8)}`, object: 'refund', payment_intent: paymentIntentId, amount: amountCents, status, created: now(),
    }),
  };
}

/** A client-level invoice with one Stripe payment that paid it in full. */
export async function seedStripePaidInvoice(lawFirmId: string, paymentIntentId: string) {
  const client = await createPersonClient(lawFirmId, { email: 'payer@example.test' });
  const invoice = await createInvoice(lawFirmId, client.id, { totalCents: STRIPE_INVOICE_CENTS });
  await testPool.query(
    `insert into invoice_payments (invoice_id, law_firm_id, amount_cents, payment_date, payment_source, stripe_payment_intent_id)
     values ($1, $2, $3, current_date, 'stripe', $4)`,
    [invoice.id, lawFirmId, STRIPE_INVOICE_CENTS, paymentIntentId],
  );
  const paid = await testPool.query(
    `update invoices set amount_paid_cents = $2, is_paid = true, status = 'paid', paid_date = now() where id = $1`,
    [invoice.id, STRIPE_INVOICE_CENTS],
  );
  // The paid state is the premise of every reversal assertion.
  if (paid.rowCount !== 1) throw new Error('seedStripePaidInvoice: the invoice was not marked paid');
  return { invoiceId: invoice.id, clientId: client.id };
}

/** The invoice's paid figures and its one Stripe payment, read from Postgres. */
export async function stripeInvoiceMoney(invoiceId: string) {
  const { rows } = await testPool.query(
    `select i.amount_paid_cents, i.is_paid, p.amount_cents as payment_cents, p.stripe_refunded_cents
       from invoices i join invoice_payments p on p.invoice_id = i.id
      where i.id = $1`,
    [invoiceId],
  );
  if (rows.length !== 1) throw new Error(`expected one Stripe payment on ${invoiceId}, found ${rows.length}`);
  const r = rows[0];
  return {
    amountPaid: Number(r.amount_paid_cents),
    isPaid: r.is_paid,
    paymentCents: Number(r.payment_cents),
    refundedCents: Number(r.stripe_refunded_cents),
  };
}

/**
 * A trust account holding one ACH deposit posted from a Stripe payment intent.
 * Inserted directly: `trust_transactions` is append-only, so the payment intent
 * has to be on the row from the start. The account's Stripe connected account is
 * `acct_trust_fixture`.
 */
export async function seedStripeTrustDeposit(lawFirmId: string, paymentIntentId: string) {
  const client = await createPersonClient(lawFirmId, { email: 'trust-client@example.test' });
  const accountId = randomUUID();
  const depositId = randomUUID();
  await testPool.query(
    `insert into trust_accounts (id, law_firm_id, name, account_type, status, book_balance_cents, stripe_connected_account_id)
     values ($1, $2, 'Stripe IOLTA', 'iolta', 'active', $3, 'acct_trust_fixture')`,
    [accountId, lawFirmId, STRIPE_DEPOSIT_CENTS],
  );
  await testPool.query(
    `insert into trust_transactions
       (id, law_firm_id, trust_account_id, type, amount_cents, client_id, txn_date, description,
        status, client_balance_after_cents, account_balance_after_cents, stripe_payment_intent_id)
     values ($1, $2, $3, 'deposit', $4, $5, current_date, 'ACH retainer', 'completed', $4, $4, $6)`,
    [depositId, lawFirmId, accountId, STRIPE_DEPOSIT_CENTS, client.id, paymentIntentId],
  );
  return { accountId, depositId, clientId: client.id };
}

/** Every row posted for the account, oldest first. */
export async function trustRowsFor(accountId: string) {
  const { rows } = await testPool.query(
    `select type, status, amount_cents, stripe_payment_intent_id
       from trust_transactions where trust_account_id = $1
      order by created_at, id`,
    [accountId],
  );
  return rows.map((r: any) => ({ type: r.type, status: r.status, cents: Number(r.amount_cents), pi: r.stripe_payment_intent_id }));
}

export async function trustBookBalance(accountId: string) {
  const { rows } = await testPool.query('select book_balance_cents from trust_accounts where id = $1', [accountId]);
  return Number(rows[0].book_balance_cents);
}

/**
 * A Stripe event envelope with a FIXED id, as the exact string that gets signed.
 * Idempotency specs need to control the id, so a redelivery is the same event.
 */
export function stripeEventPayload(id: string, type: string, object: unknown) {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
}

/**
 * POST a payload signed with `secret`, the way Stripe would, and return the raw
 * response. Unlike `stripeWebhookSender`, nothing is asserted and nothing is
 * drained, so a spec can check a refusal or hold the request at a gate. Async so
 * the request is sent on the call, not on the caller's first `await`: a gated
 * spec starts two deliveries and only then waits for them.
 */
export async function deliverSigned(payload: string, secret: string, path = '/api/webhooks/stripe') {
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return request()
    .post(path)
    .set('stripe-signature', signature)
    // The STRING, not a Buffer: supertest re-encodes a Buffer, so the bytes
    // `express.raw()` hands to `constructEvent` would no longer match the signature.
    .set('content-type', 'application/json')
    .send(payload);
}

/** Every event id the idempotency table has claimed, sorted. */
export async function claimedEventIds(): Promise<string[]> {
  const { rows } = await testPool.query('select event_id from stripe_events order by event_id');
  return rows.map((r: any) => r.event_id);
}

/** A `payment_intent.succeeded` for an ACH trust deposit. */
export function paymentIntentSucceededEvent(id: string, opts: {
  paymentIntentId: string;
  lawFirmId: string;
  trustAccountId: string;
  clientId: string;
  amountCents: number;
}) {
  return stripeEventPayload(id, 'payment_intent.succeeded', {
    id: opts.paymentIntentId,
    object: 'payment_intent',
    amount_received: opts.amountCents,
    amount: opts.amountCents,
    metadata: {
      depositType: 'trust',
      lawFirmId: opts.lawFirmId,
      trustAccountId: opts.trustAccountId,
      clientId: opts.clientId,
    },
  });
}

/** The trust deposit posted from a payment intent, or null if none was. */
export async function depositIdFor(paymentIntentId: string): Promise<string | null> {
  const { rows } = await testPool.query(
    `select id from trust_transactions where stripe_payment_intent_id = $1 and type = 'deposit'`,
    [paymentIntentId],
  );
  return rows[0]?.id || null;
}

/** The ACH fee row recorded against a trust deposit, or null. */
export async function feeRowFor(trustTransactionId: string | null) {
  const { rows } = await testPool.query(
    `select fee_cents, status, stripe_invoice_id from trust_deposit_fees where trust_transaction_id = $1`,
    [trustTransactionId],
  );
  return rows[0] || null;
}

/**
 * A fake of the four Stripe invoice calls `chargeAccruedTrustFee` makes, which
 * records every idempotency key it is given. `.pay` succeeds by default;
 * `pay: 'decline'` makes every call a card decline, and `setPayBehavior` scripts
 * it per call. Always `restore()` it.
 */
export function installFakeStripeInvoicing({ pay = 'succeed' }: { pay?: 'succeed' | 'decline' } = {}) {
  // Required at call time, so a spec's own `jest.mock` of the config applies.
  const stripeClient = require('../../src/modules/stripe/stripe.config');
  let invoiceCounter = 0;
  const state: { id: string | null; status: 'draft' | 'open' | 'paid' } = { id: null, status: 'draft' };
  const idempotencyKeys: { create: string[]; item: string[]; final: string[]; pay: string[] } = {
    create: [], item: [], final: [], pay: [],
  };
  const decline = async () => {
    throw Object.assign(new Error('simulated card decline'), { code: 'card_declined' });
  };
  let payBehavior: (() => Promise<void>) | null = pay === 'decline' ? decline : null;
  const payCalls: string[] = [];

  const spies = [
    jest.spyOn(stripeClient.invoices, 'create').mockImplementation(async (_params: any, opts: any) => {
      idempotencyKeys.create.push(opts?.idempotencyKey);
      invoiceCounter += 1;
      state.id = `in_fake_fee_invoice_${invoiceCounter}`;
      state.status = 'draft';
      return { id: state.id, status: state.status };
    }),
    jest.spyOn(stripeClient.invoiceItems, 'create').mockImplementation(async (_params: any, opts: any) => {
      idempotencyKeys.item.push(opts?.idempotencyKey);
      return { id: `ii_fake_${invoiceCounter}` };
    }),
    jest.spyOn(stripeClient.invoices, 'finalizeInvoice').mockImplementation(async (_id: any, opts: any) => {
      idempotencyKeys.final.push(opts?.idempotencyKey);
      state.status = 'open';
      return { id: state.id, status: state.status };
    }),
    jest.spyOn(stripeClient.invoices, 'retrieve').mockImplementation(async () => ({
      id: state.id, status: state.status,
    })),
    jest.spyOn(stripeClient.invoices, 'pay').mockImplementation(async (_id: any, opts: any) => {
      idempotencyKeys.pay.push(opts?.idempotencyKey);
      payCalls.push(opts?.idempotencyKey);
      if (payBehavior) {
        await payBehavior();
      } else {
        state.status = 'paid';
      }
      return { id: state.id, status: state.status };
    }),
  ];

  return {
    state,
    idempotencyKeys,
    payCalls,
    /** Script every later `.pay` call. Persists until replaced. */
    setPayBehavior(fn: (() => Promise<void>) | null) { payBehavior = fn; },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
