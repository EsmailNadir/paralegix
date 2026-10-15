/**
 * B06.3 T05: "Fee attempt times out after provider may have charged."
 *
 * The ACH processing fee on a trust deposit is charged up front, off the
 * firm's operating card, inside `billFirmForTrustAchFee` ->
 * `chargeAccruedTrustFee` (stripe.service.ts). That path already documents an
 * idempotency design for exactly this scenario:
 *
 *  - The fee invoice id is persisted (`attachTrustDepositFeeInvoice`) BEFORE
 *    `stripe.invoices.pay` is ever called, so a retry can look up the CURRENT
 *    provider-side state of that invoice instead of guessing.
 *  - Every outbound call carries a deterministic idempotency key derived from
 *    `trustTransactionId` (`trust_fee_<id>_{inv,item,final,pay}`), not a fresh
 *    key per attempt, so a retry of the same logical step is safe to repeat
 *    even without the local "check first" logic.
 *  - The `pay` call's own catch block re-`retrieve`s the invoice before
 *    deciding to propagate the error, so an ambiguous local failure (the
 *    request errored, but the charge may have gone through) is resolved by
 *    asking Stripe rather than assumed either way.
 *
 * Nothing before this file exercised that design under an actual ambiguous
 * failure. These tests drive it for real (through the webhook route and
 * `sweepAccruedTrustFees`), with the Stripe SDK's own methods stubbed to
 * behave like a request that failed locally while the operation completed (or
 * didn't) on Stripe's side, the one thing that can't be tested by mocking
 * `chargeAccruedTrustFee` itself.
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

const stripeService = require('../../src/modules/stripe/stripe.service');

const WEBHOOK_SECRET = 'whsec_test_secret_for_the_fee_retry_suite';
const AMOUNT_CENTS = 100_000; // fee = min(round(100000*0.008), 500) = 500, deterministic
const EXPECTED_FEE_CENTS = 500;

const deliver = (payload: string) => deliverSigned(payload, WEBHOOK_SECRET);

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('T05: a trust deposit ACH fee charge that times out after Stripe may already have completed it', () => {
  let firm: Firm;
  let owner: any;
  let clientId: string;
  let trustAccountId: string;
  let fakeStripe: ReturnType<typeof installFakeStripeInvoicing>;

  beforeEach(async () => {
    firm = await createFirm();
    owner = await ownerOf(firm.id);
    const client = await createPersonClient(firm.id, { name: 'Fee Retry Client' });
    clientId = client.id;

    // A subscription customer on file is what makes `billFirmForTrustAchFee`
    // actually attempt the charge instead of leaving it accrued for the sweep.
    await testPool.query(
      `update law_firms set plan = plan || '{"stripeCustomerId":"cus_fee_retry_test"}'::jsonb where id = $1`,
      [firm.id],
    );

    trustAccountId = await createTrustAccount(owner, firm.id, { name: 'Fee Retry IOLTA', last4: '4400' });

    fakeStripe = installFakeStripeInvoicing();
  });

  afterEach(() => {
    fakeStripe.restore();
  });

  it('an ambiguous pay-call error that Stripe actually completed resolves to billed, not a second charge', async () => {
    const PAYMENT_INTENT_ID = 'pi_fee_retry_ambiguous_resolved';

    // The first (and, if this works, ONLY) pay attempt: our client errors out
    // (as a real network timeout would), but the charge genuinely went through
    // on Stripe's side -- reflected here by flipping the fake invoice to paid
    // before throwing, exactly like a response that completed server-side but
    // was never received.
    fakeStripe.setPayBehavior(async () => {
      fakeStripe.state.status = 'paid';
      throw Object.assign(new Error('simulated timeout reading the pay response'), { code: 'ETIMEDOUT' });
    });

    const payload = paymentIntentSucceededEvent('evt_fee_retry_ambiguous', {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    const res = await deliver(payload);
    await drainEvents();

    // The deposit itself must never be at risk of a fee-charging hiccup.
    expect(res.status).toBe(200);

    const depositId = await depositIdFor(PAYMENT_INTENT_ID);
    expect(depositId).toBeTruthy();

    const fee = await feeRowFor(depositId);
    expect(fee).not.toBeNull();
    expect(Number(fee.fee_cents)).toBe(EXPECTED_FEE_CENTS);
    // Resolved to billed WITHOUT a second attempt: the pay catch block noticed
    // (via retrieve) that the invoice was actually paid, rather than treating
    // the local error as "nothing happened."
    expect(fee.status).toBe('billed');
    expect(fee.stripe_invoice_id).toBe(fakeStripe.state.id);

    expect(fakeStripe.payCalls).toHaveLength(1);
    expect(fakeStripe.idempotencyKeys.create).toHaveLength(1);
    expect(fakeStripe.idempotencyKeys.pay[0]).toBe(`trust_fee_${depositId}_pay`);
  });

  it('a retry after a genuinely unresolved pay failure reuses the same invoice and idempotency key, never a fresh charge', async () => {
    const PAYMENT_INTENT_ID = 'pi_fee_retry_genuine_failure';

    // First attempt: pay errors AND the invoice is genuinely still unpaid on
    // Stripe's side (a real decline, or a timeout where nothing happened) --
    // the hardest case, since nothing here can locally resolve the ambiguity.
    fakeStripe.setPayBehavior(async () => {
      // status stays 'open'
      throw Object.assign(new Error('simulated card decline'), { code: 'card_declined' });
    });

    const payload = paymentIntentSucceededEvent('evt_fee_retry_genuine_failure', {
      paymentIntentId: PAYMENT_INTENT_ID, lawFirmId: firm.id, trustAccountId, clientId, amountCents: AMOUNT_CENTS,
    });
    const res = await deliver(payload);
    await drainEvents();

    // The webhook itself still succeeds -- a failed fee charge must never
    // fail the deposit (the deposit already landed; the firm still owes the
    // fee, and the sweep exists precisely to retry it).
    expect(res.status).toBe(200);

    const depositId = await depositIdFor(PAYMENT_INTENT_ID);
    const feeAfterFirstAttempt = await feeRowFor(depositId);
    expect(feeAfterFirstAttempt.status).toBe('accrued');
    expect(feeAfterFirstAttempt.stripe_invoice_id).toBe(fakeStripe.state.id); // persisted before pay was attempted
    expect(fakeStripe.payCalls).toHaveLength(1);
    expect(fakeStripe.idempotencyKeys.create).toHaveLength(1);

    // Time passes; the retry sweep runs. This time the charge actually succeeds.
    fakeStripe.setPayBehavior(null); // default behavior: succeed, mark paid
    const sweepSummary = await stripeService.sweepAccruedTrustFees({});

    expect(sweepSummary.billed).toBe(1);
    expect(sweepSummary.failures).toHaveLength(0);

    const feeAfterRetry = await feeRowFor(depositId);
    expect(feeAfterRetry.status).toBe('billed');
    // Same invoice reused across both attempts -- never a second Stripe invoice
    // (a second charge) for the same logical fee.
    expect(feeAfterRetry.stripe_invoice_id).toBe(fakeStripe.state.id);
    expect(fakeStripe.idempotencyKeys.create).toHaveLength(1);
    expect(fakeStripe.idempotencyKeys.item).toHaveLength(1);
    expect(fakeStripe.idempotencyKeys.final).toHaveLength(1);

    // Both pay attempts used the exact SAME idempotency key -- a stable
    // identity for this logical operation, not a fresh key per attempt (which
    // would defeat Stripe's own replay protection too).
    expect(fakeStripe.payCalls).toHaveLength(2);
    expect(fakeStripe.payCalls[0]).toBe(fakeStripe.payCalls[1]);
    expect(fakeStripe.payCalls[0]).toBe(`trust_fee_${depositId}_pay`);
  });

  // The clean first-attempt control lives in `trustFeesOutsidePrincipal.test.ts`,
  // which asserts the billed fee to the cent.
});
