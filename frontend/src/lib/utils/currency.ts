/**
 * An integer cents amount as a bare decimal string ("12345" -> "123.45"), with
 * no currency symbol and no thousands separator.
 *
 * For CSV export, where a spreadsheet has to read the cell back as a number.
 * `formatCents` is the one to use anywhere a person reads the value.
 */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Format an integer cents amount as a USD currency string (e.g. 12345 -> "$123.45"). */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

/** Format a dollars amount as a USD currency string (e.g. 1234.5 -> "$1,234.50"). Non-numeric input renders "$0.00". */
export function formatCurrency(amount: number): string {
  if (typeof amount !== "number" || isNaN(amount)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Shown when a typed amount has more than two decimal places. */
export const MONEY_DECIMALS_MESSAGE = "Amounts can have at most two decimal places.";
/** Shown when a typed amount is empty, zero, negative or not a plain number. */
export const MONEY_POSITIVE_MESSAGE = "Enter an amount greater than zero.";

/** The largest amount the server accepts in one money field, in dollars (MAX_MONEY_AMOUNT on the backend). */
export const MAX_MONEY_AMOUNT = 1_000_000_000;
/** Shown when a typed amount is above what the server accepts. */
export const MONEY_TOO_LARGE_MESSAGE = "Enter an amount of $1,000,000,000 or less.";

/** Shown when a positive amount was typed with separators, an exponent or a sign instead of as a plain number. */
export const MONEY_PLAIN_NUMBER_MESSAGE = "Enter the amount as a plain number, for example 1000.50.";

/** The result of reading a typed dollar amount: the number, or why it was refused. */
export type MoneyInputResult = { amount: number } | { error: string };

/**
 * Read a dollar amount a person typed into a money field.
 *
 * Money is stored as integer cents, so an amount with a third decimal place
 * cannot be stored as typed. It is refused rather than rounded, so the person
 * decides what they meant instead of the app deciding for them.
 */
export function parseMoneyInput(raw: string): MoneyInputResult {
  const text = raw.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) {
    // A positive value in a non-plain format ("1,000.50", "1e3", "+5") is a
    // formatting problem, not a sign problem, so say so.
    const loose = Number(text.replace(/,/g, ""));
    return { error: Number.isFinite(loose) && loose > 0 ? MONEY_PLAIN_NUMBER_MESSAGE : MONEY_POSITIVE_MESSAGE };
  }
  const decimals = text.includes(".") ? text.split(".")[1].length : 0;
  if (decimals > 2) return { error: MONEY_DECIMALS_MESSAGE };
  const amount = Number(text);
  if (!(amount > 0)) return { error: MONEY_POSITIVE_MESSAGE };
  if (amount > MAX_MONEY_AMOUNT) return { error: MONEY_TOO_LARGE_MESSAGE };
  return { amount };
}

/** Shown when a signed money field is left empty. */
const MONEY_REQUIRED_MESSAGE = "Enter an amount.";
/** Shown when a signed amount was typed with separators, an exponent or a stray sign. */
const MONEY_SIGNED_PLAIN_NUMBER_MESSAGE = "Enter the amount as a plain number, for example -1000.50.";
/** Shown when a signed amount is further from zero than the server accepts. */
const MONEY_SIGNED_TOO_LARGE_MESSAGE = "Enter an amount between -$1,000,000,000 and $1,000,000,000.";

/**
 * Read a dollar amount that may be negative or zero, such as a bank statement
 * balance or a reconciliation adjustment.
 *
 * The same plain-number and two-decimal rules as `parseMoneyInput`, with an
 * optional leading minus. A third decimal place is refused rather than rounded.
 */
export function parseSignedMoneyInput(raw: string): MoneyInputResult {
  const text = raw.trim();
  if (text === "") return { error: MONEY_REQUIRED_MESSAGE };
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(text)) return { error: MONEY_SIGNED_PLAIN_NUMBER_MESSAGE };
  const decimals = text.includes(".") ? text.split(".")[1].length : 0;
  if (decimals > 2) return { error: MONEY_DECIMALS_MESSAGE };
  // `+ 0` turns "-0" into 0, so a zero balance never serialises with a sign.
  const amount = Number(text) + 0;
  if (Math.abs(amount) > MAX_MONEY_AMOUNT) return { error: MONEY_SIGNED_TOO_LARGE_MESSAGE };
  return { amount };
}

/**
 * Whole cents for an amount `parseMoneyInput` or `parseSignedMoneyInput`
 * accepted. Those allow at most two decimals, so rounding only absorbs float
 * error in the product (1.15 * 100 is 114.99999999999999) and never moves the
 * amount to a different cent.
 */
export function moneyInputToCents(amount: number): number {
  return Math.round(amount * 100);
}

/* Rounded products. These mirror backend/src/modules/billing/shared/money.ts
 * exactly (backend/tests/fixtures/moneyRoundingCases.json pins both), so a
 * preview shows the cents the server will store. A float product lands a hair
 * under an exact half cent (3000 * 7.25 / 100 is 217.49999999999997), so the
 * product is taken on integers and rounded half up. */

function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const zero = BigInt(0);
  const two = BigInt(2);
  const negative = numerator < zero;
  const abs = negative ? -numerator : numerator;
  const quotient = (two * abs + denominator) / (two * denominator);
  return negative ? -quotient : quotient;
}

/**
 * `ratePercent` percent of an integer cent amount, rounded half up to whole
 * cents. The rate may carry up to three decimals; finer digits are rounded
 * away before the product is taken.
 */
export function percentOfCents(cents: number, ratePercent: number): number {
  const thousandths = Math.round((Number(ratePercent) || 0) * 1000);
  const product = BigInt(Math.round(Number(cents) || 0)) * BigInt(thousandths);
  return Number(divideRoundHalfUp(product, BigInt(100000)));
}

/** Hours to whole hundredths of an hour, the precision a time entry stores. */
export function hoursToHundredths(hours: number): number {
  return Math.round((Number(hours) || 0) * 100);
}

/** Amount of a time entry in cents: hundredths of an hour x rate in cents / 100, rounded half up. */
export function hoursTimesRateCents(hundredthsOfHour: number, rateCents: number): number {
  const product = BigInt(Math.round(Number(hundredthsOfHour) || 0)) * BigInt(Math.round(Number(rateCents) || 0));
  return Number(divideRoundHalfUp(product, BigInt(100)));
}

/** Amount in dollars of `hours` worked at `rateDollars` per hour, priced like a stored time entry (whole cents, half up). */
export function hourlyAmount(hours: number, rateDollars: number): number {
  const rateCents = Math.round((Number(rateDollars) || 0) * 100);
  return hoursTimesRateCents(hoursToHundredths(hours), rateCents) / 100;
}
