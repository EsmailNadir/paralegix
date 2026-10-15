"use client";

import { useEffect, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import Button from "@/components/ui/Button";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import { stripeForAccount } from "@/lib/payments/stripeClient";
import {
  CARD_FORM_ERRORS,
  CARD_FORM_INTRO,
  CARD_FORM_UNAVAILABLE,
  CHECK_CARD,
  FEE_CHANGED,
  PAY_BY_BANK_INSTEAD,
  USE_DIFFERENT_CARD,
  cardResultCopy,
} from "@/lib/payments/cardFeeCopy";
import { ApiError, getErrorMessage } from "@/lib/utils/apiErrors";
import type { CardConfirmResult, CardQuote, CardSetup } from "@/types/cardFees";

/** The three server calls behind the card form, bound to a pay link or a portal invoice. */
export interface CardPaymentApi {
  quote: (confirmationTokenId: string) => Promise<CardQuote>;
  confirm: (confirmationTokenId: string, expectedTotalCents: number) => Promise<CardConfirmResult>;
  complete: (paymentIntentId: string) => Promise<CardConfirmResult>;
}

/**
 * Refusals the card routes word for the client themselves: Stripe's decline
 * text, the firm's refusal of a card type, a payment already processing. Read
 * from the error directly, because `getErrorMessage` reads any 402 (a decline)
 * as the firm's subscription being inactive.
 */
const CARD_ERROR_CODES = new Set(["CARD_DECLINED", "CARD_NOT_ACCEPTED", "CARD_NOT_CHARGED", "PAYMENT_PROCESSING"]);

function payErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === "FEE_CHANGED") return FEE_CHANGED;
  if (err instanceof ApiError && err.code && CARD_ERROR_CODES.has(err.code) && err.message) return err.message;
  return getErrorMessage(err, CARD_FORM_ERRORS.failed);
}

interface Props {
  setup: CardSetup;
  /** What is owed before any card fee: the amount Stripe's form is set up for. */
  invoiceCents: number;
  api: CardPaymentApi;
  onPaid: () => void;
  onPayByBank: () => void;
  /** The bank checkout `onPayByBank` started is on its way: lock the form. */
  payingByBank?: boolean;
  /** 2 on the pay page under its h1; 3 inside a dialog whose title is the h2. */
  headingLevel?: 2 | 3;
}

/**
 * Card payment on our own page, for an invoice whose card fee the client pays.
 * The card is checked before anything is charged, so the client always sees the
 * exact fee, or why there is none, or why the card is not accepted, first.
 * Shared by the no-login pay page and the portal's payment dialog.
 */
export default function CardPaymentPanel(props: Props) {
  const { setup, invoiceCents, onPayByBank, payingByBank } = props;
  const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    if (setup.stripeAccountId) {
      stripeForAccount(setup.stripeAccountId).then((loaded) => {
        if (live) setStripe(loaded);
      });
    }
    return () => {
      live = false;
    };
  }, [setup.stripeAccountId]);

  if (stripe === undefined) return <PanelLoadingSpinner label="Loading card form" />;
  if (stripe === null) {
    return (
      <div className="space-y-3">
        <ErrorNotification error={CARD_FORM_UNAVAILABLE} compact />
        <Button type="primary" onClick={onPayByBank} loading={payingByBank} className="w-full">
          {PAY_BY_BANK_INSTEAD}
        </Button>
      </div>
    );
  }
  return (
    <Elements
      stripe={stripe}
      options={{
        mode: "payment",
        amount: invoiceCents,
        currency: "usd",
        paymentMethodCreation: "manual",
        allowedPaymentMethodTypes: ["card"],
      }}
    >
      <CardForm {...props} />
    </Elements>
  );
}

function CardForm({ setup, api, onPaid, onPayByBank, payingByBank = false, headingLevel = 2 }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [quote, setQuote] = useState<CardQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ConfirmationToken pays once, and a quote is for the card as it was
  // entered, so any change or failure sends the client back to the check.
  const reset = () => {
    setQuote(null);
    setTokenId(null);
  };

  const check = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await elements.submit();
      if (submitted.error) {
        setError(submitted.error.message || CARD_FORM_ERRORS.details);
        return;
      }
      const { error: tokenError, confirmationToken } = await stripe.createConfirmationToken({ elements });
      if (tokenError || !confirmationToken) {
        setError(tokenError?.message || CARD_FORM_ERRORS.details);
        return;
      }
      const result = await api.quote(confirmationToken.id);
      setTokenId(confirmationToken.id);
      setQuote(result);
    } catch (err) {
      setError(getErrorMessage(err, CARD_FORM_ERRORS.check));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    if (!stripe || !tokenId || !quote || quote.outcome === "refused") return;
    setBusy(true);
    setError(null);
    try {
      let result = await api.confirm(tokenId, quote.totalCents);
      if (result.status === "requires_action") {
        const next = await stripe.handleNextAction({ clientSecret: result.clientSecret });
        const paymentIntent = "paymentIntent" in next ? next.paymentIntent : undefined;
        if (next.error || !paymentIntent) {
          setError(next.error?.message || CARD_FORM_ERRORS.notVerified);
          reset();
          return;
        }
        result = await api.complete(paymentIntent.id);
      }
      if (result.status === "succeeded" || result.status === "processing") {
        onPaid();
        return;
      }
      setError(CARD_FORM_ERRORS.notCharged);
      reset();
    } catch (err) {
      setError(payErrorMessage(err));
      reset();
    } finally {
      setBusy(false);
    }
  };

  const copy = quote ? cardResultCopy(quote, { debitCards: setup.debitCards || "absorb" }) : null;
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const locked = busy || payingByBank;

  return (
    <div className="space-y-4">
      <PaymentElement
        options={{ wallets: { applePay: "never", googlePay: "never", link: "never" } }}
        onChange={() => {
          if (quote) reset();
        }}
      />
      <ErrorNotification error={error} onClose={() => setError(null)} compact />
      {!copy && (
        <>
          <p className="text-sm text-on-surface-secondary">{CARD_FORM_INTRO}</p>
          <Button type="primary" onClick={check} loading={busy} disabled={payingByBank} className="w-full">
            {CHECK_CARD}
          </Button>
        </>
      )}
      {copy && (
        <section aria-live="polite" className="rounded-xl border border-outline bg-surface-alt px-4 py-3 space-y-3">
          <div className="space-y-1">
            <Heading className="text-sm font-semibold text-on-surface">{copy.heading}</Heading>
            <p className="text-sm text-on-surface-secondary">{copy.body}</p>
          </div>
          {copy.payLabel ? (
            <>
              <Button type="primary" onClick={pay} loading={busy} disabled={payingByBank} className="w-full">
                {copy.payLabel}
              </Button>
              {copy.showBankInstead && (
                <Button type="secondary" onClick={onPayByBank} loading={payingByBank} disabled={busy} className="w-full">
                  {PAY_BY_BANK_INSTEAD}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button type="primary" onClick={onPayByBank} loading={payingByBank} disabled={busy} className="w-full">
                {PAY_BY_BANK_INSTEAD}
              </Button>
              {copy.showDifferentCard && (
                <Button type="secondary" onClick={reset} disabled={locked} className="w-full">
                  {USE_DIFFERENT_CARD}
                </Button>
              )}
            </>
          )}
          {copy.footer && <p className="text-xs text-on-surface-muted">{copy.footer}</p>}
        </section>
      )}
    </div>
  );
}
