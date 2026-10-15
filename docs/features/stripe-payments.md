# Stripe payments and Connect

## Summary

The Stripe module moves every dollar that is not a subscription: a client paying an
invoice, a client funding a trust account electronically, and the reversals when either
comes back. It holds the firm's Connect onboarding for two separate connected accounts
(the operating account and, per trust account, a trust bank account), the secure payment
links the firm sends, the portal checkout a client pays through, and the thirteen webhook
events that turn all of it into ledger rows. Subscriptions are a **different** module and
a different webhook endpoint (`docs/features/lawfirms-rbac-plans.md`).

At about 3,300 lines it is the largest single service in the backend and the only one
where a bug moves money in the wrong direction.

## Key Takeaways

- **Two webhook endpoints, two secrets, two event lists, and they must not overlap.**
  `/api/webhooks/stripe` (payments) and `/api/webhooks/stripe-subscriptions` are mounted
  before `express.json()` because signature verification needs the raw body
  (`backend/src/app.ts:361-362`). Which endpoint gets which events is in `/dev/ops/webhooks`.
- **The API version is pinned** to `2026-08-26.dahlia` in
  `backend/src/modules/stripe/stripe.config.ts:19`. It is not
  cosmetic: `Invoice.payment_intent` disappeared in `2025-03-31.basil` and every
  hosted-invoice payment (invoice payments no longer use hosted invoices) silently stored a
  null intent id until the reader learnt the new shape. Bump the version deliberately, with
  the changelog open, and update the readers with it.
- **Every webhook is claimed before it is processed.** `claimStripeEvent` claims the
  event id in `stripe_events`, keyed per webhook endpoint. A finished event acks 200 and
  does nothing, one another delivery is still processing gets 409 so Stripe retries, and
  a claim older than `STRIPE_EVENT_CLAIM_STALE_SECONDS` is reclaimed. A failure releases
  the claim so Stripe's retry can re-claim it. Full protocol: /dev/ops/webhooks.
- **Client payments are destination charges.** The platform takes an application fee and
  the remainder settles to the firm's connected account (`stripe.service.ts:1293`). **A
  trust deposit carries no application fee** and settles to the trust account's own
  connected account, because client money must land in full (`:1682-1684`).
- **Money is applied under the invoice row lock**, never by an in-database increment. The
  whole write payload is computed in JavaScript, so re-applying a duplicate is a no-op
  (`applyStripeCandidateTransaction`, `stripe.service.ts:580`).
- **A returned deposit whose funds have already left charges the firm's card**, and only
  when `STRIPE_AUTO_RECOVERY_ENABLED` is on. It defaults to **off**, and while it is off
  every clawback is a platform loss (`stripe.service.ts:2503`).

---

## How It Works

### Entry Points

| Surface | Path | File |
|---|---|---|
| Firm routes | `/api/stripe/...` | `stripe.routes.ts`, mounted at `app.ts:904` |
| Payments webhook | `POST /api/webhooks/stripe` | `stripe.webhook.routes.ts:25`, mounted at `app.ts:361` |
| Subscriptions webhook | `POST /api/webhooks/stripe-subscriptions` | `subscriptions.webhook.routes.ts:9`, mounted at `app.ts:362` |

The firm routes fall into four groups. `verifyToken` is applied router-wide
(`stripe.routes.ts:12`) and every route names its own permission code.
`requireActiveBilling` guards only the two routes that start a new charge: the invoice
payment request and the trust deposit request.
Voiding a link, and every Connect route, works on a lapsed subscription.

| Route | Permission | Purpose |
|---|---|---|
| `POST /connect/:lawFirmId/create-account`, `GET .../status`, `GET .../dashboard-link`, `DELETE /connect/:lawFirmId` | `settings.manageFirm` (status: `billing.viewInvoices`) | The firm's own operating connected account |
| The same four under `/trust-connect/:lawFirmId/:trustAccountId` | `trust.manage` (status: `trust.view`) | One connected account per trust account, tagged `metadata.purpose = 'trust'` (`stripe.service.ts:977`) |
| `POST /payment/:lawFirmId/:contextType/:entityId/:invoiceId/request` and `.../void`, `GET .../fee-quote` | `billing.recordPayments` | Create, quote or cancel the invoice's secure payment link, for the full balance or one installment |
| `POST /trust/:lawFirmId/request-deposit` | `trust.manage` | Ask a client to fund trust electronically |

On the frontend both onboarding screens (the operating account on
`settings/payments/page.tsx`, the trust account in `TrustConnectSettings.tsx`) share one
lifecycle hook, `frontend/src/hooks/useStripeConnect.ts`, which owns status, connect,
dashboard link and disconnect over the service methods in `billing.service.ts:2027-2184`.

### Data Flow: a client pays an invoice

1. The firm requests payment. `requestPayment` stores a secure payment link token on the
   invoice, for the full balance or one installment (see "Payment requests: one secure
   link" below). Nothing is created at Stripe yet.
2. The client opens the link (or pays in the portal) and picks card or bank transfer.
   `getClientCheckoutUrl` mints a Checkout Session for the requested amount, with the
   application fee and, for a destination charge, `transfer_data.destination` set to the
   firm's connected account.
3. Stripe delivers `checkout.session.completed` (or, for a bank debit that settles later,
   `checkout.session.async_payment_succeeded`). The endpoint verifies the signature, claims
   the event id, and dispatches on `event.type`.
4. The handler builds a **candidate**: the firm, the invoice, the amount, the payment
   intent id, the date and any targeted installment, read from the `metadata` the checkout
   wrote (`buildStripeCandidateFromCheckoutSession`).
5. `applyStripeCandidateTransaction` (`:580`) runs the read, the computation and the write
   inside `invoicesRepo.runInvoiceTxn`, which holds a `select ... for update` on the
   invoice row. Two concurrent deliveries cannot both see the pre-payment state.
6. The payment lands in `invoice_payments` with `payment_source = 'stripe'` and its
   PaymentIntent id, which is what a later refund or dispute looks the payment up by.
7. `INVOICE_PAYMENT_RECEIVED` is emitted, from the invoice the transaction just wrote;
   `stripe.events.ts` mails the firm's admins. The payment is already committed by now, so
   nothing after it can fail the webhook: a failing announcement is logged and the endpoint
   still answers 200, because a 500 would only make Stripe retry into a duplicate that
   returns early and could never announce it.

### Data Flow: an electronic trust deposit

Deliberately different, because the money belongs to the client rather than the firm.

1. `requestTrustDeposit` (`stripe.service.ts:1574`) refuses unless the firm has opted in
   (`electronicTrustDepositsAllowed`), has a subscription customer to bill the processing
   fee to, and the trust account has its own connected account that can accept charges. It
   also checks the matter belongs to the paying client.
2. It creates a Checkout Session carrying `metadata.depositType = 'trust'`, with
   **no application fee** and `transfer_data.destination` set to the trust account's
   connected account (`:1682-1684`). Like an invoice payment request, the firm chooses to
   have the link emailed to the client (`sendEmail: true`, `sendTrustDepositRequestEmail`,
   returned as `emailedTo`) or copies it to send another way. Unlike the invoice pay link,
   it is a Stripe Checkout link and Stripe ends it after 24 hours; the email and dialog say so.
3. **Nothing is posted at checkout.** ACH can still fail after the session completes, so
   the webhook router skips every checkout event whose `metadata.depositType` is `'trust'`
   (`stripe.webhook.routes.ts:68,78,85`) and posts on `payment_intent.succeeded`
   (`handleTrustDepositPaymentSucceeded`, `stripe.service.ts:1705`), which is when the
   funds are real. The ledger entry is dated at the event time, not the checkout.
4. `trustService.createTrustDepositFromStripe` writes the ledger row, idempotent on the
   Checkout Session id and on the payment intent id (`trust.service.ts:1121`), with a
   partial unique index on each as the backstop.
5. The processing fee (`STRIPE_TRUST_ACH_FEE_RATE`, capped by
   `STRIPE_TRUST_ACH_FEE_CAP_CENTS`, `computeTrustAchFeeCents`, `stripe.service.ts:95`) is accrued against the firm's
   operating side in `trust_deposit_fees` and billed later by `chargeAccruedTrustFee`
   (`:2166`). That fee invoice carries `{ lawFirmId, trustTransactionId }` and **no**
   `invoiceId`; the payments webhook acknowledges `invoice.paid` and `invoice.voided` without
   acting on them.

### Data Flow: a reversal

`charge.refunded`, `charge.dispute.created` and `charge.dispute.funds_withdrawn` each run
two handlers, one after the other, and each no-ops when the charge is not theirs
(`stripe.webhook.routes.ts`, `reverseDisputedFunds`). A dispute's cumulative reversal target
is the charge's `amount_refunded` plus the disputed `amount`, capped at the charge
(`disputeReversalTargetCents`): Stripe's dispute amount excludes earlier refunds, so passing
it alone after a partial refund reversed too little. The charge is read on the connected
account for a Connect event. A partial dispute still reverses only the disputed portion, and
`created` plus `funds_withdrawn` for one dispute reverse once. An inquiry (`warning_*`
status) reverses nothing on `created`, because it withdraws no funds and closes as
`warning_closed`, which restores nothing. A Connect event (`event.account`) never runs the
trust handler, and reverses an invoice payment only when it is a direct charge of the firm
that owns that account.

1. `handleTrustDepositReversal` (`:1781`) reverses the ledger entry, dated at the event
   time rather than the original charge date so it cannot land in a closed trust period.
   The whole decide-then-post sequence runs under `withLock('STRIPE_PAYMENT_INTENT', ...)`,
   so a simultaneous refund and dispute for one deposit cannot both reverse it. The lock
   is a lease row in `lock_leases` (`shared/database/advisoryLock.ts`) that holds no pool
   connection across the Stripe calls and expires after
   `STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS`. The ledger writes run in the trust service's
   own transactions, never in a transaction the lock opened.
2. `handleInvoicePaymentReversal` (`:1877`) converges the payment on
   `original - amount_refunded`. Stripe's `amount_refunded` is **cumulative**, so the
   handler is idempotent and order-safe across partial refunds and re-deliveries. What a
   dispute took is kept apart from what a refund took: `invoice_payments.stripe_refunded_cents`
   is the whole reversal and `stripe_disputed_cents` is the part of it a dispute accounts
   for. A won dispute (`recreditInvoicePayment`) gives back at most that part, so money a
   refund really returned to the customer stays reversed; a failed refund gives back the
   rest.
3. Cash recovery runs after the ledger step, and the ledger decides its source. The trust
   connected account's Stripe balance pools every client's pending deposits, so reversing the
   trust transfer (`recoverConnectedTransfer`) is used only when the ledger reversal for the
   same cents succeeded. When the ledger refused (the client already spent the money), the
   trust transfer is left alone and `chargeFirmForTrustClawback` bills the whole delta to the
   firm's operating card; it also covers whatever a transfer reversal could not. The card is
   charged off-session on the firm's subscription customer, with an idempotency key suffixed
   by the cumulative target. Every Stripe object that moves recovered cash is recorded in
   `stripe_fund_recoveries`, and the cash still owed is the target less what that table
   holds, so a replay of a refused clawback charges the firm once. `notifyFirmOfClawbackCharge` (`:2555`) then sends a `trust_clawback_charged`
   notification to the firm's owners and every member whose role holds `trust.manage`,
   naming the amount and the recovery PaymentIntent. The notification is best-effort: a
   failure is logged, never retried.
4. The restore counterparts run one handler each, and it undoes both halves:
   `charge.dispute.closed` (`handleDisputeClosed`) restores only when the dispute was
   won, dated at the event's own timestamp rather than the day the dispute opened (a lost
   dispute instead emits `INVOICE_PAYMENT_DISPUTE_LOST`, which emails the client that the
   payment was returned; a refund emails them too, an opened dispute never does);
   `charge.refund.updated` (`handleRefundUpdated`, `:2002`) acts only when the refund
   failed. Both call `restoreReversedFunds` (`:2017`), which re-credits the invoice payment
   and re-posts the trust deposit, each a no-op when the payment intent is not theirs.
   It runs under the same per-payment-intent lock as the clawback. With recovery on, the
   cash goes back from the `stripe_fund_recoveries` record, independent of what the ledger
   or the invoice did: `restoreTrustCash` refunds the recorded firm-card charges first, then
   transfers back to the trust connected account only what was reversed out of it, and
   `restoreConnectedTransfer` returns to the firm only what was reversed out of its operating
   account. That last cap matters on a destination charge: the transfer, and so the
   recovery, is the charge less the application fee, which the firm never had. Each restore
   is keyed on the recovery row and how much of it had gone back, so a replay sends nothing
   twice.

### Data Model

| Table | Holds |
|---|---|
| `stripe_events` | One row per webhook endpoint and event id, `processing` or `done`. The whole idempotency mechanism (`db/schema/10_identity.sql`) |
| `law_firms.stripe_account_id` + `stripe_charges_enabled` / `stripe_onboarding_complete` | The firm's operating connected account and a mirror of its capability state (`db/schema/10_identity.sql:68-70`) |
| `trust_accounts.stripe_connected_account_id` + `stripe_charges_enabled` / `stripe_onboarding_complete` | The per-trust-account connected account, unique when set (`db/schema/80_trust.sql:30-32,40`) |
| `clients.stripe_customer_id` | The Stripe customer, created once and reused. `syncStripeCustomerIdentity` (`stripe.service.ts:1123`) pushes a changed email or name onto it on every payment path: one retrieve, an update only when something differs, every failure swallowed so a payment is never refused over a stale display name |
| `invoices.pay_link_token` / `pay_link_installment_id` / `stripe_checkout_session_id` / `stripe_payment_status` / `stripe_payment_requested` | The open payment request: the link's token, the installment it asks for (null for the full balance), and the checkout session a client opened from it. The session pointer is cleared only by an event naming the session the invoice still points at |
| `invoice_payments.stripe_payment_intent_id` | What a refund or dispute finds the payment by |
| `trust_deposit_fees` | The accrued ACH processing fee, `accrued` then `billed` (`db/schema/80_trust.sql:47`) |
| `stripe_fund_recoveries` | Cash automatic recovery took back per payment intent, one row per transfer reversal or firm-card charge, with `source` (`trust_transfer`, `firm_transfer`, `firm_card`) and `restored_cents` (migration 0046) |

### Key Logic and Rules

- **A stale event may not clear a newer pointer.** The checkout expires an amount-mismatched
  session and mints a fresh one; the old session's `checkout.session.expired` then arrives.
  Each handler compares the event's session id with the one currently stored and returns
  when they differ.
- **`invoice.paid` and `invoice.voided` are acknowledged and ignored.** No invoice payment
  uses a hosted Stripe invoice. The trust fee invoices this module creates itself, and
  subscription invoices, still reach this endpoint; refusing one would make Stripe retry for
  days.
- **Trust deposits skip every checkout event and post on the payment intent.** Recording at
  checkout would credit a trust account before the bank confirmed.
- **The application fee never applies to trust.** A trust deposit lands in full.
- **A Stripe-funded trust deposit cannot be voided by hand.** The reversal must come back
  through `charge.refunded` so the money and the ledger move together
  (`trust.service.ts`, `TRUST_ENTRY_STRIPE_FUNDED`).
- **A request Stripe reports paid cannot be voided.** `voidPaymentRequest` refuses with
  400 when the request's checkout session has completed at Stripe (the client paid, or a
  bank debit is settling). Clearing it instead told the firm it had cancelled a request
  that had in fact been paid.
- **An installment link never asks for more than the invoice owes.** It charges
  `min(installment amount, total - paid - written off)`, with the application fee computed
  on the amount actually charged. A payment recorded outside the plan lowers the balance
  without marking an installment paid.
- **Disconnecting a trust connected account fails closed.** When Stripe cannot report the
  account's balance, `disconnectTrustConnectAccount` answers 503
  `STRIPE_TRUST_BALANCE_UNKNOWN` instead of assuming it is empty, so client money cannot be
  stranded in Stripe.
- **A failed ACH trust deposit reaches a person.** `payment_intent.payment_failed` emits
  `TRUST_DEPOSIT_FAILED`; the listener in `trust.events.ts` sends a non-muteable
  `trust_deposit_failed` notification to owners and `trust.manage` holders with the amount,
  the client and the bank's reason. Nothing was posted, so there is no ledger work.
- **Plan prices are checked by a script, not at runtime.**
  `backend/scripts/verify-stripe-prices.ts` compares the six configured price ids with
  `PLAN_TIERS` pricing. It found every annual id in local and staging to be a copy of the
  monthly one, so annual plans billed monthly and were recorded as monthly.
- **`requestTrustDeposit` is validated at the boundary** by `stripe.validation.ts`: uuids,
  whole cents, and the same money ceiling every other amount carries.

### Payment requests: one secure link

Every payment request makes **one secure payment link** per invoice to the no-login pay
page. The link asks for either the **full balance** or **one payment-plan installment**. The
firm either has Paralegix email it to the invoice's billing recipients, or copies it to send
another way, such as a text (`sendEmail: false`). No Stripe object exists until the client
picks a method on the pay page or in the portal.

- **The requested amount** is computed in one place, `payLinkRequest` in
  `billing/shared/payLinkRequest.ts`, and every surface reads it: the request email, the fee
  quote, the pay page, the portal's payment options and the checkout. The full balance is
  `total - paid - written off`. An installment link asks for `min(that row's amount, the full
  balance)`, but only while the row exists on an enabled plan and is not paid. Once the row
  is paid another way or leaves the plan, the link is **no longer payable**: the pay page and
  the pay-link checkout answer 404 like a dead link, and the portal checkout and options
  answer 400. Plan edits keep the link token but expire an existing checkout before
  changing what it collects (`runPaymentPlanTxn`). If Stripe cannot close the checkout,
  or it has collected or is processing a payment, the edit is refused.
- **Installments are named by their stable id.** `invoices.pay_link_installment_id` holds the
  target row's `installment_id` (the row's `id` in the API), not its position and not its
  database uuid, because a plan edit deletes and reinserts the rows. Null means the full
  balance.
- **Request** (`requestPayment`, `POST /api/stripe/payment/.../:invoiceId/request`): body
  `installmentId` (optional) names the installment. It must be on an enabled plan, exist and
  be unpaid, or the request is refused with 400. The request resolves who pays each
  processing fee (body `isCardFeePassedOn` / `isBankFeePassedOn`, defaulting to the firm's
  `billing.processingFees` setting) and stores it on the invoice (`is_card_fee_passed_on`,
  `is_bank_fee_passed_on`), closes the previous request's checkout session, and stores a fresh
  random token (`invoices.pay_link_token`) with the target (`pay_link_installment_id`),
  replacing any earlier link. It emails `${FRONTEND_URL}/pay/<token>` with the requested
  amount (and "Installment N" and that row's due date when one is targeted) unless
  `sendEmail` is false. Emailing needs a billing recipient; copying does not. It returns
  `{ message, paymentUrl }`. The link's address is built in one place,
  `billing/shared/payLinkUrl.ts`.
- **Copying later:** the firm invoice APIs return `paymentLinkUrl` while a request is open,
  and `payLinkInstallmentId` (null for the full balance). The invoice page shows **Copy
  Payment Link**. Each payment in `payments[]` carries `surchargeCents`, the fee the client
  paid on top (0 when none); the portal's invoice payments carry it too.
- **Request dialog** (`RequestPaymentDialog`, shared by every screen that requests payment):
  "Email it" or "Copy link", one "Client pays the processing fee" box, and the per-method
  breakdown from `GET .../fee-quote` (`getPaymentFeeQuote`, optional query `installmentId`),
  whose `invoiceCents` is what that link would charge. It also reports `emailTo`, the
  addresses an emailed link goes to, resolved as the request resolves them without freezing
  the bill-to.
- **Pay page** (`payLink.routes.ts`, `/api/pay/:token`, rate-limited by IP): `getPayPage`
  shows the firm name, invoice name, due date, `installmentNumber` (the target row's 1-based
  position, or null), the requested amount and each method's fee, nothing about the client.
  `startPayLinkCheckout` mints the method's Checkout Session returning to the pay link. A
  token that matches nothing, a withdrawn request, a voided invoice and an installment link
  that is no longer payable all answer 404. Reminders' "View Invoice & Pay" uses the link
  while one exists. Portal clients can also pay from the portal, which asks the method the
  same way.
- **Checkout** charges the requested amount. An installment's line item reads
  `Invoice #<name>, Installment <n>`, and the session metadata carries `installmentId` (the
  stable id) beside `invoiceAmountCents` (the requested amount). An open session is reused
  only for the same method, installment, amount and success/cancellation return URLs.
- **Crediting and request completion.** When a link's payment is recorded
  (`checkout.session.completed` with `payment_status: 'paid'`, or
  `checkout.session.async_payment_succeeded` for a bank debit), the webhook marks the row
  named by `metadata.installmentId` paid only when the money covers it, leaving any unpaid
  remainder open and applying excess to other open rows. If the row is gone or paid, it spreads the money
  across the open installments from the earliest one. It then **ends the request**:
  `stripe_payment_status = 'completed'`, `stripe_payment_requested = false`, and the token and
  target are cleared, so the link stops working and the firm can send the next installment's
  link. A bank debit still processing (`payment_status` not `'paid'`) records nothing and
  leaves the request open; checkout refuses a second session meanwhile.
- **Cancelling.** Voiding the request or the invoice clears the token and the target.
- **Balance changes keep the link working.** A manual payment, write-off or line edit expires
  only an open checkout session priced at the old amount (`expireStaleCheckoutSession`); the
  request stays open, because the pay page prices from the current balance.
- **No hosted Stripe invoices.** Invoice-level `invoices.stripe_invoice_id` /
  `stripe_invoice_account_id` and the per-row `invoice_expected_payments.stripe_invoice_id` /
  `stripe_invoice_account_id` / `stripe_payment_status` are no longer written or read; they
  remain only as columns. Nothing writes `stripe_payment_status` `'expired'` or
  `'payment_failed'` either; an async bank failure writes `'failed'` and leaves the request open.

#### Processing fees

| | Card | Bank transfer (ACH) |
|---|---|---|
| Estimated cost of a charge | 3.8% + 30c (Stripe's ~2.9% + 30c plus the 0.9% margin) | 0.8% capped at $5, plus 0.9% |
| Application fee, destination charge (Express) | the estimated cost | the estimated cost |
| Application fee, direct charge (Standard) | 0.9% | 0.9% |
| Env overrides | `STRIPE_APPLICATION_FEE_RATE`, `STRIPE_APPLICATION_FEE_FIXED_CENTS` | `STRIPE_ACH_FEE_RATE`, `STRIPE_ACH_FEE_CAP_CENTS`, `STRIPE_DIRECT_APPLICATION_FEE_RATE` |

- Every number lives in `stripe/processingFees.ts`, except the credit card fee, which lives in
  `stripe/cardFeeRules.ts` (see "Credit card fees" below). The firm settings are two separate
  switches stored as `settings.billing.processingFees.card` and `.bank`. Only
  `PUT /billing/card-fees` can set `card` to `'client'`; the generic firm settings route refuses it.
- **A passed-on bank fee is grossed up.** `clientSurchargeCents('bank', ...)` finds the smallest
  surcharge that leaves the firm the full invoice amount after the estimated cost of the larger
  charge: a $1,000.00 invoice charges $1,014.13 by bank. Hosted Checkout never adds a card fee,
  because it cannot tell credit from debit before the amount is fixed.
- **The fee travels as its own line and in metadata** (`paymentMethod`, `invoiceAmountCents`,
  `surchargeCents`). A session is reused only for the same method, installment and amount.
- **The webhook credits only invoice money.** `buildStripeCandidateFromCheckoutSession`
  subtracts `surchargeCents` (clamped to the charge) from `amount_total`, and the fee is stored in
  `invoice_payments.surcharge_cents`. The receipt names the fee and the total charged. A refund
  reduces invoice money first; on a destination charge, transfer recovery also takes back the
  fee's share once the refund passes the invoice amount.

### Credit card fees (the card form)

A firm can have its client pay the card fee, within what card-network rules and US law allow.
`stripe/cardFeeRules.ts` holds every rule as pure functions, and `stripe/cardFeeCopy.ts` (backend)
and `frontend/src/lib/payments/cardFeeCopy.ts` hold every sentence the client and firm see.

**The rules**

- **Credit cards only.** Debit, prepaid and unknown funding never carry a fee (federal debit
  rules and card-network rules).
- **The fee is the firm's real Stripe cost, capped.** `creditCardFeeCents` grosses up the firm's
  card rate (`cardFees.ratePercent` and `fixedCents`, default 2.9% and 30c, plus 1.5% for a card
  issued outside the US) and caps the result at 3% of the invoice, rounding the cap down. Under
  about $2,300 the cap binds and the firm can be up to 29c short; above it the firm nets the
  invoice exactly.
- **States.** `STATE_RULES` blocks California, Connecticut, Maine and Massachusetts and caps
  Colorado at 2%. The firm's state comes from the free-text `law_firms.state`, read through
  `normalizeUsState`.
- **Notice and disclosure.** The firm records the date it told Stripe and confirms its engagement
  letters disclose the fee (`cardFees.confirmation`, with who confirmed and when). The setting can
  only be on from 30 days after that date, counted on the firm's own calendar day.
- **No Paralegix fee on a surcharged payment.** A charge whose client paid a card fee carries no
  `application_fee_amount`. A card the firm absorbs (debit, prepaid, unknown, or the fee not
  passed on) carries the usual 0.9% margin.

`cardFeeEligibility` returns `{ eligible, reasons, state, capPercent, availableFrom }`. The reasons
are `stripe_not_connected`, `state_missing`, `state_banned`, `not_confirmed` and `notice_period`.
`GET/PUT /api/lawfirms/:lawFirmId/billing/card-fees` (`workbench.routes.ts`,
`cardFeeSettings.service.ts`) reads and writes it; turning the fee on is refused with every reason
that applies. A payment request refuses an explicit card fee the firm may not use, and silently
drops a firm default it may not use.

The firm also chooses `debitCards` and `internationalCards`, each `'absorb'` or `'decline'`. Those
choices apply only when the card fee is passed on; a firm that pays the fee accepts every card.

**The flow** (`stripe/cardPayment.service.ts`)

1. The pay page and the portal's payment options carry a `card` setup object.
   `flow: 'card_form'` when the invoice passes the card fee on and the firm is eligible,
   otherwise `'checkout'` (hosted Checkout, no card fee). The card option shows no fee; the card
   form shows the exact amount.
2. The client enters a card in Stripe's Payment Element, loaded with the platform publishable key
   and the firm's connected account. Stripe.js creates a ConfirmationToken.
3. `POST .../card/quote` reads the token's `payment_method_preview.card` (funding and issuing
   country) on the firm's account and returns `credit_fee`, `no_fee` (with the reason) or
   `refused` (with the message). Nothing is created in Stripe.
4. `POST .../card/confirm` runs under the same advisory lock as Checkout. It refuses while a bank
   checkout or another card payment is processing (409 `PAYMENT_PROCESSING`), cancels an
   abandoned verification, re-decides the fee from the token, and refuses with 409 `FEE_CHANGED`
   when the total differs from what the client was shown. It then creates and confirms a
   PaymentIntent on the firm's account with `metadata.payChannel = 'card_form'`,
   `surchargeCents`, `invoiceAmountCents` and `cardFunding`. A decline answers 422
   `CARD_DECLINED` with Stripe's cardholder message.
5. A synchronous success is recorded immediately through `applyStripeCandidateTransaction`, the
   same path Checkout uses, with the fee kept in `surcharge_cents`. A payment waiting on bank
   verification (3D Secure) is held in `invoices.stripe_card_payment_intent_id` and
   `_account_id` (migration 0047); the client finishes it in the browser and
   `POST .../card/complete` records it.
6. Connect `payment_intent.succeeded` records the payment idempotently by PaymentIntent id, after
   checking the event's account is the firm's. `payment_intent.payment_failed` and `.canceled`
   cancel or release the held PaymentIntent.

Routes: `POST /api/pay/:token/card/{quote,confirm,complete}` (public, rate limited) and
`POST /api/client-portal/lawfirm/:lawFirmId/billing/pay/:invoiceId/card/{quote,confirm,complete}`.

Void, delete, a new request, a plan edit and a manual payment all treat a held card PaymentIntent
like an open checkout session: `closeInvoicePaymentSurfaces` cancels one waiting on the client
and reports one that is processing or succeeded as collected.

The receipt labels the fee "Credit card fee" or "Bank transfer fee". Refunds stay in the Stripe
dashboard; the firm's payment list shows how much of the fee to refund with a refund, because
card-network rules require the fee back in proportion.

Known limit: the offline Stripe reconciler does not look at card-form payments, so a missed
`payment_intent.succeeded` relies on Stripe's three days of webhook retries or on the client's
`complete` call.

### Dependencies

- **Modules**: `billing/invoices` (the row lock and every invoice write), `trust` (the
  ledger and the fee table), `clients`, `lawfirms`, `notifications`, `subscriptions` (the
  customer the trust fee is billed to).
- **Environment**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_APPLICATION_FEE_RATE`, `STRIPE_APPLICATION_FEE_FIXED_CENTS`, and the five
  behavioural knobs in `.env.example`: `STRIPE_AUTO_RECOVERY_ENABLED`,
  `STRIPE_TRUST_ACH_FEE_RATE`, `STRIPE_TRUST_ACH_FEE_CAP_CENTS`,
  `STRIPE_CONNECT_PAYOUT_DELAY_DAYS`, `STRIPE_PAYMENT_INTENT_LOCK_MAX_HOLD_MS`.
- **Operator tooling**: `npm run stripe:reconcile` re-reads Stripe and applies payments the
  webhooks missed (`reconcileStripeInvoices`, `stripe.service.ts:3108`). It is dry-run by
  default and pages 500 invoices at a time through
  `invoicesRepo.listStripeCandidateInvoices` (`invoices.repository.ts:1282`), whose SQL
  admits only invoices carrying Stripe state. The query mirrors `isStripePaymentEntry`
  clause for clause (`stripe.service.ts:162`); the JavaScript predicate
  `invoiceHasStripeState` stays the authority on what is repaired.
  `reconcileStripeTrustDeposits` (`:3214`) is the equivalent backstop for ACH trust
  deposits whose webhook died after the claim committed.

---

### Platform exposure

**Direct charges (a firm on its own Standard account, every firm that connects from
2026-09-22):** none on invoice payments. The charge is made on the firm's account, the firm pays
Stripe's fee, refunds and disputes debit the firm, and Stripe (not Paralegix) carries a negative
balance; Paralegix only receives its 0.9% application fee. Trust deposits are never direct
(below). See `DIRECT_CHARGE_MIGRATION.md`.

**Destination charges (firms still on Express, and every trust deposit).** Stripe debits
Paralegix first for refunds, disputes and its own fees; the code can only recover afterwards,
best-effort. For a $100 card payment (3.8% + 30c application fee, Stripe US card pricing):

| Event | Paralegix net |
|---|---|
| Normal payment | about +$0.90 (the $4.10 application fee less Stripe's $3.20 card fee) |
| Full refund | about -$3.20: Stripe keeps its fee, and recovery can reverse only the $95.90 transferred |
| Lost dispute | about -$18: the $15 dispute fee plus the lost fee income |
| International card | about -$0.60 per payment: Stripe's 4.4% exceeds the 3.8% application fee |
| Recovery fails (empty connected balance, declined firm card) | the whole clawback |
| Trust deposit ACH fee | fronted by the platform and billed to the firm later; lost if the firm never pays |

The app has no refund action, so refunds only start from the Stripe Dashboard, a disputed
charge or an ACH return. The structural fix is `DIRECT_CHARGE_MIGRATION.md` (the firm's account
takes refunds, disputes and processing fees; the platform keeps only its application fee),
blocked on three product decisions. Trust keeps the operating-card backstop even then, because
an IOLTA cannot be debited after payout. Sandbox history from February and March 2026 shows
transfers of the full amount with no application fee; that code predates the fee (added
2026-06-15) and is not a current path.

## What Can Be Improved

- **Automatic recovery is off by default** (`AUTO_RECOVERY_ENABLED`, `stripe.service.ts:89`). Until
  `STRIPE_AUTO_RECOVERY_ENABLED` is on, a dispute, refund or ACH return debits the platform
  and the code logs what it would have reversed. It is on for local and staging, and the
  recommendation for production is on, set at the cutover.
- **Recoveries made before migration 0046 have no record.** A won dispute on one returns
  nothing automatically. Recovery has been off in production, so there should be none.
- **Some Stripe money math is still in float dollars.** The paid-total sum in
  `normalizeStripeInvoiceLocally` is integer cents now (`stripePaymentsTotalCents`,
  `stripe.service.ts:376`), but `computeStripeInvoiceStatus` (`:242-244`),
  `buildStripePaymentEntry` (`:290`) and `buildInvoiceUpdateData` (`:412`) still
  `roundCurrency` dollars, and the charge amounts are derived as
  `Math.round(remaining * 100)` from a dollar balance (`:1293,1317,1506,1511,2907,2926`).
  They round correctly because the inputs are two-decimal, but every other payment path
  is integer cents end to end.
- **Connect is still reached from outside the shared hook.** `useStripeConnect` now backs
  both onboarding screens, but `BillingSettingsView.tsx:102,215,235,251` still carries its
  own connect, status, dashboard-link and disconnect calls through raw `apiFetch`, and
  four more places fetch `/stripe/connect/:lawFirmId/status` independently
  (`client-invoice/[invoiceId]/page.tsx:207`, `InvoiceDetailView.tsx:524`,
  `ClientDetail.tsx:558`, `useGetStartedProgress.ts:38`). They should read through the
  service method or the hook so a fix to one reaches all of them.
- **Open question: what `STRIPE_CONNECT_PAYOUT_DELAY_DAYS` should be.** A longer delay
  leaves more time to catch a reversal before the money has left the platform, which is
  exactly the case the recovery path exists for. Seven days is a default, not a decision.
