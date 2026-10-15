import billingService from "@/services/billing.service";
import type { BillingContext } from "@/types";
import type { SetPaymentPlanPayload } from "@/services/billing.service";

export type InvoiceDraftPrePayment = {
  id: string;
  amount: string;
  date: string;
  invoiceNumber: string;
  note: string;
};

/** Applies the shared post-create setup in order before either composer navigates. */
export async function completeInvoiceDraft(
  context: BillingContext,
  invoiceId: string,
  plan: SetPaymentPlanPayload | null | undefined,
  prePayments: InvoiceDraftPrePayment[],
) {
  if (plan && invoiceId) {
    try {
      await billingService.setPaymentPlan(context, invoiceId, plan);
    } catch (error) {
      console.error("Invoice created but failed to attach payment plan:", error);
    }
  }
  for (const payment of prePayments.filter(value => value.amount && Number(value.amount) > 0)) {
    await billingService.updateInvoicePayment(context, invoiceId, {
      paymentAmount: Number(payment.amount),
      paidDate: payment.date || null,
      invoiceNumber: payment.invoiceNumber.trim() || undefined,
      paymentNote: payment.note.trim() || undefined,
    });
  }
}
