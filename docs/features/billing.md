# Billing

## Summary

The Billing module covers everything a firm bills and collects: **time entries**, **flat fees**, **expenses**, **invoices** (with line items, payments, payment plans/installments, credit notes/write-offs, ad-hoc amount adjustments, optional **sales tax**, one-time **late fees**, **split invoices** across a matter's payers, and **voiding**), **charge codes** (rate cards) and **expense categories** (one `billing_codes` table since migration `0231`, told apart by `kind`; both route surfaces are unchanged), **recurring billing plans** (retainers, with auto-generated periods), **per-firm billing settings** (time-rounding, tax defaults, late-fee config, who pays the online processing fee; see `stripe-payments.md`), and **analytics** (firm billing summary). Everything is multi-tenant: every table carries `law_firm_id` and every query is scoped to it.

All billing work lives under one Express module, `backend/src/modules/billing/`, split into sub-areas: `timeEntries/`, `flatFees/`, `expenses/`, `invoices/`, `chargeCodes/`, `expenseCategories/`, `plans/`, `analytics/`, `reports/`, plus a `shared/` folder (`money.ts`, `invoiceStatus.ts`, `invoiceDerive.ts`, `firmBilling.service.ts`, `billingReads.ts`, `rateResolution.ts`, `billingCalendar.ts`, `billingSettings.ts`, `timeRounding.ts`, `splitAllocation.ts`, `firmBillingWindow.ts`, `workbench.routes.ts`, among others) and `context.ts` (matter-vs-client billing context resolution). The frontend talks to it through `frontend/src/services/billing.service.ts` and `chargeCodes.service.ts`.

A **billing context** is either a `matter` or a `client` (`backend/src/modules/billing/context.ts`). Time entries, flat fees, expenses, invoices, and billing plans all hang off exactly one context, enforced in the DB by a XOR check `(matter_id is not null) <> (client_id is not null)` on each table (on `activities`, and on `invoices` with `client_context_id`).

## Key Takeaways

- **Money is stored in integer cents** (`*_cents`, `bigint`). The math is **integer-cent end to end**. The canonical helpers live in `backend/src/modules/billing/shared/money.ts` (`money.ts`): `toCents`/`fromCents` (0-for-empty) plus the null-preserving `toCentsOrNull`/`fromCentsOrNull` for nullable money columns. Every monetary sum/allocation/comparison in `invoices.service.ts`, `firmBilling.service.ts`, `invoiceStatus.ts`, `invoiceDerive.ts`, and `billingAnalytics.service.ts` is done in whole cents and converted to dollars only at the output boundary.
- **Derived invoice status is a single source of truth.** `deriveInvoiceStatus` lives once in `shared/invoiceStatus.ts` and is consumed by BOTH the read path (imported by `firmBilling.service.ts` and reached through `computeInvoiceDerived`) and the persisted-status writeback in the repository (`invoices.repository.ts`). That module depends only on `money.ts`, so it breaks the old `firmBilling.service ↔ invoices.repository` require cycle without duplicating the rule.
- **The `status` column is authoritative and self-healing.** After EVERY create and update (all of which funnel through the row-locked txn), the repo recomputes `deriveInvoiceStatus` and writes it back in the same transaction (`invoices.repository.ts`, in `_createTx` and `_applyUpdateLocked`). The writeback patches **only** the `status` column from the already-assembled invoice, with no second full child-table reassemble/SELECT. The midnight-crossing staleness limit of a write-time-only derived column is explicitly documented at the writeback (`invoices.repository.ts`). The one status the amounts cannot override is `voided`, which the firm sets and `deriveInvoiceStatus` returns unchanged (`invoiceStatus.ts`).
- **Shared derived fields.** `computeInvoiceDerived` (`shared/invoiceDerive.ts`) factors out the fields both serializers need identically (effective total, remaining balance, recurring-retainer detection, the `plan-` flat-fee lookup, `billingPlanName`, status) so `formatInvoice` (`invoices.service.ts`) and `mapInvoiceRecord` (`firmBilling.service.ts`) can't drift on them. The split-share rounding is also reconciled: both serializers `roundCurrency` `splitShareAmount`/`splitSharePercent` (`invoices.service.ts`, `firmBilling.service.ts`).
- An invoice is a **relational aggregate**, not a JSON document. The `invoices` row holds scalars; repeating groups live in child tables (`invoice_line_items`, `invoice_payments`, `invoice_expected_payments`, `invoice_adjustments`). All four carry `law_firm_id not null` with a composite key to their invoice (migration `0246`), so a child pointing at another firm's invoice is refused by the database rather than merely never written. The repository reassembles the legacy camelCase doc shape so the service layer is unchanged from the Firestore era.
- **`balance_due_cents` is a generated column** = `total_cents - amount_paid_cents - coalesce(total_written_off_cents,0)` (`backend/db/schema/70_billing.sql`): it subtracts write-offs, matching the app's `remainingBalance`. `activities.amount_cents` is also generated, and since migration `0233` it is **summable**: it generates from `resolved_rate_cents` (falling back to an explicit `rate_cents`) for a time row and from `charge_cents` otherwise, so a row rated at write time carries its real value rather than 0. See "One `activities` table, and the rate an entry carries" below.
- **Dates**: day-only fields (`invoice_date`, `due_date`, `next_payment_date`, `entry_date`, installment `due_date`) are `date`/text and returned as `'YYYY-MM-DD'` strings; `paid_date`, `created_at`, etc. are `timestamptz` returned as ISO strings.
- **All invoice payment/total/plan mutations run inside `runInvoiceTxn`** (`SELECT … FOR UPDATE` then read-under-lock, `invoices.repository.ts`). Every payment-state service mutator (record/edit/delete payment, credit notes, add-amount, late fee, void, all payment-plan/installment ops, and the lighter `removePaymentPlan`/`updateInstallment`/`setReminderOptOut`/`setPreDueReminder`) reads under the lock through this path.
- **Invoice numbers** are allocated atomically from a per-firm counter (`firm_counters`) via `allocateInvoiceNumber` (`invoices.repository.ts`), backed by a unique index (`invoices_number_unique_idx`, `backend/db/schema/70_billing.sql`). Invoice **names** are unique per `(firm, context)` via a partial unique index. The number, the invoice date and the remit-to block are frozen once an invoice has been issued (`updateInvoiceDetails`, `invoices.service.ts`); an edit that changes one of them afterwards is a 409 `ConflictError`, not a 403, because it is a conflict with the invoice's state rather than a permission failure. The freeze compares values, not keys: resending the stored number, the same day or an equal remit-to block is accepted and left unwritten, so a rename or a new due date still saves, and the edit form leaves the frozen fields out once `billingSnapshotAt` is set. There is no next-number preview, so the prefix index `invoices_name_prefix_idx` has no reader (see Improvements).
- **Voiding** cancels a bill while keeping the record: `voidInvoice` (`invoices.service.ts`) sets the terminal status `voided`, closes the invoice's Stripe payment links, releases its time entries, flat fees and expenses so they can be billed again, and is refused once any payment is recorded. A voided invoice drops out of reminders, auto late fees, the overdue bucket and the billed and outstanding totals, refuses a manual late fee, and cannot be linked to a trust ledger entry. `deleteInvoice` refuses a Stripe-paid or trust-referenced invoice and points the firm at void instead. See "Voiding an invoice" below.
- **Rate resolution** is a multi-tier hierarchy (`shared/rateResolution.ts`): entry override → matter-member → client per-member → client default → charge-code per-member → charge-code default → user default → firm default → 0.
- **Stripe** integration exists (columns + `stripePayment*` fields threaded through the invoice) but the actual Stripe service is outside this module (`docs/features/stripe-payments.md`); billing persists/reads the fields and re-syncs the calendar after external writes. The manual payment route cannot record `paymentSource: 'stripe'` (its enum is `trust | external`, `invoices.validation.ts`).
- **Firm-wide accounts receivable.** The billing summary's A/R totals (billed / collected / outstanding / overdue) are derived from `firmInvoiceMoneyRecords` (`firmBilling.service.ts`), which builds a money-only record for EVERY invoice in the firm from the `law_firm_id`-scoped `invoicesByContext`, with **no membership filter**. The totals are not derived from `listFirmInvoices`, which only builds records for the acting user's accessible matters and would drop every other attorney's outstanding balance. `getBillingSummary` points at it (`billingAnalytics.service.ts`); per-invoice math is unchanged.
- **Optional per-invoice tax.** `createInvoice` applies a sales/gross-receipts tax on top of the recomputed line-item subtotal: the rate is the caller's `taxRate` if sent, else the firm's `tax.defaultRate` when tax is enabled (`invoices.service.ts`). `tax_cents` is folded INTO `total_cents`, so all balance/payment/status math is unchanged; `tax_rate` + `tax_cents` are stored for display (columns `backend/db/schema/70_billing.sql`). A line-item edit recomputes the tax on the new lines, and may change the rate (`updateInvoiceLineItems`, `invoices.service.ts`); amounts added since creation (add-amount, late fee, kept in `invoice_adjustments`) stay in the total and are never taxed, so the new total is lines + tax + adjustments. `formatInvoice` exposes `taxRate`, `taxAmount`, and a derived `subtotalAmount` (`invoices.service.ts`) for the detail view and PDF.
- **One-time late fees (a charge, NOT interest).** Configured per firm (`lateFee`: `flatAmount` + `percent` stack, `graceDays`, `autoApply`). `applyLateFeeCore` (`invoices.service.ts`) runs under the invoice row lock and is idempotent: an invoice that already carries a `kind: 'late_fee'` amount adjustment is never charged twice (`lateFeeEligibility`). It is recorded as an `invoice_adjustments` row on the charge side (`direction = 'charge'`, `kind = 'late_fee'`) and, on a plan invoice, added to the next open instalment (the earliest by date) so the open rows keep covering the balance (a plan with no open instalment gets a new one for the fee; a plan already at 120 instalments refuses it). Applied manually via `POST .../:invoiceId/late-fee` or automatically by the daily `applyAutoLateFees` sweep (`lateFees.service.ts`).
- **Time rounding.** When a firm enables it, `roundHoursUp` (`timeRounding.ts`) rounds each time entry's hours UP to the configured increment (default 6 minutes / 0.1h) at save time, in both `createTimeEntry` and `updateTimeEntry` (`timeEntries.service.ts`). Off by default so existing hours are never silently altered. The result is also rounded UP to the hundredth of an hour, because `activities.hours` stores two decimals and a 5 or 10 minute increment is not a whole number of hundredths.
- **Time-entry ownership.** Editing or deleting another member's time entry, singly or in a bulk delete, needs `billing.manageOthersTimeEntries` on top of `billing.manageTimeEntries`. Firm-level time has no timekeeper, so it needs the code too (`assertMayActOnTimekeeper`, `timeEntries.service.ts`). The Attorney and Paralegal built-in roles hold the code.
- **Collections reach every unpaid invoice with a due date.** Overdue reminders, pre-due reminders, the auto late-fee sweep and the daily digest all cover an unpaid, non-voided invoice with a due date, whether or not it was emailed or given a Stripe link (`findUnpaidByDue`; `notifications/digest/digest.repository.ts`). See "Reminders and late fees run on the firm's calendar".
- **Payment inputs are bounded.** Payment, credit-note, adjustment and plan amounts must be whole cents (`isWholeCents`, `invoices.validation.ts`), and a payment plan holds at most 120 instalments (`MAX_PLAN_INSTALLMENTS`, `shared/money.ts`).
- **Per-firm billing settings live in `law_firms.settings -> 'billing'`** (a jsonb sub-object, no dedicated table). `getFirmBillingSettings` (`billingSettings.ts`) merges stored overrides onto `BILLING_SETTINGS_DEFAULTS` (`clientPaymentEmails`, `timeRounding`, `lateFee`, `tax`, `processingFees`). Two write paths feed the same blob: the firm-settings module validates + persists `timeRounding`/`lateFee`/`tax`/`processingFees` (via `updateFirmSettings`, `settings.validation.ts`), while billing's own `PUT /billing/settings` (`firmBilling.updateBillingSettings`) writes only `clientPaymentEmails`.

---

## How It Works

### Entry Points

Routes are registered per sub-area and mounted under `/api/lawfirms/:lawFirmId/billing/...`. All require a verified Firebase token (`verifyToken`) plus a permission check (`requirePermission(...)`).

| Area | Routes file | Service | Repository |
|---|---|---|---|
| Invoices | `invoices/invoices.routes.ts:1` | `invoices/invoices.service.ts:1` | `invoices/invoices.repository.ts:1` |
| Time entries | `timeEntries/timeEntries.routes.ts:1` | `timeEntries/timeEntries.service.ts:1` | `timeEntries/timeEntries.repository.ts:1` |
| Flat fees | `flatFees/flatFees.routes.ts:1` | `flatFees/flatFees.service.ts` | `flatFees/flatFees.repository.ts` |
| Expenses | `expenses/expenses.routes.ts:1` | `expenses/expenses.service.ts` | `expenses/expenses.repository.ts` |
| Charge codes | `chargeCodes/chargeCodes.routes.ts:1` | `chargeCodes/chargeCodes.service.ts` | `chargeCodes/chargeCodes.repository.ts` |
| Expense categories | `expenseCategories/expenseCategories.routes.ts:1` | `expenseCategories/expenseCategories.service.ts` | `expenseCategories/expenseCategories.repository.ts` |
| Billing plans (retainers) | `plans/plans.routes.ts:1` | `plans/plans.service.ts` | `plans/plans.repository.ts` |
| Analytics | `analytics/billingAnalytics.routes.ts:1` | `analytics/billingAnalytics.service.ts:1` | (queries `pool` directly) |
| Reports | `reports/billingReports.routes.ts:1` | `reports/billingReports.service.ts:1` | `reports/billingReports.repository.ts:1` |
| Firm-wide reads / workbench | `shared/workbench.routes.ts:1` | `shared/firmBilling.service.ts:1` | via `shared/billingReads.ts:1` |

Key permission gates: `billing.viewInvoices` (firm list / unbilled-summary / calendar payment dates / per-context reads), `billing.manageInvoices` (create / split / details / line items / void / late fee / credit notes / payment plans / add-amount / reminders / LEDES / send / bulk), `billing.recordPayments` (record / edit / delete payments). All in `invoices/invoices.routes.ts`. Sending an invoice email or a single reminder also needs the matter write gate (`assertInvoiceSendable` calls `authorizeContext` in `invoiceReminders.service.ts`), so a member holding `billing.manageInvoices` who is not on a walled matter cannot send its bill. LEDES export needs `billing.manageInvoices` but only the matter read gate, the same access rule as the invoice reads.

Notable invoice endpoints (most mirrored `matter/:matterId` and `client/:clientId`):
- `POST /billing/invoices`: create a matter invoice; `POST /billing/invoices/client/:clientId`: client invoice.
- `POST /billing/invoices/matter/:matterId/split`: split one set of unbilled items across multiple client invoices (`createSplitInvoices`, `invoices.service.ts`).
- `POST /billing/invoices/bulk`: auto-generate one invoice per context from unbilled work (`bulkCreateInvoices`, `invoices.service.ts`).
- `PATCH .../:invoiceId/details` and `.../line-items`: edit the header or the lines (`updateInvoiceDetails`, `updateInvoiceLineItems`).
- `PUT .../:invoiceId/payment`: record payment / mark paid / set next date (`recordPayment`); `PATCH` edits and `DELETE` removes one. A payment is named by the `id` the invoice payload carries for it (`paymentId` in the PATCH body or the DELETE query, and in the un-pay installment query); the position (`paymentIndex`) is still accepted when no id is sent. An id that is no longer on the invoice is a 409, so a double-clicked delete or an edit from a stale tab never lands on whichever payment now holds the old position (`resolvePaymentIndex`, `invoices.service.ts`). Marking an invoice unpaid is refused with a 409 while it holds a payment Stripe collected.
- `POST .../:invoiceId/void` (`voidInvoice`,; routes `invoices.routes.ts`).
- `POST .../:invoiceId/late-fee` (`applyLateFee`).
- `POST .../:invoiceId/payment-plan` (`setPaymentPlan`), `PATCH .../payment-plan/installment/:installmentIndex` (`updateInstallment`), `PATCH .../payment-plan/schedule` (`replacePaymentPlanSchedule`), `DELETE .../payment-plan/installment/:installmentIndex/payment` (`unpayInstallment`).
- `GET .../:invoiceId/export/ledes`: LEDES 1998B export (`ledesExport.service.ts`). Time entries and flat fees are `F` lines, expenses are `E` lines (expense code `E124`, Other, in the activity-code column), and tax plus each added amount or late fee is an `IF` (invoice-level fee adjustment) line, so the line totals add up to `INVOICE_TOTAL` in cents.
- `GET /billing/invoices/firm` and `/calendar-payment-dates` (`getCalendarPaymentDates`).

Flat fees have their own firm-wide read alongside the per-context pair: `GET /billing/flat-fees/firm`, filterable by `clientId` and a bounded `matterIds` list, with a hard page ceiling and a `countOnly` shape. See "The firm-wide flat-fee read" below.

The `reports/` sub-area backs the workbench's Reports tab: `GET /billing/reports/by-matter` and `/by-client` return one page of firm-wide roll-ups (billed/outstanding/hours/invoice counts), each gated by BOTH `billing.viewInvoices` and `billing.viewTimeEntries`; `GET /billing/reports/by-client/:clientId/matters` backs the by-client detail drill-in. `by-matter` also carries `unlinkedInvoices` (client-direct invoices, no matter) and `by-client` carries `unattributedInvoices` (multi-client matter invoices naming no single client), each grouping's money that the other omits, deliberately unfiltered by the caller's search/status/practiceArea so the shortfall banner never understates itself.

Frontend service (`frontend/src/services/billing.service.ts`) wraps all of these; it uses `requestDeduplicator` so concurrent identical GETs share one in-flight request. Pages: `frontend/src/app/lawfirm/[lawFirmId]/billing/page.tsx` (workbench), `.../billing/bulk-invoice/page.tsx`, `.../billing/plans/`, plus per-matter/per-client invoice pages, and the client portal under `client/lawfirm/[lawFirmId]/billing/`.

### Firm-wide list paging, and the ceiling on the firm time-entry list

The firm-wide billing lists (`listFirmInvoices`, `listFirmTimeEntries`, `listFirmUnbilledWork`, the workbench attention list) all filter, sort and window over DERIVED records rather than in SQL, because the fields their filters read (effective invoice total, remaining balance, derived status, resolved rate, `billingStatus`) are computed in JavaScript from several joined reads. `totalItems` and every `summary` figure are therefore always taken over the whole match set, BEFORE the window, so a paged response never understates a firm's hours, value or backlog.

`GET /billing/unbilled-work` (`listFirmUnbilledWork`) is bounded differently: the set is completed tasks no time entry points back at yet, which is small, so it keeps the opt-in paging and instead bounds its CONNECTION use. It runs its three reads (visible completed tasks, captured source ids, firm clients) one at a time, so it holds exactly one pool connection for the request. A fourth read, `getAccessibleMatters`, was removed: nothing in the item list consumed it (a task's `matterId` and `matterName` come from the task read's own `matters` join), and it was not the matter wall either. `tasksRepo.findVisibleToUser` is called without `seeAll`, so it applies `matter_id is null or exists (matter_members …)` in SQL itself, and the accessible-matter list is WIDER than that for an owner or admin. `tests/billing/billingReadConnections.test.ts` pins the one-connection peak; `tests/billing/workbenchRoutes.test.ts` pins that an owner still cannot see work on a matter they are walled off from.

`GET /billing/time-entries/firm` is the one list with a hard ceiling on the rows it returns (`MAX_PAGE_SIZE`, 200, `shared/firmBillingWindow.ts`). The frontend's "select all matching" read (`billing.service.ts` `listFirmTimeEntriesAll`) sends no `limit` and so reaches the ceiling. On an instance with a 12-connection pool against a Supabase pooler that allows 15, an unbounded read would hold a connection while the whole log was read, derived and serialized, on a page that already holds several other reads. Two behaviours bound it:

- A `limit` **above** the ceiling is **refused** (400, from `paging({ max: MAX_PAGE_SIZE })` in `timeEntries.validation.ts`). It is not clamped: a caller that asked for 5,000 rows and silently received 200 would page off a size it never agreed to.
- A request with **no** `limit` is **clamped** to the ceiling, and the response carries `truncated: true` when that withheld anything. Refusing it instead would break select-all with no fallback; clamping silently would hand a caller 200 rows it believes are all of them and let it bulk-invoice or bulk-delete the wrong set. `truncated` means "the SERVER withheld rows", so it is `false` whenever the caller supplied its own `limit`.

The ceiling lives in `timeEntries.service.listFirmTimeEntries`, which is the route's own wrapper and has no other caller. The firm-wide aggregates call `firmBilling.service.listFirmTimeEntries` directly, in process, and still receive every row: `getBillingWorkbench` sums unbilled hours and builds its ready-to-bill list from the complete set, and `billingAnalytics.getBillingSummary` counts hours-this-month and unbilled entries the same way. Pushing the ceiling down into the shared service would silently turn both into "the first 200 entries".

**Real paging for this list is not a `limit`; it is a move of the derivation into SQL.** The clamp bounds the payload, not the scan: the service still loads every matching entry, derives each one and sorts them before slicing. To hold only one page in memory, four things have to move server-side into `billingReads.listTimeEntriesForFirm`: the rate resolution behind `hourlyRate`/`amount` (eight rate sources, currently `rateResolution.ts`), the `billingStatus` derivation (a join against `invoice_line_items` plus retainer coverage and the draft queue), the free-text search across joined matter/client/user names, and the `summary`/`totalItems` aggregates, which would become window functions alongside the page rather than a reduce over the full array. Until then the ceiling is what keeps one request's cost bounded.

### Bulk-deleting time entries

Firm, matter and client time-entry panels default to the same uninvoiced statuses: `unbilled`, `queued` and `covered_by_retainer`. Their shared `isTimeEntryLocked` helper locks only `billed` time. Client panels additionally keep linked-organization entries read-only because those entries belong to another client context.

`POST /api/lawfirms/:lawFirmId/billing/time-entries/bulk-delete` (`timeEntries.routes.ts`, `bulkDeleteTimeEntries` in `timeEntries.service.ts`) deletes a whole selection in one request. The three panels that offer bulk delete (`billingComp/BillingTimeEntriesView`, `matterComp/TimeTracking`, `clientComp/ClientBillingTimeEntriesSection`) do not send one `DELETE` per selected row: a select-all delete would be up to a thousand round trips against an instance holding twelve Postgres connections for every user on it. The single-entry `DELETE .../matter/:matterId/:timeEntryId` and `.../client/:clientId/:timeEntryId` routes are unchanged and still back the per-row delete button.

- **Permission**: `billing.manageTimeEntries`, the same gate as the single delete. Not time-aware, so no `requireTimezone`. A selection containing another member's entry also needs `billing.manageOthersTimeEntries`; without it the whole request is refused with a 403 and nothing is deleted.
- **Cap**: `MAX_BULK_TIME_ENTRY_IDS` (1,000) in `timeEntries.service.ts`, which `timeEntries.validation.ts` imports rather than restating. It is exactly what the firm list's select-all can gather: `FIRM_TIME_ENTRY_SELECT_ALL_CEILING` in `frontend/src/services/billing.service.ts` is `FIRM_BILLING_MAX_LIMIT` (200, the same `MAX_PAGE_SIZE` above) times the five pages that walk makes. A lower cap would turn a full, legitimate selection into a 400; a higher one would accept a list no screen could have produced. A longer list is refused whole (400), not truncated.
- **Envelope**: the repo's bulk shape, `{ message, requested, deleted, failed, errors }`. A 200 does NOT mean every id went; it means the server reached a decision about each one.
- **Per-entry outcomes.** Two rules refuse a single delete and both still refuse one row of a batch. An entry on a matter the caller is not staffed on gets `User is not a member of this matter`; an entry an invoice already carries gets the same refusal `deleteTimeEntry` throws. Everything else in the batch is still deleted, because one billed row must not cancel the other 999. An id that is malformed, belongs to another firm, or never existed is answered identically (`Time entry not found`), so the response cannot be used to probe which ids are real.
- **A constant number of queries.** Every decision is resolved for the whole batch at once: one read for the entries (`timeEntriesRepo.findManyForFirm`), then three in parallel (`getAccessibleMatterIds` for the matter wall, `resolveClientsInFirm` for the client wall, `billingReads.billedSourceIdsForFirm` for the invoice lock), then one `deleteManyForFirm`. `tests/billing/timeEntriesBulkDelete.test.ts` pins that by counting pool `acquire` events: twelve times the ids costs the same number of checkouts.
- **Why the billed check is firm-wide.** `billedSourceIdsForFirm` asks whether ANY line item of the firm names the row, which is wider than `isSourceBilled`'s context-scoped question and is deliberately the same question `activities_billed_immutable` asks. That trigger aborts the whole statement when it fires, so a batch built on the narrower answer would fail entirely rather than refusing one row. Invoice composition only ever puts an entry on an invoice for its own context, so the two answers agree on every row the product can produce.
- **Events**: one `TIME_ENTRY_CHANGED` per distinct context, not per entry. Every listener invalidates a context's derived figures, so a matter whose fifty entries just went needs to hear that once.

On the frontend, `billingService.bulkDeleteTimeEntries(lawFirmId, timeEntryIds)` takes a firm id rather than a `BillingContext`, since a selection spans matters and clients. The panels still filter locked rows out before sending (a billed row is never offered), map `failed` back to the rows that stay selected, and build the partial-run sentence with `bulkFailureMessage`, so the user still reads "940 of 1000 time entries deleted. 60 could not be deleted and stayed selected." The confirm dialog does not count progress: one request has no per-item settling to count, so while it is in flight the dialog reads `Deleting N time entries…`. `lib/utils/bulkRequests.ts` stays in place for the client file-share surfaces, which have no bulk route to send a selection to.

### The firm-wide flat-fee read

`GET /billing/flat-fees/firm` (`flatFees.routes.ts`, `listFirmFlatFees` in `flatFees.service.ts`, `findForFirm` in `flatFees.repository.ts`) answers for the whole firm what `/flat-fees/matter/:matterId` and `/flat-fees/client/:clientId` answer for one context. Those two are unchanged and remain the per-context reads.

It exists because two screens looped them. The client detail Billing tab called `listFlatFees` once per matter, and the client invoice composer did the same and then reduced the result to a count, so a client with eighty matters fired eighty requests, each taking one of the twelve connections the whole instance shares.

- **Permission**: `billing.viewInvoices`, the same gate as the two per-context reads, behind `heavyReadLimiter`. Not time-aware, so no `requireTimezone`: a flat fee's date is a day-only value.
- **Filters**: `clientId`, `matterIds` (comma-separated, at most `MAX_PAGE_SIZE` ids), `context` (`matter`|`client`), `billingStatus` (`billed`|`unbilled`), `dateFrom`/`dateTo`, plus `page`/`limit`/`offset`. `clientId` and `matterIds` are **OR'd**, not AND'd: an `activities` row holds exactly one of `matter_id` and `client_id`, so ANDing them would return nothing for every caller that sent both, and sending both is precisely the client Billing tab's question (this client's own fees, plus the fees on this client's matters) in one request.
- **Envelope**: `{ flatFees, totalItems, truncated, summary: { totalAmount } }`. Items are the same objects the per-matter route returns, `isBilled` included; `tests/billing/firmFlatFees.test.ts` pins deep equality against that route rather than re-deriving the fields.
- **Ceiling**: `MAX_PAGE_SIZE` (200, `shared/firmBillingWindow.ts`), the same number the firm time-entry list uses. A `limit` above it is a 400, and unlike that list an **absent** `limit` is served at the ceiling too, with `truncated: true` when rows were withheld. There is no in-process caller needing the complete set (the workbench reads `listFirmUnbilledFlatFees` in `firmBilling.service.ts` directly), so this route never returns an unbounded list.
- **Count only**: `countOnly=true` returns `totalItems` and `summary` with `flatFees: []`, running one aggregate query and fetching no rows. That is what the invoice composer wants.

Unlike the other firm-wide lists, this one filters, counts and totals **in SQL**. `is_billed` is computed per row by the same rule `billingReads.billedSourceIds` uses (an `invoice_line_items` row of kind `flat_fee` whose `source_id` names the fee, on an invoice in that fee's own context), `count(*) over ()` and `sum(amount_cents) over ()` ride on the page query, and a page past the end falls back to an aggregate-only form of the same CTE. Nothing in a flat fee's shape needs the JavaScript derivation the invoice and time-entry lists depend on, so the totals describe the whole match set exactly and the cost does not grow with the filter.

Access is the per-context rule reused, not restated: matter fees are restricted to `billingReads.listAccessibleMatters` (owner or admin sees all, everyone else needs matter membership, the audience `assertMatterReadAccess` grants on the per-matter route), and client fees stay visible to any firm member because that is what the per-client route already grants. The whole request is **three service reads whatever the filter's size** (the firm-membership assertion, then the owner/admin check and matter list inside `listAccessibleMatters`, then one page query); `tests/billing/firmFlatFees.test.ts` measures the app pool's own `acquire` events and asserts the count is identical for 2 matter ids and for 14.

### Money-in-cents convention (the integer-cent helpers)

Storage is integer cents (`bigint`). Cent handling is consolidated:

1. **`shared/money.ts`** — the canonical helpers (`money.ts`):
   - `toNum`/`toNumber` (`:28`, alias): coerce to number (parse strings, else 0).
   - `roundCurrency(v)`: `Math.round(toNum(v)*100)/100` (used for hours and percentages).
   - `toCents(v)`: dollars → whole cents (0 for empty).
   - `fromCents(c)`: whole cents → dollars (0 for null).
   - `toCentsOrNull` / `fromCentsOrNull`: null-preserving variants for nullable money columns (an optional hourly rate, `split_share_cents`).
   - `formatDollarsFromCents` for user-facing messages, and `MAX_MONEY_AMOUNT`, the ceiling every money validator shares.
   - `percentOfCents(cents, ratePercent)`, `hoursTimesRateCents(hundredthsOfHour, rateCents)`, `hoursToHundredths` and `hourlyAmountCents(hours, rateDollars)`: the rounded products (see "Rounding policy" below).
   - There is no `splitCents` helper (the old largest-remainder one was removed; no imports remain).
2. **Service / repository edges** import from `money.ts` rather than re-declaring. `invoices.repository.ts` pulls `toNum`/`toCents`/`fromCents`/`toCentsOrNull`/`fromCentsOrNull` and aliases them locally (`centsOf`/`centsOrNull`/`dollars`/`dollarsOrNull`). `timeEntries.repository.ts` imports the null-preserving pair (because `rate_cents` is nullable there). `firmBilling.service.ts`, `invoiceDerive.ts`, `invoiceStatus.ts`, `plans/plans.service.ts`, and `billingAnalytics.service.ts` all import from `money.ts`. `shared/billingReads.ts` imports `toNum` as `num`, `fromCentsOrNull` as `centsToDollars` and `toCentsOrNull` as `dollarsToCents`, so there is no hand-rolled cents conversion left in that file.

`shared/billingCalendar.ts` deliberately keeps its OWN `toNumber` (`billingCalendar.ts`, guards with `Number.isFinite`), documented as an intentional divergence in `money.ts`.

So a `totalAmount` of `123.45` is stored as `12345` and read back as `123.45`, and a chain of additions never accumulates float dust because the addends are integer cents.

### Data Flow — Time Entry (create)

1. `POST /billing/...time-entries` → `createTimeEntry` (`timeEntries.service.ts`).
2. `resolveContext(...)` + `authorizeContext(...)` resolve and authorize the matter-or-client context.
3. `assertTargetUserAllowed` — if `userId !== 'FIRM'`, the target user must be a matter member (matter context) or firm member (client context).
4. `parseDateOrThrow(date, timeZone)` (a day-only string keeps its day; a timestamp is projected into the caller's zone with `zonedDayString`, so an entry sent as `2026-03-10T23:30:00-05:00` from Chicago is dated the 10th); `resolveSourceMetadata` optionally links a source task or matter event (mutually exclusive); `resolvePreferredMatterClients` validates `matterClientIds`.
5. `timeEntriesRepo.create(...)` inserts an `activities` row with `kind = 'time'`. **`hourlyRate` (dollars) → `rate_cents` via `toCentsOrNull`.** `hours` is stored as `numeric`, first passed through `roundHoursUp(hours, firmBillingSettings.timeRounding)` (`timeEntries.service.ts`), which rounds UP to the firm's billing increment when time rounding is enabled (a no-op otherwise). `updateTimeEntry` applies the same rounding to an edited `hours`. The rate is stamped at write time by `billingReads.resolveEntryRate` (`timeEntries.service.ts`), resolved from the same validated `matterClientIds` payer list the row is written with. **`amount_cents` is NOT written by the app, it is a generated column**; since migration `0233` it generates from the rate the entry was resolved at, so it is meaningful for every rated row rather than only for one carrying an explicit override.
6. `eventBus.emit(TIME_ENTRY_CHANGED, ...)` fires; the plans listener refreshes the open retainer periods of that context.

A time entry becomes "billed" not by a column flip but by **id-membership**: line-item ids on the context's invoices are collected into a set, and a row is marked billed when its `id` is in the set (`billingReads.collectBilledIds`/`isBilled`).

### Data Flow — Invoice (create, matter context)

1. `POST /billing/invoices` → `createInvoiceSchema` validation → `invoicesService.createInvoice` (`invoices.service.ts`).
2. `resolveInvoiceContext(...)` + `authorizeContext`.
3. Resolve a display name: `invoiceName || billingPlanName || invoiceNumber || "Invoice <timestamp>"`.
4. **Pre-read uniqueness check**: `findByInvoiceName`; name collision → 400. The partial unique index `invoices_name_unique_idx` (`70_billing.sql`) is the race backstop, caught as Postgres `23505` → 400 (`invoices.service.ts`).
5. `resolveInvoiceClientSnapshot`: for a matter invoice, `matterClientId` is the `clients` uuid via the `matter_clients` junction; snapshots `clientName`/`clientEmail`/`billingEmail`. A supplied `clientId` on a matter invoice must be one of the matter's clients (`billingReads.isClientOnMatter`, the same check plan default clients use), else a 400 "The client must be a client on this matter." before anything is written; split invoices apply the same rule per share, and client-context invoices have no matter to check.
6. **Server-side total recompute (never trusted from the client):** `computedTotalAmount = fromCents(toCents(sumLineAmounts(timeEntries)) + toCents(sumLineAmounts(flatFees)) + toCents(sumLineAmounts(expenses)))` in integer cents. The supplied `totalAmount` is asserted with `approxEqual` **only when the caller explicitly sent a non-zero value** (`invoices.service.ts`); the server-recomputed values are persisted regardless. Before that, the context's existing invoices are loaded and any time entry, flat fee or expense already billed on one of them is refused (`collectBilledIds`).
7. **Tax (optional):** the effective rate is the caller's `taxRate` if sent, else the firm's `tax.defaultRate` when tax is enabled (`invoices.service.ts`). `taxCents = percentOfCents(subtotalCents, rate)` (half up) is folded into the stored `totalAmount`, and `taxRate`/`taxCents` are persisted alongside.
8. `invoicesRepo.create(context, docData)` runs in a transaction (`invoices.repository.ts`, body in `_createTx`): one `INSERT` into `invoices`, `writeChildren` bulk-inserts the child tables, the full graph is reassembled once, then `deriveInvoiceStatus` is computed from that in-hand invoice and, if it differs from the table default `'draft'`, only the `status` column is patched in the same txn.
9. `emitInvoiceCalendarEvent(INVOICE_CREATED, ...)` emitted with `emitAsync` so Google/Outlook listeners finish before returning.

**Recording a payment** (`recordPayment`, `invoices.service.ts`) is the most intricate flow:
1. Validate body; at least one of `isPaid` / positive `paymentAmount` / `nextPaymentDate` required.
2. `runInvoiceTxn` (`invoices.repository.ts`) locks the row and loads the full invoice under the lock.
3. **Over-payment guard**: `paymentAmount > remainingBalance + 0.01` → 400, computed against the locked state *before* any trust withdrawal (`invoices.service.ts`).
4. If `paymentSource === 'trust'`: resolve client id/name **from the stored invoice, not the request**, then `createTrustWithdrawalForInvoice` with `amountCents: toCents(paymentAmount)` on the same transaction, so the withdrawal rolls back with the invoice write. `trustAccountId` must be a uuid.
5. Append a `payments[]` entry, recompute `amountPaid` in cents, set `isPaid` when `amountPaid >= effectiveTotal` (effectiveTotal = total − writtenOff, in cents), set `paidDate`/`nextPaymentDate`.
6. If a payment plan is active, allocate the payment across installments in integer cents (`allocatePaymentAcrossOpenRows`, `shared/paymentPlanSchedule.ts`). An unnamed payment starts at the earliest open instalment by date. A payment naming an instalment (`installmentIndex`) settles it first, then the excess runs to the open rows after it and wraps to the open rows before it, so the open rows always add up to the balance. Naming an instalment that is already paid, or one past the end of the schedule, is a 400. A payment short of the named instalment follows the shortfall action (`write_off` → credit note, `add_to_next` → the next open row, or a new row when none is left and the plan has room, `add_to_current` → the instalment stays open for the remainder). With no shortfall action the default is `add_to_current`, so the open rows still add up to the balance. A request that only sends `nextPaymentDate` on a plan invoice is refused, because the plan owns that date.
7. `_applyUpdateLocked` persists (replace-all on child tables), recomputes+persists `status`, commits, then emits `INVOICE_UPDATED`.
8. A payment that lowered the balance closes both Stripe payment surfaces priced at the old balance, the top-level hosted invoice and the checkout session (`closeStalePaymentSurfaces`, best effort, pointers cleared). A credit note and a payment edit that raises an amount do the same; removing a payment or a credit note raises the balance and leaves them closed.

### Data Model — the invoice family

The invoice is a relational aggregate. The repository (`invoices.repository.ts`) maps the camelCase "doc" the service uses to/from these tables.

| Table (`backend/db/schema/70_billing.sql`) | Holds | Notes |
|---|---|---|
| `invoices` | scalar invoice fields | money in `*_cents bigint`; `balance_due_cents` generated (subtracts write-offs); `status` app-managed + self-healed, CHECK `draft\|outstanding\|overdue\|partially_paid\|paid\|credited\|voided`; XOR check on matter vs `client_context_id`; optional `tax_rate` + `tax_cents` (tax already folded into `total_cents`); split columns `split_group_id`/`split_mode`/`split_share_cents`/`split_share_percent`; bill-to snapshot `billing_*` columns frozen at first external issue |
| `invoice_line_items` | time-entry / flat-fee / expense lines | `kind in ('time_entry','flat_fee','expense')`; `source_id` is text; `amount_cents`, `rate_cents`, `quantity` (hours), split `allocation_percent`/`allocation_amount_cents`, LEDES `utbms_task_code`/`utbms_activity_code`; ordered by `sort_order` |
| `invoice_payments` | recorded payments | **ordered by `sort_order`**: `matched_payment_index` on installments is this array position; each row's `id` is the payment's stable id in the API payload (written back on every rewrite of the list); carries `trust_*` + `stripe_*` linkage, the cumulative `stripe_refunded_cents` with the `stripe_disputed_cents` share of it that a dispute took, and a `charge_model` only ever written as `'destination'`; indexed by `(law_firm_id, trust_transaction_id)` |
| `invoice_expected_payments` | payment-plan installment schedule | `installment_id` text, `due_date` date, `status` (`pending\|paid\|unpaid`; `overdue` is derived at read time and never stored), `matched_payment_index` int, `is_down_payment`, per-installment `stripe_invoice_id`/`stripe_payment_status` |
| `invoice_adjustments` | both sides of an adjustment | ONE table, keyed by `direction`: `credit` holds the former `invoice_credit_notes` (write-offs, discounts), whose sum feeds `total_written_off_cents`; `charge` holds the former `invoice_amount_adjustments` (`addAmountToInvoice`, and the late-fee audit log). `kind` tags the row within its direction: `write_off` / `discount` / `adjustment` on the credit side, `late_fee` on the charge side, which is what makes a late fee one-time. A CHECK pins which kinds each direction may carry. Both API arrays (`creditNotes`, `amountAdjustmentNotes`) survive unchanged; the repository partitions them on `direction` |

**How they relate at read time** (`assembleInvoice` / `loadChildren`, `invoices.repository.ts`): all four child tables are batch-loaded with `WHERE invoice_id = ANY($1)` (one query each, regardless of invoice count) and bucketed by invoice id. `timeEntries`/`flatFees`/`expenses` are the line items partitioned by `kind`. `payments` are ordered by `sort_order`. `paymentPlan.expectedPayments` is built from the expected-payments rows plus plan-header columns on the `invoices` row.

### Key Logic & Rules

**Rounding policy.** Every percentage or hours x rate product is rounded half up (away from zero for positives) to a whole cent, and is computed on integers, never on a float product: 3000 cents x 7.25% is exactly 217.5 and the float product is 217.49999999999997, which rounds the wrong way. `percentOfCents` (`shared/money.ts`) scales the rate to integer thousandths of a percent (up to three decimals) and divides with BigInt, so 7.25% of 3000 is 218 and 9.975% of 10000 is 998. `hoursTimesRateCents` takes hundredths of an hour (the precision `activities.hours` stores) times the rate in cents, divided by 100 and rounded half up, which equals Postgres' numeric rounding behind the generated `activities.amount_cents`: 0.3 h at $123.45 is 3704 cents everywhere (stored entry, unbilled summary, bulk create, retainer overage line, line edits, firm billing reads, the frontend generate-invoice pages). The frontend mirrors both in `frontend/src/lib/utils/currency.ts`, and `backend/tests/fixtures/moneyRoundingCases.json` is read by a backend and a frontend test so a preview and a save cannot differ by a cent. The same helper sizes tax, percentage late fees and the Stripe application fees (`computeApplicationFeeCents`, `computeDirectApplicationFeeCents`, `computeTrustAchFeeCents`: $15.00 at the direct 0.9% rate is 14 cents). Money inputs (line amounts, a time entry's `hourlyRate` override) must be whole cents: a third decimal is a 400, never a silent rounding. The frontend `parseMoneyInput` also refuses amounts above `MAX_MONEY_AMOUNT`, and its settlement helpers (`billingComp/utils.ts`) subtract in integer cents.

**Money math & rounding.** Done in integer cents. Hours/percentages use `roundCurrency`. Comparisons use `approxEqual` (within `$0.01`, `invoices.service.ts`); the split validator compares each source amount in exact cents, with allocations summed in cents. Over-payment is rejected with a `+0.01` tolerance. Marking an invoice paid never lowers `amount_paid` below what the payment rows hold, so an overpayment from a later line edit stays visible as a credit due back.

**Invoice total derivation.** `getInvoiceTotal` (`firmBilling.service.ts`) returns `totalAmount` if > 0, else `flatFeesAmount` if > 0, else 0. The integer-cent form `invoiceTotalCents` (`invoiceStatus.ts`) backs both the status derivation and `computeInvoiceDerived`. `createInvoice`, split, and bulk all recompute from line items and cross-check.

**Status.** `deriveInvoiceStatus` (`invoiceStatus.ts`) is pure (no DB, no side-effects), and in this order: `voided` if the stored status is `voided` (the only sticky value); when nothing remains, `paid` if `isPaid`, else `credited` if a write-off or credit note cleared it, else `paid`; `partially_paid` if `amountPaid > 0`; `overdue` if not settled and `(nextPaymentDate || dueDate)` is before today (day-granular, in the viewer's zone on reads and UTC on the writeback); else `outstanding`. `credited` is derived from the live amounts, never from the stored column. `isPaid` records that the firm collected the money, so a write-off that clears the balance leaves it unset and the invoice reads `credited` (a mix of 10 collected and 990 written off is `credited` too); a payment that settles the remainder in cash sets it and reads `paid`. A zero-total invoice reads `outstanding` until it is marked paid, then `paid`, and is never overdue or awaiting payment. The repo persists this after every write (`invoices.repository.ts`); the read serializers re-derive it via `computeInvoiceDerived` (`invoiceDerive.ts`). Because both call the same `invoiceStatus.ts` function, the persisted column and the read value agree, except that a due date passing without a write leaves `outstanding` in the column; the only raw-SQL readers of the column test only `voided`, which time never reaches (`invoices.repository.ts`). The separate `isPastDue` (`invoiceStatus.ts`) is the overdue predicate the workbench and analytics use, so a partially-paid late invoice still counts as overdue; it is `false` for a voided invoice.

**Payment plans / installments.** `setPaymentPlan` (`invoices.service.ts`) requires remaining > 0, optionally takes a down payment (which must be less than the remaining balance), and builds a schedule via `rebuildSchedule`, which fills installments of `installmentAmount` in integer cents until `remaining` is covered (installments sum EXACTLY to remaining). Installments carry `matchedPaymentIndex` into `payments[]`; on payment delete, `reindexMatchedPaymentIndices` re-points survivors. `frequencyDays` is 1 to 365 and `planStartDate` falls between `PLAN_EARLIEST_DAY` and `PLAN_MAX_YEARS_AHEAD` years ahead (`plans/plans.validation.ts`), so an absurd value is a 400. A plan is held to the balance on every edit:

- **Dates are anchored on the start day.** A monthly plan (`frequencyDays` 30) dates row `i` as the start day plus `i` months, clamped to the month end (`scheduleDay`, `shared/paymentPlanSchedule.ts`), so a plan starting 31 Jan runs 31 Jan, 28 Feb, 31 Mar, 30 Apr, the same schedule the plan form previews (`buildPaymentPlanSchedule`); with a down payment the regular rows start one period after the start day and stay on the same series. Any other cadence is a plain multiple of days. Rows a refit, a carried shortfall, an added amount or a lowered last instalment appends continue that series when the last date sits on it, and step on from the last date when edits have moved it off. `backend/tests/fixtures/paymentPlanSchedules.json` holds the shared cases, so the server and the preview cannot drift apart.
- **The schedule is stored in date order**, the down payment first (`syncDueDateToLastInstallment` sorts on every write), and the next payment day of an invoice is its earliest open instalment by date whatever order rows are stored in (`invoiceNextPaymentDay`, `shared/firmBillingWindow.ts`).

- A balance-changing path (a line-item edit, a credit note added or removed, a payment edited or deleted) re-fits the schedule with `rebalancePendingInstallments`: paid installments carry over verbatim, only the pending tail is refilled in instalments of the plan's own amount, the tail's existing due dates are reused, and an open down payment keeps its own amount. An open row keeps its id and pre-due reminder stamp at its position in the tail, so a refit that leaves a row's date alone leaves its reminder history alone. When the refill would pass the instalment limit the whole remainder lands on the last open row. A credit note that settles the invoice keeps the paid rows and drops the open ones, exactly as a line-item edit does.
- Editing ONE installment (`updateInstallment`) keeps exactly what the firm typed and absorbs the difference into the unpaid installments after it, back to front (`absorbInstallmentDelta`). A shortfall with nothing after it adds one installment (refused once the plan holds 120); an overage with nothing to absorb it is refused. Rescheduling onto a date that already has an unpaid installment merges the two, and the reconciliation targets the row the edit ended up on. Paid installments are never rewritten (`isFixedInstallment`).
- Replacing the schedule wholesale (`replacePaymentPlanSchedule`) keeps those same locked installments and refuses a schedule whose unpaid installments do not add up to exactly the balance still owed.
- A plan holds at most **120 instalments**, a down payment included (`MAX_PLAN_INSTALLMENTS` in `shared/money.ts`). `setPaymentPlan` refuses a plan that would need more through `assertPlanWithinInstallmentCap`, which counts rows in integer cents before building any, `replacePaymentPlanSchedule` refuses a schedule whose locked and replacement rows exceed it, and request validation applies the same cap. Every path that can add a row checks `assertRoomForAnotherInstallment`: a shortfall carried off the end, a lowered last instalment and a late fee are refused on a full plan, and an amount added to a full plan folds into the last open instalment.
- Removing a payment reopens every instalment it settled. `deletePayment` and `unpayInstallment` reopen all the rows linked to the payment (`reopenInstallmentsSettledBy`), re-point the later payments, and refit the open tail to the new balance, so deleting a payment restores the schedule to what it was before the payment existed, including a cascaded multi-row payment, a plan marked paid outright (its top-up payment is linked to the rows it settles) and a paid down payment. Un-paying a row settled short with `add_to_next` restores that row and the next to the plan's own amounts.
- Editing a payment's amount refits the schedule to the balance without that payment and applies the payment again at its new amount, starting where it started, so a settled instalment never reads as paid for an amount that no longer exists. An edit that settles the invoice keeps the paid rows (`editPayment`).
- **Payment links follow row identity.** An installment payment link names its row by the stable `installment_id` (`invoices.pay_link_installment_id`), so a link paid after a schedule edit settles that row whatever its position; when the row is paid already or gone, the payment is spread across the open rows from the earliest (`applyStripeCandidate`). Plan edits never close a link: a link whose row changes amount asks for the new amount, and one whose row is paid or dropped stops being payable (`payLinkRequest`, see `stripe-payments.md`).

A late fee is deliberately kept out of the schedule.

**Permissions & tenancy.** Every route runs `verifyToken` then `requirePermission(...)`. Every service call runs `authorizeContext` / `assertLawFirmMembership`. Every repository query is scoped by `law_firm_id` (+ `matter_id`/`client_context_id`). The backend connects as `postgres` and bypasses RLS; tenant isolation is the application's responsibility.

**Concurrency.** Every payment-state mutator goes through `runInvoiceTxn` (`SELECT … FOR UPDATE`, then reads the full invoice UNDER the lock in a second statement so joined tables are not read at the pre-lock snapshot, then computes+writes in the same txn, `invoices.repository.ts`), including the lighter mutators (`removePaymentPlan`, `updateInstallment`, `setReminderOptOut`, `setPreDueReminder`, `deleteCreditNote`) and `voidInvoice`. The plain `update()` path is still used for non-payment writes (e.g. `updateInvoiceDetails`, calendar-sync date writebacks, Stripe reconciliation) and also takes a row `FOR UPDATE` lock. Invoice-number allocation is a single atomic `UPDATE … RETURNING` on `firm_counters`.

### Invariants the billing code holds

- **One total, one status.** Every serializer and the status writeback fold onto `invoiceStatus.invoiceTotalCents`, `isPastDue` and `deriveInvoiceStatus`. `firmBilling.isInvoicePastDue` delegates to `invoiceStatus.isPastDue`, and the persisted status is patched on the status-persist write path without a second reassemble.
- **Firm A/R covers every invoice.** `getBillingSummary` derives billed, collected, outstanding and overdue from `firmInvoiceMoneyRecords` (`firmBilling.service.ts`), a money-only record for EVERY invoice in the firm built from the `law_firm_id`-scoped `invoicesByContext` with no membership filter. Per-invoice math is unchanged.
- **Overdue is derived from live amounts.** The `invoices_firm_due_idx` partial index is not used and the only raw SQL that filters the `status` column tests only `voided`, which the passage of time never changes (`invoices.repository.ts`). A SQL-level overdue filter must compute from `due_date`/`balance_due_cents`, not from `status`.
- **Counts and totals agree across surfaces.** An invoice that owes nothing (a zero total, or fully written off) is never overdue and is under no unpaid chip: `invoiceStatusKey` keeps it `outstanding` but `countInvoiceStatuses` and the `status` filter share `matchesStatus`, so each status chip counts exactly the rows its filter returns, and the unpaid, outstanding, overdue and part-paid chips sum to the `status=unpaid` filter. (The deliberate exception stands: a late part-paid invoice counts under both `partially_paid` and `overdue`.) The workbench's `dueSoonCount` requires a positive remaining balance. Each list row's `status` and instalment statuses are derived on the viewer's calendar day (`computeInvoiceDerived(invoice, now, timeZone)`), the same day the chips and filters use. The client summary header (`sumClientInvoices`, `clients/clientSummary.repository.ts`) counts the invoices the client's Billing tab lists, widened to linked companies with billing access, and its outstanding is the sum of each owned invoice's balance net of write-offs and floored at zero per invoice, excluding voided invoices, so header, tab and by-client report agree. The portal summary sums in integer cents and converts once. Non-billable time counts as unbilled work nowhere: `uninvoicedTimeEntryCount` (workbench) and `unbilledTimeEntryCount` (billing summary) skip it like unbilled hours and the dashboard do.
- **Concurrent requests cannot double-bill one source.** Normal creates, split creates and invoice edits take the same transaction advisory lock for the firm and billing context, then recheck source ownership inside the write transaction. A source already billed elsewhere is rejected; shares within the same split group are valid. The service preflight check is only an early failure path.
- **Billed sources are protected.** `createInvoice`, the split path and the bulk path reject a time entry, flat fee or expense already billed on another invoice (`collectBilledIds`). The three source-delete paths reject removing a row billed on an invoice through `billingReads.isSourceBilled(context, kind, [id, legacyId])`, which looks at invoice line items whose `source_id` points back at the row and ignores voided invoices, rather than at the source tables' own `billed`/`is_billed` columns. Edits stay allowed because the invoice keeps its own line-item snapshot. Every source an invoice line names must also be a billable row of the firm that sits in the invoice's own context (a matter invoice bills that matter's rows, a client-context invoice that client's): `assertSourcesBelongToContext` (`invoices.repository.ts`) refuses with a 400 a row in another context or firm and non-billable work of any kind (time, flat fee or expense). An id that names no activity of the firm (unknown, malformed or another firm's) is refused with a 400 "One or more selected items do not exist" on create, split, bulk and line edit; the bulk run checks its picked ids before writing any invoice. **Manual lines versus activity-linked lines.** A line that carries a source id is activity-linked: the id names a real activity, which the line freezes (`activity_billed_immutable`) and takes off the unbilled lists. A line with no source id (`id` omitted or null) is a manual line: it is billed as typed (amount, description), is stored with `source_id` null, is never frozen or released by the activity triggers because nothing points at it, comes back in the payload without an `id` under the same kind it was stored as, and never makes an activity read as billed. The composers send no `id` for a time entry or flat fee typed into the page (`lib/billing/lineSource.ts`); the split request treats a share line with no `id` as manual. The one source id that is not an activity is a recurring plan's retainer fee, `plan-<planId>-<periodStartDate>`, which must name a `billing_plan_periods` row of the firm. Migration `0030_clear_orphan_line_sources.sql` turned every earlier phantom link into a manual line.
- **Expenses bill onto invoices.** `createInvoice` accepts `expenses`, folds them into the recomputed total and persists them as `kind='expense'` line items, which `collectBilledIds` reads. Every serializer (`formatInvoice`, portal), the firm and client invoice detail views and the PDF render an Expenses section. Split and bulk invoicing carry time entries and flat fees only.
- **Flat fees keep their date.** `flat_fees` stores `fee_date` and `created_by`; the day is day-only with no timezone shift and is returned on read.
- **A write-off settles without marking paid.** `addCreditNote` leaves `isPaid` as it was, so a write-off that clears the balance derives `credited`, and every surface that chases or lists money owed (reminders, late fees, the digest, the dashboard, the workbench, the portal, the calendar) skips it because its remaining balance is zero. `deleteCreditNote` reopens an invoice marked paid whenever `newRemainingCents > 0 && existing.isPaid` (`invoices.service.ts`), so it re-enters the overdue and reminder machinery.
- **A reopened invoice has no paid date.** Every write that makes a settled invoice owe money again (a line-item edit, `addAmountToInvoice`, `deleteCreditNote`, a late fee, a deleted or lowered payment) clears `paidDate` with `isPaid`.
- **Removing a trust payment is all or nothing.** `deletePayment`, `unpayInstallment` and the reset to unpaid reverse the payment's trust withdrawal inside the invoice transaction, before the invoice write. A reconciled withdrawal or a closed trust period refuses the removal with a 409 and writes nothing.
- **Plans stay on the balance.** `absorbInstallmentDelta` and the refusal in `replacePaymentPlanSchedule` hold every plan to the invoice balance (see "Payment plans / installments").
- **Batched unbilled summary keys by context.** `getUnbilledSummaryBatch` keys its result by `${context.type}:${context.entityId}` and `bulkCreateInvoices` reads it back the same way, so a matter id and a client id can never overwrite each other.
- **Every invoice has a void path.** `deleteInvoice` refuses an invoice the trust ledger points at or that carries a Stripe payment and directs the firm to `voidInvoice` (see "Voiding an invoice").

### `bulkCreateInvoices` batched unbilled summary (perf fix)

`bulkCreateInvoices` (`invoices.service.ts`) calls **`getUnbilledSummaryBatch`** (`invoices.service.ts`) once rather than the per-context `getUnbilledSummary` in a loop: the batch loads every input firm-wide a single time and computes each context's summary in memory. Per-line math (rate resolution, integer-cent line amounts, billed-id filtering) is identical to `getUnbilledSummary`, so a context bills to the same cents either way. Authorization is preserved per context inside the batch; an unauthorized or empty context is omitted and surfaces as "skipped". The result `Map` is keyed by the composite `${context.type}:${context.entityId}` and read back the same way, so a matter id and a client id can never collide. A matter with a configured split produces one invoice per payer here too (see "Split invoices" below), each share taking its own number from the counter.

### Voiding an invoice

`POST .../:invoiceId/void` (`invoices.routes.ts`, `billing.manageInvoices`) calls `voidInvoice` (`invoices.service.ts`), which runs under the row lock and:

1. refuses an invoice already `voided` (409);
2. refuses an invoice with any recorded payment or a non-zero `amountPaid` (409). The order is remove the payment first (which voids a linked trust withdrawal with it), then void, so the firm never holds client money against a bill that no longer exists;
3. closes the invoice's open checkout session through `closeInvoicePaymentSurfaces`, first on an unlocked read so a refused void has no side effect at Stripe, then again under the row lock for a link minted in between, and refuses with a 409 if Stripe already collected the money;
4. writes `status: 'voided'`, clears the payment link (its token and installment target) and the checkout session pointer, marks an open request `voided`, and emits the calendar update so synced payment-date events are deleted.

Voiding releases the invoice's billed work: `billingReads.isSourceBilled` and the billed-id reads ignore voided invoices, so its time entries, flat fees and expenses become unbilled and can go on another invoice, and the database's billed-row guard on `activities` skips them too. A voided invoice contributes nothing to the billing summary's billed, collected and outstanding totals, the workbench's collected total, the dashboard's collected-this-month figure (a Stripe payment that lands on it after the void is owed back to the payer, so it is not revenue) or to the Reports tab's `billed_cents` and `outstanding_cents`, though it still counts in the invoice count. `lateFeeEligibility` refuses it (`reason: 'voided'`), so the manual late-fee route and the sweep both skip it. Every payment, credit-note, adjustment, plan, line-item and reminder mutator calls `assertInvoiceNotVoided`, and so does the trust service when an entry is linked to an invoice.

A Stripe payment that lands on a voided invoice, or one that pushes an invoice past its total, stays recorded on that invoice, because a Stripe refund finds the payment through its record. Every invoice payload (`formatInvoice` and the firm list's `mapInvoiceRecord`, both fed by `computeInvoiceDerived` / `deriveRefundDue` in `invoiceDerive.ts`) carries `refundDue: { amount, reason } | null`, with `amount` in dollars derived from integer cents. For a voided invoice `amount` is everything paid on it and `reason` is `'voided'` (voiding is refused while payments exist, so any payment there arrived after the void); for any other invoice it is the amount paid beyond the total and `reason` is `'overpaid'`; otherwise it is `null`. When a Stripe payment leaves a `refundDue`, the listener in `billing.events.ts` creates one `payment_refund_due` in-app notification ("Refund due") for the firm owner and every `billing.manageInvoices` holder, keyed on the invoice and the Stripe payment so a redelivered webhook never adds a second. It links to the invoice and names the amount and the reason ("received after the invoice was voided" or "exceeds the invoice total"). The client does not get the standard receipt for a payment on a voided invoice: `sendPaymentOnVoidedInvoiceEmail` sends a neutral "We received your payment" notice instead (the payment, the invoice number, and that the firm will contact them about the funds, with no "paid in full" wording and no pay link), gated by the same `clientPaymentEmails` setting. An overpayment keeps the standard receipt. The firm holds the money until it refunds it in Stripe; there is no client credit ledger.

`voided` is terminal: `deriveInvoiceStatus` returns it unchanged, so the status writeback cannot overwrite it on a later edit (`invoiceStatus.ts`); `isPastDue` is `false`, which takes it out of the workbench's overdue bucket and the analytics overdue count; and `findUnpaidByDue` excludes it (`invoices.repository.ts`), which takes it out of both reminder sweeps and the auto late-fee sweep. Void is the path `deleteInvoice` (`invoices.service.ts`) points to when it refuses a delete: an invoice with a Stripe payment is refused because a later refund or dispute would find nothing to reverse, and one referenced by a trust ledger entry is refused because the FK's `SET NULL` would be an UPDATE the append-only trigger rejects.

### Split invoices

A matter can carry several clients, each with a share of its bills in basis points (`matter_clients.billing_portion_bp`, 0 to 10000; the portions must sum to 10000, enforced in the matter-clients service, `backend/db/schema/30_matters.sql`). Two paths bill against it:

- `POST .../matter/:matterId/split` (`createSplitInvoices`, `invoices.service.ts`) takes explicit per-invoice allocations. Each source line's allocated amount is summed and compared in exact integer cents; hours and percentages retain the `approxEqual` tolerance.
- The bulk run reads the split from the matter rather than asking for it (`billingReads.isSplitConfigured`) and allocates each line across the payers with `allocateWorkToPayers` (`shared/splitAllocation.ts`), which keeps every line summing exactly to its source amount and assigns each line's odd cents by error diffusion: a running exact share is tracked per payer and the next odd cent goes to the payer furthest behind it (ties go to the later payer), so each payer's overall share of the bill stays within one cent of exact however many lines carry a remainder. Hours are split the same way, in hundredths.
- Every share is taxed like a single-payer invoice: the firm's default rate when tax is enabled, levied with `percentOfCents` on that share's own lines. Each share carries its own `tax_rate`/`tax_cents` and its `total_cents` includes them.

Each share is its own invoice row naming its payer in `matter_client_id`. `createSplitInvoices` also stamps one shared `split_group_id` (`invoices.service.ts`) and the `split_mode` on every share.

### Adjustments (credits and charges)

Everything applied to an invoice after its lines were set lives in `invoice_adjustments` (`70_billing.sql`), rewritten whole on every save like the other children. The repository partitions it into two API arrays on `direction`:

| Direction | API array | Written by | Effect |
|---|---|---|---|
| `credit` (`kind` `write_off` / `discount` / `adjustment`) | `creditNotes` | `addCreditNote` (`invoices.service.ts`), removed by `deleteCreditNote` | summed into `total_written_off_cents`, which reduces the balance |
| `charge` (`kind` null or `late_fee`) | `amountAdjustmentNotes` | `addAmountToInvoice` and the late fee (`buildLateFeeUpdate`) | raises `total_cents`; add-amount also appends an installment when a plan is active, and a late fee goes onto the next open installment |

`formatInvoice` returns both arrays (`amountAdjustmentNotes` at `invoices.service.ts`). The detail API returns the charge side so a late fee that grows the total has a row explaining it. The firm's invoice detail renders the charge side as an **Adjustments** section with a total, since those amounts raise the total without a line-item row (`frontend/src/components/billingComp/InvoiceDetailView.tsx:2657-2702`); `InvoiceDetailPanel.tsx:193-197` shows the credit notes under the same heading.

### Recurring retainers (billing plans)

`plans/` owns recurring retainers: `billing_plans` (`70_billing.sql`, `plan_type` only `retainer`, status `active|paused|ended`, a weekly or monthly interval, an optional `included_hours` allowance) and their generated `billing_plan_periods` (status `ready_to_bill|draft_created|skipped`, unique per plan and start date). Routes are `GET/POST /billing/plans`, `PUT /:planId`, and `POST /:planId/periods/:periodId/create-draft` (`plans/plans.routes.ts`). `ensurePlanPeriods` (`plans.service.ts`) materializes the periods due; `computePeriodUsage` counts the period's time against the allowance. A time entry's coverage is `activities.billing_plan_period_id` + `coverage` (`covered` or `overage`), so an activity belongs to at most one period. `createDraftFromPeriod` drafts the invoice (flagged `is_recurring_retainer`, with a `plan-` flat fee that `computeInvoiceDerived` recognises) and refuses a matter plan that names no payer (`defaultClientId`).

**Period usage follows the time log.** Every read of a plan (`ensurePlanPeriods`) recomputes the usage of each period behind the run date that has no invoice, bounded by the capped period read, and writes only the periods whose consumed hours or coverage changed; a period with an invoice is that invoice's record and is never rewritten (the upsert's `generated_invoice_id is null` guard enforces it). A `TIME_ENTRY_CHANGED` listener (`plans.events.ts`, `refreshContextPlans`) runs the same refresh for the changed entry's context, so coverage is current before the next read. Usage is computed over entries ordered by date, then creation time, then id (`billingReads.listTimeEntries`), so entries that share a date are covered in a stable order, and over the unbilled set only: work on a voided invoice counts again (`collectBilledIds` skips voided invoices). The invoice composer (`getUnbilledSummary` and its batch twin) leaves out entries a period covers (`activities.coverage = 'covered'`), so the hours a retainer already pays for cannot be billed a second time; entries wholly in overage stay available. Voiding a retainer invoice releases its period (`plansRepo.releasePeriodsOfInvoice`: status back to `ready_to_bill`, invoice link cleared), and drafting that period again numbers the new invoice's name and number (`... (2)`, `...-2`) because the voided invoice keeps its own.

### Time-Entry Source Links & the `billable` Flag

`activities` carries three columns: `source_task_id`, `source_event_id`, and `billable`.

**The source links are stored.** `sourceTaskId` and `sourceEventId` are validated and written to `activities`. The unbilled-work panel needs them to tell which completed tasks are already captured, and time rolls up per task and per event through them.

Four schema decisions are worth knowing:

- **Single-column FKs, not the composite `(law_firm_id, id)` form** used elsewhere. `on delete set null` would have to null `law_firm_id` too, and that column is `NOT NULL`. Firm scoping is instead enforced in the service, which resolves the task or event through a firm-scoped repository read before accepting the link.
- **`set null`, never `cascade`.** Deleting a task must not delete billable time recorded against it — that time may already sit on an issued invoice.
- **A CHECK enforces one source.** The single-source check requires `source_task_id is null or source_event_id is null`: an entry describes one piece of work, a task or an event, never both.
- **Two partial indexes** (one per source column, each `where … is not null`) back the dedup question "does any time entry already point at this task?" per firm.

`resolveSourceMetadata` (`timeEntries/timeEntries.service.ts`) is the gate. It rejects both ids at once, refuses a task or event that no longer exists, and, the important part, **checks the source against the billing context**: a matter-context entry must link a task on that matter, a client-context entry a task belonging to that client. An unscoped task (no matter, no clients) is allowed anywhere. Events are matter-only.

**`billable` is not `billed`.** They answer different questions and both exist:

| Column | Meaning |
|---|---|
| `billable` | may this time ever reach an invoice? `false` = pro bono, write-off, internal work |
| `billed` | has it already been placed on an invoice? |

`billable` is one column on `activities` and defaults to `true`. It lets a firm record time for utilization reporting that must never be charged, without deleting it or excluding it from hours totals. The task detail read aggregates both: it runs a `sum(hours) filter (where billable)` alongside the unfiltered total (`tasks.repository.ts`), so a task shows total time and billable time separately.

**Two write paths reach these columns**, so a change to one must be mirrored in the other: `create` sets all three inline (`timeEntries.repository.ts`), and `update` patches `source_task_id`, `source_event_id` and `billable` through the same `add(...)` builder.

### One `activities` table, and the rate an entry carries

Matter and client invoice composers use each time entry's persisted `resolvedRate` when `rateSource` is present, including client, charge-code and firm rates. Legacy entries use their manual or member rate. Single-entry Bill now actions share the context composer destination; batch actions retain the firm invoice run.

Time entries, expenses and flat fees are rows of one `activities` table since migration 0232,
told apart by `kind` (`time`, `expense`, `flat_fee`). The three route files and their services
are unchanged; each repository filters on its kind. Ids were preserved, so
`invoice_line_items.source_id` still names the row it was built from. `amount_cents` is generated:
hours times the resolved rate for time, the entered `charge_cents` for an expense or fee. A
`before update or delete` trigger (`activities_billed_immutable`) refuses to change the figures
an invoice was built from, or to delete the row, while a line item names it; the services keep
their `FROZEN_ONCE_BILLED` checks so the caller gets a sentence rather than a constraint error. The frozen time-entry columns are the hours, `rate_cents`, `resolved_rate_cents` (the stamped rate readers price the entry at), the date, the charge code, the client split, the billable flag and the matter. An edit or delete that loses a race to an invoice reaches the trigger, whose `restrict_violation` the central error handler answers as a 409 carrying the trigger's own message, not a 500.

Moving a client-context entry onto a matter (`PUT` with `matterId`, `resolveMoveToMatter`) needs the matter to list that client, the acting user to be on the matter, and the entry's own timekeeper to be on it too, the rule direct creation applies to whoever the time is logged for (400 "User is not a member of this matter"). Firm-level time with no timekeeper is exempt, as it is on direct creation.

A time entry STORES the rate it was resolved at when it was written (migration 0233):
`resolved_rate_cents` and `rate_source`, one of the eight sources `rateResolution.ts` walks or
`none`. `billingReads.resolveEntryRate` does that walk once, at write time, and again only when
the entry's own inputs change (its override, its charge code, or a move to another matter). Every
reader (`firmBilling.service`, `getUnbilledSummary`, the retainer overage in `plans.service`)
goes through `billingReads.storedOrLiveRate`: the stored rate when the row has one, live
resolution only for a row nothing has rated yet (a hand-written fixture, or a row the 0233
backfill did not reach). So raising a member's default rate does not revalue the unbilled work
they logged last month. `POST .../time-entries/matter/:matterId/rerate` (and the client form)
is the sanctioned way to make a rate change reach a context's unbilled entries; billed entries
are never touched. It restates other people's stored rates, so it needs
`billing.manageOthersTimeEntries` whenever any unbilled entry in the context belongs to someone
other than the caller (or is firm-level time); the whole request is refused with a 403 and nothing
changes. A caller whose unbilled entries are all their own may re-rate with `billing.manageTimeEntries`
alone. No screen calls it yet.

Rate tiers 3 and 4 read a client's negotiated rates, and a matter can carry several clients. The
entry's own `matter_client_ids` names the payer, and that is the client whose rates apply
(`billingReads.billingRatesForEntry`); an entry naming nobody, or a client no longer on the
matter, still falls back to the matter's first client by name. Changing the pick is safe because
0233 stamps the rate at write time and backfilled every row that already existed, so it settles
a price once rather than repricing work.

A retainer period's coverage is `billing_plan_period_id` + `coverage` on the activity row, not a
junction; an activity belongs to at most one period.

### Per-firm billing settings, tax, late fees, and time rounding

Small firm-wide billing config lives in `law_firms.settings -> 'billing'` (a jsonb blob, not a table). `shared/billingSettings.ts` owns the shape: `getFirmBillingSettings` (`billingSettings.ts`) merges stored overrides onto `BILLING_SETTINGS_DEFAULTS`: `clientPaymentEmails`, `timeRounding { enabled, incrementMinutes }`, `lateFee { enabled, flatAmount, percent, graceDays, autoApply }`, `tax { enabled, defaultRate, label }`. It is written from two places into the same sub-object: the firm-settings module (`updateFirmSettings`, validated in `settings.validation.ts` / defaulted in `settings.defaults.ts`) persists `timeRounding`/`lateFee`/`tax`, and billing's own `PUT /billing/settings` → `firmBilling.updateBillingSettings` writes only `clientPaymentEmails`. The frontend surface is `BillingSettingsView.tsx` (the **Settings** sub-tab of the billing hub's "Rates & setup"): firm default rate, time rounding, late fees, tax, event-type charge-code defaults, Stripe, UTBMS, client payment emails.

- **Time rounding.** `roundHoursUp` (`timeRounding.ts`) rounds hours UP to the next `incrementMinutes/60` (with a small epsilon so a value already on a boundary isn't bumped), then UP again to the hundredth of an hour so the returned value is the one `numeric(6,2)` stores, applied in `createTimeEntry`/`updateTimeEntry`. Disabled by default.
- **Tax.** Levied at invoice creation (`createInvoice`, and per share in `createSplitInvoices`) and re-levied on a line edit, never trusted from the client. See the invoice-create flow above; `formatInvoice` returns `taxRate`/`taxAmount`/`subtotalAmount` for the detail view and the invoice PDF.
- **Late fees.** A one-time overdue charge (flat + percent, which stack), NOT interest. `computeLateFeeCents` (`invoices.service.ts`) sizes it against the remaining balance in cents; `lateFeeEligibility` gates on outstanding balance, past-due-beyond-grace (both days taken in the same zone), and "not already applied" (any existing `kind: 'late_fee'` adjustment). `applyLateFeeCore` runs the whole check→apply under the invoice row lock so it is idempotent. `applyLateFee` is the manual per-invoice path (`POST .../:invoiceId/late-fee`, `invoices.routes.ts`), counted in the caller's zone; `applyAutoLateFees` (`lateFees.service.ts`), driven from the daily reminder cron, sweeps `findUnpaidByDue(..., 'overdue', firmToday)` for firms with `lateFee.autoApply` on, counting on the firm's calendar (`firmZone`). Both share `applyLateFeeCore`, so a fee is never stacked twice. Off by default (`lateFee.enabled: false`, `autoApply: false` in `BILLING_SETTINGS_DEFAULTS`), and the settings page labels them "Off by default". `getFirmBillingSettings` merges each nested group key by key, so a partial save such as `lateFee: { enabled: true }` keeps the default amounts and grace days.

### Dependencies

- **Trust accounting**: `recordPayment` calls `../../trust/trust.service` (`createTrustWithdrawalForInvoice`, `voidTransactionInternal`) for trust-funded payments; the withdrawal is created, and reversed on removal, on the invoice's own transaction. The `invoice_payments(law_firm_id, trust_transaction_id)` index (`70_billing.sql`) supports trust↔invoice-payment reconciliation. A trust withdrawal that paid an invoice cannot be voided from the trust side; removing the payment here is the only way to reverse both halves. A trust entry cannot be linked to a voided invoice (`assertInvoiceNotVoided` in `trust.service.ts`), because the ledger is append-only and the link could never be removed.
- **Calendar (Google/Outlook)**: invoice create/update/delete emit `INVOICE_CREATED/UPDATED/DELETED` consumed by calendar sync. `getCalendarPaymentDates` (`invoices.service.ts`) computes installment ids **in memory only** (`ensureInvoicePaymentPlanIds`) and does **not** write on a GET.
- **Stripe**: columns persisted/round-tripped; the Stripe service (`docs/features/stripe-payments.md`) updates invoices out-of-band under the same `runInvoiceTxn` lock, after which the calendar sync is re-emitted.
- **Matters / Clients / Users** — read via `shared/billingReads.ts` (clients, matter clients, charge-code map, member/firm default rates, accessible matters, batched `findByIdsRaw`) and `usersRepo`/`mattersRepo`/`tasksRepo`/`matterEventsRepo` for time-entry sourcing.
- **Billing plans**: `firmBilling.service.ts` lazy-`require`s `plans/plans.service` for retainer coverage and ready-to-bill periods.
- **Analytics** (`billingAnalytics.service.ts`): `getBillingSummary` loads firm reads once via `loadFirmBillingShared`, derives its A/R totals from **`firmInvoiceMoneyRecords(shared.invoicesByContext)`** (every firm invoice, no membership filter, see the firm-wide A/R takeaway) and threads the `shared` payload into `listFirmTimeEntries` for hours, reducing every monetary aggregate in integer cents. It counts overdue via `firmBilling.isInvoicePastDue` (the same day-granular, integer-cent past-due predicate the workbench buckets use), not `inv.status === 'overdue'`, so a partially-paid-but-still-late invoice is included in the overdue count/amount instead of being dropped (a partially-paid invoice re-derives to status `partially_paid`, never `overdue`).

### Example

Create a $1,500 matter invoice from one time entry (6 hrs @ $250) and record a $500 partial payment:

```
POST /api/lawfirms/{firm}/billing/invoices
{ "matterId": "<matterUuid>", "invoiceName": "Invoice 001", "invoiceDate": "2026-06-01",
  "dueDate": "2026-07-01", "clientId": "<matterClientUuid>",
  "timeEntries": [{ "id": "<teUuid>", "name": "Drafting", "hours": 6, "rate": 250, "amount": 1500 }],
  "flatFees": [], "totalHours": 6, "totalAmount": 1500, "flatFeesAmount": 0 }
```

The server recomputes `sumLineAmounts([...]) = 1500.00`; since `totalAmount` is a non-zero supplied value it is asserted equal (`invoices.service.ts`). Stored: `invoices.total_cents = 150000`, one `invoice_line_items` row (`kind='time_entry'`, `amount_cents=150000`, `quantity=6`, `rate_cents=25000`). `status` is derived+persisted as `outstanding`; `balance_due_cents` (generated) = `150000`.

```
PUT /api/lawfirms/{firm}/billing/invoices/matter/{matterId}/{invoiceId}/payment
{ "paymentAmount": 500, "paidDate": "2026-06-15" }
```

Result: `amount_paid_cents = 50000`, one `invoice_payments` row, `is_paid=false`. Read-side `remainingBalance = 1000.00`, status derived+persisted as `partially_paid`. `balance_due_cents` (generated) = `100000`.

---

## What Can Be Improved

Items, ordered roughly by impact:

### Reminders and late fees run on the firm's calendar

Whether a bill is late is a calendar-day question, and the nightly passes have no request to
read `req.tz` from. They read the firm's day through `firmZone` (`shared/utils/personalDay.ts`):
`law_firms.settings.timezone` when it is set (an IANA name, validated by `firmSettingsSchema`),
else the zone saved on the firm's owner, else UTC. The overdue and pre-due reminder passes, the
auto late-fee sweep and the manual "send reminder" all count days there, and `findUnpaidByDue`
takes that day as its `today` instead of the database's `current_date`, so the candidate query
and the decision agree on what today is.

`findUnpaidByDue` selects every unpaid, non-voided invoice with a due date, whether or not it was
ever emailed or given a Stripe link: an invoice is delivered once it exists and shows in the client
portal, so "sent" does not mean emailed. It feeds the three unattended passes that contact or
charge a client (overdue reminders, pre-due reminders including plan installments, the auto
late-fee sweep), and the daily digest applies the same rule and dates each invoice by its next payment day (`coalesce(next_payment_date, due_date)`, the workbench's rule), so an overdue payment-plan instalment is listed even though the plan sets `due_date` to the last instalment. An invoice with no frozen bill-to
record resolves its reminder recipients live from the client. A voided invoice is excluded from
all four. `status` is never `'draft'` (create writes the derived status over the table default),
so the only status the predicates test is `'voided'`. The manual "send reminder" and manual late
fee are separate paths that a person chooses. The firm-wide manual run
(`POST .../invoices/send-reminders`) passes the caller to `sendOverdueReminders`, which keeps only the
invoices that caller could remind one at a time: matter invoices on matters they are a member of
(resolved for every matter in one `getAccessibleMatterIds` query) and every client-context invoice
of the firm. The scheduled pass passes no user and covers everything.

Every reminder path claims, sends, then releases. A short row-locked transaction
(`invoicesRepo.runReminderTxn`: the invoice row lock only, not the matter's billing lock)
re-checks eligibility and commits the stamp. The email is then sent with no transaction open,
and a second short transaction gives the stamp back only if the send was refused or threw and
the stamp is still the one this pass wrote. A crash between claim and send, or a failed
release, costs at most one reminder and can never send one twice, and a slow mail provider
cannot stall other invoice writes in the matter.

Each overdue threshold in `invoiceReminderDays` earns one reminder: `shouldSendReminder` sends
when the invoice has reached a threshold and nothing has gone out since the day it reached the
latest one, all in calendar days. The pre-due reminder still re-sends daily inside its window,
at most once per firm calendar day (`sentOnFirmDay`), so a pass that runs a few seconds earlier
than yesterday's still sends; whether it should send once is an open product question.

### An orphaned index and a stale schema comment

`invoices_name_prefix_idx` (`backend/db/schema/70_billing.sql`) exists only to serve
the next-number preview (`billingReads.nextInvoiceNumber`, which no longer exists); nothing else issues a left-anchored
`LIKE` on `invoice_name`. It costs a write on every invoice insert or rename for no reader.
Separately, the comment on `invoices.status` in `70_billing.sql` says nothing writes `'voided'`,
which is not true: `voidInvoice` writes it.

---

### 1. Bulk invoicing burns an invoice number when a draft fails

`bulkCreateInvoices` takes the next number from the atomic per-firm counter
(`invoices.service.ts`, and once per extra share of a split)
BEFORE it calls `createInvoice`. Each context is created inside its own
try/catch, and a failure records the entity in `errors` and moves on, so the
number the counter already issued is never written to a row. The firm's
`invoice_number` sequence then has a gap it cannot account for.

The split path is the part that matters: it writes the allocated value to
`invoiceNumber` as well as `invoiceName`, so this is a gap in the
legal record, not just in a display label. Some jurisdictions require a gapless
sequence. The fix is to allocate after the draft is known to be valid, or to
return an unused number to the counter when the create throws.

### 2. Billing routes with no UI

The backend serves per-invoice send-reminder, reminder opt-out and pre-due reminder
(`invoices.routes.ts`), but nothing in `frontend/src` calls them, so a firm cannot reach them.
Either build the controls on the invoice page or drop the routes. LEDES export does have a control
(the "Download LEDES" item in `InvoiceDetailView.tsx`).
