// How an invoice's payments leave the API, for the firm and for the client
// portal alike: each one carries `surchargeCents`, the processing fee the
// client paid on top of it, so a screen can show what the client was charged
// without treating the fee as invoice money.

/** The payments with `surchargeCents` on every one, 0 when no fee was paid. */
export function paymentsWithSurcharge(payments: unknown): any[] {
  if (!Array.isArray(payments)) return [];
  return payments.map((payment: any) => ({
    ...payment,
    surchargeCents: Number.isInteger(payment?.surchargeCents) && payment.surchargeCents > 0 ? payment.surchargeCents : 0,
  }));
}
