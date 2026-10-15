"use client";

import { CreditCard, X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import PaymentMethodOptions from "@/components/portalComp/PaymentMethodOptions";
import CardPaymentPanel, { type CardPaymentApi } from "@/components/portalComp/CardPaymentPanel";
import { cardMethodSubtitles } from "@/lib/payments/cardFeeCopy";
import { formatCents } from "@/lib/utils/currency";
import type { PaymentMethodKind, PaymentOptions } from "@/services/client-portal.service";

/** The card form inside the dialog, for an invoice whose card fee the client pays. */
export interface PortalCardForm {
  open: boolean;
  api: CardPaymentApi;
  onPaid: () => void;
  onBack: () => void;
}

/**
 * Card or bank transfer, with what each costs, before Stripe opens. A fee the
 * firm passes on to the client is only added at checkout, so this is where the
 * client sees it first. The caller owns the request; `choosing` is the method
 * whose checkout is starting, which locks both choices.
 *
 * When the client pays the card fee, choosing card swaps the choice for our
 * card form, which shows the exact fee once the card is entered.
 */
export default function PaymentMethodDialog({
  open,
  options,
  choosing,
  onChoose,
  onClose,
  cardForm,
}: {
  open: boolean;
  options: PaymentOptions | null;
  choosing: PaymentMethodKind | null;
  onChoose: (method: PaymentMethodKind) => void;
  onClose: () => void;
  cardForm?: PortalCardForm;
}) {
  const showCardForm = !!cardForm?.open && options?.card?.flow === "card_form";
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="How would you like to pay?"
      subtitle={options ? `Invoice balance ${formatCents(options.invoiceCents)}` : undefined}
      icon={<CreditCard className="w-4 h-4 text-accent-emphasis" />}
      closeIcon={<X className="w-4 h-4" />}
      size={showCardForm ? "lg" : "md"}
      dismissible={!choosing}
      bodyClassName="px-5 py-4 space-y-3"
      footer={
        showCardForm ? (
          <Button type="secondary" size="compact" onClick={cardForm.onBack} disabled={!!choosing}>
            Back
          </Button>
        ) : (
          <Button type="secondary" size="compact" onClick={onClose} disabled={!!choosing}>
            Cancel
          </Button>
        )
      }
    >
      {options && showCardForm && cardForm && (
        <CardPaymentPanel
          setup={options.card}
          invoiceCents={options.invoiceCents}
          api={cardForm.api}
          onPaid={cardForm.onPaid}
          onPayByBank={() => onChoose("bank")}
          payingByBank={choosing === "bank"}
          headingLevel={3}
        />
      )}
      {options && !showCardForm && (
        <PaymentMethodOptions
          methods={options.methods}
          choosing={choosing}
          onChoose={onChoose}
          subtitles={cardMethodSubtitles(options.card)}
        />
      )}
    </Modal>
  );
}
