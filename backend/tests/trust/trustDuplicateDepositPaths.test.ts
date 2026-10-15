/**
 * B06.3 T04: "Duplicate online deposit through webhook and reconciliation."
 *
 * The plan's T04 is NOT the two-webhook-deliveries race already covered by
 * `trustStripeDepositRace.test.ts` (that file races the SAME delivery path
 * against itself). T04 asks about the ledger's other real entry point for a
 * Stripe-funded trust deposit: `reconcileStripeTrustDeposits` (stripe.service.ts),
 * wired to `POST /api/cron/reconcile-trust-deposits`. Its own doc comment says
 * why it exists: "a webhook that was claimed but not processed... can't leave
 * settled client funds sitting in the IOLTA with no ledger entry." It re-scans
 * Stripe's payment intents and posts any `depositType=trust` intent missing from
 * the ledger, through the SAME `handleTrustDepositPaymentSucceeded` the webhook
 * route calls. That makes it the literal "reconciliation" path the plan names,
 * as distinct from the webhook path.
 *
 * Both paths fall through to `createTrustDepositFromStripe`, which dedupes on
 * `trustTxnRepo.findByStripePaymentIntentAnyFirm`, a plain read, outside any
 * lock, backstopped only by the unique partial index `trust_txn_stripe_pi_uidx`.
 * Nothing before this file proved that guard holds across the SECOND path, only
 * across two deliveries of the first. Racing the two real entry points against
 * each other is what actually tests "webhook AND reconciliation," rather than
 * assuming the existing webhook-vs-webhook coverage generalizes.
 *
 * Offline: fixture firms carry no `plan.stripeCustomerId`, so
 * `billFirmForTrustAchFee` accrues the ACH fee row and returns without an
 * outbound Stripe call for the charge itself (see trustStripeDepositRace.test.ts's
 * identical note). `stripe.paymentIntents.list`, the one Stripe call
 * `reconcileStripeTrustDeposits` makes, is stubbed locally so the sweep never
 * reaches the network either.
 */

import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  createPersonClient,
  type Firm,
} from '../support/setupInProcess';
import { gateMethod, type Gate } from '../support/gate';
import { claimedEventIds, deliverSigned } from '../support/stripeWebhook';
import { createTrustAccount } from '../support/trust';

const { AsyncLocalStorage } = require('async_hooks');
const { trustTxnRepo } = require('../../src/modules/trust/trust.repository');
const trustService = require('../../src/modules/trust/trust.service');
const stripeService = require('../../src/modules/stripe/stripe.service');
const stripeClient = require('../../src/modules/stripe/stripe.config');

const WEBHOOK_SECRET = 'whsec_test_secret_for_the_dup_path_suite';

let gate: Gate | null = null;
let paymentIntentsListSpy: jest.SpyInstance | null = null;

function paymentIntentObject(opts: {
  paymentIntentId: string;
  lawFirmId: string;
  trustAccountId: string;
  clientId: string;
  amountCents: number;
}) {
  return {
    id: opts.paymentIntentId,
    object: 'payment_intent',
    status: 'succeeded',
    amount_received: opts.amountCents,
    amount: opts.amountCents,
    created: Math.floor(Date.now() / 1000),
    metadata: {
      depositType: 'trust',
      lawFirmId: opts.lawFirmId,
      trustAccountId: opts.trustAccountId,
      clientId: opts.clientId,
    },
  };
}

function paymentIntentSucceededEvent(id: string, pi: ReturnType<typeof paymentIntentObject>) {
  return JSON.stringify({
    id,
    object: 'event',
    type: 'payment_intent.succeeded',
    created: pi.created,
    data: { object: pi },
  });
}

const deliver = (payload: string) => deliverSigned(payload, WEBHOOK_SECRET);

/** Makes the reconciliation sweep "see" exactly this one payment intent. */
function stubStripePaymentIntentsList(pi: ReturnType<typeof paymentIntentObject>) {
  paymentIntentsListSpy = jest.spyOn(stripeClient.paymentIntents, 'list').mockReturnValue([pi] as any);
}

async function depositsFor(paymentIntentId: string) {
  const { rows } = await testPool.query(
    `select id, amount_cents, status, stripe_payment_intent_id from trust_transactions
      where stripe_payment_intent_id = $1 and type = 'deposit'`,
    [paymentIntentId],
  );
  return rows;
}

async function feeRowsFor(trustTransactionId: string) {
  const { rows } = await testPool.query(
    `select fee_cents, status from trust_deposit_fees where trust_transaction_id = $1`,
    [trustTransactionId],
  );
  return rows;
}

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  gate?.restore();
  gate = null;
  paymentIntentsListSpy?.mockRestore();
  paymentIntentsListSpy = null;
});

describe('T04: the same Stripe deposit reachable through both the webhook and the reconciliation sweep', () => {
  let firm: Firm;
  let owner: any;
  let clientId: string;
  let trustAccountId: string;
  const AMOUNT_CENTS = 100_000; // fee = min(round(100000*0.008), 500) = 500, deterministic
  const EXPECTED_FEE_CENTS = 500;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Dup Path Client' });
    clientId = client.id;

    trustAccountId = await createTrustAccount(owner, firm.id, { name: 'Dup Path IOLTA', last4: '9911' });
  });

  it('posts the deposit exactly once when the webhook and the reconciliation sweep race for the same payment intent', async () => {
    const PAYMENT_INTENT_ID = 'pi_dup_path_race';
    const pi = paymentIntentObject({
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    stubStripePaymentIntentsList(pi);
    gate = gateMethod(trustTxnRepo, 'findByStripePaymentIntentAnyFirm');

    // `trustService.createTrustDepositFromStripe` is the single point both
    // paths fall through to, and its `duplicate` flag is ground truth for
    // "did THIS call actually create the row." An HTTP status can't answer
    // that: a webhook call that gracefully dedupes (finds the row already
    // there) also answers 200, indistinguishable from "the webhook created
    // it" by status alone. Tagging each call with `AsyncLocalStorage` (correct
    // across interleaved awaits, unlike a shared boolean flag) lets the
    // assertions below tell the two 200s apart.
    const callerContext = new AsyncLocalStorage();
    const calls: Array<{ caller: string; duplicate?: boolean; error?: string }> = [];
    const originalCreate = trustService.createTrustDepositFromStripe.bind(trustService);
    const createSpy = jest.spyOn(trustService, 'createTrustDepositFromStripe')
      .mockImplementation(async (...args: any[]) => {
        const caller = callerContext.getStore() || 'unknown';
        try {
          const result = await originalCreate(...args);
          calls.push({ caller, duplicate: result.duplicate });
          return result;
        } catch (err: any) {
          calls.push({ caller, error: err.message });
          throw err;
        }
      });

    const webhookPayload = paymentIntentSucceededEvent('evt_dup_path_webhook', pi);

    async function fireWebhook() {
      // Not wrapped in `callerContext`: see the note beside the assertions on
      // why an async store cannot follow a request over a socket.
      return deliver(webhookPayload);
    }
    async function fireReconcile() {
      return callerContext.run('reconcile', () => stripeService.reconcileStripeTrustDeposits({ dryRun: false }));
    }

    const webhookPromise = fireWebhook();
    const reconcilePromise = fireReconcile();

    // Evidence both paths are paused INSIDE the dedupe read, exactly like the
    // webhook-vs-webhook race, but this time for two DIFFERENT callers.
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);
    expect(await depositsFor(PAYMENT_INTENT_ID)).toHaveLength(0);

    gate.open();
    const [webhookRes, reconcileSummary] = await Promise.all([webhookPromise, reconcilePromise]);
    await drainEvents();
    createSpy.mockRestore();

    // Only the reconcile path can be tagged by `AsyncLocalStorage`: it is a
    // direct in-process call, so the store follows it through every await. The
    // webhook path is a real HTTP request, and an async context cannot cross a
    // socket, so its call arrives untagged. Being untagged IS the webhook's
    // signature here, and the two paths are still told apart exactly.
    //
    // This used to read `c.caller === 'webhook'` and worked by accident:
    // `supertest(app)` bound a NEW server per request, so the listener was
    // created inside `callerContext.run('webhook', ...)` and the request handler
    // inherited that store. The harness now shares one server per worker (see
    // tests/support/app.ts), which is what stopped the suite failing at random
    // with `socket hang up`, and that accident no longer holds.
    const reconcileCall = calls.find((c) => c.caller === 'reconcile');
    const webhookCall = calls.find((c) => c.caller !== 'reconcile');
    expect(webhookCall).toBeDefined();
    expect(reconcileCall).toBeDefined();
    expect(calls).toHaveLength(2);

    const webhookCreated = webhookCall?.duplicate === false;
    const reconcileCreated = reconcileCall?.duplicate === false;

    // Exactly one of the two calls actually created the ledger row. The other
    // either found it already there (a graceful `duplicate: true`, itself
    // answering 200/posted-looking) or lost the DB unique-index race outright
    // (a thrown error) -- both are acceptable "lost cleanly" outcomes; both
    // being the creator, or neither, is not.
    expect(webhookCreated).toBe(!reconcileCreated);

    // The reconciliation sweep's own `posted` count must reflect whether IT
    // actually created a new row, not merely "the call didn't throw" -- a
    // graceful dedupe must not be counted as a posting.
    expect(reconcileSummary.posted).toBe(reconcileCreated ? 1 : 0);

    if (webhookCreated) {
      expect(await claimedEventIds()).toEqual(['evt_dup_path_webhook']);
    } else if (webhookCall?.error) {
      expect(webhookRes.status).toBeGreaterThanOrEqual(400);
      // The loser's webhook claim must be released, or a legitimate Stripe
      // retry of this exact event would be told "duplicate" without ever
      // having posted anything.
      expect(await claimedEventIds()).toEqual([]);
    } else {
      // The webhook gracefully deduped against the sweep's already-committed
      // row: no error, so the claim is kept exactly like an ordinary success.
      expect(webhookRes.status).toBe(200);
      expect(await claimedEventIds()).toEqual(['evt_dup_path_webhook']);
    }

    // Exactly one principal posting, for the full amount, carrying the provider
    // id no matter which path actually won the race.
    const deposits = await depositsFor(PAYMENT_INTENT_ID);
    expect(deposits).toHaveLength(1);
    expect(Number(deposits[0].amount_cents)).toBe(AMOUNT_CENTS);
    expect(deposits[0].status).toBe('completed');
    expect(deposits[0].stripe_payment_intent_id).toBe(PAYMENT_INTENT_ID);

    // Exactly one fee accrual for that one deposit, not two.
    const fees = await feeRowsFor(deposits[0].id);
    expect(fees).toHaveLength(1);
    expect(Number(fees[0].fee_cents)).toBe(EXPECTED_FEE_CENTS);

    const { rows: acctRows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [trustAccountId],
    );
    expect(Number(acctRows[0].book_balance_cents)).toBe(AMOUNT_CENTS);
  });

  it('the sweep does not count a graceful dedupe as a new posting when its own "is it missing" check goes stale', async () => {
    // Deterministic version of the race above, targeting the exact window:
    // `reconcileStripeTrustDeposits` decides "missing" from ONE read
    // (`findDepositByStripePaymentIntentIncludingVoid`), then only LATER, inside
    // `handleTrustDepositPaymentSucceeded`, takes a second read
    // (`findByStripePaymentIntentAnyFirm`) that actually creates-or-dedupes. A
    // write landing in between makes the first read stale without making the
    // second one wrong -- the second read correctly finds the row and dedupes,
    // but nothing before this test checked whether the sweep's own `posted`
    // counter noticed the difference between "I created it" and "it turned out
    // to already be there."
    const PAYMENT_INTENT_ID = 'pi_dup_path_stale_precheck';
    const pi = paymentIntentObject({
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });

    // The webhook processes this payment intent first and fully commits the deposit.
    const webhookPayload = paymentIntentSucceededEvent('evt_dup_path_stale_precheck', pi);
    const webhookRes = await deliver(webhookPayload);
    await drainEvents();
    expect(webhookRes.status).toBe(200);
    const depositsAfterWebhook = await depositsFor(PAYMENT_INTENT_ID);
    expect(depositsAfterWebhook).toHaveLength(1);

    // Force the sweep's OWN "is it missing" precheck to report "missing" for
    // this one call, exactly as a real read that ran a moment before the
    // webhook's commit would have. Its SECOND read (inside
    // `createTrustDepositFromStripe`) is real and unmocked, so it correctly
    // sees the webhook's already-committed row.
    const staleCheck = jest.spyOn(trustTxnRepo, 'findDepositByStripePaymentIntentIncludingVoid')
      .mockResolvedValueOnce(null);

    stubStripePaymentIntentsList(pi);
    const summary = await stripeService.reconcileStripeTrustDeposits({ dryRun: false });
    staleCheck.mockRestore();

    expect(summary.missing).toBe(1); // the stale precheck really did say "missing"
    expect(summary.failures).toHaveLength(0); // and the second read did not error -- a clean dedupe
    expect(summary.posted).toBe(0); // but nothing new was actually created

    const deposits = await depositsFor(PAYMENT_INTENT_ID);
    expect(deposits).toHaveLength(1);
    expect(deposits[0].id).toBe(depositsAfterWebhook[0].id);

    const fees = await feeRowsFor(deposits[0].id);
    expect(fees).toHaveLength(1);

    const { rows: acctRows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [trustAccountId],
    );
    expect(Number(acctRows[0].book_balance_cents)).toBe(AMOUNT_CENTS);
  });

  it('a reconciliation sweep run after the webhook already posted is a clean no-op, not a second posting', async () => {
    const PAYMENT_INTENT_ID = 'pi_dup_path_webhook_first';
    const pi = paymentIntentObject({
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });

    const webhookPayload = paymentIntentSucceededEvent('evt_dup_path_webhook_first', pi);
    const webhookRes = await deliver(webhookPayload);
    await drainEvents();
    expect(webhookRes.status).toBe(200);

    const depositsAfterWebhook = await depositsFor(PAYMENT_INTENT_ID);
    expect(depositsAfterWebhook).toHaveLength(1);

    // Now the sweep discovers the SAME payment intent (e.g. its regular window
    // overlapping a deposit the webhook already handled).
    stubStripePaymentIntentsList(pi);
    const summary = await stripeService.reconcileStripeTrustDeposits({ dryRun: false });

    expect(summary.trust).toBe(1);
    expect(summary.missing).toBe(0);
    expect(summary.posted).toBe(0);
    expect(summary.failures).toHaveLength(0);

    const deposits = await depositsFor(PAYMENT_INTENT_ID);
    expect(deposits).toHaveLength(1);
    expect(deposits[0].id).toBe(depositsAfterWebhook[0].id);

    const fees = await feeRowsFor(deposits[0].id);
    expect(fees).toHaveLength(1);

    const { rows: acctRows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [trustAccountId],
    );
    expect(Number(acctRows[0].book_balance_cents)).toBe(AMOUNT_CENTS);
  });

  it('a webhook delivered after the reconciliation sweep already posted dedupes rather than posting again', async () => {
    const PAYMENT_INTENT_ID = 'pi_dup_path_reconcile_first';
    const pi = paymentIntentObject({
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });

    stubStripePaymentIntentsList(pi);
    const summary = await stripeService.reconcileStripeTrustDeposits({ dryRun: false });
    expect(summary.posted).toBe(1);

    const depositsAfterSweep = await depositsFor(PAYMENT_INTENT_ID);
    expect(depositsAfterSweep).toHaveLength(1);

    // The webhook for the very same event now arrives (Stripe's normal delivery,
    // just later than the sweep that recovered it).
    const webhookPayload = paymentIntentSucceededEvent('evt_dup_path_reconcile_first', pi);
    const webhookRes = await deliver(webhookPayload);
    await drainEvents();

    expect(webhookRes.status).toBe(200);

    const deposits = await depositsFor(PAYMENT_INTENT_ID);
    expect(deposits).toHaveLength(1);
    expect(deposits[0].id).toBe(depositsAfterSweep[0].id);

    const fees = await feeRowsFor(deposits[0].id);
    expect(fees).toHaveLength(1);

    const { rows: acctRows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [trustAccountId],
    );
    expect(Number(acctRows[0].book_balance_cents)).toBe(AMOUNT_CENTS);
  });

  it('the barrier actually fired: control proving the webhook and the sweep are not two sequential calls', async () => {
    // Without this, a gate installed on the wrong property (or a race that
    // resolved before the assertions above ran) would make the first case pass
    // as an ordinary one-after-another run with nobody noticing the overlap
    // was never real.
    const PAYMENT_INTENT_ID = 'pi_dup_path_control';
    const pi = paymentIntentObject({
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    stubStripePaymentIntentsList(pi);
    gate = gateMethod(trustTxnRepo, 'findByStripePaymentIntentAnyFirm');

    const webhookPayload = paymentIntentSucceededEvent('evt_dup_path_control', pi);
    const webhookPromise = deliver(webhookPayload);
    const reconcilePromise = stripeService.reconcileStripeTrustDeposits({ dryRun: false });

    await gate.arrived(2);
    gate.open();
    await Promise.all([webhookPromise, reconcilePromise]);

    expect(gate.entered()).toBe(2);
  });
});
