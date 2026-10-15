/** Whether the invoice already contains the payment collected by this Stripe surface. */
export function hasRecordedStripeSurface(invoice: { payments?: Array<{ stripeSessionId?: string; stripeInvoiceId?: string }> }, surfaceId: string): boolean {
  return !!surfaceId && (invoice.payments || []).some((payment) =>
    payment.stripeSessionId === surfaceId || payment.stripeInvoiceId === surfaceId);
}
