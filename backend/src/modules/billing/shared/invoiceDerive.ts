/**
 * Canonical derived invoice fields shared by the two invoice serializers:
 *   - invoices/invoices.service.js  -> formatInvoice  (single-invoice/detail shape)
 *   - shared/firmBilling.service.js -> mapInvoiceRecord (firm-list shape)
 *
 * Both functions historically recomputed the SAME handful of derived fields
 * (effective total, remaining balance, recurring-retainer detection, the
 * `plan-` flat-fee lookup, status) inline, with subtly different surrounding
 * code. That let them drift. This module factors out ONLY the parts that are
 * provably identical between the two callers so they can never diverge:
 *
 *   - recurringPlanFlatFee : the `plan-` prefixed flat fee, if any
 *   - totalAmount          : effective billable total (getInvoiceTotal)
 *   - remainingBalance     : max(0, total - amountPaid - totalWrittenOff) in cents
 *   - status               : deriveInvoiceStatus(inv)
 *   - billingPlanName      : inv.billingPlanName || recurringPlanFlatFee.description
 *   - isRecurringRetainer  : retainer/plan detection
 *
 * Things that LEGITIMATELY differ between the two callers (the extra detail
 * fields, amountPaid / totalWrittenOff coercion style, and the null-vs-zero
 * handling of the optional split-share fields) are deliberately NOT in here.
 * Each caller keeps applying its own. Note: the split-share *rounding* divergence
 * is now reconciled. BOTH formatInvoice (invoices.service.js) and
 * mapInvoiceRecord (firmBilling.service.js) roundCurrency splitShareAmount /
 * splitSharePercent, so the two shapes report identical precision for the same
 * invoice (they only differ on whether an absent share is emitted as null or 0).
 *
 * Depends only on shared/money.js + the sibling shared helpers (getInvoiceTotal
 * lives in firmBilling.service, but to avoid the firmBilling <-> this-module
 * require shape we recompute the identical integer-cent total via invoiceStatus'
 * invoiceTotalCents (same value getInvoiceTotal returns, just from cents).
 */

const { toCents, fromCents } = require('./money');
const { deriveInvoiceStatus, invoiceTotalCents } = require('./invoiceStatus');

/**
 * Compute the derived fields that BOTH formatInvoice and mapInvoiceRecord need,
 * identically. Returns plain values; each caller decides how (and whether) to
 * round / wrap them in its own output object.
 *
 * @param {object} inv - the camelCase invoice object from invoices.repository.
 * @param {Date} [now] - the instant the status is judged at.
 * @param {string} [timeZone] - the viewer's IANA zone: "overdue" rolls over at
 *   that zone's midnight. UTC when omitted.
 * @returns {{
 *   recurringPlanFlatFee: object|undefined,
 *   totalAmount: number,
 *   remainingBalance: number,
 *   status: string,
 *   refundDue: { amount: number, reason: 'voided' | 'overpaid' } | null,
 *   billingPlanName: string|null,
 *   isRecurringRetainer: boolean,
 * }}
 */
export function computeInvoiceDerived(inv: any, now = new Date(), timeZone = 'UTC') {
  const recurringPlanFlatFee = (inv.flatFees || []).find(
    (fee: any) => String(fee?.id || '').startsWith('plan-'),
  );

  // Effective billable total: totalAmount if > 0, else flatFeesAmount, else 0.
  // invoiceTotalCents is the integer-cent form of getInvoiceTotal; fromCents of
  // it equals getInvoiceTotal(inv) exactly (both return whole-cent dollars).
  const totalCents = invoiceTotalCents(inv);
  const totalAmount = fromCents(totalCents);

  // BL #3: subtract in integer cents so float dust never leaks into the balance.
  const remainingBalance = fromCents(
    Math.max(0, totalCents - toCents(inv.amountPaid) - toCents(inv.totalWrittenOff)),
  );

  const status = deriveInvoiceStatus(inv, now, timeZone);

  const refundDueCents = deriveRefundDue(inv);
  const refundDue = refundDueCents
    ? { amount: fromCents(refundDueCents.amountCents), reason: refundDueCents.reason }
    : null;

  const billingPlanName = inv.billingPlanName || recurringPlanFlatFee?.description || null;

  const isRecurringRetainer = Boolean(
    inv.isRecurringRetainer
    || inv.billingPlanType === 'retainer'
    || inv.billingPlanId
    || recurringPlanFlatFee,
  );

  return {
    recurringPlanFlatFee,
    totalAmount,
    remainingBalance,
    status,
    refundDue,
    billingPlanName,
    isRecurringRetainer,
  };
}

export type RefundDueReason = 'voided' | 'overpaid';

/**
 * The money an invoice holds that the firm owes back, in integer cents, or null
 * when it holds none. A payment stays recorded on the invoice it landed on (a
 * Stripe refund finds it through that record), so this is what keeps it from
 * sitting there unnoticed:
 *   - a voided invoice: everything paid on it. Voiding is refused while
 *     payments exist, so any payment on a voided invoice arrived after the void.
 *   - any other invoice: the amount paid beyond its total.
 * Written-off amounts are not money held, so they never enter the figure.
 */
export function deriveRefundDue(inv: any): { amountCents: number; reason: RefundDueReason } | null {
  const paidCents = toCents(inv.amountPaid);
  if (inv.status === 'voided') {
    return paidCents > 0 ? { amountCents: paidCents, reason: 'voided' } : null;
  }
  const excessCents = paidCents - invoiceTotalCents(inv);
  return excessCents > 0 ? { amountCents: excessCents, reason: 'overpaid' } : null;
}
