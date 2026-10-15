// The credit card fee contract shared by the pay page, the client portal and the
// firm's settings and request dialog. A fee is only ever charged on a US-allowed
// credit card, so its amount depends on the card the client enters.

/** What a firm that passes the card fee on does with a debit, prepaid or non-US card. */
export type CardAcceptance = "absorb" | "decline";

/**
 * How card payments on one invoice are taken. `card_form` is our own card form,
 * used when the client pays the card fee; `checkout` is Stripe's hosted page.
 */
export interface CardSetup {
  flow: "card_form" | "checkout";
  /** The firm's connected account; present for `card_form`. */
  stripeAccountId?: string;
  /** The fee a US credit card adds to the amount owed; present for `card_form`. */
  creditFeeCents?: number;
  debitCards?: CardAcceptance;
  internationalCards?: CardAcceptance;
}

export interface CardSummary {
  brand: string | null;
  last4: string | null;
  funding: string;
  country: string | null;
}

/** What one entered card pays on one invoice, before anything is charged. */
export type CardQuote =
  | { outcome: "credit_fee"; feeCents: number; invoiceCents: number; totalCents: number; card?: CardSummary }
  | {
      outcome: "no_fee";
      reason: "debit" | "prepaid" | "unknown_funding";
      feeCents: number;
      invoiceCents: number;
      totalCents: number;
      card?: CardSummary;
    }
  | {
      outcome: "refused";
      reason: "debit_not_accepted" | "prepaid_not_accepted" | "non_us_not_accepted";
      message?: string;
      invoiceCents: number;
      card?: CardSummary;
    };

/** Where a card payment stands after confirm or complete. */
export type CardConfirmResult =
  | { status: "succeeded" | "processing" | "failed" }
  | { status: "requires_action"; clientSecret: string };

export type CardFeeIneligibleReason =
  | "stripe_not_connected"
  | "state_missing"
  | "state_banned"
  | "not_confirmed"
  | "notice_period";

/** One line of the request dialog's card breakdown when the client pays the card fee. */
export type CardFeeRow =
  | {
      kind: "us_credit" | "non_us_credit" | "debit";
      paidBy: "client" | "firm";
      feeCents: number;
      clientPaysCents: number;
      firmReceivesCents: number;
    }
  | { kind: "debit" | "non_us_credit"; accepted: false };

/** Whether a firm may pass the card fee on, and every reason it may not. */
export interface CardFeeEligibility {
  eligible: boolean;
  reasons: CardFeeIneligibleReason[];
  /** Two-letter US state code, or null when the firm's state is not a US state. */
  state?: string | null;
  capPercent?: number;
  /** 'YYYY-MM-DD': 30 days after the firm told Stripe. */
  availableFrom?: string | null;
}

/** The firm's record that it gave Stripe notice and discloses the fee to clients. */
export interface CardFeeConfirmation {
  /** 'YYYY-MM-DD' */
  stripeNotifiedOn: string;
  engagementLetterConfirmed: true;
  confirmedBy: string;
  confirmedAt: string;
}

/** GET /lawfirms/:id/billing/card-fees */
export interface CardFeeSettingsState {
  clientPays: boolean;
  debitCards: CardAcceptance;
  internationalCards: CardAcceptance;
  ratePercent: number;
  fixedCents: number;
  confirmation: CardFeeConfirmation | null;
  eligibility: CardFeeEligibility;
}

/** PUT /lawfirms/:id/billing/card-fees. The confirmation fields are sent when turning the fee on. */
export interface CardFeeSettingsUpdate {
  clientPays: boolean;
  debitCards: CardAcceptance;
  internationalCards: CardAcceptance;
  ratePercent: number;
  fixedCents: number;
  stripeNotifiedOn?: string;
  engagementLetterConfirmed?: boolean;
}
