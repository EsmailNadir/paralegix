"use client";

import { useEffect, useId, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle } from "lucide-react";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import PaymentMethodOptions from "@/components/portalComp/PaymentMethodOptions";
import CardPaymentPanel from "@/components/portalComp/CardPaymentPanel";
import BackButton from "@/components/ui/BackButton";
import { CARD_FORM_ERRORS, cardMethodSubtitles } from "@/lib/payments/cardFeeCopy";
import payLinkService, { type PayPage } from "@/services/payLink.service";
import type { PaymentMethodKind } from "@/services/client-portal.service";
import { formatCents } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { ApiError, getErrorMessage } from "@/lib/utils/apiErrors";

type LoadState = "loading" | "ready" | "not_found" | "error";

/** Centered message card for the terminal states, as the share page uses. */
function MessageCard({ title, message, headingId, success = false }: {
  title: string;
  message: string;
  headingId: string;
  success?: boolean;
}) {
  const Icon = success ? CheckCircle : AlertCircle;
  return (
    <div className="w-full max-w-md rounded-xl bg-surface border border-outline shadow-sm p-8 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-alt">
        <Icon size={24} className={success ? "text-emerald-600 dark:text-emerald-400" : "text-on-surface-muted"} />
      </div>
      <h1 id={headingId} tabIndex={-1} className="text-lg font-semibold text-on-surface">{title}</h1>
      <p className="mt-2 text-sm text-on-surface-secondary">{message}</p>
    </div>
  );
}

/**
 * The no-login pay page a secure payment link opens: the invoice, and card or
 * bank transfer with any processing fee the firm passed on. The token in the
 * URL is the only credential. When the client pays the card fee, card opens our
 * card form in place of the choice, which shows the exact fee before paying.
 */
export default function PayLinkPage() {
  const params = useParams();
  const search = useSearchParams();
  const headingId = useId();
  const token = (Array.isArray(params?.token) ? params.token[0] : params?.token) || "";
  const returned = search?.get("payment") || null;
  // Stripe appends the PaymentIntent to the return URL after a bank's card
  // verification page, so the payment can be completed here.
  const verifiedIntent = returned === "card_return" ? search?.get("payment_intent") || null : null;

  const [state, setState] = useState<LoadState>("loading");
  const [page, setPage] = useState<PayPage | null>(null);
  const [choosing, setChoosing] = useState<PaymentMethodKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setState("not_found");
        return;
      }
      if (verifiedIntent) {
        try {
          const { status } = await payLinkService.completeCard(token, verifiedIntent);
          if (cancelled) return;
          if (status === "succeeded" || status === "processing") {
            setPaid(true);
            setState("ready");
            return;
          }
          setError(CARD_FORM_ERRORS.notCharged);
        } catch (err) {
          if (cancelled) return;
          setError(getErrorMessage(err, CARD_FORM_ERRORS.notCharged));
        }
      }
      try {
        const data = await payLinkService.getPayPage(token);
        if (cancelled) return;
        setPage(data);
        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setState(err instanceof ApiError && err.status === 404 ? "not_found" : "error");
      }
    })();
    return () => { cancelled = true; };
  }, [token, verifiedIntent]);

  useEffect(() => {
    if (state !== "loading" && state !== "ready") document.getElementById(headingId)?.focus();
  }, [state, headingId]);

  const startCheckout = async (method: PaymentMethodKind) => {
    setChoosing(method);
    setError(null);
    try {
      const { checkoutUrl } = await payLinkService.startCheckout(token, method);
      // Left choosing: the page is navigating away to Stripe.
      window.location.href = checkoutUrl;
    } catch (err) {
      setChoosing(null);
      setError(getErrorMessage(err, "Failed to start payment"));
    }
  };

  const choose = (method: PaymentMethodKind) => {
    if (method === "card" && page?.card?.flow === "card_form") {
      setError(null);
      setCardOpen(true);
      return;
    }
    void startCheckout(method);
  };

  if (state === "loading") return <LoadingSpinner />;

  const thankYou = (
    <MessageCard
      success
      headingId={headingId}
      title="Thank you for your payment"
      message="Your payment is being processed. A card payment confirms within minutes; a bank transfer can take a few business days. You'll get a receipt by email."
    />
  );

  // Paying a link ends its request, so a client returning from checkout can
  // find the link gone. They are thanked all the same. A client returning from
  // their bank's card verification page is thanked once the payment completes.
  if (returned === "success" && state !== "error") return thankYou;
  if (paid) return thankYou;

  if (state === "not_found") {
    return (
      <MessageCard
        headingId={headingId}
        title="This payment link is no longer valid"
        message="It may have been replaced by a newer link or withdrawn. Please contact the firm that sent it."
      />
    );
  }

  if (state === "error" || !page) {
    return (
      <MessageCard
        headingId={headingId}
        title="Something went wrong"
        message="We couldn't load this payment link. Please try again in a few minutes."
      />
    );
  }

  if (page.isPaid) {
    return (
      <MessageCard
        success
        headingId={headingId}
        title="This invoice is paid"
        message="There is nothing left to pay on this invoice."
      />
    );
  }

  const firm = page.firmName || "your law firm";
  return (
    <div className="w-full max-w-md rounded-xl bg-surface border border-outline shadow-sm p-8">
      <h1 className="text-lg font-semibold text-on-surface">Pay {firm}</h1>
      <p className="mt-1 text-sm text-on-surface-secondary">
        {page.installmentNumber
          ? `Installment ${page.installmentNumber} of ${page.invoiceName ? `invoice ${page.invoiceName}` : "this invoice"}`
          : page.invoiceName ? `Invoice ${page.invoiceName}` : "Invoice"}
        {page.dueDate ? ` · Due ${formatDateOnly(page.dueDate)}` : ""}
      </p>
      <p className="mt-4 text-2xl font-semibold text-on-surface">{formatCents(page.invoiceCents)}</p>
      {returned === "cancelled" && (
        <p className="mt-2 text-sm text-on-surface-secondary">Payment was not completed. You can choose a method and try again.</p>
      )}
      {cardOpen ? (
        <div className="mt-6 space-y-3">
          <BackButton onClick={() => setCardOpen(false)} label="Back" variant="link" />
          <ErrorNotification error={error} onClose={() => setError(null)} compact />
          <CardPaymentPanel
            setup={page.card}
            invoiceCents={page.invoiceCents}
            api={{
              quote: (confirmationTokenId) => payLinkService.quoteCard(token, confirmationTokenId),
              confirm: (confirmationTokenId, totalCents) => payLinkService.confirmCard(token, confirmationTokenId, totalCents),
              complete: (paymentIntentId) => payLinkService.completeCard(token, paymentIntentId),
            }}
            onPaid={() => setPaid(true)}
            onPayByBank={() => void startCheckout("bank")}
            payingByBank={choosing === "bank"}
          />
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          <ErrorNotification error={error} onClose={() => setError(null)} compact />
          <p className="text-sm font-medium text-on-surface">How would you like to pay?</p>
          <PaymentMethodOptions
            methods={page.methods}
            choosing={choosing}
            onChoose={choose}
            subtitles={cardMethodSubtitles(page.card)}
          />
        </div>
      )}
      <p className="mt-6 text-xs text-on-surface-muted">Payments are processed securely by Stripe.</p>
    </div>
  );
}
