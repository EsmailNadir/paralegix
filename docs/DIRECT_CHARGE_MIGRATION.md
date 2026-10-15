# Direct-Charge Migration: Shift Payment Dispute Liability to Firms

**Status (2026-09-22): built for invoice payments, on staging.** The decisions below are
locked, and the design changed in one important way once Stripe's own rules were tested:

- **Standard accounts, not Express.** Stripe refuses an Express account (Express dashboard)
  unless the PLATFORM pays Stripe's fees and carries losses, whatever the charge type
  (`stripe_dashboard[type]=express` requires `fees.payer=application` and
  `losses.payments=application`). So direct charges on Express would not have moved the
  liability at all. New firm accounts are created with `controller.fees.payer=account`,
  `controller.losses.payments=stripe`, `controller.stripe_dashboard.type=full`: the firm pays
  Stripe's fees and Stripe, not Paralegix, carries negative balances.
- **Fee:** 0.9% of the charge, no fixed part (`STRIPE_DIRECT_APPLICATION_FEE_RATE` /
  `_FIXED_CENTS`), which keeps Paralegix's margin and the firm's total cost where the
  destination model left them.
- **Rollout:** per firm, by connection. `createConnectAccount` makes every NEW account Standard
  and sets `law_firms.direct_charges_enabled`; a firm still on Express keeps destination charges
  until it disconnects and reconnects. Production starts with fresh onboarding anyway.
- **Trust stays on destination charges.** A Standard account must pay its own fees
  (`fees.payer=application` is refused with the full dashboard), and Stripe takes them from the
  charge, so a direct trust deposit would pay Stripe's fee out of client money in the IOLTA.
  Trust deposits keep the destination model, the payout delay and the operating-card backstop.
- **No new migration.** Phase 0's columns carry it (`direct_charges_enabled`,
  `invoice_payments.charge_model`). The firm-side Customer is found by the client's email on the
  firm's account (`customers.list`, consistent) and matched on `metadata.paralegixClientId`,
  instead of the `client_stripe_customers` table this plan proposed.
- **What the code does:** `invoiceChargeScope` in `stripe.service.ts` decides per firm; every
  Stripe call about a direct firm's invoice payments carries `{ stripeAccount }`; no
  `transfer_data`; `metadata.chargeModel = 'direct'` on the invoice, session and payment intent,
  recorded on `invoice_payments.charge_model`; refunds and disputes on a direct payment reopen the
  invoice but skip transfer recovery and restore, because Stripe debited or credited the firm.
  Direct-charge events arrive as Connect events on the Connect endpoint (see /dev/ops/webhooks).
  Tests: `backend/tests/stripe/stripeDirectCharges.test.ts`.
- **Not done:** returning the 0.9% application fee proportionally on a refund
  (`refund_application_fee`), and firm-facing copy beyond the fee note on invoice screens.

The original plan follows, kept for its reasoning; where it says Express or proposes a customer
table, the status above supersedes it.

**Status:** Phase 0 landed (staging); Phases 1–5 not started and **blocked on the business
decisions in "Decisions to lock before building"**. This is the "Layer 3" structural fix
referenced in `docs/TRUST_STRIPE_COMPLIANCE.md` and the (since retired) billing/payments audit. Layers 1–2 (payout
hardening + automatic fund recovery, gated by `STRIPE_AUTO_RECOVERY_ENABLED`) reduce the
bleed on the current destination-charge model but do **not** remove Paralegix's liability.
This migration removes it at the source.

**Phase 0 (done, behavior-neutral):** the old migration `0096_direct_charge_foundation.sql`,
now folded into `backend/db/schema.sql` (`schema/10_identity.sql`, `70_billing.sql`,
`80_trust.sql`), adds the per-firm `law_firms.direct_charges_enabled` cutover flag and a
`charge_model` (`'destination'|'direct'`) marker on `invoice_payments` and
`trust_transactions`. Every column defaults to the current model, so nothing changes until a
later phase flips it. Nothing in `backend/src` yet writes `'direct'` or reads
`direct_charges_enabled` (only the introspected Drizzle schema names them). **Do not build
Phases 1+ until a product owner signs off on the decisions in "Decisions to lock before building" (fee re-pricing, Stripe loss-liability
config, firm merchant-of-record comms) — these change live charges and firm-visible
behavior and cannot be validated without that sign-off.**

Prereq reading: `docs/TRUST_STRIPE_COMPLIANCE.md` (trust Connect model). Do NOT start
implementation until a product owner signs off on the pricing and firm-communication changes
in "Decisions to lock before building".

## Problem

Every client payment is a Stripe **destination charge** created on the platform account:

- Invoice payment (Invoices API, `requestPayment`): `stripe.service.ts:1294`: `transfer_data.destination = firmData.stripeAccountId`, `application_fee_amount = computeApplicationFeeCents(...)`.
- Invoice payment (Checkout session, `getClientCheckoutUrl`): `stripe.service.ts:1512`: same shape.
- Installment payment (Invoices API, `requestInstallmentPayment`): `stripe.service.ts:2908`: same shape.
- Trust deposit (Checkout session, ACH, `requestTrustDeposit`): `stripe.service.ts:1684`: `transfer_data.destination = trustAccount.stripeConnectedAccountId`, no application fee.

(Line numbers as of 2026-09-10; search for the function name if they drift.)

Per Stripe (`docs.stripe.com/connect/disputes`): **for destination charges the platform
balance is debited for the disputed amount and fee, with or without `on_behalf_of`.** So on
any chargeback, refund, or ACH return, Stripe pulls the money from Paralegix's balance while
the funds already sit in the firm's (or IOLTA) connected account. `on_behalf_of` does not
change this — only the **charge type** does.

## Goal

Move client payments to **direct charges** (created *on* the firm's connected account via the
`Stripe-Account` header), with an `application_fee_amount` collecting Paralegix's cut. Then:

- The **connected account is primarily liable** for disputes/refunds. Stripe debits the
  firm's balance first; the platform is only liable if it owns negative-balance responsibility
  *and* the firm's balance is insufficient.
- The firm becomes the **merchant of record** (statement descriptor, 1099-K, network dispute
  monitoring), which is the correct allocation — the firm is the entity selling legal services
  and holding client trust.

Non-goals: this does not replace Layers 1–2 for **trust** (see "Trust nuance" below: an IOLTA can't bear a
clawback after payout regardless of charge type; the operating-card backstop stays).

## Decisions to lock before building

1. **Fee economics.** On direct charges the *connected account* pays Stripe's processing
   fee; the platform keeps `application_fee_amount` as pure revenue. Today (destination) the
   platform pays the processing fee out of the app fee. Decide whether to lower the app fee
   (currently 3.8% + 30¢, `STRIPE_APPLICATION_FEE_RATE`) now that the firm bears processing.
2. **Negative-balance liability.** Decide, with Stripe, whether the platform or the connected
   account owns loss liability on these Express accounts. For the firm to truly bear disputes,
   the connected account should own it (or `debit_negative_balances=true` so Stripe recovers
   from the firm's bank). Trust is the exception ("Trust nuance" below).
3. **Cutover model.** Per-firm gradual rollout (recommended) vs. global flip. Spec assumes
   per-firm.

## Target architecture

### Charge creation
Replace the four destination-charge sites with direct charges on the firm's account:

```js
// Checkout-session flows (invoice checkout, installments, trust):
await stripe.checkout.sessions.create(
  {
    mode: 'payment',
    line_items: [...],
    payment_intent_data: {
      application_fee_amount: computeApplicationFeeCents(amountCents), // trust: omit
    },
    // NO transfer_data — the charge is already on the firm's account.
    ...
  },
  { stripeAccount: firm.stripeAccountId },   // <- the direct-charge switch
);
```

The Invoices-API flows (`requestPayment` and `requestInstallmentPayment`) are the same idea but every
call in the sequence (`invoices.create`, `invoiceItems.create`, `finalizeInvoice`) must carry
`{ stripeAccount }`, and the Customer must live on the connected account (below).

### Customers — the hardest part
`getOrCreateStripeCustomer` (`stripe.service.ts`) creates Customers on the **platform** and
caches the id on `clients.stripe_customer_id`. A platform Customer cannot be used for a charge
on a connected account. Options:

- **Checkout-session flows:** don't pre-create a Customer. Pass `customer_email` and let the
  connected-account Checkout Session create/own the Customer (and the ACH mandate for trust).
  Simplest; avoids a cross-account customer store. Trade-off: no reuse of a saved card across
  invoices unless the firm's Checkout is configured to save it.
- **Invoices-API flow:** requires a Customer on the connected account. Introduce a per-account
  customer map (new table `client_stripe_customers(law_firm_id, client_id, stripe_account_id,
  stripe_customer_id)`), created lazily with `{ stripeAccount }`. `clients.stripe_customer_id`
  becomes the *platform* subscription-side id only; do not overload it.

### Application-fee refunds
On a refund of a direct charge, decide whether Paralegix keeps or returns its fee. Setting
`refund_application_fee: true` returns the platform fee to the firm proportionally. Default
recommendation: return it (the firm shouldn't pay a platform fee on money it refunded).

### Webhooks — re-architecture
Direct-charge events fire on the **connected account**, delivered as **Connect events** with
`event.account` set. Today the payments endpoint already listens to connected accounts, but
only for `account.updated` (see /dev/ops/webhooks); every money handler in
`stripe.webhook.routes.ts` assumes a platform-scoped object. Changes:

1. Subscribe a Connect webhook (or enable "listen to connected accounts" on the endpoint) for:
   `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `charge.refund.updated`.
2. In every handler, when the event is a Connect event, retrieve objects with the account
   scope: `stripe.paymentIntents.retrieve(pi, { stripeAccount: event.account })`. The current
   handlers (`handleInvoicePaymentReversal`, `handleTrustDepositReversal`, `recoverConnectedTransfer`)
   assume platform-scoped objects and must branch on `event.account`.
3. The idempotency gate (`claimStripeEvent`, `stripe.webhook.routes.ts:47`) keys on `event.id`,
   which is unique per delivery — unchanged and still correct.

### What Layer 1/2 recovery becomes
For a **direct-charge** invoice there is **no transfer to reverse** — Stripe already debited
the firm. `recoverConnectedTransfer` / `restoreConnectedTransfer` (added in Layer 1) are only
meaningful for residual destination charges. The reversal handlers still run to keep
Paralegix's *internal* ledger correct (mark the invoice open again), but the money movement is
Stripe's, not ours. Handlers must branch on charge model (below) so they don't try to reverse a
transfer that doesn't exist.

## Data model

Phase 0 shipped `charge_model` on both tables and `law_firms.direct_charges_enabled`. The
`stripe_connected_account_id` columns on `invoice_payments` / `trust_transactions` and the
`client_stripe_customers` table do not exist yet; add them in the phase that needs them, as a
new numbered migration in `backend/db/migrations/` plus the matching edit to
`backend/db/schema/*.sql` (see the `new-migration` skill).

- `invoice_payments`: add `charge_model text default 'destination'` (`'destination' | 'direct'`)
  and `stripe_connected_account_id text`. Set on payment creation; read in webhook handlers to
  pick the right dispute/refund path during coexistence.
- `trust_transactions`: same two columns for Stripe-sourced deposits.
- New `client_stripe_customers` table (per §Customers) if the Invoices-API flow is kept.
- `law_firms`: a `direct_charges_enabled boolean default false` cutover flag (or derive from a
  rollout cohort).

## Trust nuance (why Layers 1–2 stay)

Direct charging the trust connected account makes the firm's *trust* account primarily liable
for an ACH return — good — but the fundamental risk is unchanged: **you cannot claw money back
out of an IOLTA once it pays out.** So for trust:

- Keep the payout delay (Layer 1) so returns hit the trust account's Stripe balance in-window.
- Keep `debit_negative_balances=false` on trust accounts — never auto-debit an IOLTA.
- Keep the operating-card backstop (`chargeFirmForTrustClawback`) for the residual that
  outlives the delay. Direct charges do not remove this need.

Net: trust = direct charge + payout delay + operating-card backstop. Invoices = direct charge
(the clean win).

## Rollout phases

- **Phase 0 — Data + flag.** Migrations (charge_model columns, `direct_charges_enabled`,
  optional customer table). Handlers read `charge_model` but nothing writes `'direct'` yet.
  No behavior change.
- **Phase 1 — Connect webhook.** Stand up the connected-account event subscription and make
  every handler `event.account`-aware, retrieving objects with `{ stripeAccount }`. Verify with
  the Stripe CLI against test-mode connected accounts. Still no direct charges created.
- **Phase 2 — Charge creation behind the flag.** For `direct_charges_enabled` firms, create
  direct charges (all four sites) + connected-account customer handling. Payments recorded with
  `charge_model='direct'`. Roll out to internal/pilot firms first.
- **Phase 3 — Refund/dispute paths.** Confirm the branch: direct charges skip transfer reversal
  (firm already debited) and only correct the ledger; destination charges keep Layer 1 recovery.
  Add `refund_application_fee` on direct-charge refunds.
- **Phase 4: Fee re-pricing + firm comms.** Ship the app-fee change (decision 1) and the firm-facing
  copy about being merchant of record / seeing processing fees on their account.
- **Phase 5 — General rollout + de-risk.** Enable for all firms. Destination-charge code stays
  until every in-flight destination charge's dispute window (~60–120 days for ACH) has closed,
  then remove it and the now-dead Layer 1 transfer-reversal recovery.

## Testing

- Stripe CLI, test mode, against a connected account (`--stripe-account acct_...`): simulate
  `charge.dispute.created`, `charge.refunded`, `charge.dispute.closed`, and an ACH return, and
  confirm (a) the firm's balance is debited, not the platform's, and (b) Paralegix's ledger
  reopens the invoice correctly.
- Verify `application_fee_amount` lands on the platform and `refund_application_fee` returns it.
- Trust: simulate an ACH return before and after the payout delay window; confirm in-window
  recovers from the trust account's Stripe balance and out-of-window hits the operating-card
  backstop, never the IOLTA.
- Coexistence: a destination charge created pre-cutover must still route through Layer 1
  recovery after cutover (assert on `charge_model`).

## Risks & open questions

- **Merchant-of-record shift is firm-visible:** statement descriptors change to the firm; the
  firm receives the 1099-K (removes that burden from Paralegix, but must be communicated).
- **Saved-payment-method reuse** across invoices weakens if we drop pre-created customers for
  Checkout flows; confirm the product doesn't rely on it.
- **Loss-liability configuration** on Express accounts must be confirmed with Stripe so firms
  actually bear disputes; otherwise the platform is still ultimately liable and this migration
  buys only merchant-of-record separation, not liability transfer.
- **Negative-balance / underfunded firm:** if a firm's account can't cover a dispute and the
  platform owns loss liability, Paralegix is back on the hook — reserves/`debit_negative_balances`
  mitigate but don't eliminate. Trust always retains residual platform exposure ("Trust nuance").
- **Effort:** this is a multi-week migration touching charge creation, the customer model, the
  entire webhook layer, refund/dispute handling, and a firm-comms/pricing change — materially
  larger than Layers 1–2. Sequence it behind the per-firm flag and never big-bang it.
