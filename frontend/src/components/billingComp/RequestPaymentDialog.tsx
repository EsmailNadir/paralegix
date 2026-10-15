"use client";

import { useMemo, useState } from "react";
import { Check, Copy, CreditCard, Mail, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import PaymentRequestFees from "@/components/billingComp/PaymentRequestFees";
import usePaymentRequestFees from "@/hooks/billingHooks/usePaymentRequestFees";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import billingService from "@/services/billing.service";
import { formatCurrency } from "@/components/billingComp/utils";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import type { BillingContext, PaymentPlan } from "@/types/billing";

type Delivery = "email" | "copy";

const DELIVERY_OPTIONS: Array<{ value: Delivery; label: string; icon: typeof Mail }> = [
  { value: "email", label: "Email it", icon: Mail },
  { value: "copy", label: "Copy link", icon: Copy },
];

/** The target value meaning the full remaining balance rather than one installment. */
const FULL_BALANCE = "";

/**
 * Request online payment for an invoice. Every request makes one secure
 * payment link: the client opens it, picks card or bank transfer and pays. The
 * firm chooses whether Paralegix emails it to the billing recipients, or copies
 * it to send another way (a text, a chat). Copying shows the link, ready to
 * paste. The same dialog serves every screen that requests payment.
 *
 * An invoice has one open link at a time. On an invoice with a payment plan
 * the firm picks what the link charges: the full remaining balance or one
 * unpaid installment. Sending replaces any link already open.
 */
export default function RequestPaymentDialog({
  open,
  onClose,
  onRequested,
  billingContext,
  invoiceId,
  paymentPlan = null,
  initialInstallmentId = null,
  hasOpenLink = false,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after the request succeeds, to refresh the invoice. */
  onRequested: () => void | Promise<void>;
  billingContext: BillingContext | null;
  invoiceId: string | null | undefined;
  /** The invoice's payment plan, whose unpaid rows the link can be for. */
  paymentPlan?: PaymentPlan | null;
  /** The plan row the dialog opens on; null opens on the full balance. */
  initialInstallmentId?: string | null;
  /** The invoice already has an open payment link, which sending replaces. */
  hasOpenLink?: boolean;
}) {
  const targetOptions = useMemo(() => {
    if (!paymentPlan?.enabled) return [];
    return (paymentPlan.expectedPayments || []).flatMap((ep, index) =>
      ep.status !== "paid" && ep.id
        ? [{
            value: ep.id,
            label: `Installment ${index + 1} · ${formatCurrency(ep.amount)} · due ${formatDateOnly(ep.dueDate, { month: "short", day: "numeric", year: "numeric" })}`,
          }]
        : [],
    );
  }, [paymentPlan]);
  const [target, setTarget] = useState<string>(initialInstallmentId ?? FULL_BALANCE);
  const [delivery, setDelivery] = useState<Delivery>("email");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Seeded before the fee quote reads the target, so the quote never prices
  // the previous session's choice.
  useSeedOnOpen(open, () => {
    setTarget(initialInstallmentId ?? FULL_BALANCE);
    setDelivery("email");
    setError(null);
    setLink(null);
    setCopied(false);
  }, initialInstallmentId);
  // A preselected row that is paid or gone falls back to the full balance.
  const installmentId = target !== FULL_BALANCE && targetOptions.some((option) => option.value === target) ? target : null;
  const fees = usePaymentRequestFees(billingContext, invoiceId, open, installmentId);
  // From the server, resolved as the request resolves them.
  const recipientEmails = fees.quote?.emailTo ?? [];
  const canEmail = recipientEmails.length > 0;
  // Email is offered only once the quote says someone can receive it.
  const effectiveDelivery: Delivery = canEmail ? delivery : "copy";

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // The link stays on screen to copy by hand when the browser refuses.
      setCopied(false);
    }
  };

  // Closing after a link was copied also refreshes the invoice, so it shows the
  // open request and its Copy Payment Link button.
  const finish = () => {
    onClose();
    if (link) void onRequested();
  };

  const submit = async () => {
    if (!billingContext || !invoiceId) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await billingService.requestStripePayment(billingContext, invoiceId, fees.choice ?? undefined, {
        sendEmail: effectiveDelivery === "email",
        installmentId: installmentId ?? undefined,
      });
      if (effectiveDelivery === "email") {
        onClose();
        await onRequested();
      } else {
        // Refreshing now would reload the invoice page behind a full-page
        // spinner, unmounting this dialog and losing the link. The page is
        // refreshed when the firm closes the dialog instead (`finish`).
        setLink(result.paymentUrl);
        await copy(result.paymentUrl);
      }
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create the payment link"));
    } finally {
      setSubmitting(false);
    }
  };

  const readyBody = link && (
    <div className="space-y-3">
      <p className="text-sm text-on-surface-secondary">
        {copied ? "Copied. " : ""}Paste it into a text or message to your client. They open it, choose card or bank transfer, and pay.
      </p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          aria-label="Payment link"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
        />
        <Button
          type="secondary"
          onClick={() => copy(link)}
          icon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-on-surface-muted">
        Anyone with this link can pay this invoice. It stops working once the invoice is paid or you cancel the payment link.
      </p>
    </div>
  );

  // One dialog throughout: once a copied link exists it shows the link, so the
  // dialog never remounts between the two steps.
  return (
    <Modal
      isOpen={open}
      onClose={finish}
      dismissible={!submitting}
      title={link ? "Payment link ready" : "Request Payment via Stripe"}
      icon={<CreditCard className="w-4 h-4 text-accent-emphasis" />}
      closeIcon={<X className="w-4 h-4" />}
      size="md"
      footer={link ? (
        <Button type="primary" onClick={finish}>Done</Button>
      ) : (
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="primary" onClick={submit} loading={submitting} disabled={submitting || !fees.choice}>
            {effectiveDelivery === "email" ? "Email Payment Link" : "Create & Copy Link"}
          </Button>
        </>
      )}
    >
      {readyBody || (
        <div className="space-y-4">
          <ErrorNotification error={error} onClose={() => setError(null)} compact />
          {targetOptions.length > 0 && (
            <Dropdown
              label="What is this link for?"
              value={installmentId ?? FULL_BALANCE}
              onChange={setTarget}
              options={[{ value: FULL_BALANCE, label: "Full remaining balance" }, ...targetOptions]}
              portal
            />
          )}
          {hasOpenLink && (
            <p className="text-xs text-on-surface-muted">
              This invoice already has an open payment link. Sending this one replaces the current payment link, and the old one stops working.
            </p>
          )}
          <div className="space-y-2">
            <p className="text-sm text-on-surface-secondary">
              Your client gets a secure link to pay this invoice by card or bank transfer. How do you want to send it?
            </p>
            <SegmentedToggle
              ariaLabel="How to send the payment link"
              options={canEmail ? DELIVERY_OPTIONS : DELIVERY_OPTIONS.filter((option) => option.value === "copy")}
              value={effectiveDelivery}
              onChange={setDelivery}
            />
            <p className="text-xs text-on-surface-muted">
              {!fees.quote
                ? null
                : effectiveDelivery === "email"
                  ? `We'll email it to ${recipientEmails.join(", ")}.`
                  : canEmail
                    ? "We'll create the link and copy it, so you can text or message it yourself. Nothing is emailed."
                    : "This invoice has no billing email, so copy the link and send it yourself."}
            </p>
          </div>
          {/* A link out of the dialog to fix card fees closes it on the way. Without
              a billing context there is no quote, so no link to build. */}
          <PaymentRequestFees fees={fees} lawFirmId={billingContext?.lawFirmId ?? ""} onNavigate={onClose} />
        </div>
      )}
    </Modal>
  );
}
