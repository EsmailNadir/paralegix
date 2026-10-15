/**
 * Zod shapes for caller-supplied dollar amounts that are stored as integer
 * cents. A value with more than two decimals is refused rather than rounded:
 * 0.001 would otherwise be stored as zero cents, and 12.345 as an amount
 * nobody entered.
 */
import { z } from 'zod';
const { MAX_MONEY_AMOUNT, MAX_HOURLY_RATE } = require('./money');

/**
 * Whether a dollar amount is a whole number of cents, judged on the number's
 * shortest decimal form, which is what the caller typed: `33.33` passes and
 * `10.999`, `0.005` and `1e-7` do not. Arithmetic on `v * 100` cannot decide
 * this, because 33.33 * 100 is 3332.9999999999995 in binary floating point.
 */
export function isWholeCents(v: number): boolean {
  return /^\d+(\.\d{1,2})?$/.test(String(v));
}

/** An entered charge: at least one cent, at most MAX_MONEY_AMOUNT, whole cents. */
export const positiveMoneyAmount = z
  .number()
  .min(0.01, 'amount must be at least 0.01')
  .max(MAX_MONEY_AMOUNT, `amount cannot exceed ${MAX_MONEY_AMOUNT}`)
  .refine(isWholeCents, 'amount cannot have more than two decimal places');

/** An hourly rate: zero allowed, at most MAX_HOURLY_RATE, whole cents. */
export const hourlyRateAmount = z
  .number()
  .nonnegative('rate cannot be negative')
  .max(MAX_HOURLY_RATE, `rate cannot exceed ${MAX_HOURLY_RATE}`)
  .refine(isWholeCents, 'rate cannot have more than two decimal places');
