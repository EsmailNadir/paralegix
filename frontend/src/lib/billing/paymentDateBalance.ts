import type { PaymentDate } from "@/types";

const toCents = (dollars: number | null | undefined) => Math.round((Number(dollars) || 0) * 100);

/**
 * What is still owed on the invoice behind a calendar payment item, in dollars:
 * the total less payments and credits, never below zero.
 *
 * An invoice due date item already carries this figure as `scheduledAmount`,
 * which the server nets in whole cents (`getInvoiceRemainingBalance` in
 * backend/src/modules/billing/shared/billingCalendar.ts), so that is used when
 * present. Otherwise the subtraction is done here in whole cents and converted
 * once, because float dollars leave residue (1.1 - 1.0 - 0.1 is 8.3e-17, which
 * reads as still owed).
 */
export function paymentDateRemaining(p: PaymentDate): number {
  if (p.billingItemType === "invoice_due_date" && typeof p.scheduledAmount === "number") {
    return toCents(p.scheduledAmount) / 100;
  }
  const remainingCents = toCents(p.totalAmount) - toCents(p.amountPaid) - toCents(p.totalWrittenOff);
  return Math.max(0, remainingCents) / 100;
}

/**
 * The amount "Mark as Paid" records for a calendar payment item, in dollars: an
 * installment's scheduled amount, or the remaining balance of an invoice due
 * date. Zero means there is nothing this item can pay.
 */
export function paymentDatePayableAmount(p: PaymentDate): number {
  if (p.billingItemType === "installment") {
    if (p.installmentIndex === undefined) return 0;
    return Math.max(0, toCents(p.scheduledAmount)) / 100;
  }
  if (p.billingItemType === "invoice_due_date") return paymentDateRemaining(p);
  return 0;
}
