/**
 * Canonical money/number helpers for the billing module.
 *
 * Consolidates the previously-duplicated `toNum`/`toNumber` and `roundCurrency`
 * helpers that were re-declared across:
 *   - invoices/invoices.service.ts
 *   - invoices/invoices.repository.ts
 *   - shared/firmBilling.service.ts
 *   - plans/plans.service.ts
 *
 * Both `toNum` and `toNumber` are exported (same implementation) so each call
 * site keeps its original local name. `roundCurrency` is unchanged: it rounds
 * to two decimals via the canonical coercion above.
 *
 * NOTE: `shared/billingCalendar.ts` keeps its OWN `toNumber` because it differs
 * (it guards with `Number.isFinite`, returning 0 for non-finite parses such as
 * the string "Infinity", whereas this one returns the parsed value). That
 * divergence is intentional and must not be collapsed into this module.
 *
 * NOTE: the date→ISO helpers (`ts` in invoices.service, `toIso` in
 * invoices.repository / firmBilling.service) are NOT consolidated here. They
 * have subtly different invalid-date handling (e.g. firmBilling's `toIso`
 * throws on an invalid Date object via its `toDate` path, while `ts` and the
 * repository `toIso` return null), so merging them would change behavior.
 */

/** Coerce any value to a number: numbers pass through, strings are parsed, everything else -> 0. */
export function toNum(value: any) {
  return typeof value === 'number' ? value : parseFloat(value) || 0;
}

/** Round to currency precision (two decimals). */
export function roundCurrency(value: any) {
  return Math.round(toNum(value) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/*  Integer-cent arithmetic (BL #3)                                    */
/*                                                                     */
/*  Storage is integer cents. The service layer historically did float */
/*  dollar math patched with Math.round(x*100)/100, which accumulates  */
/*  error across many adds/divisions. These helpers let callers do all */
/*  sums / allocations / splits in integer cents and convert to        */
/*  dollars only at the display boundary.                              */
/* ------------------------------------------------------------------ */

/** Dollars (number/string) -> integer cents. Always exact whole cents. */
export function toCents(value: any) {
  return Math.round(toNum(value) * 100);
}

/** Integer cents -> dollars (number). Exact: a whole-cent integer / 100. */
export function fromCents(cents: any) {
  return (cents == null ? 0 : Math.round(toNum(cents))) / 100;
}

/**
 * Dollars -> integer cents, preserving "empty" as null (for nullable money
 * columns like an optional hourly rate). null/undefined/'' map to null; any
 * other value is coerced and rounded to whole cents exactly like `toCents`.
 */
export function toCentsOrNull(value: any) {
  return value == null || value === '' ? null : Math.round(toNum(value) * 100);
}

/** Integer cents -> dollars, preserving null (null cents -> null dollars). */
export function fromCentsOrNull(cents: any) {
  return cents == null ? null : Math.round(toNum(cents)) / 100;
}

/**
 * Integer cents -> a `$X.XX` display string, for plain-text notification/email
 * copy (Slack-less system messages, notification bodies, receipt emails).
 * Consolidates the identical helper that was independently re-declared in
 * trust.events.ts, notifications.events.ts, billing.events.ts, and
 * stripe.events.ts.
 */
export function formatDollarsFromCents(cents: any) {
  return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
}

export const toNumber = toNum;

/**
 * Upper bound for a caller-supplied dollar amount, enforced in each module's
 * Zod schema before the value is multiplied into integer cents and written to
 * a `bigint` money column (`*_cents`). Zod's base `z.number()` already rejects
 * Infinity/NaN, but a merely huge FINITE number (e.g. 1e17) sails through
 * `.positive()`/`.nonnegative()` unchanged, survives ordinary JSON
 * serialization, gets multiplied by 100 for cents storage, and only fails once
 * it reaches Postgres as a value outside bigint's ~9.223e18 range (or, past
 * 1e21, as a string in exponential notation bigint cannot parse at all). That
 * turns a malformed request into a raw, uncaught database error -> 500,
 * instead of the clean 400 a bad amount should get. First found and fixed for
 * `activities.hourlyRate` (see timeEntries.validation.ts); this constant is
 * the same fix shared across every other module with the identical shape
 * (flat fees, expenses, plans, invoice line items).
 *
 * This is a technical bigint-range safety margin, not a product pricing
 * policy: any real invoice, flat fee, expense, or retainer amount is many
 * orders of magnitude below it, and the cap exists purely to keep the
 * post-conversion cents value inside bigint range with room to spare.
 */
export const MAX_MONEY_AMOUNT = 1_000_000_000;

/**
 * Most schedule rows (`invoice_expected_payments`) one payment plan may hold,
 * a down payment included. Whole-cent amounts bound the value of a row but not
 * how many there are: 0.01 against a 10,000.00 balance is a million rows built
 * inside the invoice row lock. Ten years of monthly installments is already
 * past any real arrangement.
 */
export const MAX_PLAN_INSTALLMENTS = 120;

/**
 * Upper bound for a caller-supplied hourly rate in dollars: a time entry's own
 * override and a charge code's default or per-member rate. The same bigint
 * range reasoning as MAX_MONEY_AMOUNT, with room for hours x rate.
 */
export const MAX_HOURLY_RATE = 1_000_000;

/* ------------------------------------------------------------------ */
/*  Rounded products (docs/features/billing.md, "Rounding policy")     */
/*                                                                     */
/*  A percentage or an hours x rate product is rounded half up, to a   */
/*  whole cent, computed on integers. A float product lands a hair     */
/*  under an exact half cent (3000 * 7.25 / 100 is 217.49999999999997) */
/*  and rounds the wrong way. BigInt keeps the product exact even when */
/*  cents x thousandths passes 2^53.                                   */
/* ------------------------------------------------------------------ */

/** numerator / denominator rounded half up (away from zero for negatives). */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = (2n * abs + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

/**
 * `ratePercent` percent of an integer cent amount, rounded half up to whole
 * cents. The rate may carry up to three decimals (9.975 is 9975 thousandths of
 * a percent); finer digits are rounded away before the product is taken.
 */
export function percentOfCents(cents: number, ratePercent: number): number {
  const thousandths = Math.round(toNum(ratePercent) * 1000);
  const product = BigInt(Math.round(toNum(cents))) * BigInt(thousandths);
  return Number(divideRoundHalfUp(product, 100_000n));
}

/** Hours to whole hundredths of an hour, the precision `activities.hours` stores. */
export function hoursToHundredths(hours: number): number {
  return Math.round(toNum(hours) * 100);
}

/**
 * Amount of a time entry in cents: `hundredthsOfHour` x `rateCents` / 100,
 * rounded half up. Equals the Postgres numeric rounding behind the generated
 * `activities.amount_cents`.
 */
export function hoursTimesRateCents(hundredthsOfHour: number, rateCents: number): number {
  const product = BigInt(Math.round(toNum(hundredthsOfHour))) * BigInt(Math.round(toNum(rateCents)));
  return Number(divideRoundHalfUp(product, 100n));
}

/** Amount in cents of `hours` worked at `rateDollars` per hour, priced like a stored time entry. */
export function hourlyAmountCents(hours: any, rateDollars: any): number {
  return hoursTimesRateCents(hoursToHundredths(toNum(hours)), toCents(rateDollars));
}
