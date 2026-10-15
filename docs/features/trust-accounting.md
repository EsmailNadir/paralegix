# Trust Accounting (IOLTA)

## Summary

Trust Accounting lets a law firm hold client money (retainers, settlements) in IOLTA-style
trust bank accounts, kept separate from operating funds. It tracks three things:

- **Trust accounts** — one row per real-world bank account (`trust_accounts`).
- **Trust transactions** — an append-only ledger of deposits, withdrawals, transfers, and
  refunds (`trust_transactions`).
- **Reconciliations** — periodic three-way reconciliation snapshots that compare the bank
  statement, the book balance, and the sum of per-client ledger balances
  (`trust_reconciliations`).

Money never moves without leaving a permanent ledger row. Each account's `book_balance_cents`
is a stored running total maintained transactionally; each client's available balance is
derived from the same ledger by SUM on every read. Trust withdrawals can also be triggered
from the billing module when an invoice is paid "from trust".

## Key Takeaways

- **Append-only ledger.** `trust_transactions` is never edited or deleted. A Postgres trigger
  (`trust_txn_immutable`, `backend/db/schema/80_trust.sql:216-303`) refuses any DELETE of a
  `completed` or `void` row, any UPDATE of a `void` row, and any UPDATE of a `completed` row
  other than the bank-clearing stamps or the void transition (`completed → void`, which may
  set only the void fields). The one declared exception is a client-record merge that
  names the exact `from:to` pair it is remapping (see "Immutability trigger" below).
- **Corrections are reversing entries, not edits.** To fix a mistake you *void* the bad
  transaction and post a new correct one. Voiding does two things in one transaction
  (`voidWithBalance`, `backend/src/modules/trust/trust.repository.ts:1029`, body in
  `_voidWithBalanceTx`, `:1043`): it flips the original row to `status='void'` and reverses
  the account book balance **in place**, and it *also* INSERTs a new balance-neutral
  `status='void'` reversing entry whose `reverses_transaction_id` points at the original
  (`trust.repository.ts:1198-1206`). That reversing row makes void lineage queryable while
  staying out of every balance SUM.
- **Money is integer cents (`bigint`).** Every amount column is `*_cents`. There is no float
  math in the ledger path. The one rounding point is the billing→trust bridge, which calls the
  shared `toCents()` helper (`Math.round(value * 100)`,
  `backend/src/modules/billing/shared/money.ts:48-50`) at
  `backend/src/modules/billing/invoices/invoices.service.ts:2024`.
- **Account balance stored; client balances derived.** `book_balance_cents` is a stored
  running total updated inside each write/void transaction. Per-client balances are recomputed
  on every read by a SUM in which only `completed` rows count, deposits positive and every
  other type negative (`balanceExprFor`, `trust.repository.ts:364-374`). A `void` row, or a
  future `pending` one, contributes 0 even if a caller's WHERE clause lets it through.
- **Overdraft-safe at two levels.** A withdrawal/transfer/refund is rejected if it would drive
  *either* the client's balance *or* the account `book_balance` negative. Both checks run inside
  a `SELECT ... FOR UPDATE` Postgres transaction on the account row to defeat
  concurrent-withdrawal races (`createWithBalance`, `trust.repository.ts:730`, body in
  `_createWithBalanceTx`, `:752`; per-client guard `:789-794`, account guard `:823-828`).
  There is exactly one overdraft path (the locked one); the billing bridge deliberately does
  no pre-check (`trust.service.ts:1089-1093`).
- **Disabling cannot strand newly credited funds.** Deposit and void writes hold a shared lock
  on the firm row while checking the opt-out and committing the ledger. The feature toggle updates
  the opt-out first, then checks holdings in the same transaction, rolling back if funds remain
  (`settings.service.ts:303-311`; `trust.repository.ts:23-30,836,1166`). An in-flight deposit must
  commit before disabling can check holdings, making disabling fail. A deposit or withdrawal void
  delayed until after disabling is refused. This also covers concurrently created accounts.
- **Only `deposit` is an inflow.** `withdrawal`, `transfer`, and `refund` are all outflows
  (debits) and all pass the overdraft guard (`trust.repository.ts:759-760`).
- **Two kinds of entry cannot be voided by hand.** A withdrawal that paid an invoice
  (`TRUST_ENTRY_LINKED_TO_INVOICE`) and a Stripe-funded deposit (`TRUST_ENTRY_STRIPE_FUNDED`)
  are each half of a two-system record, so `voidTransaction` sends the user to the invoice
  payment or to a Stripe refund instead (`trust.service.ts:562-605`).
- **The low-balance alert threshold resolves most specific first**: the client's own
  `trust_minimum_balances` row for the account, then the firm's `defaultMinimumCents` trust
  setting (editable on the trust settings screen), then the built-in $100
  (`trust.service.ts:13,517-539`).

---

## How It Works

### Entry Points

#### Backend HTTP routes
All mounted at `/api/lawfirms/:lawFirmId/trust`. Router:
`backend/src/modules/trust/trust.routes.ts`.

| Method & path | Permission | Handler (service) | Routes line |
|---|---|---|---|
| `GET /accounts` | `trust.view` | `listAccounts` | `trust.routes.ts:31` |
| `POST /accounts` | `trust.manage` | `createAccount` | `trust.routes.ts:41` |
| `GET /accounts/:accountId/summary` | `trust.view` | `getAccountSummary` | `trust.routes.ts:54` |
| `GET /accounts/:accountId` | `trust.view` | `getAccount` | `trust.routes.ts:65` |
| `PUT /accounts/:accountId` | `trust.manage` | `updateAccount` | `trust.routes.ts:76` |
| `PATCH /accounts/:accountId/status` | `trust.manage` | `updateAccountStatus` | `trust.routes.ts:89` |
| `PATCH /accounts/:accountId/book-close` | `trust.manage` | `setBookCloseDate` | `trust.routes.ts:102` |
| `GET /transactions` | `trust.view` | `listTransactions` | `trust.routes.ts:117` |
| `POST /transactions` | `trust.manage` | `createTransaction` | `trust.routes.ts:129` |
| `GET /transactions/:transactionId` | `trust.view` | `getTransaction` | `trust.routes.ts:141` |
| `PATCH /transactions/:transactionId/void` | `trust.manage` | `voidTransaction` | `trust.routes.ts:152` |
| `GET /clients/:clientId/ledger` | `trust.view` | `getClientLedger` | `trust.routes.ts:167` |
| `GET /clients/:clientId/balance` | `trust.view` | `getClientBalance` | `trust.routes.ts:182` |
| `GET /balances` | `trust.view` | `listAllBalances` | `trust.routes.ts:193` |
| `GET /matters/:matterId/ledger` | `trust.view` | `getMatterLedger` | `trust.routes.ts:205` |
| `GET /matters/:matterId/balance` | `trust.view` | `getMatterBalance` | `trust.routes.ts:220` |
| `GET /minimum-balances` | `trust.view` | `listMinimumBalances` | `trust.routes.ts:233` |
| `PUT /minimum-balances` | `trust.manage` | `upsertMinimumBalance` | `trust.routes.ts:243` |
| `DELETE /minimum-balances/:id` | `trust.manage` | `deleteMinimumBalance` | `trust.routes.ts:255` |
| `GET /settings` | `trust.view` | `getTrustSettings` | `trust.routes.ts:268` |
| `PUT /settings` | `trust.manage` | `updateTrustSettings` | `trust.routes.ts:278` |
| `GET /interest-remittances` | `trust.view` | `listRemittances` | `trust.routes.ts:292` |
| `POST /interest-remittances` | `trust.manage` | `createRemittance` | `trust.routes.ts:306` |
| `PUT /interest-remittances/:remittanceId` | `trust.manage` | `updateRemittance` | `trust.routes.ts:318` |
| `DELETE /interest-remittances/:remittanceId` | `trust.manage` | `deleteRemittance` | `trust.routes.ts:331` |
| `GET /audit-report` | `trust.view` | `getAuditReport` | `trust.routes.ts:346` |
| `GET /reconciliation-snapshot` | `trust.view` | `getReconciliationSnapshot` | `trust.routes.ts:359` |
| `GET /reconciliations` | `trust.view` | `listReconciliations` | `trust.routes.ts:380` |
| `POST /reconciliations` | `trust.reconcile` | `createReconciliation` | `trust.routes.ts:394` |
| `GET /reconciliations/latest` | `trust.view` | `getLatestReconciliation` | `trust.routes.ts:407` |
| `GET /reconciliations/:reconciliationId` | `trust.view` | `getReconciliation` | `trust.routes.ts:418` |
| `DELETE /reconciliations/:reconciliationId` | `trust.reconcile` | `reopenReconciliation` | `trust.routes.ts:430` |

Electronic (Stripe ACH) trust deposits are a separate set of routes under `/api/stripe/trust*`,
owned by the `stripe` module, not this router. See `docs/TRUST_STRIPE_COMPLIANCE.md` for the
full Connect onboarding, deposit, and webhook flow.

Middleware order: `verifyToken → requirePermission → (validate) → handler`. Every write route
with a body (except the two DELETEs and the reopen), plus the query-string routes
`GET /transactions`, both ledger routes, `GET /interest-remittances` and
`GET /reconciliations`, carries a `validate(...)` step; the read-by-id routes do their own
`assertUuid` in the service. `/accounts/:accountId/summary` and `/reconciliations/latest` are
declared *before* their `/:id` siblings so the literal segment isn't captured as an id. `GET
/reconciliation-snapshot` 400s in the route handler if `trustAccountId` is missing.
`DELETE /reconciliations/:reconciliationId` reopens (does not delete) the reconciliation so its
outstanding transactions can be re-cleared; see `reopenReconciliation` in `trust.service.ts`.

#### Internal / cross-module entry points (no membership check — caller is responsible)
- `createTrustWithdrawalForInvoice(...)` — called by the invoices service when a payment is
  recorded with `paymentSource === 'trust'` (`trust.service.ts:1078`, invoked from
  `invoices.service.ts:2045`).
- `voidTransactionInternal(...)`: compensating void used when an invoice update fails after a
  trust withdrawal already succeeded, and when a trust-funded payment is removed
  (`trust.service.ts:1167`). It bypasses the manual-void guards.
- `createTrustDepositFromStripe(...)`, called by the Stripe webhook handler
  (`handleTrustDepositPaymentSucceeded`, `stripe.service.ts:1705`) on `payment_intent.succeeded`
  for an ACH-funded trust deposit; idempotent on the Checkout Session id and on the payment
  intent id (`trust.service.ts:1121`). See `docs/features/stripe-payments.md` and
  `docs/TRUST_STRIPE_COMPLIANCE.md` for the full Connect deposit flow.
- `sumStripeReversals` / `createStripeReversalWithdrawal` / `restoreStripeReversal`, which post
  and unwind reversing entries for an ACH return or Stripe dispute on a trust deposit
  (`trust.service.ts:1179`, `:1192`, `:1221`).
- `getClientLedgerForPortal` / `getClientBalanceForPortal`: portal-safe (no
  `assertLawFirmMembership`) reads (`trust.service.ts:1239`, `:1254`).

#### Frontend entry points
- Firm page: `frontend/src/app/lawfirm/[lawFirmId]/trust/page.tsx`.
- Client portal page: `frontend/src/app/client/lawfirm/[lawFirmId]/trust/page.tsx`.
- API client: `frontend/src/services/trust.service.ts` (one method per route, plus paginated
  variants `getClientLedgerPaged` `:437` and `listReconciliationsPaged` `:528`).
- Hooks: `frontend/src/hooks/trustHooks/`. Components: `frontend/src/components/trustComp/`.

### Data Flow

#### A. Deposit (client pays a retainer into trust)
1. UI submits `POST /transactions` with `type:'deposit'`, `amountCents`, `clientId`,
   `trustAccountId`, `date`.
2. `validate(createTransactionSchema)` enforces a positive-integer `amountCents`, a valid `type`
   enum, and UUID-shaped ids (`trust.validation.ts:92`).
3. `createTransaction` (`trust.service.ts:417`) asserts firm membership and the service-level
   entry checks (the client is in the firm, a named matter belongs to that client, a named
   invoice exists and is that client's, a trust-to-operating transfer names its invoice
   unless `flatFeeToOperatingAllowed`, `:430-480`), then delegates to
   `_createTransactionInternal` (`:491`), which every write path shares and which resolves the
   firm's trust settings once.
4. `_createTransactionInternal` calls `trustTxnRepo.createWithBalance` (`trust.repository.ts:730`,
   a thin wrapper that opens the transaction and calls `_createWithBalanceTx`, `:752`).
5. Inside one Postgres transaction:
   - `BEGIN`, then `SELECT book_balance_cents ... FOR UPDATE` to lock the account row.
   - Refuse an inactive account (`TRUST_ACCOUNT_INACTIVE`, `:771-773`), a date on or before
     `book_close_date` (`assertPeriodOpen`, `:39`) or inside an already-reconciled period
     (`assertPeriodNotReconciled`, `:59`), and a duplicate cheque number
     (`assertCheckNumberFree`, `:84`).
   - Recompute the client's current `(client, account)` balance from the ledger via
     `balanceExpr`.
   - `isCredit = true` for a deposit, so `delta = +amountCents`; both overdraft guards are
     skipped.
   - `INSERT` the transaction with `status='completed'` plus the stored snapshots
     `client_balance_after_cents` and `account_balance_after_cents`.
   - `UPDATE trust_accounts SET book_balance_cents = newBookBalance`.
   - `COMMIT`.
6. Returns the formatted transaction. A deposit never triggers the low-balance event.

#### B. Disbursement (withdrawal / transfer / refund out of trust)
1. UI submits `POST /transactions` with `type` in `withdrawal|transfer|refund`.
2. Same path through `_createTransactionInternal → createWithBalance` (a same-account transfer,
   e.g. `transfer_to='operating'`, still goes through `createWithBalance`; a transfer that
   targets *another trust account* instead goes through the double-entry path in "New
   capabilities" below).
3. In the transaction: `isCredit = false`, so `delta = -amountCents`. Two guards under the
   `FOR UPDATE` account lock:
   - Per-client: if `clientBalanceBefore + delta < 0`, throw `INSUFFICIENT_TRUST_BALANCE`
     (400) and roll back.
   - Matter (only when the firm turned on `enforceMatterTrustBalance`): if the matter's
     balance on this account would go negative, throw `INSUFFICIENT_MATTER_TRUST_BALANCE`
     (`trust.repository.ts:801-815`).
   - Account: if `newBookBalance < 0`, throw `INSUFFICIENT_TRUST_BALANCE` (400) and roll back.
     This mirrors the per-client check at the account level, and is backed by the
     `trust_accounts_book_balance_nonneg` CHECK (`80_trust.sql:24-25`).
   The `FOR UPDATE` lock serializes concurrent debits so two withdrawals can't both pass on a
   stale balance.
4. On success, the book balance decreases and the row is inserted.
5. Back in the service, if the debit dropped the client below the threshold *crossing* it
   from above, emit the typed `TRUST_LOW_BALANCE` event (`trust.service.ts:517-539`). The
   threshold is resolved most specific first: this client's own `trust_minimum_balances` row
   for this account, then the firm's `defaultMinimumCents` trust setting, then the built-in
   `LOW_BALANCE_THRESHOLD_CENTS` ($100, `:13`). A null setting is read as "use the built-in",
   never as zero; an explicit per-client `0` disables the alert for that client. The firm
   default is edited on the trust settings screen (`TrustSettings.tsx`), which shows dollars
   and sends integer cents, and sends null when the field is blank.
6. `trust.events.ts` listens for `TRUST_LOW_BALANCE` and posts a system message into the
   client's portal conversation asking them to replenish.

##### B′. Disbursement via invoice payment (billing bridge)
1. Invoice paid with `paymentSource === 'trust'` and a `trustAccountId` →
   `createTrustWithdrawalForInvoice` (`trust.service.ts:1078`, invoked from
   `invoices.service.ts:2045`).
2. The client id/name are resolved from the invoice record, not the request. There is **no**
   balance pre-check here, the call goes straight to `_createTransactionInternal` with a
   `withdrawal` linked via `invoiceId`; the authoritative overdraft guards are the locked ones
   inside `createWithBalance`.
3. The withdrawal is created on the invoice's own row-locked transaction, so a failed invoice
   write rolls it back with the invoice. Removing a trust-funded payment (a delete, a reset to
   unpaid, un-paying an installment) runs the opposite way on the same transaction:
   `voidTrustWithdrawalsForRemovedPayments` calls `voidTransactionInternal` with that
   transaction as `executor` before the invoice write, so the reversal and the removal commit
   or roll back together. When the ledger refuses the reversal (the entry was reconciled, or its
   period is closed) the removal is refused with a 409 that names the reason, the payment stays
   on the invoice and the withdrawal stays on the ledger.

#### C. Correction via reversal (void)
1. UI submits `PATCH /transactions/:transactionId/void` with a required `voidReason`
   (`trust.validation.ts:170`).
2. `voidTransaction` (`trust.service.ts:562`) refuses an entry that paid an invoice
   (`TRUST_ENTRY_LINKED_TO_INVOICE`, 409) and a Stripe-funded deposit
   (`TRUST_ENTRY_STRIPE_FUNDED`, 409), then calls `trustTxnRepo.voidWithBalance`
   (`trust.repository.ts:1029`, delegating to `_voidWithBalanceTx`, `:1043`).
3. In one transaction:
   - `SELECT ... FOR UPDATE` the txn (every leg of its transfer group, in id order); 404 if
     missing; `ALREADY_VOIDED` (400) if already void. A leg that has cleared the bank is
     refused (`TRANSACTION_RECONCILED`, 409) until its reconciliation is reopened.
   - Compute the reversing delta: a voided deposit subtracts, a voided debit adds back.
   - `UPDATE ... SET status='void', voided_by, voided_at=now(), void_reason` on the original —
     the only mutation the immutability trigger allows for a `completed` row (see "Immutability
     trigger" below for the current, hardened rule set).
   - `UPDATE trust_accounts` to reverse the book balance.
   - Recompute the client's post-reversal `(client, account)` balance.
   - `INSERT` a **new** balance-neutral `status='void'` reversing entry that copies the
     original's fields, sets `reverses_transaction_id = <original id>`, a
     `"Reversal of <id>"` description, and the post-reversal balance snapshots. Because it is
     `status='void'`, it is excluded from every balance SUM, so it records lineage without
     double-counting the reversal.
   - `COMMIT`.
4. To actually *correct* the figure, the user then posts a fresh, correct transaction. The
   original row plus its reversing entry stay forever as the audit trail (and, since the
   trigger hardening, the void row itself can never again be edited or deleted).

#### D. Reconciliation (three-way)
1. UI pre-fills via `GET /reconciliation-snapshot?trustAccountId=...` →
   `getReconciliationSnapshot` (`trust.service.ts:950`), returning `bookBalanceCents`,
   `clientLedgerTotalCents`, per-client `clientBreakdown`, `lastReconciliationDate`, and
   `accountName`. Critically, `clientLedgerTotalCents` here is derived from the **same**
   `computeAccountClientBreakdown` source that `createReconciliation` uses, not the raw account
   SUM, so the pre-fill and the stored reconciliation cannot disagree.
2. User enters the bank statement balance + outstanding (uncleared) transaction ids +
   adjustments, then `POST /reconciliations` → `createReconciliation` (`trust.service.ts:788`).
   A statement date in the future, or at or before the account's previous reconciliation, is
   refused (`RECONCILIATION_OUT_OF_ORDER`):
   - `bookBalanceCents` is read straight off the account row.
   - `clientLedgerTotalCents` = sum of per-client ledger balances via
     `computeAccountClientBreakdown` — deliberately *not* `computeAccountBalance`, which would be
     tautologically equal to the book balance and prove nothing.
   - **Outstanding-id validate + sum in one query:** `validateAndSumOutstanding`
     (`trust.repository.ts:618`) runs a single
     `select array_agg(id), <balanceExpr> ... where id = any($3)` that returns both the set of
     matched (this-account, non-void, not-yet-cleared) ids *and* their net delta in one
     round-trip. The service
     rejects the whole request with a `ValidationError` if any flagged id isn't in the returned
     valid set, closing the old silent-drop gap where a foreign/voided id contributed 0.
   - `expectedBankBalanceCents = book − outstandingNet + adjustments`.
   - `discrepancyCents = bankStatementBalance − expectedBank`.
   - `isReconciled = discrepancy === 0 AND (book − clientLedgerTotal) === 0` — all three must
     agree.
   - The reconciliation is recorded via `createWithClearing` (`trust.repository.ts:224`), which
     inserts the `trust_reconciliations` row **and**, in the same transaction, marks every
     covered completed/not-flagged-outstanding transaction `cleared_at`/
     `cleared_in_reconciliation_id` (see "Per-transaction clearing" below).
3. History is read via the paginated `GET /reconciliations` (`listReconciliations`,
   `trust.service.ts:900`, returns `{ reconciliations, totalItems }`) and
   `GET /reconciliations/latest` (`trust.service.ts:915`). `reopenReconciliation`
   (`trust.service.ts:938`) undoes a reconciliation's clearing stamps so it can be redone.

### Data Model

The DDL lives in `backend/db/schema/80_trust.sql` (`backend/db/schema.sql` is generated from
the `schema/*.sql` files). Migration numbers quoted below are historical: the chain was
collapsed into `schema.sql` and numbering restarted at 0001.

#### `trust_accounts` (`backend/db/schema/80_trust.sql:5-42`)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `law_firm_id` | uuid | FK → `law_firms`, `on delete cascade`; tenant key |
| `name`, `bank_name` | text | |
| `account_number_last4` | text | CHECK `^[0-9]{4}$` |
| `routing_number_last4` | text | |
| `account_type` | text | CHECK `iolta\|trust\|separate_interest`, default `iolta` (migration 0085): pooled interest-to-bar-foundation vs. non-IOLTA retainer/escrow vs. client-specific interest-bearing |
| `iolta_tin` | text | IOLTA program TIN (migration 0085) |
| `interest_beneficiary` | text | CHECK `bar_foundation\|client\|firm`, nullable (migration 0085) |
| `book_close_date` | date | period lock: transactions on/before this date are closed; enforced in the application layer (migration 0085) |
| `status` | text | CHECK `active|inactive`, default `active` |
| `book_balance_cents` | bigint | **stored running total**, maintained in the txn writers; `not null default 0`; DB `CHECK (>= 0)` declared inline as `trust_accounts_book_balance_nonneg` |
| `stripe_connected_account_id` | text | this trust account's own Stripe Connect account for electronic ACH deposits (migration 0092), unique when set. Separate from `law_firms.stripe_account_id`, the firm's operating account. Never exposed to the client portal. |
| `stripe_charges_enabled` | boolean | default `false`; gates `POST /api/stripe/trust/:lawFirmId/request-deposit` (migration 0092) |
| `stripe_onboarding_complete` | boolean | default `false` (migration 0092) |
| `created_by`/`updated_by` | text | FK → `users(id)` (Firebase UID) |
| Unique `(law_firm_id, id)` | | enables composite FKs from child tables |

See `docs/TRUST_STRIPE_COMPLIANCE.md` for the full electronic-deposit Connect flow built on the
three `stripe_*` columns above.

#### `trust_deposit_fees` (`backend/db/schema/80_trust.sql:47-63`)
One row per electronic (ACH) trust deposit, tracking the processing fee Paralegix fronts and
bills back to the firm's operating side (never taken from trust). `law_firm_id`,
`trust_transaction_id` (unique per pair), `fee_cents`, `stripe_invoice_item_id`,
`stripe_invoice_id` (migration 0097, persists the one-off fee invoice so a retried sweep reuses
it instead of double-charging once the Stripe idempotency key's 24h TTL expires), `status`
(`accrued|billed|waived`). See `docs/TRUST_STRIPE_COMPLIANCE.md`.

#### `trust_transactions`, the append-only ledger (`backend/db/schema/80_trust.sql:65-145`)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `law_firm_id` | uuid | tenant key |
| `trust_account_id` | uuid | composite FK `(law_firm_id, trust_account_id)` → `trust_accounts` |
| `type` | text | CHECK `deposit|withdrawal|transfer|refund` |
| `amount_cents` | bigint | CHECK `> 0` (always positive; direction comes from `type`) |
| `client_id` | uuid | FK → `clients`, `on delete restrict` |
| `matter_id` | uuid | composite FK, `on delete set null` |
| `txn_date` | date | `not null`; day-only `'YYYY-MM-DD'` (no tz shift, see `dateOnly`, `trust.repository.ts`) |
| `description`, `reference_number`, `payee` | text | |
| `transfer_to` | text | CHECK `operating|other` (single-leg transfer out of trust) |
| `transfer_to_account_id` | uuid | destination trust account on the source (withdrawal) leg of a double-entry trust→trust transfer (migration 0082) |
| `transfer_group_id` | uuid | links the withdrawal + deposit legs of a double-entry transfer (migration 0082) |
| `source` | text | CHECK `check\|wire\|ach\|cash\|credit_card\|interest\|stripe\|other` (`interest` and `stripe` added by migration 0085) |
| `invoice_id` | uuid | tenant-scoped composite FK `trust_txn_invoice_fk (law_firm_id, invoice_id)` → `invoices` with `on delete set null (invoice_id)` (migration 0064; PG 15+ column-list SET NULL form) |
| `stripe_session_id`, `stripe_payment_intent_id` | text | Stripe-funded deposit linkage (migration 0085); partial unique indexes make a replayed webhook idempotent |
| `charge_model` | text | CHECK `destination\|direct`, default `destination` (migration 0096) — Connect charge model for a Stripe-funded deposit; see `docs/DIRECT_CHARGE_MIGRATION.md` |
| `reverses_transaction_id` | uuid | self-FK, `on delete restrict`: written by `voidWithBalance` on the reversing entry, and by the Stripe partial-reversal withdrawals |
| `status` | text | CHECK `completed|pending|void`, default `completed`. Nothing writes `pending` today, and only `completed` rows count toward a balance |
| `client_balance_after_cents` | bigint | **stored snapshot** at write time (and on the void reversing row; not recomputed on downstream rows) |
| `account_balance_after_cents` | bigint | **stored snapshot** at write time (and on the void reversing row) |
| `cleared_at`, `cleared_in_reconciliation_id` | timestamptz, uuid | bank-reconciliation clearing stamps (migration 0081); no FK on the latter, a soft audit link |
| `voided_by`/`voided_at`/`void_reason` | | void audit trail on the original row |
| `created_by`, `created_at`, `updated_at` | | |

Indexes (`80_trust.sql:125-145`):
- `trust_txn_firm_account_date_idx (law_firm_id, trust_account_id, txn_date desc)` and
  `trust_txn_firm_client_date_idx (law_firm_id, client_id, txn_date desc)`: firm-leading, since
  every read filters `law_firm_id` together with the account or client.
- `trust_transactions_client_id_idx (client_id)`, `trust_transactions_matter_idx` and
  `trust_transactions_invoice_idx`: foreign-key probe support for a client, matter or invoice
  delete.
- `trust_txn_uncleared_idx (law_firm_id, trust_account_id) WHERE status = 'completed' AND cleared_at IS NULL`
- `trust_txn_transfer_group_idx (transfer_group_id) WHERE transfer_group_id IS NOT NULL`
- `trust_txn_stripe_session_uidx (law_firm_id, stripe_session_id)` and
  `trust_txn_stripe_pi_uidx (law_firm_id, stripe_payment_intent_id) WHERE ... status <> 'void'`:
  partial unique indexes for Stripe webhook idempotency. The payment-intent one excludes void
  rows so a clawed-back deposit can be re-posted when a dispute is won.

The earlier `trust_txn_account_idx`, `trust_txn_client_idx` and `trust_txn_firm_date_idx` no
longer exist.

#### Immutability trigger (`backend/db/schema/80_trust.sql:216-303`), the core correctness property

The trigger has been hardened twice since the first version shipped (migration 0086, then
migration 0098). The current rule set is materially stricter than a simple "block edits to
`amount_cents`/`type`/`trust_account_id`" check:

```sql
create or replace function trust_txn_immutable() returns trigger as $$
declare
  frozen trust_transactions%rowtype;
  declared_remap text;
begin
  if (tg_op = 'DELETE') then
    if old.status in ('completed', 'void') then
      raise exception 'trust_transactions are append-only: % entries cannot be deleted (id=%)', old.status, old.id;
    end if;
    return old;
  end if;

  if old.status = 'void' then
    raise exception 'trust_transactions are append-only: void entries are immutable (id=%)', old.id;
  end if;

  if old.status = 'completed' and new.status not in ('completed', 'void') then
    raise exception 'trust_transactions are append-only: completed entries may only be voided (id=%)', old.id;
  end if;

  if old.status = 'completed' and new.status = 'completed' then
    frozen := new;
    frozen.cleared_at := old.cleared_at;
    frozen.cleared_in_reconciliation_id := old.cleared_in_reconciliation_id;
    frozen.updated_at := old.updated_at;
    -- Declared client-merge exception (comments trimmed; see the source).
    declared_remap := current_setting('paralegix.trust_client_remap', true);
    if declared_remap is not null
       and new.client_id is distinct from old.client_id
       and declared_remap = old.client_id::text || ':' || new.client_id::text then
      frozen.client_id := old.client_id;
    end if;
    if frozen is distinct from old then
      raise exception 'trust_transactions are append-only: post a reversing entry instead of editing (id=%)', old.id;
    end if;
  end if;

  if old.status = 'completed' and new.status = 'void' then
    frozen := new;
    frozen.status := old.status;
    frozen.voided_by := old.voided_by;
    frozen.voided_at := old.voided_at;
    frozen.void_reason := old.void_reason;
    frozen.cleared_at := old.cleared_at;
    frozen.cleared_in_reconciliation_id := old.cleared_in_reconciliation_id;
    frozen.updated_at := old.updated_at;
    if frozen is distinct from old then
      raise exception 'trust_transactions are append-only: a void may only set the void fields (id=%)', old.id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql;
drop trigger if exists trust_txn_immutable on trust_transactions;
create trigger trust_txn_immutable before update or delete on trust_transactions
  for each row execute function trust_txn_immutable();
```
- DELETE of a `completed` **or** `void` row → always rejected (the earlier version only
  protected `completed` rows, leaving the void-lineage reversal rows deletable).
- A `void` row is now fully immutable — no UPDATE of any kind, including flipping it back to
  `completed`, which would have resurrected a reversed entry and silently inflated every
  SUM-derived balance without touching `book_balance_cents`.
- A `completed` row may transition only to `completed` (frozen, see below) or `void`; no other
  target status (e.g. `pending`) is allowed.
- A `completed → completed` UPDATE is frozen byte-for-byte except the bank-clearing stamps
  (`cleared_at`, `cleared_in_reconciliation_id`) and `updated_at` — not just
  `amount_cents`/`type`/`trust_account_id` as the first version checked. Attribution
  (`client_id`, `matter_id`), `txn_date`, and every other column are locked too (migration 0086
  closed the gap where re-pointing `client_id` could silently re-attribute whose money moved).
- A `completed → void` UPDATE may set **only** the void bookkeeping fields (`status`,
  `voided_by`, `voided_at`, `void_reason`) plus the clearing stamps/`updated_at`; every other
  column must stay identical, so a void can't smuggle in a data edit alongside the status change.
- **The one declared exception** (`80_trust.sql:256-273`): a client-identity merge may repoint
  `client_id` on a `completed` row, but only when the transaction first sets
  `paralegix.trust_client_remap` to the exact `'<from>:<to>'` pair. The duplicate client row
  is the same person by construction, and the merge must repoint before deleting it because
  `trust_transactions.client_id` is `on delete restrict`. Any other pair, no setting, or any
  other changed column still raises.

This is a DB-enforced guarantee independent of application code. The reversing entry inserted by
`voidWithBalance` is an INSERT, never an edit, so it never trips the trigger.

#### `trust_reconciliations` (`backend/db/schema/80_trust.sql:147-167`)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `law_firm_id`, `trust_account_id` | uuid | composite FK to account |
| `reconciliation_date` | date | `not null` (migration 0051) |
| `bank_statement_balance_cents` | bigint | operator input; `not null` (migration 0051) |
| `book_balance_cents` | bigint | snapshot of account at reconcile time; `not null` (migration 0051) |
| `client_ledger_total_cents` | bigint | Σ per-client ledger balances; `not null` (migration 0051) |
| `is_reconciled` | boolean | true only when all three agree; `not null default false` |
| `discrepancy_cents` | bigint | bank − expected bank; `not null` (migration 0051; legitimately signed) |
| `adjustments` | jsonb | `not null default '[]'`; `[{description, amountCents, category?}]` |
| `outstanding_transaction_ids` | uuid[] | uncleared txns (still nullable) |
| `notes` | text | |
| `reconciled_by`/`reconciled_at` | | |

Migration `0051` tightened the five
value columns to `not null` (verified 0 existing nulls first). It deliberately did **not** add a
non-negative CHECK — legacy dev rows carry negative balances, and `discrepancy_cents` is signed
by design.

#### `trust_minimum_balances` and `trust_interest_remittances` (migration 0085)

Two smaller per-account-type tables added alongside the IOLTA expansion, both surfaced in the
user guide's Retainers and Interest tabs (`docs/trust/overview.md`):

- **`trust_minimum_balances`** — one row per `(law_firm_id, client_id, trust_account_id)`
  holding an evergreen-retainer `minimum_cents` threshold. Crossing below it from above is what
  fires the `TRUST_LOW_BALANCE` event (see Data Flow, section B, above). This row wins over
  the firm's `defaultMinimumCents` setting, which in turn wins over the built-in $100. An
  explicit `0` here means "no minimum for this client", which is a different thing from
  having none set. CRUD via
  `listMinimumBalances`/`upsertMinimumBalance`/`deleteMinimumBalance` (`trust.service.ts:675-700`).
- **`trust_interest_remittances`** — one row per IOLTA interest-remittance period for a trust
  account: `interest_earned_cents`, `amount_remitted_cents`, `remitted_to`, `remittance_date`,
  `status` (`pending|remitted`). This is the firm's own accounting of a remittance the bank
  performs; Paralegix does not move the money. CRUD via
  `listRemittances`/`createRemittance`/`updateRemittance`/`deleteRemittance`
  (`trust.service.ts:729-787`).

### Key Logic & Rules

- **Append-only enforcement** — DB trigger above + repository never issuing a financial UPDATE.
  Corrections = void (which also posts a linked reversing entry) + a new entry.
- **Balance math (cents)** — direction is encoded in `type`, not sign:
  `coalesce(sum(case when status = 'completed' then (case when type = 'deposit' then amount_cents else -amount_cents end) else 0 end), 0)::bigint`
  (`balanceExprFor`/`balanceExpr`, `trust.repository.ts:364-375`). Reused by
  `computeClientBalance` (`:569`), `computeClientBalancesByAccount` (`:589`),
  `validateAndSumOutstanding` (`:618`), `computeAccountBalance` (`:655`), `computeAllBalances`
  (`:668`), `computeAccountClientBreakdown` (`:716`), and `computeMatterBalancesByAccount`
  (`:552`) for the matter-level ledger. Callers also filter `status <> 'void'`, but the
  expression itself is what guarantees that only `completed` rows count.
- **Stored vs derived** — `book_balance_cents` is a stored running total updated transactionally
  on every write/void; client balances and the reconciliation ledger total are recomputed from
  the ledger. Reconciliation's whole point is to catch divergence between the stored book
  balance and the derived ledger total.
- **Per-client trust ledger** — every transaction carries `client_id`, and balances are scoped
  per `(client, account)`. `getClientBalance`/`getClientBalanceForPortal` resolve all accounts'
  balances for one client in a single `GROUP BY trust_account_id` query
  (`computeClientBalancesByAccount`, `trust.repository.ts:589`; consumed at
  `trust.service.ts:625` and `:1257`). `getAccountSummary` uses the SQL
  `computeAccountClientBreakdown` + `countNonVoidByAccount` (`trust.service.ts:383-391`). The
  matter ledger (`getMatterLedger`/`getMatterBalance`, `trust.service.ts:645-674`) is the
  equivalent view scoped by `matter_id` instead of `client_id`; it becomes authoritative for
  withdrawals only when the firm turns on `enforceMatterTrustBalance`.
- **List envelopes** — list endpoints return `{ <items>, totalItems }` by running the
  filtered fetch and a matching `count` in parallel, so the UI gets a filter-aware total
  independent of the limit/offset window: `listTransactions`
  (`trust.service.ts:542`, `findWithFilters`/`countWithFilters`), `getClientLedger`
  (`trust.service.ts:607`, `findByClientId`/`countByClientId`), and `listReconciliations`
  (`trust.service.ts:900`, `findPaged`/`countAll`). Portal ledger paginates the same way
  (`getClientLedgerForPortal`, `trust.service.ts:1239`). Filter `limit` is capped at 200
  (`trust.validation.ts`, e.g. `:165`), default 100 in the repos.
- **Overdraft prevention**: enforced once, in `createWithBalance`/`_createWithBalanceTx` under
  the account `FOR UPDATE` lock, at BOTH the per-client level and the account `book_balance`
  level (`INSUFFICIENT_TRUST_BALANCE`, `trust.repository.ts:789-794,823-828` for the
  single-leg path, `:943,950` for the double-entry transfer, and `:1179` for a void that
  would take a balance negative).
- **Account deactivation guard**: cannot set `status='inactive'` while `book_balance > 0`
  (`trust.service.ts:329-357`, `TRUST_ACCOUNT_HAS_BALANCE`), and an inactive account refuses
  every new entry under the lock (`TRUST_ACCOUNT_INACTIVE`). The one exception is a settled
  Stripe deposit (`createTrustDepositFromStripe`, `settledStripeFunds`): the money is already
  in the IOLTA, so it posts to an account deactivated, or a firm whose trust accounting was
  switched off, while the ACH was in flight. The flag is an argument, never a body field. If a
  settled deposit still cannot post, `TRUST_DEPOSIT_POSTING_FAILED` alerts the trust managers
  once per payment intent and the webhook fails so Stripe retries.
- **Stripe clawbacks on closed books**: a full refund or dispute voids the deposit, but a void
  is refused once the deposit is reconciled or its period closed. Only for those two refusals
  the reversal falls back to a reversing withdrawal dated at the event. A reversal that would
  take the client negative is still refused and alerted (`TRUST_DEPOSIT_REVERSAL_FAILED`). A
  won dispute re-posts a voided deposit with its original matter. A separate `book_close_date`
  guard blocks posting or voiding a transaction dated on/before the account's closed period,
  and a recorded reconciliation closes its period the same way.
- **Validation**: Zod schemas in `trust.validation.ts`; positive-integer cents, enum types,
  UUID-shaped ids. Service `assertUuid` (`trust.service.ts:110`) guards path/query ids that
  bypass body validation so a malformed id is a clean 404, not a Postgres cast 500.
- **Permissions** — `trust.view` (read), `trust.manage` (record txns / manage accounts),
  `trust.reconcile` (reconcile) in `backend/src/modules/lawfirms/roles/permissions.ts`.
- **Events** — `TRUST_LOW_BALANCE` is a typed constant in
  `backend/src/shared/events/eventTypes.ts:71` (`'trust.lowBalance'`), imported on both the
  emit side (`trust.service.ts:8`) and the listen side (`trust.events.ts:4`, handler `:17`).
  `trust.events.ts` also listens for `TRUST_DEPOSIT_REVERSAL_FAILED` (`:189`),
  `TRUST_DEPOSIT_RECEIVED` (`:224`) and `TRUST_DEPOSIT_POSTING_FAILED`, emitted by the Stripe
  ACH deposit/reversal flow
  (`docs/TRUST_STRIPE_COMPLIANCE.md`).
- **Tenancy** — every query is scoped by `law_firm_id`; HTTP service methods call
  `assertLawFirmMembership` first. Portal/internal variants deliberately skip it and document
  that the caller owns the auth check.

### Dependencies

- **Drizzle query layer** attached to the shared Postgres pool at
  `backend/src/shared/database/drizzleClient.ts`, including transaction executors.
- **Repositories** (`trust.repository.ts`): accounts, reconciliations, minimum balances and
  interest remittances extend `DrizzleRepository` (`:102,133,1271,1322`). The transaction
  ledger repository (`TrustTransactionRepository`, `:375`) is a plain class that issues its
  locked multi-statement writes through `financialSql` inside `withDrizzleTransaction`, since
  the overdraft and void logic is raw SQL under row locks.
- **Auth/permissions** `verifyToken`, `requirePermission`, `assertLawFirmMembership`.
- **Event bus** `backend/src/shared/events/eventBus` — emits `TRUST_LOW_BALANCE`,
  `TRUST_DEPOSIT_RECEIVED`, `TRUST_DEPOSIT_REVERSAL_FAILED`; consumed in `trust.events.ts`,
  which writes to `conversations`/`messages` (messaging module).
- **Billing/invoices** `invoices.service.ts` — the only cross-module writer of trust
  transactions via `createTrustWithdrawalForInvoice`; converts the dollar payment amount to
  cents via `money.ts` `toCents()`.
- **Stripe module** (`backend/src/modules/stripe/`) — the other cross-module writer, via
  `createTrustDepositFromStripe` and the Stripe reversal helpers, for electronic ACH trust
  deposits routed to a per-trust-account Stripe Connect account. See
  `docs/TRUST_STRIPE_COMPLIANCE.md` for the full flow and `docs/DIRECT_CHARGE_MIGRATION.md` for
  the (not-yet-built) direct-charge follow-up that the `charge_model` column already carries.
- **Clients module** — `client_id` FK, client-name JOINs, and the portal read path.
- **Matters module** — `matter_id` FK and the matter-scoped ledger/balance reads.
- **Frontend** — React Query hooks + `trust.service.ts`; feature-flagged by `trustAccounting`.

### Example

Client Acme deposits a $5,000 retainer, then a $2,000 invoice is paid from trust:

1. `POST /transactions` `{type:'deposit', amountCents:500000, clientId, trustAccountId, date}`
   → ledger row #1 (`completed`), client balance `500000`, account `book_balance_cents` `500000`.
2. Invoice paid from trust → `createTrustWithdrawalForInvoice(amountCents:200000)` →
   `createWithBalance` locks the account, checks Acme's balance (`500000 ≥ 200000`) and the book
   balance, inserts ledger row #2 (`type:'withdrawal'`, `invoice_id` set), client balance
   `300000`, book balance `300000`.
3. Deposit entered with the wrong client → `PATCH /transactions/{row1}/void`
   `{voidReason:'wrong client'}` → row #1 becomes `status='void'`, book balance reversed by
   `-500000`, AND a new `status='void'` reversing row #3 is posted with
   `reverses_transaction_id = row1`. (You'd then post a correct deposit for the right client.)
4. Month-end: `GET /reconciliation-snapshot` pre-fills `bookBalanceCents` and
   `clientLedgerTotalCents` (both from the per-client breakdown); operator enters the bank
   statement figure and outstanding checks (validated + summed in one query against this
   account); `POST /reconciliations` records `discrepancyCents` and `isReconciled`.

---

### Low-balance alert identity

A threshold crossing carries its trust transaction ID as the alert event identity. Distinct crossings with identical balances remain separate notifications; retrying the same identity uses a fixed deduplication bucket. Ordinary notifications without an event identity retain their existing short content-deduplication window.

## What Can Be Improved

> **Note:** the "Resolved" and "Added" lists below are history. Migration numbers in them
> refer to the old chain, which was collapsed into `backend/db/schema.sql`.

**Resolved in the refactor pass (old migrations 0080-0082):**

- **Balance engine reverted to authoritative SUMs.** The stored-snapshot read paths,
  the downstream-snapshot recompute, and the `TRUST_BALANCE_INCONSISTENT` drift guard
  were removed. Every per-client/account balance is a `balanceExpr` SUM over the
  non-void ledger (`balanceExprFor`, `trust.repository.ts`). The snapshot columns
  `client_balance_after_cents`/`account_balance_after_cents` are now written once at
  insert (point-in-time "balance as posted") for display only — never read back for
  an authoritative balance, so they cannot drift the answer. This trades an O(1) read
  for an O(n) SUM, which is the right call for a correctness-critical, low-volume
  ledger: it is self-correcting and removes the stale-snapshot and void-blocking
  failure modes entirely. (Resolves the former items 1, 3, and 6.)
- **DB `CHECK (book_balance_cents >= 0)`** added (`trust_accounts_book_balance_nonneg`,
  `80_trust.sql:24-25`). It was first added `NOT VALID` by a migration so legacy negative
  rows could not block it. That caveat is gone: every database is now built from
  `schema.sql`, where the constraint is declared inline and therefore validated.
- **Single billing→trust rounding point.** The invoice payment branch computes
  `paymentAmountCents = toCents(paymentAmount)` once and reuses it for the trust
  withdrawal and the `amountPaid` math (`invoices.service.ts`), instead of re-rounding
  the same dollar float three times.
- **Reconciliation history paginates.** `ReconciliationHistory` now calls
  `listReconciliationsPaged` with a "Load more (X of Y)" control and reads `totalItems`.

**New capabilities added in the same pass:**

- **Per-transaction clearing.** `trust_transactions.cleared_at` +
  `cleared_in_reconciliation_id` (migration 0081). Recording a reconciliation marks
  every completed, on/before-date, not-flagged-outstanding entry as cleared **in the
  same transaction** (`createWithClearing`, `trust.repository.ts`). "Currently
  outstanding" is now a simple query (completed + `cleared_at is null`), surfaced as a
  CLEARED/OUTSTANDING badge in `TransactionList`.
- **Double-entry trust→trust transfers.** `transfer_to_account_id` + `transfer_group_id`
  (migration 0082). A transfer that targets another trust account posts a linked
  `transfer` (outflow) + `deposit` (inflow) pair for the same client, both accounts
  locked in id order (`createTransferWithBalance`). Voiding either leg voids the whole
  group atomically (`voidWithBalance`). Transfers to `operating`/`other` remain single
  outflow legs as before.

**Added in the compliance-guard pass (see `backend/tests/trust/trustPeriodGuards.test.ts`,
`trustEntryIntegrity.test.ts`, `trustSettingsEnforcement.test.ts` and `trustAuditReport.test.ts`):**

- **A reconciliation closes its period.** `assertPeriodNotReconciled` refuses an entry dated
  on or before an account's latest `reconciliation_date` (`TRUST_PERIOD_RECONCILED`).
  Reopening the reconciliation is the sanctioned way back in, as it already was for a void.
- **`book_close_date` is a one-way ratchet.** It may advance or be cleared, never move
  backwards (`TRUST_PERIOD_LOCK_REGRESSION`), so a closed period cannot be quietly reopened.
- **Reconciliations run forward in time.** A future statement date is refused (a mistyped
  year clears every entry in the account), as is one at or before the previous
  reconciliation (`RECONCILIATION_OUT_OF_ORDER`).
- **An already-cleared entry cannot be flagged outstanding again.**
  `validateAndSumOutstanding` filters `cleared_at is null`, so its delta cannot be
  subtracted from the expected bank balance a second time.
- **A withdrawal that paid an invoice cannot be voided from the trust side**
  (`TRUST_ENTRY_LINKED_TO_INVOICE`). Removing the payment on the invoice reverses both
  halves; `voidTransactionInternal` (the billing side's own path) bypasses the guard.
- **A matter on a trust entry must belong to the paying client**
  (`TRUST_MATTER_CLIENT_MISMATCH`). The `(law_firm_id, matter_id)` FK only proved same-firm.
- **An account with ledger history cannot change identity** (`TRUST_ACCOUNT_HAS_HISTORY`):
  type, bank digits and interest beneficiary freeze once entries reference them. Renaming
  stays open.
- **Duplicate check numbers are refused per account** (`TRUST_DUPLICATE_CHECK_NUMBER`), for
  `source = 'check'` only; a voided cheque releases its number.
- **A trust-to-operating transfer must name the invoice it pays**
  (`TRUST_FEE_REQUIRES_INVOICE`) unless `flatFeeToOperatingAllowed` is on. This is what
  that setting was added to express and previously did not enforce.
- **The trust settings now do something.** `reconcileCadence` drives
  `nextReconciliationDueDate` / `reconciliationOverdue` (a never-reconciled account reads as
  overdue); `retentionYears` derives `retentionCutoffDate`; the new
  `enforceMatterTrustBalance` makes the matter ledger authoritative for withdrawals
  (`INSUFFICIENT_MATTER_TRUST_BALANCE`), off by default; and `defaultMinimumCents` sets the
  firm's own low-balance threshold, null meaning the built-in $100.
- **A setting must be on `SETTINGS_KEYS` to survive the round trip** (`trust.service.ts`).
  `updateTrustSettings` copies only the keys on that list, so a setting added to the Zod
  schema and the defaults but not to the list is accepted with a 200 and silently dropped.
- **`GET /trust/audit-report`** returns every account's three figures, per-client
  breakdown, negative balances, drift, outstanding items and reconciliation standing in one
  read, surfaced as the trust page's **Compliance** tab with a CSV export. Accounts are
  read one after another, each account's four reads in parallel, so one report holds at
  most four pool connections however many accounts the firm has.
- **`transactionFiltersSchema`'s `startDate`/`endDate`** use the module's own `dateStr`
  validator, so a malformed filter is a 400 rather than a scrubbed 500.

**Still open / deliberately not done:**

1. **The invoice payment request still takes a dollar float.** Storage is already
   cents-native (`invoice_payments.amount_cents bigint not null`, `70_billing.sql:231`), so
   the "stored in dollars" half of this item is done. What remains is the request
   boundary: `recordPaymentSchema` accepts `paymentAmount: z.number().positive()`
   (`invoices.validation.ts:256`), a dollar float that `toCents` rounds once on the way
   in (`invoices.service.ts:2024`). That single rounding point is exact for whole-cent
   input, so this is a tidiness/robustness item rather than a live correctness bug.
   Making the request cents-native would remove the float boundary entirely.

2. **Every trust write reads the firm's settings twice and the client minimum once, even
   when the answer is thrown away.** `_createTransactionInternal` loads the settings through
   `resolveTrustSettings` (`trust.service.ts:496`), then after the write loads them again
   through `getFirmTrustSettings` and reads `trustMinRepo.getMinimum` (`:517-527`) to size
   the low-balance threshold. That happens for deposits too, where `isCredit` means the
   alert can never fire. Reuse the first settings read and skip the threshold lookup on a
   credit.

3. **`trust_transactions.status = 'pending'` is a valid enum value nothing writes.**
   An ACH deposit takes days to settle and the firm sees nothing until
   `payment_intent.succeeded` posts it as `completed`. The schema already carries the
   state to show an in-flight deposit; the flow to write it does not exist.
   `docs/TRUST_STRIPE_COMPLIANCE.md` lists this as an open question rather than an
   oversight. Note `balanceExpr` already sums only `completed` rows
   (`trust.repository.ts:364-375`), so introducing `pending` cannot inflate a withdrawable
   balance.

4. **`trust_transactions.charge_model` is written by nobody.** The column and its CHECK
   exist, `_createWithBalanceTx` never passes it, and every row therefore holds the
   `'destination'` default. It is a placeholder for `docs/DIRECT_CHARGE_MIGRATION.md`,
   which is not built. Left as-is deliberately: filling it in with the value it already
   defaults to would be motion without meaning, and the column is what the migration
   will need.

5. **No escheatment or dormant-balance tracking.** Trust money a client never collects
   eventually escheats to the state, and no competitor surveyed ships this either
   (Smokeball's Dormant Trust Balances report and CosmoLex's Trust Listing "last
   activity date" column are the closest anything comes). The audit report's per-client
   breakdown is the natural place to hang a last-activity date when this is built.

6. **No bank feed.** Reconciliation takes a bank statement CSV upload
   (`ReconciliationForm.tsx`). Every competitor that has automated this uses Plaid.
   That is the single highest-value external integration for this module.
