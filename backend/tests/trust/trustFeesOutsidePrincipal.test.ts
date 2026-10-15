/**
 * B06.1 invariant row 7: "Fees charged outside trust remain outside the
 * client's protected principal according to the existing accounting model."
 *
 * `trust_transactions.type` is constrained to `deposit`, `withdrawal`,
 * `transfer`, `refund` (db/schema.sql) -- there is no `fee` type. The ACH
 * processing fee on a Stripe-funded trust deposit is therefore never posted
 * against the client's trust ledger at all: `billFirmForTrustAchFee` ->
 * `chargeAccruedTrustFee` (stripe.service.ts) charges the FIRM's own Stripe
 * subscription customer (its card on file) and records the fee in the
 * standalone `trust_deposit_fees` table, keyed off `trust_transaction_id`
 * only for traceability. Nothing reads that table when computing a client's
 * trust balance (`getClientBalance` -> `computeClientBalancesByAccount`
 * sums `trust_transactions` only), so a fee cannot touch the client's
 * protected principal by construction.
 *
 * Prior tests (`trustDepositFeeRetryIdempotency.test.ts`,
 * `trustDuplicateDepositPaths.test.ts`) pin the billing/idempotency mechanics
 * of that fee but never frame this as the invariant it is. This file asserts
 * it directly through the client's actual trust balance/ledger READ routes --
 * not by re-deriving the expected balance from the same ledger-sum code the
 * balance endpoint itself calls -- across every fee outcome: billed
 * successfully, left accrued for lack of a subscription customer, and left
 * accrued after a failed charge attempt. In all three, the client's
 * principal is the full deposit, to the cent, every time.
 */

import {
  testPool,
  drainEvents,
  createFirm,
  ownerOf,
  createPersonClient,
  type Firm,
} from '../support/setupInProcess';
import {
  deliverSigned,
  depositIdFor,
  feeRowFor,
  installFakeStripeInvoicing,
  paymentIntentSucceededEvent,
} from '../support/stripeWebhook';
import { createTrustAccount } from '../support/trust';

const TRUST = (firmId: string) => `/api/lawfirms/${firmId}/trust`;

const WEBHOOK_SECRET = 'whsec_test_secret_for_the_fees_outside_principal_suite';

// $555.00. Fee = min(round(55500 * 0.008), 500) = min(444, 500) = 444 -- below
// the cap, so the number is distinctive and cannot be confused with the cap
// itself or with a value re-derived from the deposit by simple subtraction.
const AMOUNT_CENTS = 55_500;
const EXPECTED_FEE_CENTS = 444;

/** Every trust_transactions row ever posted for this account, whatever the type. */
async function allTxnTypesFor(trustAccountId: string) {
  const { rows } = await testPool.query(
    `select type from trust_transactions where trust_account_id = $1`,
    [trustAccountId],
  );
  return rows.map((r: any) => r.type);
}

const deliver = (payload: string) => deliverSigned(payload, WEBHOOK_SECRET);

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('B06.1 row 7: an ACH deposit fee never touches the client trust principal', () => {
  let firm: Firm;
  let owner: any;
  let clientId: string;
  let trustAccountId: string;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Fee Outside Principal Client' });
    clientId = client.id;

    trustAccountId = await createTrustAccount(owner, firm.id, { name: 'Fees Outside Principal IOLTA', last4: '7700' });
  });

  async function assertPrincipalIsExactlyTheDeposit() {
    // The read surface a client or firm member actually sees, not the sum
    // recomputed by calling the same repository function under test again.
    const balanceRes = await owner.api.get(`${TRUST(firm.id)}/clients/${clientId}/balance`);
    expect(balanceRes.status).toBe(200);
    expect(balanceRes.body.totalBalanceCents).toBe(AMOUNT_CENTS);
    expect(balanceRes.body.accountBalances).toHaveLength(1);
    expect(balanceRes.body.accountBalances[0].trustAccountId).toBe(trustAccountId);
    expect(balanceRes.body.accountBalances[0].balanceCents).toBe(AMOUNT_CENTS);

    // The ledger a firm member scrolls through carries exactly one entry: the
    // deposit. A fee posted into the trust ledger by mistake would show up
    // here as a second row and change the sum above.
    const ledgerRes = await owner.api.get(`${TRUST(firm.id)}/clients/${clientId}/ledger`);
    expect(ledgerRes.status).toBe(200);
    expect(ledgerRes.body.totalItems).toBe(1);
    expect(ledgerRes.body.transactions).toHaveLength(1);
    expect(ledgerRes.body.transactions[0].type).toBe('deposit');
    expect(ledgerRes.body.transactions[0].amountCents).toBe(AMOUNT_CENTS);
    expect(ledgerRes.body.transactions[0].clientBalanceAfter).toBe(AMOUNT_CENTS);

    // And the type check constraint's own vocabulary is exhausted: the only
    // row ever posted for this account is the one deposit. No withdrawal,
    // transfer, or refund snuck in to fund a fee out of client money.
    expect(await allTxnTypesFor(trustAccountId)).toEqual(['deposit']);
  }

  it('a successfully billed fee is charged to the firm, not deducted from the client principal', async () => {
    await testPool.query(
      `update law_firms set plan = plan || '{"stripeCustomerId":"cus_fees_outside_billed"}'::jsonb where id = $1`,
      [firm.id],
    );
    const fakeStripe = installFakeStripeInvoicing();

    const PAYMENT_INTENT_ID = 'pi_fees_outside_billed';
    const payload = paymentIntentSucceededEvent('evt_fees_outside_billed', {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    const res = await deliver(payload);
    await drainEvents();
    fakeStripe.restore();

    expect(res.status).toBe(200);
    const depositId = await depositIdFor(PAYMENT_INTENT_ID);
    expect(depositId).toBeTruthy();

    // The fee really was billed (positive control: this file's claim about
    // "outside trust" is only meaningful if a fee genuinely got charged).
    const fee = await feeRowFor(depositId);
    expect(fee).not.toBeNull();
    expect(Number(fee.fee_cents)).toBe(EXPECTED_FEE_CENTS);
    expect(fee.status).toBe('billed');

    await assertPrincipalIsExactlyTheDeposit();
  });

  it('a fee left accrued for lack of a subscription customer still does not touch the principal', async () => {
    // No stripeCustomerId on this firm -- billFirmForTrustAchFee accrues the
    // fee and returns without ever calling Stripe for the charge.
    const PAYMENT_INTENT_ID = 'pi_fees_outside_no_customer';
    const payload = paymentIntentSucceededEvent('evt_fees_outside_no_customer', {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    const res = await deliver(payload);
    await drainEvents();

    expect(res.status).toBe(200);
    const depositId = await depositIdFor(PAYMENT_INTENT_ID);
    const fee = await feeRowFor(depositId);
    expect(fee).not.toBeNull();
    expect(Number(fee.fee_cents)).toBe(EXPECTED_FEE_CENTS);
    expect(fee.status).toBe('accrued');

    await assertPrincipalIsExactlyTheDeposit();
  });

  it('a fee whose up-front charge attempt fails is left accrued, and still does not touch the principal', async () => {
    await testPool.query(
      `update law_firms set plan = plan || '{"stripeCustomerId":"cus_fees_outside_declined"}'::jsonb where id = $1`,
      [firm.id],
    );
    const fakeStripe = installFakeStripeInvoicing({ pay: 'decline' });

    const PAYMENT_INTENT_ID = 'pi_fees_outside_declined';
    const payload = paymentIntentSucceededEvent('evt_fees_outside_declined', {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    // The deposit itself must succeed even though the firm's card charge for
    // the fee failed -- the client's funds already landed in trust and are
    // not held hostage by an unrelated billing failure on the firm's side.
    const res = await deliver(payload);
    await drainEvents();
    fakeStripe.restore();

    expect(res.status).toBe(200);
    const depositId = await depositIdFor(PAYMENT_INTENT_ID);
    const fee = await feeRowFor(depositId);
    expect(fee).not.toBeNull();
    expect(Number(fee.fee_cents)).toBe(EXPECTED_FEE_CENTS);
    expect(fee.status).toBe('accrued');

    await assertPrincipalIsExactlyTheDeposit();
  });
});
