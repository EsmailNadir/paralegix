/**
 * The Stripe claim commits before the money moves. A crash between them.
 *
 * `claimStripeEvent` (stripe.service.ts) is its own statement: an
 * `insert ... on conflict do nothing` into `stripe_events`, committed on its own
 * before the route does anything else. The money effect for a checkout payment
 * runs afterward, in a SEPARATE transaction: `handleCheckoutCompleted` ->
 * `applyStripeCandidateTransaction` -> `invoicesRepo.runInvoiceTxn`, which locks
 * the invoice row and writes the payment. Nothing ties those two statements
 * together. If the process dies (or the DB write fails) between them, the event
 * is claimed but the payment was never applied.
 *
 * The route's answer is `releaseStripeEvent` in its outer catch: a handler that
 * throws AFTER the claim gets the claim handed back, so Stripe's retry of the
 * SAME event id is treated as fresh rather than dismissed as `duplicate: true`.
 * That release is the entire recovery mechanism. If it were missing, or wired to
 * the wrong event id, or skipped on some error paths, a single transient failure
 * (a deploy mid-request, a connection blip) would permanently strand the payment:
 * every future retry would find the event already "claimed" and skip it forever,
 * with no automatic way to notice.
 *
 * This file simulates the crash with `gate.ts`'s `failNext` at exactly the
 * boundary the ledger names: `invoicesRepo.runInvoiceTxn`. The claim above it
 * still runs for real and commits for real; only the invoice-transaction call
 * is made to reject, the same way a lost connection or an OOM kill would surface
 * to the caller. Everything else — signature verification, the claim, the outer
 * route catch, the real Postgres row — is real.
 *
 * Offline for the same reason as its siblings: `handleCheckoutCompleted` makes
 * no outbound Stripe call. Everything it needs is in the session payload and in
 * Postgres, so the network is never reached.
 */

import { testPool, drainEvents, createFirm, createPersonClient, type Firm } from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import { claimedEventIds, deliverSigned, stripeEventPayload } from '../support/stripeWebhook';

const invoicesRepo = require('../../src/modules/billing/invoices/invoices.repository');

const WEBHOOK_SECRET = 'whsec_test_secret_for_the_offline_suite';

let gate: Gate | null = null;

function checkoutCompletedEvent(id: string, opts: {
  invoiceId: string;
  lawFirmId: string;
  clientId: string;
  amountTotalCents: number;
  sessionId?: string;
  paymentIntentId?: string;
}) {
  return stripeEventPayload(id, 'checkout.session.completed', {
    id: opts.sessionId || 'cs_test_session',
    object: 'checkout.session',
    payment_status: 'paid',
    amount_total: opts.amountTotalCents,
    payment_intent: opts.paymentIntentId || 'pi_test_intent',
    metadata: {
      lawFirmId: opts.lawFirmId,
      invoiceId: opts.invoiceId,
      contextType: 'client',
      entityId: opts.clientId,
    },
  });
}

const deliver = (payload: string) => deliverSigned(payload, WEBHOOK_SECRET);

async function invoiceMoneyState(invoiceId: string) {
  const { rows } = await testPool.query(
    'select amount_paid_cents, is_paid, status from invoices where id = $1',
    [invoiceId],
  );
  return rows[0];
}

async function paymentRows(invoiceId: string) {
  const { rows } = await testPool.query(
    'select amount_cents, stripe_payment_intent_id from invoice_payments where invoice_id = $1',
    [invoiceId],
  );
  return rows;
}

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  // Unconditional, so a failed assertion between `failNext` and the request
  // does not leave a later spec's gate confused by a stale pending failure.
  gate?.restore();
  gate = null;
});

describe('a crash between the claim and the invoice-money transaction', () => {
  let firm: Firm;
  let clientId: string;
  let invoiceId: string;
  const TOTAL_CENTS = 50_000; // $500.00, a round number so cents<->dollars round-trips exactly

  beforeEach(async () => {
    firm = await createFirm();
    const client = await createPersonClient(firm.id, { name: 'Recovery Client' });
    clientId = client.id;
    const { rows } = await testPool.query(
      `insert into invoices (id, law_firm_id, client_id, client_context_id, context_type,
                             invoice_number, status, total_cents, invoice_date, due_date)
       values (gen_random_uuid(), $1, $2, $2, 'client', 'INV-RECOVERY-1', 'outstanding', $3,
               current_date, current_date + 30)
       returning id`,
      [firm.id, clientId, TOTAL_CENTS],
    );
    invoiceId = rows[0].id;
  });

  it('answers 500, releases the claim, and applies NOTHING to the invoice', async () => {
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');
    gate.open();
    gate.failNext(new Error('simulated crash: connection lost mid invoice transaction'));

    const payload = checkoutCompletedEvent('evt_crash_before_money_moves', {
      invoiceId, lawFirmId: firm.id, clientId, amountTotalCents: TOTAL_CENTS,
    });
    const res = await deliver(payload);
    await drainEvents();

    // The route must fail loudly so Stripe retries, not swallow the crash.
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Webhook processing failed' });

    // The fault actually landed at the named seam, not somewhere upstream that
    // would make this a test of the wrong thing.
    expect(gate.entered()).toBe(1);

    // BL2's whole point: the claim taken before the crash must be given back,
    // or the event is claimed forever and no retry can ever re-process it.
    expect(await claimedEventIds()).toEqual([]);

    // No partial money effect. The transaction that would have written the
    // payment never committed, because it never ran for real.
    const state = await invoiceMoneyState(invoiceId);
    expect(Number(state.amount_paid_cents)).toBe(0);
    expect(state.is_paid).toBe(false);
    expect(await paymentRows(invoiceId)).toHaveLength(0);
  });

  it('a retry of the SAME event after the crash is processed, not dismissed as a duplicate', async () => {
    // This is the half that proves the release was useful, not merely
    // performed: without it, the retry below would see `duplicate: true` and
    // the invoice would stay unpaid forever despite Stripe holding the money.
    gate = gateMethod(invoicesRepo, 'runInvoiceTxn');
    gate.open();
    gate.failNext(new Error('simulated crash: connection lost mid invoice transaction'));

    const payload = checkoutCompletedEvent('evt_retry_after_crash', {
      invoiceId, lawFirmId: firm.id, clientId, amountTotalCents: TOTAL_CENTS,
    });

    const failed = await deliver(payload);
    expect(failed.status).toBe(500);

    // The retry: same event id, no injected fault this time (failNext only
    // fails the NEXT call; the gate stays open so this one runs for real).
    const retried = await deliver(payload);
    await drainEvents();

    expect(retried.status).toBe(200);
    expect(retried.body.duplicate).toBeUndefined();

    // Claimed exactly once (by the retry), and the money is now applied exactly
    // once — not doubled by the earlier failed attempt.
    expect(await claimedEventIds()).toEqual(['evt_retry_after_crash']);

    const state = await invoiceMoneyState(invoiceId);
    expect(Number(state.amount_paid_cents)).toBe(TOTAL_CENTS);
    expect(state.is_paid).toBe(true);

    const payments = await paymentRows(invoiceId);
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].amount_cents)).toBe(TOTAL_CENTS);

    // Only two calls into the gated function total: the failed one and the
    // successful retry. A third would mean something reprocessed on its own.
    expect(gate.entered()).toBe(2);
  });

  it('control: the SAME delivery with no injected fault applies the payment and keeps its claim', async () => {
    // Without this control, a route that released the claim unconditionally
    // (even on success) would satisfy the case above by reprocessing every
    // event, and nobody would notice the release was firing on the happy path.
    const payload = checkoutCompletedEvent('evt_no_crash_control', {
      invoiceId, lawFirmId: firm.id, clientId, amountTotalCents: TOTAL_CENTS,
    });

    const res = await deliver(payload);
    await drainEvents();

    expect(res.status).toBe(200);
    expect(await claimedEventIds()).toEqual(['evt_no_crash_control']);

    const state = await invoiceMoneyState(invoiceId);
    expect(Number(state.amount_paid_cents)).toBe(TOTAL_CENTS);
    expect(state.is_paid).toBe(true);
  });
});
