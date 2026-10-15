import dayjs from "dayjs";
import type { Invoice } from "@/types";

/** A failed bank attempt leaves its payment link open for another attempt or cancellation. */
export function hasOpenPaymentLink(invoice: Pick<Invoice, "stripePaymentRequested" | "stripePaymentStatus"> | null): boolean {
  return invoice?.stripePaymentRequested === true
    && (invoice.stripePaymentStatus === "pending" || invoice.stripePaymentStatus === "failed");
}

/** Next schedule date for a payment-plan installment (matches backend shortfall / new-installment logic). */
export function addPaymentPlanPeriod(dueDateStr: string, frequencyDays: number): string {
  const fd = frequencyDays || 30;
  if (fd === 30) {
    return dayjs(dueDateStr).add(1, "month").format("YYYY-MM-DD");
  }
  return dayjs(dueDateStr).add(fd, "day").format("YYYY-MM-DD");
}


/**
 * An installment the bulk editor must not touch: it's already paid and carries
 * payment linkage. The backend preserves these untouched on a schedule replace.
 */
export function isInstallmentLocked(ep: { status: string }): boolean {
  return ep.status === "paid";
}
