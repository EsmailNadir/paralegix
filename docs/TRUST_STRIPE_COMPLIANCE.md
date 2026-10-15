# Trust Deposits: Stripe Compliance Rework

**Status:** Completed. This page is now a historical design record: Phases 0-7 are in code.
The migrations that carried it (0092, 0093, and the two follow-on hardenings 0097 and 0098)
were folded into `backend/db/schema.sql` when the numbered chain was collapsed, so every
database built from it already has them and there is nothing to apply. They live in
`backend/db/schema/80_trust.sql`: the `trust_accounts` Connect columns, `trust_deposit_fees`
with its `stripe_invoice_id` (the one-off ACH-fee invoice id, persisted so a retried charge
reuses it instead of double-charging the firm once the Stripe idempotency key expires), and the
hardened `trust_txn_immutable` trigger (void rows cannot be deleted or edited; a completed row
may transition only to `completed` or `void`). Still required before production: (1) subscribe
the production payments endpoint to the events listed in /dev/ops/webhooks, created with
"Listen to events on connected accounts" so a trust account's `account.updated` arrives,
(2) enable `us_bank_account` (ACH) payments on the platform Stripe account, (3) run
`npx tsx backend/scripts/report-stripe-trust-deposits.ts` against any database that holds
electronic trust deposits collected before per-trust-account routing, and remediate what it
lists (bank transfer operating -> trust); a fresh production database built from `schema.sql`
has none, and (4) set the optional `STRIPE_TRUST_ACH_FEE_RATE` /
`STRIPE_TRUST_ACH_FEE_CAP_CENTS` env vars if the defaults (0.8%, $5 cap, in
`backend/src/modules/stripe/stripe.service.ts`) need tuning.

## Problem (pre-fix state, now resolved below)

Electronic trust deposits used to commingle client trust funds with firm operating
funds at the banking layer. There was exactly one `stripe_account_id` per firm
(`law_firms.stripe_account_id`, `schema.sql:81`), and **both** invoice payments
(`getClientCheckoutUrl`, `stripe.service.ts:1129`) and trust deposits
(`requestTrustDeposit`, `stripe.service.ts:1287`) set
`transfer_data.destination` to that single connected account. A client's electronic
trust deposit therefore settled into the same Stripe balance and paid out to the same
bank account as operating revenue. The "Target architecture" below is what now ships:
trust deposits route to a trust-account-specific connected account instead.

The internal `trust_transactions` ledger correctly labels the money as trust, but the
actual dollars land in operating funds. That is a trust-accounting / IOLTA violation
regardless of ledger quality. The append-only ledger, overdraft guards, three-way
reconciliation, and no-application-fee-on-trust behavior are all sound and stay as-is;
this rework only changes **where the money settles** and **how the feature is gated**.

## Decisions (locked)

1. **ACH-only** for electronic trust deposits (`us_bank_account`). No cards. Lower fees,
   far lower chargeback/reversal risk against pooled client funds.
2. **Processing fee is billed to the firm's operating side**, never deducted from the
   trust deposit. The trust charge carries no application fee (full amount to trust); the
   fee is recovered by adding an invoice item to the firm's Paralegix subscription
   customer (`law_firms.plan.stripeCustomerId`).
3. Per-**trust-account** Stripe connected account (not per-firm): a firm may hold multiple
   trust accounts (`iolta`, `trust`, `separate_interest`), each backed by a different bank
   account.

## Target architecture

- Each `trust_accounts` row optionally onboards its own Stripe Express connected account
  whose payout bank account is that trust/IOLTA bank account.
- A trust deposit is a **destination charge** to that trust connected account with **no
  `application_fee_amount`** (trust stays whole). Paralegix (platform) fronts the ACH
  processing cost, then bills it back to the firm's operating payment method via a
  subscription invoice item.
- Electronic trust deposits are gated on two conditions, both required:
  1. Firm-level opt-in `electronicTrustDepositsAllowed` (jurisdiction acknowledgement).
  2. The selected trust account has an **active** connected account
     (`stripe_charges_enabled = true`).

### ACH lifecycle (critical difference from cards)

ACH does not settle instantly and can fail days later (insufficient funds / returns).
The trust ledger must reflect **confirmed funds only**.

- Do **not** post the trust transaction on `checkout.session.completed`. For ACH that
  event fires while the payment is still `processing`.
- Post the trust deposit only when funds are confirmed: on `payment_intent.succeeded`
  (equivalently `charge.succeeded`) for the trust session's payment intent.
- Handle async failure: `payment_intent.payment_failed` before posting → do nothing
  (no ledger entry was created).
- Handle **late reversal** (ACH return / dispute after a successful post):
  `charge.refunded`, `charge.dispute.created`, or a late failure → post a **reversing
  entry** against the original trust transaction (reuse the existing void/reversal
  machinery, `voidTransactionInternal`), with a clear `void_reason` such as
  "ACH return (R01)". Never edit the original completed row.
- Optionally record a `pending` trust transaction on session completion for firm
  visibility, flipped to `completed` on confirmation. `trust_transactions.status`
  already supports `'pending'`; if used, ensure `pending` rows are excluded from
  available-balance math and from withdrawals.

## Fee billing mechanic (bill-to-firm)

- Compute the ACH processing fee Paralegix was charged for the trust deposit
  (Stripe ACH pricing; pass-through, optionally with margin). Make rate/cap
  env-configurable, mirroring `STRIPE_APPLICATION_FEE_*`:
  `STRIPE_TRUST_ACH_FEE_RATE`, `STRIPE_TRUST_ACH_FEE_CAP_CENTS`.
- On confirmed trust deposit, accrue the fee and add it to the firm's Paralegix
  subscription customer:
  `stripe.invoiceItems.create({ customer: firm.plan.stripeCustomerId, amount, currency:'usd', description: 'Trust ACH processing fee (deposit <id>)' })`.
  It lands on the firm's next subscription invoice and is charged to the operating
  payment method on file, fully separate from trust.
- Persist an audit link so fees are never double-billed (idempotent on the trust
  transaction id).

**As shipped**, the fee does not wait for the next subscription invoice. On a confirmed
deposit, `billFirmForTrustAchFee` (`backend/src/modules/stripe/stripe.service.ts`) charges it up
front: a one-off invoice on the firm's subscription customer (`pending_invoice_items_behavior:
'exclude'`) holding one invoice item, finalized and paid at once. If that charge fails (no card,
declined), the fee stays `accrued` and `backend/scripts/bill-accrued-trust-fees.ts` retries it.

## Data model

Migration `00XX_trust_account_stripe_connect.sql`:

```sql
alter table trust_accounts
  add column stripe_connected_account_id  text,
  add column stripe_charges_enabled       boolean not null default false,
  add column stripe_onboarding_complete   boolean not null default false;

create unique index trust_accounts_stripe_acct_uidx
  on trust_accounts (stripe_connected_account_id)
  where stripe_connected_account_id is not null;
```

Migration `00YY_trust_deposit_fees.sql` (fee audit / idempotency):

```sql
create table trust_deposit_fees (
  id                        uuid primary key default gen_random_uuid(),
  law_firm_id               uuid not null,
  trust_transaction_id      uuid not null,
  fee_cents                 bigint not null check (fee_cents >= 0),
  stripe_invoice_item_id    text,
  status                    text not null default 'accrued'
                              check (status in ('accrued','billed','waived')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (law_firm_id, trust_transaction_id)
);
```

Repository/mapping updates:
- `trust.repository.ts`: surface the three new `trust_accounts` columns; **never** expose
  the raw connected account id to the client portal (firm-side reads only).
- Add a `TrustDepositFeeRepository` (or fold into trust repo) for accrue/mark-billed.

## Implementation phases

### Phase 0 — Safety gate (ship first)
- `requestTrustDeposit` (`stripe.service.ts:1287`): throw `503 STRIPE_TRUST_NOT_READY`
  unless the new gating conditions hold. Effectively off by default.
- Add `electronicTrustDepositsAllowed: false` to `TRUST_SETTINGS_DEFAULTS`
  (`trust.service.ts:12`) and to the settings patch allow-list (`trust.service.ts:455`).
- Frontend `RequestDepositModal.tsx`: hide/disable the action with an explanatory note.

### Phase 1 — Data model
- Apply the two migrations above; update repositories and `formatAccount`.

### Phase 2 — Connect onboarding scoped to a trust account
Generalize the firm Connect service (`stripe.service.ts:593-763`) into trust-scoped
functions:
- `createTrustConnectAccount({ lawFirmId, trustAccountId, actingUserId })` —
  `stripe.accounts.create` with `metadata:{ lawFirmId, trustAccountId, purpose:'trust' }`,
  `business_type:'company'`, capabilities `{ transfers, us_bank_account_ach_payments }`.
  Store id on the `trust_accounts` row. Return an `account_onboarding` link returning to
  `…/settings/trust?stripe=return`.
- `getTrustConnectStatus`, `getTrustDashboardLink`, `disconnectTrustAccount` — mirror the
  firm versions, caching status onto the trust row.
- Routes. As shipped they live in `backend/src/modules/stripe/stripe.routes.ts`, not
  `trust.routes.ts`, under `/api/stripe/trust-connect/:lawFirmId/:trustAccountId`:
  - `POST   .../create-account` (`trust.manage`)
  - `GET    .../status` (`trust.view`)
  - `GET    .../dashboard-link` (`trust.manage`)
  - `DELETE .../` (disconnect, `trust.manage`)

### Phase 3 — Route trust deposits correctly
In `requestTrustDeposit`:
- Require `trustAccount.stripeConnectedAccountId` and `stripe_charges_enabled`, else
  `400 STRIPE_TRUST_NOT_READY`.
- Require firm `electronicTrustDepositsAllowed`.
- `transfer_data.destination = trustAccount.stripeConnectedAccountId` (not the firm's).
- Keep no `application_fee_amount`.
- `payment_method_types: ['us_bank_account']` (ACH-only); no card.

### Phase 4 — Webhook lifecycle
- Split trust posting off `checkout.session.completed`. Post on
  `payment_intent.succeeded` for trust sessions; ignore/short-circuit
  `payment_intent.payment_failed`; add `charge.refunded` and `charge.dispute.created`
  handlers that post reversing entries.
- `handleAccountUpdated` (`stripe.service.ts`, wired at the `account.updated` case in
  `stripe.webhook.routes.ts`): as shipped it looks the Stripe account id up on
  `trust_accounts` first and updates that row, falling back to the firm's operating account.
  The account also carries `metadata.purpose = 'trust'`, but the lookup is what decides.
- Confirm the platform webhook is subscribed to: `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`,
  and Connect `account.updated`.
- On confirmed deposit, accrue + bill the ACH fee (fee mechanic above), idempotent on
  the trust transaction id.

### Phase 5 — Frontend
- Trust settings (`frontend/src/components/trustComp/…`): per-account "Connect a trust
  bank account for electronic deposits" card with status
  (Not connected → Onboard, Pending → Continue, Active → Dashboard / Disconnect),
  calling Phase 2 endpoints via `billing.service.ts`.
- Firm-level toggle for `electronicTrustDepositsAllowed` with copy stating the firm is
  responsible for confirming its jurisdiction permits electronic funding of trust.
- `RequestDepositModal.tsx`: enable a deposit only when the selected trust account is
  `Active`; otherwise show a setup prompt (firm-side). Copy should note ACH timing
  (funds take several business days to clear and post to the ledger).

### Phase 6 — Remediate already-collected deposits
Existing `trust_transactions` with `source='stripe'` were physically deposited into the
**operating** account. Do not auto-move money.
- One-off report `backend/scripts/report-stripe-trust-deposits.ts`: firm, trust account,
  client, amount, date, session id.
- Each affected firm must transfer those amounts operating→trust at the bank and record
  it. This is a real remediation obligation, tracked in the rollout, not just code.

### Phase 7 — Polish / tests / docs
- Settlement date: shipped as speced in spirit but not in the letter. Rather than reading
  `balance_transaction.available_on`, `handleTrustDepositPaymentSucceeded`
  (`stripe.service.ts`) dates the deposit at the `payment_intent.succeeded` webhook
  event's `created` timestamp (falling back to the payment intent's own `created`), not at
  Checkout `session.created` (which can be days earlier for ACH). That is still ACH
  settlement time, not checkout/auth time, so the original goal (dating the ledger entry
  at settlement rather than checkout) is met.
- Guard: block disconnecting a trust connected account or inactivating a trust account
  while it has a non-zero Stripe balance or pending payouts.
- `.rest` requests for the new endpoints were planned but not kept: `backend/test-requests/`
  no longer exists. Manual E2E via the Stripe CLI (`stripe-dev` skill), including simulated
  ACH failure/return.

## Rollout order

Phase 0 (gate) → 1 (schema) → 2 (onboarding) → 3 (routing) → 4 (webhooks/fees) →
5 (frontend) → 6 (remediation report) → 7 (polish). Ship Phase 0 alone first so nothing
else commingles while the rest is built.

## Open items to confirm at implementation time

- Fee margin: pure pass-through vs. add a small markup on the ACH fee.
- Whether to record a `pending` trust transaction on session completion for firm
  visibility, or stay silent until `payment_intent.succeeded`.
- Verification UX for ACH bank connection (Stripe Financial Connections / instant vs.
  microdeposits) in the client portal.
