/**
 * `createTrustDepositFromStripe` reads before it writes, OUTSIDE any lock.
 *
 * trust.service.ts: `findByStripePaymentIntentAnyFirm` (a plain SELECT) runs
 * first; only if it finds nothing does the code fall through to
 * `_createTransactionInternal`, which is what finally takes the `trust_accounts`
 * row lock (inside `_createWithBalanceTx`). Nothing serializes the read against
 * a concurrent read for the SAME payment intent — the ledger's own framing is
 * "protected only by two unique indexes, not a lock". Two calls that both see
 * "not found" both fall through to the insert.
 *
 * This matters because the function is reachable from more than one path for
 * the same payment intent: the ordinary webhook delivery
 * (`handleTrustDepositPaymentSucceeded`) and the dispute/refund restore path
 * (`restoreReversedFunds`), and Stripe itself can in principle deliver
 * `payment_intent.succeeded` under two different event ids (multiple webhook
 * endpoints on the account is the textbook cause). Either way, two overlapping
 * calls for one payment intent is the scenario the unique partial index
 * `trust_txn_stripe_pi_uidx` (schema.sql) exists to backstop.
 *
 * The gate proves the overlap the way `trustConcurrency.test.ts`'s bare
 * `Promise.all` cannot: both deliveries are held INSIDE the read, so neither
 * has any way to see the other's row yet, before the test decides to release
 * them. What is untested before this file is what happens to the LOSER: does
 * the unique index's rejection surface as a clean, retryable failure (500 +
 * released claim), or does it corrupt the ledger, silently drop the deposit, or
 * hang the request.
 *
 * Offline: `billFirmForTrustAchFee` (run after a successful deposit) checks
 * `firmData.plan.stripeCustomerId` first, which fixture firms never carry, so
 * it warns and returns without an outbound Stripe call.
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
import { claimedEventIds, deliverSigned, paymentIntentSucceededEvent } from '../support/stripeWebhook';
import { createTrustAccount } from '../support/trust';

const { trustTxnRepo } = require('../../src/modules/trust/trust.repository');

const WEBHOOK_SECRET = 'whsec_test_secret_for_the_offline_suite';

let gate: Gate | null = null;

const deliver = (payload: string) => deliverSigned(payload, WEBHOOK_SECRET);

async function depositsFor(paymentIntentId: string) {
  const { rows } = await testPool.query(
    `select id, amount_cents, status from trust_transactions
      where stripe_payment_intent_id = $1 and type = 'deposit'`,
    [paymentIntentId],
  );
  return rows;
}

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  gate?.restore();
  gate = null;
});

describe('two deliveries for the same payment intent, proved to overlap at the pre-lock read', () => {
  let firm: Firm;
  let owner: any;
  let clientId: string;
  let trustAccountId: string;
  const AMOUNT_CENTS = 75_000;
  const PAYMENT_INTENT_ID = 'pi_shared_trust_race';

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Trust Race Client' });
    clientId = client.id;

    trustAccountId = await createTrustAccount(owner, firm.id, { name: 'Race IOLTA', last4: '4321' });
  });

  it('lets exactly ONE deposit land when both reads are held open together', async () => {
    gate = gateMethod(trustTxnRepo, 'findByStripePaymentIntentAnyFirm');

    const payloadA = paymentIntentSucceededEvent('evt_trust_race_a', {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    const payloadB = paymentIntentSucceededEvent('evt_trust_race_b', {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });

    const first = deliver(payloadA);
    const second = deliver(payloadB);

    // The evidence: both deliveries are paused INSIDE the dedupe read, so
    // neither has any way to have seen the other's (nonexistent) row yet.
    await gate.arrived(2);
    expect(gate.waiting()).toBe(2);
    expect(await depositsFor(PAYMENT_INTENT_ID)).toHaveLength(0);

    gate.open();
    const [resA, resB] = await Promise.all([first, second]);
    await drainEvents();

    const statuses = [resA.status, resB.status].sort();
    // Exactly one delivery's deposit commits. The other collides with the
    // unique index at insert time (the read-then-write gap this file is
    // about) and must fail cleanly rather than silently double-post or hang.
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    // The database, not application logic, is what decided the winner: one
    // deposit row for this payment intent, not two and not zero.
    const deposits = await depositsFor(PAYMENT_INTENT_ID);
    expect(deposits).toHaveLength(1);
    expect(Number(deposits[0].amount_cents)).toBe(AMOUNT_CENTS);
    expect(deposits[0].status).toBe('completed');

    // The account balance reflects the money exactly once.
    const { rows: acctRows } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [trustAccountId],
    );
    expect(Number(acctRows[0].book_balance_cents)).toBe(AMOUNT_CENTS);

    // The loser's event must have been released — the same recovery contract
    // as the Stripe invoice-effect case — or its id is stranded forever and a
    // legitimate Stripe retry of that exact event would be told "duplicate"
    // without ever having actually posted anything.
    const loserEventId = resA.status >= 400 ? 'evt_trust_race_a' : 'evt_trust_race_b';
    const winnerEventId = resA.status >= 400 ? 'evt_trust_race_b' : 'evt_trust_race_a';
    expect(await claimedEventIds()).toEqual([winnerEventId]);

    // Redelivering the LOSER's event now finds the deposit the winner already
    // posted and dedupes on it rather than erroring or double-posting.
    const retryPayload = paymentIntentSucceededEvent(loserEventId, {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    const retried = await deliver(retryPayload);
    await drainEvents();

    expect(retried.status).toBe(200);
    expect(await depositsFor(PAYMENT_INTENT_ID)).toHaveLength(1);
    expect(await claimedEventIds()).toEqual([loserEventId, winnerEventId].sort());

    const { rows: acctRowsAfterRetry } = await testPool.query(
      'select book_balance_cents from trust_accounts where id = $1', [trustAccountId],
    );
    expect(Number(acctRowsAfterRetry[0].book_balance_cents)).toBe(AMOUNT_CENTS);
  });

  it('the barrier actually fired: control proving these are not two sequential deliveries', async () => {
    // Without this, a gate installed on the wrong property (or a race that
    // closed itself before the assertions above ran) would make the case above
    // pass as an ordinary one-after-another run and nobody would know the
    // overlap was never real.
    gate = gateMethod(trustTxnRepo, 'findByStripePaymentIntentAnyFirm');

    const payloadA = paymentIntentSucceededEvent('evt_trust_race_control_a', {
      paymentIntentId: 'pi_control_only', lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    const payloadB = paymentIntentSucceededEvent('evt_trust_race_control_b', {
      paymentIntentId: 'pi_control_only', lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });

    const first = deliver(payloadA);
    const second = deliver(payloadB);
    await gate.arrived(2);
    gate.open();
    await Promise.all([first, second]);

    expect(gate.entered()).toBe(2);
  });

  it('control: a single delivery with no race posts one deposit for the correct amount', async () => {
    // Without this, a route that refused every deposit (a bug, not a race
    // defense) would satisfy "exactly one deposit" trivially.
    const payload = paymentIntentSucceededEvent('evt_trust_no_race', {
      paymentIntentId: 'pi_solo_delivery', lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });

    const res = await deliver(payload);
    await drainEvents();

    expect(res.status).toBe(200);
    const deposits = await depositsFor('pi_solo_delivery');
    expect(deposits).toHaveLength(1);
    expect(Number(deposits[0].amount_cents)).toBe(AMOUNT_CENTS);
  });
});
