import type { PaymentDate } from "@/types";

/**
 * Hover title for a payment chip on the calendar grid. A client-level invoice
 * has no matter, so the client names it; with neither known it still reads as
 * an invoice rather than "null".
 */
export function paymentTooltipTitle(p: PaymentDate): string {
  const prefix = p.billingItemType === "payment_received" ? "Payment received" : "Payment";
  return `${prefix}: ${p.matterName || p.clientName || "Invoice"}`;
}

/** The name shown on a payment row inside a month-view day cell: the client first, then the matter. */
export function paymentMonthCellLabel(p: PaymentDate): string {
  return p.clientName || p.matterName || "Payment";
}
