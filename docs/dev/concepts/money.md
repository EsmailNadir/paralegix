# Money Handling

Why every amount is an integer number of cents, how the conversion helpers work,
and where the few deliberate float exceptions live.

## Summary

Money is stored and computed as **integer cents**, never floating-point dollars.
Every money column is a `bigint` named `*_cents`
(`total_cents`, `amount_paid_cents`, `rate_cents`, `amount_cents`, ...), and the
service layer does sums, allocations, and splits in integer cents, converting to
dollars **only at the output boundary**.

This exists because floating-point dollar math accumulates rounding error across
many adds and divisions — unacceptable for legal billing, where an invoice total,
a trust-ledger balance, or a client statement must reconcile to the exact cent.
The old pattern (float dollars patched with `Math.round(x * 100) / 100`) drifts as
soon as you sum enough entries or split an amount three ways; integer cents do not.

## Key Takeaways

- **Cents in, cents out — dollars only at the edge.** Persist and compute in
  integer cents; call `fromCents` (or `fromCentsOrNull`) only when shaping a value
  for display or an API response.
- **One helper module.** `backend/src/modules/billing/shared/money.ts` is the
  canonical `toCents`/`fromCents` (+ null-preserving variants). Do not re-declare
  local copies.
- **Generated columns are convenience, not gospel.** Some `*_cents` totals are
  `generated always as ... stored`. `activities.amount_cents` reflects only the
  rate stored on the row, so a time row nothing has resolved yet reads its
  explicit `rate_cents` or `0`.
- **Null is meaningful.** Nullable money (an optional rate) stays `null` through the
  conversion, so use the `*OrNull` variants for those columns.
- **A couple of float exceptions remain, on purpose.** Retainer-plan overage math
  works in float **hours**, and some rate tiers are still configured in dollars;
  both are documented below.

## Storage: integer cents

Every money value in the schema is a `bigint` cents column
(`backend/db/schema.sql`). Examples:

- `invoices.total_cents`, `invoices.amount_paid_cents`,
  `invoices.balance_due_cents`
- `activities.rate_cents`, `activities.resolved_rate_cents`,
  `activities.charge_cents`, `activities.amount_cents` (`activities` is the one
  table for time, expenses and flat fees, discriminated by `kind`; it replaced
  `time_entries`, `expenses` and `flat_fees`)
- `invoice_payments.amount_cents`, `trust_transactions.amount_cents`,
  `trust_minimum_balances.minimum_cents` (the low-balance threshold)

A `numeric(6,2)` column like `activities.hours` is a **quantity** (hours), not
money; money is the paired `*_cents` column. The one dollar-valued money column
left is `billing_codes.default_rate` (`numeric`), which rate resolution still
reads beside `default_rate_cents` (`rateResolution.ts`, `configuredRate`).

## Conversion helpers

`backend/src/modules/billing/shared/money.ts` is the single source for the
coercions. It consolidates helpers that used to be copy-pasted across
`invoices.service.ts`, `invoices.repository.ts`, `firmBilling.service.ts`, and
`plans.service.ts`.

| Helper | Direction | Behavior |
|---|---|---|
| `toCents(value)` | dollars → cents | `Math.round(toNum(value) * 100)`: always exact whole cents (`money.ts:48`). |
| `fromCents(cents)` | cents → dollars | `Math.round(toNum(cents)) / 100`; `null` treated as `0` (`money.ts:53`). |
| `toCentsOrNull(value)` | dollars → cents | `null`/`undefined`/`''` map to `null`; otherwise like `toCents` (`money.ts:62`). |
| `fromCentsOrNull(cents)` | cents → dollars | `null` cents stays `null` dollars (`money.ts:67`). |
| `formatDollarsFromCents(cents)` | cents → string | `$X.XX` for plain-text notification and email copy (`money.ts:78`). |
| `toNum(value)` / `toNumber` | any → number | numbers pass through, strings parse, everything else → `0` (`money.ts:28`). |
| `roundCurrency(value)` | number → number | rounds to two decimals; legacy float helper, still used to shape retainer-plan hours and amounts. |
| `MAX_MONEY_AMOUNT` | constant | `1_000_000_000` dollars. Every incoming money field is capped at it in Zod, so a huge finite number is a `400`, not a `bigint` overflow `500` (`money.ts:104`). |

Rule of thumb: use `toCentsOrNull`/`fromCentsOrNull` for nullable money columns
(e.g. an optional hourly rate) so "no value" survives as `null` instead of
collapsing to `$0.00`; use the plain variants where the column is `NOT NULL`.

> **Not everything merged.** `shared/billingCalendar.ts` keeps its own `toNumber`
> because it guards with `Number.isFinite` (returning `0` for `"Infinity"`), and
> the date→ISO helpers were intentionally left separate because their invalid-date
> handling differs. Do not collapse those into `money.ts` (`money.ts:15`).

## Generated columns and their caveats

Some totals are computed by Postgres as `generated always as ... stored`, so the
DB keeps them consistent with their inputs:

- **`invoices.balance_due_cents`** —
  `total_cents - amount_paid_cents - coalesce(total_written_off_cents, 0)`, stored
  (`backend/db/schema/70_billing.sql:79`). Safe to read and to index
  (`invoices_outstanding_idx` is a partial index on `balance_due_cents > 0`).
- **`activities.amount_cents`**: for `kind = 'time'`,
  `round(coalesce(hours,0) * coalesce(resolved_rate_cents, rate_cents, 0))::bigint`;
  for an expense or flat fee, the entered `charge_cents`
  (`backend/db/schema/70_billing.sql:429`). `resolved_rate_cents` (with
  `rate_source`) is the rate the entry was resolved at when written, re-stamped
  only when its inputs change or the firm re-rates, so a rate change stops moving
  old work. Rows carrying a resolved rate can be summed for unbilled value.
  **CAVEAT:** a time row nothing has resolved yet has `resolved_rate_cents` null,
  which readers treat as "resolve live"; its generated amount is only the explicit
  `rate_cents`, or `0`. Reporting code that must count those rows resolves the
  rate in the service layer (`storedOrLiveRate` in `billing/shared/billingReads.ts`).

The lesson generalizes: a generated `*_cents` column reflects exactly its formula's
inputs. Before summing one for reporting, confirm its formula captures the value
you think it does.

## Converting at the boundary

Do all arithmetic in cents; convert once, on the way out. A payment allocation that
splits `amount_cents` across line items, for instance, sums and subtracts integers
throughout and only calls `fromCents` when building the response object. This keeps
the reconciliation invariant exact: the sum of the parts equals the whole, to the
cent, with no `0.01` drift.

Symmetrically, values arriving from the client (dollar strings from a form) are
converted **in** with `toCents`/`toCentsOrNull` at the service boundary before any
math or persistence, after the Zod schema has capped them at `MAX_MONEY_AMOUNT`.

On the frontend, `formatCents` (integer cents) and `formatCurrency` (dollars) in
`frontend/src/lib/utils/currency.ts` are the only ways to render money for a
person. `npm run check:money-format` (part of `ci:checks`) fails on a `$` next to
a hand-rolled `toFixed`, which drops the thousands separator.

## Known float exceptions

Integer-cent discipline covers money. A small number of call sites intentionally
work in float **hours** rather than cents:

- **Retainer / billing-plan overage** in
  `backend/src/modules/billing/plans/plans.service.ts` tracks `includedHours`,
  `consumedHours`, and `overageHours` as float hours, using `toNumber`
  (`plans.service.ts:289`). It allocates each date-ordered time entry's `hours`
  against the plan's included hours, splitting the entry that crosses the
  boundary so only the portion beyond the allowance is overage. The overage
  portion is priced at the entry's stored rate (or the live-resolved one) and
  rounded to whole cents once, as `fromCents(toCents(overagePortion * rate))`,
  the same line amount the invoice composer produces (`plans.service.ts:346`).
  Hours are a `numeric(6,2)` quantity, not money, so this is float quantity math
  feeding a whole-cent figure: a deliberate exception, not a place to "fix"
  blindly. `roundCurrency` still shapes the period's hours and amount for output.
- **Dollar rate tiers.** The rate tiers `rateResolution.ts` walks include
  dollar numbers: `billing_codes.default_rate`, the client's
  `billingRates.defaultRate`, and the firm settings' `billing.defaultRate`.
  `configuredRate` accepts them as numbers or numeric strings, because node-pg
  returns `numeric` as a string.

If you find float dollar math elsewhere in billing, treat it as a bug against this
model, not as precedent.

## Why this matters

Trust accounting (IOLTA) and client invoicing are legally sensitive: a trust ledger
must balance exactly, and a client's statement must add up to the penny. Integer
cents make every total, split, and running balance exactly reproducible and
auditable. Floating-point dollars cannot make that guarantee once enough operations
compound, which is why the `*_cents` model is enforced schema-wide rather than left
to per-call-site discipline.

## Source

- `backend/src/modules/billing/shared/money.ts`: canonical cent/dollar helpers
- `backend/db/schema/70_billing.sql`: `*_cents` columns; generated
  `balance_due_cents` and `activities.amount_cents` (`schema.sql` is generated
  from it)
- `backend/src/modules/billing/plans/plans.service.ts`: retainer overage float math
- `backend/src/modules/billing/shared/rateResolution.ts`: rate tiers, `configuredRate`
- `frontend/src/lib/utils/currency.ts`: `formatCents` / `formatCurrency`
- `.claude/skills/handling-money/SKILL.md`: the working checklist for money code
- `backend/AGENTS.md`: "Money is integer cents (`*_cents`)" repository rule
