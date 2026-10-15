"use client";

import Spinner from "@/components/ui/Spinner";
import { paymentFeeLines } from "@/lib/payments/cardFeeCopy";
import type { PaymentFeeQuote } from "@/services/billing.service";

/**
 * The processing fee on a payment request, card and bank transfer apart: the
 * fee, who pays it and what the firm receives, each line led in bold by the
 * kind of payment it is about. When the client pays the card fee, card is a
 * credit card line and, if debit cards are accepted, a debit card line. Sits in
 * the Request Payment via Stripe dialog, in the same box the fee note uses.
 */
export default function PaymentFeeBreakdown({
  quote,
  loading,
  error,
}: {
  quote: PaymentFeeQuote | null;
  loading: boolean;
  error: boolean;
}) {
  return (
    <div className="rounded-md bg-accent-soft dark:bg-accent-soft border border-accent-border-soft dark:border-accent-border-soft px-3 py-2.5 text-xs text-accent-emphasis dark:text-accent-emphasis">
      <p className="font-medium mb-1.5">Processing fees</p>
      {error ? (
        <p>Processing fees could not be loaded. The request still charges them.</p>
      ) : loading || !quote ? (
        <span className="inline-flex items-center gap-2">
          <Spinner size={14} />
          Loading fees...
        </span>
      ) : (
        <ul className="space-y-1.5">
          {paymentFeeLines(quote.methods).map(({ label, text }) => (
            <li key={label} aria-label={label}>
              <span className="font-medium">{label}:</span> {text.slice(label.length + 2)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
