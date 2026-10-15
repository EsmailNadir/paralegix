"use client";

import Checkbox from "@/components/ui/Checkbox";
import PaymentFeeBreakdown from "@/components/billingComp/PaymentFeeBreakdown";
import CardFeeCopyText from "@/components/billingComp/CardFeeCopyText";
import { REQUEST_FEE_LABEL, quoteAcceptsDebit, requestFeeDescription } from "@/lib/payments/cardFeeCopy";
import type usePaymentRequestFees from "@/hooks/billingHooks/usePaymentRequestFees";

/**
 * Whether the client pays the processing fee on this request, with what card
 * and bank transfer then cost. One box covers both methods; its description
 * says what it covers for this firm and, when the firm may not pass the card
 * fee on, links to where that is fixed. Following that link calls `onNavigate`
 * first, so the dialog can close.
 */
export default function PaymentRequestFees({
  fees,
  lawFirmId,
  onNavigate,
}: {
  fees: ReturnType<typeof usePaymentRequestFees>;
  lawFirmId: string;
  onNavigate?: () => void;
}) {
  const { quote, loading, error, passedOn, eligibility, setPassedOn } = fees;
  // Described once the firm's setting has loaded, and kept while a tick re-prices.
  const description = passedOn === null
    ? null
    : requestFeeDescription({ eligibility, debitAccepted: quoteAcceptsDebit(quote?.methods) });
  return (
    <div className="space-y-3">
      <Checkbox
        checked={!!passedOn}
        onChange={setPassedOn}
        disabled={passedOn === null}
        label={REQUEST_FEE_LABEL}
        description={description ? <CardFeeCopyText parts={description} lawFirmId={lawFirmId} onNavigate={onNavigate} /> : undefined}
      />
      <PaymentFeeBreakdown quote={quote} loading={loading} error={error} />
    </div>
  );
}
