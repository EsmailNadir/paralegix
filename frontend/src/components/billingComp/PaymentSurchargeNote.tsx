import { formatCents } from "@/lib/utils/currency";

/**
 * The processing fee a client paid on top of a payment, shown under the
 * payment's amount. The amount itself is what reached the invoice, so the fee
 * is said separately. Renders nothing when the client paid no fee.
 */
export default function PaymentSurchargeNote({ surchargeCents }: { surchargeCents?: number | null }) {
  if (!surchargeCents || surchargeCents <= 0) return null;
  return (
    <span className="block text-xs font-normal text-on-surface-muted">
      + {formatCents(surchargeCents)} processing fee paid by client
    </span>
  );
}
