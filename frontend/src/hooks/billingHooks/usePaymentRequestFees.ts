"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import billingService, { type PaymentFeeChoice, type PaymentFeeQuote } from "@/services/billing.service";
import type { BillingContext } from "@/types/billing";
import type { CardFeeEligibility } from "@/types/cardFees";

/**
 * The processing-fee choice in the Request Payment via Stripe dialog: one box
 * for whether the client pays the processing fee on this request, and what each
 * method then costs. Ticked, the client pays the bank transfer fee, and the
 * credit card fee too when the firm may pass it on (the backend refuses a card
 * fee for a firm that may not). The box starts ticked when the firm's billing
 * setting passes the bank fee on, or the card fee for an eligible firm.
 *
 * The quote at the firm's setting is read first, since it carries the setting
 * and the firm's card fee eligibility. When the box asks for something else,
 * the request is priced again with card and bank set to match it. The backend
 * owns the fee math, so the quote shown is what the request will charge.
 * `installmentId` prices a link for one payment-plan row; null prices the full
 * remaining balance.
 */
export default function usePaymentRequestFees(
  context: BillingContext | null,
  invoiceId: string | null | undefined,
  open: boolean,
  installmentId: string | null = null,
): {
  quote: PaymentFeeQuote | null;
  loading: boolean;
  error: boolean;
  /** Whether the box is ticked; null until the firm's setting has loaded. */
  passedOn: boolean | null;
  /** Whether the firm may pass the card fee on, from the quote at its setting, so it holds while the box re-prices. */
  eligibility: CardFeeEligibility | undefined;
  /** What the request sends. */
  choice: PaymentFeeChoice | null;
  setPassedOn: (passedOn: boolean) => void;
} {
  // Keyed by invoice, so a choice made for one invoice never carries to another.
  const [edited, setEdited] = useState<{ invoiceId: string; passedOn: boolean } | null>(null);
  const enabled = open && !!context?.entityId && !!invoiceId;
  const keyBase = ["paymentFeeQuote", context?.lawFirmId, context?.type, context?.entityId, invoiceId, installmentId] as const;

  const base = useQuery({
    queryKey: [...keyBase, "firmDefault"],
    queryFn: () =>
      billingService.getPaymentFeeQuote(context as BillingContext, invoiceId as string, undefined, installmentId ?? undefined),
    enabled,
    staleTime: 0,
  });
  const firmQuote = base.data ?? null;
  // A quote that says nothing about eligibility does not lock the card fee.
  const eligible = firmQuote?.cardFeeEligibility?.eligible ?? true;

  const editedPassedOn = edited && edited.invoiceId === invoiceId ? edited.passedOn : null;
  const passedOn = editedPassedOn
    ?? (firmQuote ? firmQuote.firmDefault.bank || (firmQuote.firmDefault.card && eligible) : null);
  const choice: PaymentFeeChoice | null = passedOn === null ? null : { card: passedOn && eligible, bank: passedOn };
  const atFirmDefault = !!firmQuote && !!choice
    && choice.card === firmQuote.firmDefault.card && choice.bank === firmQuote.firmDefault.bank;

  const priced = useQuery({
    queryKey: [...keyBase, choice?.card, choice?.bank],
    queryFn: () =>
      billingService.getPaymentFeeQuote(context as BillingContext, invoiceId as string, choice as PaymentFeeChoice, installmentId ?? undefined),
    enabled: enabled && !!choice && !atFirmDefault,
    staleTime: 0,
    // Keep the last figures on screen while a ticked box re-prices them, but
    // only the same firm's same invoice and link target: never another firm's
    // figures, and never the full balance's figures for one installment.
    placeholderData: (prev, prevQuery) =>
      (prevQuery?.queryKey?.[1] === context?.lawFirmId
        && prevQuery?.queryKey?.[4] === invoiceId
        && prevQuery?.queryKey?.[5] === installmentId
        ? prev
        : undefined),
  });

  const quote = atFirmDefault ? firmQuote : priced.data ?? null;
  return {
    quote,
    loading: base.isLoading || (!atFirmDefault && priced.isLoading),
    error: !!base.error || (!atFirmDefault && !!priced.error),
    passedOn,
    eligibility: firmQuote?.cardFeeEligibility,
    choice,
    setPassedOn: (next) => {
      if (!invoiceId || passedOn === null) return;
      setEdited({ invoiceId, passedOn: next });
    },
  };
}
