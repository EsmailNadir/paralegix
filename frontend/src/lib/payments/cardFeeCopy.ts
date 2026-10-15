// Every screen string about credit card fees: what the client sees before and
// after entering a card, the firm's Payments settings, the request dialog and
// the payment detail. The backend keeps its refusal and receipt
// strings in its own copy file with the same wording, so the client, the firm
// and the emails always say the same thing. Amounts go through `formatCents`.
import { formatCents } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import type { PaymentFeeQuote } from "@/services/billing.service";
import type {
  CardAcceptance,
  CardFeeEligibility,
  CardSetup,
  CardFeeIneligibleReason,
  CardQuote,
} from "@/types/cardFees";

// ── Linked copy ────────────────────────────────────────────────────────────

/** Where a linked phrase in this file sends the firm. The screen turns it into an href. */
export type CardFeeLinkTarget = "payments_settings" | "stripe_support";

/** A piece of a sentence: plain text, or a phrase that links somewhere. */
export type CopyPart = string | { link: string; to: CardFeeLinkTarget };

export const STRIPE_SUPPORT_URL = "https://support.stripe.com/contact";

/** A linked sentence as plain text, for a place that cannot hold a link. */
export function copyText(parts: readonly CopyPart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.link)).join("");
}

// ── Client, before entering a card ─────────────────────────────────────────

/** The card option's subtitle on an invoice whose card fee the client pays. */
export function cardOptionSubtitle({
  creditFeeCents,
  debitCards,
  internationalCards,
}: {
  creditFeeCents: number;
  debitCards: CardAcceptance;
  internationalCards: CardAcceptance;
}): string {
  const fee = formatCents(creditFeeCents);
  const base = debitCards === "decline"
    ? `Credit cards only, plus a ${fee} fee.`
    : `Credit cards add a ${fee} fee. Debit cards don't.`;
  return internationalCards === "decline" ? `${base} US cards only.` : base;
}

/**
 * The method chooser's subtitle overrides: the card line when card payments go
 * through the card form, nothing when they go to hosted checkout.
 */
export function cardMethodSubtitles(card: CardSetup | undefined): { card: string } | undefined {
  if (card?.flow !== "card_form") return undefined;
  return {
    card: cardOptionSubtitle({
      creditFeeCents: card.creditFeeCents ?? 0,
      debitCards: card.debitCards ?? "absorb",
      internationalCards: card.internationalCards ?? "absorb",
    }),
  };
}

export const CARD_FORM_INTRO = "Enter your card to see your total.";
export const CHECK_CARD = "Check card";
/** Stripe.js could not load (no publishable key, or blocked): bank transfer still works. */
export const CARD_FORM_UNAVAILABLE = "Card payments are unavailable right now. Please pay by bank transfer.";
/**
 * Fallbacks for when neither Stripe nor the server gave a message. Stripe writes
 * its decline and verification messages for cardholders, so those are shown as
 * they come.
 */
export const CARD_FORM_ERRORS = {
  details: "Check your card details.",
  check: "We couldn't check this card.",
  notVerified: "Your bank didn't confirm the payment.",
  notCharged: "Your card was not charged. Please try again or use a different card.",
  failed: "The payment didn't go through.",
} as const;
export const FEE_CHANGED = "Your total changed. Please review it.";
export const PAY_BY_BANK_INSTEAD = "Pay by bank transfer instead";
export const USE_DIFFERENT_CARD = "Use a different card";
const RECEIPT_FOOTER = "The fee shows on your receipt.";

// ── Client, after the card is checked ──────────────────────────────────────

interface CardResultCopy {
  heading: string;
  body: string;
  /** The pay button's label; null when this card cannot be charged. */
  payLabel: string | null;
  showBankInstead: boolean;
  showDifferentCard: boolean;
  footer: string | null;
}

/** What the client is told once their card is checked, and which buttons they get. */
export function cardResultCopy(quote: CardQuote, { debitCards }: { debitCards: CardAcceptance }): CardResultCopy {
  if (quote.outcome === "credit_fee") {
    const total = formatCents(quote.totalCents);
    const avoid = debitCards === "decline" ? "Pay by bank transfer" : "Pay by bank transfer or debit card";
    return {
      heading: `Credit card fee: ${formatCents(quote.feeCents)}`,
      body: `Total ${total}. ${avoid} to avoid the fee.`,
      payLabel: `Pay ${total}`,
      showBankInstead: true,
      showDifferentCard: false,
      footer: RECEIPT_FOOTER,
    };
  }
  if (quote.outcome === "no_fee") {
    const invoice = formatCents(quote.invoiceCents);
    return {
      heading: "No card fee",
      body: quote.reason === "unknown_funding" ? `Total ${invoice}.` : `Debit cards have no fee. Total ${invoice}.`,
      payLabel: `Pay ${invoice}`,
      showBankInstead: false,
      showDifferentCard: false,
      footer: null,
    };
  }
  const nonUs = quote.reason === "non_us_not_accepted";
  return {
    heading: nonUs ? "Only US cards are accepted" : "Debit cards aren't accepted",
    body: nonUs ? "Use a US card or pay by bank transfer." : "Use a credit card or pay by bank transfer.",
    payLabel: null,
    showBankInstead: true,
    showDifferentCard: true,
    footer: null,
  };
}

// ── Firm, Payments settings ────────────────────────────────────────────────

export const CARD_FEE_SETTINGS = {
  toggleLabel: "Clients pay a fee on credit cards",
  toggleDescription: "You receive the full invoice amount.",
  howItWorksHeading: "How card fees work",
  howItWorks: [
    "Credit cards only. Debit and prepaid cards can't have a fee.",
    "Up to 3% (2% in Colorado), never more than your Stripe cost.",
    "Clients see the fee before paying and can pay by bank transfer instead.",
    "Not allowed in California, Connecticut, Maine or Massachusetts.",
    "Paralegix takes no cut on these payments.",
    "If you refund a payment, refund the same share of the fee.",
  ],
  debitLabel: "Debit and prepaid cards",
  debitOptions: {
    absorb: "Accept (your firm pays the fee)",
    decline: "Don't accept",
  },
  internationalLabel: "Cards from outside the US",
  internationalOptions: {
    absorb: "Accept (your firm pays an extra 1.5%)",
    decline: "Don't accept",
  },
  rateLabel: "Your Stripe card rate",
  /** Names of the two rate inputs, read after the group's label: "2.9 % + 30 cents". */
  ratePercentLabel: "Percent",
  rateFixedLabel: "Cents",
  rateHelp: "Change only if Stripe gave you a custom rate.",
  notifiedOnLabel: "Date you told Stripe",
  notifiedOnHelp: [
    "Required 30 days before you start. ",
    { link: "Contact Stripe support", to: "stripe_support" },
    " and say you'll add a credit card fee.",
  ] as readonly CopyPart[],
  engagementLetter: "Our engagement letters mention this fee.",
  /** The picker shown above the switch when the firm has no state on record. */
  stateLabel: "Your firm's state",
  stateHelp: "Card fee rules depend on your state.",
  /** In place of the picker, for a member who cannot change firm information. */
  stateAskAdmin: "Ask a firm admin to add your firm's state.",
} as const;

/** The intro under Payments settings' "Online Payment Fees" heading. */
export const ONLINE_PAYMENT_FEES_INTRO = "Your firm pays online processing fees unless you pass them on.";

export const BANK_FEE_SETTINGS = {
  toggleLabel: "Clients pay the bank transfer fee",
  description: "0.8% (max $5) plus 0.9%. You receive the full amount.",
} as const;

/**
 * Names for the states where card fees are blocked, which are the only states
 * a `state_banned` reason can name. Any other code is shown as it is.
 */
const BLOCKED_STATE_NAMES: Record<string, string> = {
  CA: "California",
  CT: "Connecticut",
  MA: "Massachusetts",
  ME: "Maine",
};

function stateName(state: string | null | undefined): string {
  return state ? BLOCKED_STATE_NAMES[state] || state : "your state";
}

/**
 * Why a firm cannot pass the card fee on, on the Payments settings page, one
 * reason per line. The form there collects the confirmation and the firm's
 * state, so neither `not_confirmed` nor `state_missing` is shown as a reason,
 * and the Stripe connection sits above it, so nothing links away.
 */
export function cardFeeUnavailableReason(
  reason: Exclude<CardFeeIneligibleReason, "not_confirmed" | "state_missing">,
  { state, availableFrom }: { state?: string | null; availableFrom?: string | null },
): CopyPart[] {
  switch (reason) {
    case "stripe_not_connected":
      return ["Connect Stripe above first."];
    case "state_banned":
      return [`Not allowed for firms in ${stateName(state)}.`];
    case "notice_period":
      return [`Available from ${formatDateOnly(availableFrom)}.`];
  }
}

// ── Firm, request payment dialog ───────────────────────────────────────────

export const REQUEST_FEE_LABEL = "Client pays the processing fee";

/**
 * The request dialog's one fee box, described: what passing the fee on covers
 * and, for a firm that may not pass the card fee on, a link to the Payments
 * settings that fix it, except in a state that bans the fee, where nothing can.
 * An absent eligibility reads as eligible, as the box then treats it.
 */
export function requestFeeDescription({
  eligibility,
  debitAccepted,
}: {
  eligibility: CardFeeEligibility | undefined;
  debitAccepted: boolean;
}): CopyPart[] {
  if (!eligibility || eligibility.eligible) {
    return [
      `Applies to credit cards and bank transfers. ${debitAccepted ? "Debit cards never have a fee." : "Debit cards aren't accepted."}`,
    ];
  }
  const lead = "Applies to bank transfers only.";
  const reason = eligibility.reasons[0];
  if (reason === "state_banned") return [`${lead} Card fees aren't allowed in ${stateName(eligibility.state)}.`];
  return [`${lead} `, { link: "Set up card fees", to: "payments_settings" }, " to include cards."];
}

type QuoteMethod = PaymentFeeQuote["methods"][number];

/** One line of the request dialog's fee breakdown, with the kind of payment it is about. */
export interface FeeLine {
  label: string;
  text: string;
}

function feeLine(label: string, sentence: string): FeeLine {
  return { label, text: `${label}: ${sentence}` };
}

function paidLine(label: string, paidBy: "firm" | "client", feeCents: number, firmReceivesCents: number): FeeLine {
  const fee = formatCents(feeCents);
  const gets = formatCents(firmReceivesCents);
  return feeLine(label, paidBy === "client" ? `Client pays the ${fee} fee. You get ${gets}.` : `You pay the ${fee} fee. You get ${gets}.`);
}

/**
 * The request dialog's fee breakdown, one short line per method. When the
 * client pays the card fee, card splits into a credit card line and, when debit
 * cards are accepted, a debit card line; cards from outside the US are left out
 * to keep it short.
 */
export function paymentFeeLines(methods: readonly QuoteMethod[]): FeeLine[] {
  return methods.flatMap((entry): FeeLine[] => {
    if (entry.cardRows) {
      return entry.cardRows.flatMap((row): FeeLine[] => {
        if ("accepted" in row || row.kind === "non_us_credit") return [];
        if (row.kind === "debit") return [feeLine("Debit card", `No fee. You pay about ${formatCents(row.feeCents)}.`)];
        return [paidLine("Credit card", row.paidBy, row.feeCents, row.firmReceivesCents)];
      });
    }
    const label = entry.method === "card" ? "Card" : "Bank transfer";
    return [paidLine(label, entry.paidBy, entry.feeCents, entry.firmReceivesCents)];
  });
}

/** Whether a quote's card rows accept debit cards; a quote without rows says nothing, so they are. */
export function quoteAcceptsDebit(methods: readonly QuoteMethod[] | undefined): boolean {
  const debit = methods?.flatMap((entry) => entry.cardRows ?? []).find((row) => row.kind === "debit");
  return !debit || !("accepted" in debit);
}

// ── Firm, invoice payment detail and Payments settings ─────────────────────

/** Under a payment that carried a credit card fee: how much of it to refund. */
export function cardFeeRefundGuidance(feeCents: number): string {
  return `Includes a ${formatCents(feeCents)} card fee. Refund the same share of it with any refund.`;
}

export const PAYMENTS_HOW_IT_WORKS_PAY_STEP =
  "The client gets a secure link and pays by card or bank transfer. If you pass on card fees, credit card payments include the fee and debit cards never do.";
