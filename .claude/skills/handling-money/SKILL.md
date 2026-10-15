---
name: handling-money
description: Writing or reviewing code that stores, sums, splits, allocates or displays an amount of money: invoices, time entries, expenses, flat fees, payments, Stripe amounts, or the trust ledger.
user-invocable: false
paths:
  - "backend/src/modules/billing/**"
  - "backend/src/modules/trust/**"
  - "backend/src/modules/stripe/**"
  - "backend/src/modules/subscriptions/**"
  - "frontend/src/components/billingComp/**"
  - "frontend/src/components/trustComp/**"
  - "frontend/src/services/*billing*"
  - "frontend/src/services/*trust*"
---

# Handling money

Legal billing must reconcile to the exact cent. An invoice total, a trust ledger balance and a
client statement are read by people who will notice a one-cent drift, and a trust shortfall is a
bar-complaint-grade defect rather than a bug.

## Integer cents, always

Every money column is a `bigint` named `*_cents`. Persist and compute in integer cents. Convert to
dollars only at the output boundary.

```ts
import { toCents, fromCents, toCentsOrNull, fromCentsOrNull, MAX_MONEY_AMOUNT }
  from '../billing/shared/money';   // backend/src/modules/billing/shared/money.ts
```

| Helper | Use |
|---|---|
| `toCents(dollars)` | Dollars in from a request, to whole cents |
| `fromCents(cents)` | Whole cents to dollars, at the response boundary only |
| `toCentsOrNull` / `fromCentsOrNull` | The same, preserving empty as `null` for a nullable column such as an optional hourly rate |
| `formatDollarsFromCents(cents)` | Display string |
| `percentOfCents(cents, ratePercent)` | Exact integer percentage product, rounded half up to cents |
| `hoursToHundredths` / `hoursTimesRateCents` / `hourlyAmountCents` | Price hours at the stored hundredth-hour precision, rounded half up to cents |
| `roundCurrency(value)` | Legacy two-decimal rounding. Do not reach for it in new code |

**Never store or send a float.** The old pattern was float dollars patched with
`Math.round(x * 100) / 100`. It drifts as soon as you sum enough entries or split an amount three
ways. Do sums, allocations and splits in integer cents, then convert once.

Some totals are `generated always as ... stored` in Postgres. Do not write to those columns; the
database computes them.

## The overflow guard is not optional

`MAX_MONEY_AMOUNT` is `1_000_000_000` dollars. Validate incoming amounts against it; hourly
rates use the tighter `MAX_HOURLY_RATE` of `1_000_000` dollars to leave room for hours times rate.
Zod's `z.number()` accepts values that reach Postgres outside the `bigint` range, and past `1e21`
JavaScript serializes in exponential notation that `bigint` cannot parse at all. That produces a
500 from the driver, not a validation error, so the user sees a crash instead of a message. This
is a technical range margin, not a product pricing decision.

A bigint-overflow bug in this class has already shipped and been fixed here. Assume the next one
is one unvalidated field away.

## The trust ledger is append-only

`trust_transactions` is enforced append-only by the `trust_txn_immutable` trigger
(`backend/db/schema/80_trust.sql`). Corrections are **reversing entries**, never edits. What the
trigger actually permits is narrower than "no updates", and the exceptions are the ones you will
meet:

- **Delete**: refused for any completed or void row. Only a non-terminal row could be deleted, and
  none exists today.
- **completed to completed**: the row is frozen except `cleared_at`,
  `cleared_in_reconciliation_id` and `updated_at`. One declared exception repoints `client_id`
  during a client-identity merge (migration `0183`).
- **completed to void**: allowed, and this is how a void is written. Only the void bookkeeping
  fields may change, so a void cannot smuggle an edit in alongside the status change.
- **void to anything**: refused. A void entry is terminal, so a reversed entry can never be
  resurrected into a balance.

- A reversal is a new row whose `reverses_transaction_id` points at the original.
- The account book balance must never go negative on a debit. The repository enforces this.
- Reversing a deposit whose funds were already disbursed would drive the client's balance
  negative. The code refuses and asks for a manual correction rather than doing it automatically.
  Preserve that refusal; it is the invariant, not an inconvenience.
- Voiding a withdrawal credits the client back, which is always safe. Voiding a deposit is not.
- `trust.repository.ts` carries the reasoning in comments at each guard. Read the comment before
  changing the guard.

Related tables: `trust_accounts`, `trust_reconciliations`, `trust_minimum_balances` (evergreen
retainer thresholds), `trust_interest_remittances` (IOLTA), `trust_deposit_fees`.

## Stripe

Stripe amounts are already integer cents, so no conversion is needed at that boundary. The
application fee depends on the charge model (`invoiceChargeScope` in `stripe.service.ts`). A
firm on a Standard account takes direct charges, fee `STRIPE_DIRECT_APPLICATION_FEE_RATE` and
`STRIPE_DIRECT_APPLICATION_FEE_FIXED_CENTS`; a legacy Express firm takes destination charges, fee
`STRIPE_APPLICATION_FEE_RATE` and `STRIPE_APPLICATION_FEE_FIXED_CENTS`. A trust deposit carries
no application fee at all: client trust money lands in full. `stripe_events` gives webhook idempotency; a handler that
does not go through it will double-apply on Stripe's retry.

## Testing a money change

Name the cent that has to be wrong for the test to go red. A test that asserts a total is a
number proves nothing.

- Assert exact cent values, never a rounded dollar figure and never `toBeCloseTo`.
- Include a split that does not divide evenly. Three ways on an odd number of cents is the case
  that exposes float math and allocation-remainder bugs.
- Include an amount at and just past `MAX_MONEY_AMOUNT`, and assert a validation error rather
  than a 500.
- For trust, assert the ledger after a reversal, not just the reversal row. The balance is the
  thing that matters.
- For a webhook, deliver the same event twice and assert one effect.

## A guard enforces the display half

`frontend/scripts/check-money-format.mjs`, run by `npm run ci:checks`, fails the build on
hand-formatted currency. `${amount.toFixed(2)}` beside a literal `$` renders `$12500.00` where the
rest of the app renders `$12,500.00`, because `toFixed` has no thousands separator and
`Intl.NumberFormat` does. Both spellings once sat side by side on the invoice.

## Where to read more

`docs/dev/concepts/money.md` explains why, with the deliberate float exceptions.
`docs/features/trust-accounting.md` and `docs/features/billing.md` are the engineering references
and cite `file:line`.
