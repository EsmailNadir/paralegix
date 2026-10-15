"use client";

import { useRef, useState } from "react";
import clientPortalService, { type PaymentMethodKind, type PaymentOptions } from "@/services/client-portal.service";
import { useNavigation } from "@/contexts/NavigationContext";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { PortalCardForm } from "@/components/portalComp/PaymentMethodDialog";

/**
 * Pay Now in the client portal: quote what each method costs, let the client
 * choose card or bank transfer, then send them to Stripe for that method. On an
 * invoice whose card fee the client pays, card opens our card form instead, and
 * a paid card form lands on the billing page with the same notice Checkout
 * returns to.
 *
 * `startingInvoiceId` is the invoice whose quote is in flight, for the Pay Now
 * button's loading state. `dialogProps` spread onto
 * `PaymentMethodDialog`.
 */
export default function usePortalPayment({
  lawFirmId,
  clientRecordId,
  onError,
}: {
  lawFirmId: string;
  clientRecordId?: string;
  onError: (message: string) => void;
}) {
  const { navigate } = useNavigation();
  const [startingInvoiceId, setStartingInvoiceId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [options, setOptions] = useState<PaymentOptions | null>(null);
  const [choosing, setChoosing] = useState<PaymentMethodKind | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const invoiceIdRef = useRef<string | null>(null);

  const start = async (invoiceId: string) => {
    setStartingInvoiceId(invoiceId);
    try {
      const quote = await clientPortalService.getPaymentOptions(lawFirmId, invoiceId, clientRecordId);
      invoiceIdRef.current = invoiceId;
      setOptions(quote);
      setChoosing(null);
      setCardOpen(false);
      setDialogOpen(true);
      setStartingInvoiceId(null);
    } catch (err) {
      onError(getErrorMessage(err, "Failed to start payment"));
      setStartingInvoiceId(null);
    }
  };

  const startCheckout = async (method: PaymentMethodKind) => {
    const invoiceId = invoiceIdRef.current;
    if (!invoiceId) return;
    setChoosing(method);
    try {
      const { checkoutUrl } = await clientPortalService.getPaymentCheckoutUrl(lawFirmId, invoiceId, clientRecordId, method);
      // Left choosing: the page is navigating away to Stripe.
      window.location.href = checkoutUrl;
    } catch (err) {
      setDialogOpen(false);
      setChoosing(null);
      onError(getErrorMessage(err, "Failed to start payment"));
    }
  };

  const choose = (method: PaymentMethodKind) => {
    if (method === "card" && options?.card?.flow === "card_form") {
      setCardOpen(true);
      return;
    }
    void startCheckout(method);
  };

  const invoiceId = () => invoiceIdRef.current as string;
  const cardForm: PortalCardForm = {
    open: cardOpen,
    api: {
      quote: (confirmationTokenId) =>
        clientPortalService.quoteCard(lawFirmId, invoiceId(), clientRecordId, confirmationTokenId),
      confirm: (confirmationTokenId, expectedTotalCents) =>
        clientPortalService.confirmCard(lawFirmId, invoiceId(), clientRecordId, confirmationTokenId, expectedTotalCents),
      complete: (paymentIntentId) =>
        clientPortalService.completeCard(lawFirmId, invoiceId(), clientRecordId, paymentIntentId),
    },
    onPaid: () => {
      setDialogOpen(false);
      navigate(`/client/lawfirm/${lawFirmId}/billing?payment=success`);
    },
    onBack: () => setCardOpen(false),
  };

  return {
    start,
    startingInvoiceId,
    dialogProps: {
      open: dialogOpen,
      options,
      choosing,
      onChoose: choose,
      onClose: () => setDialogOpen(false),
      cardForm,
    },
  };
}
