import { cardFeeRefundGuidance } from "@/lib/payments/cardFeeCopy";
import type { InvoicePayment } from "@/types/billing";

/**
 * The credit card fee a client paid on a payment, or 0. Hosted Checkout never
 * adds a card fee, so a fee on a Stripe payment with a PaymentIntent and no
 * Checkout session was taken through the card form, and is a credit card fee.
 */
function cardFeeCents(payment: InvoicePayment): number {
  const fee = payment.surchargeCents ?? 0;
  return fee > 0 && !!payment.stripePaymentIntentId && !payment.stripeSessionId ? fee : 0;
}

/**
 * Under a payment that carried a credit card fee: how much of the fee to refund
 * if the firm refunds the payment in Stripe. Shown in the payment's notes on
 * both firm invoice views. Renders nothing for any other payment.
 */
export default function PaymentCardFeeRefundNote({ payment }: { payment: InvoicePayment }) {
  const feeCents = cardFeeCents(payment);
  if (feeCents <= 0) return null;
  return <p className="mt-1 text-xs text-on-surface-muted">{cardFeeRefundGuidance(feeCents)}</p>;
}
