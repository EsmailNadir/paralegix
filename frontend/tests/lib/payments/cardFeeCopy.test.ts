/**
 * Every screen string about card fees, word for word. The client, the firm and
 * the receipt must say the same thing, so the wording lives in one file and is
 * pinned here exactly.
 *
 * Red if a subtitle, result, settings line, request-dialog row or refund line
 * drifts from the agreed wording, if an amount is not the formatted cents, or if
 * a debit-accepted / debit-declined branch gives the other branch's words.
 */
import {
  cardOptionSubtitle,
  cardResultCopy,
  cardFeeUnavailableReason,
  copyText,
  paymentFeeLines,
  requestFeeDescription,
  cardFeeRefundGuidance,
  CARD_FORM_INTRO,
  FEE_CHANGED,
  PAY_BY_BANK_INSTEAD,
  USE_DIFFERENT_CARD,
  CHECK_CARD,
  CARD_FORM_UNAVAILABLE,
  CARD_FORM_ERRORS,
  CARD_FEE_SETTINGS,
  BANK_FEE_SETTINGS,
  ONLINE_PAYMENT_FEES_INTRO,
  REQUEST_FEE_LABEL,
  STRIPE_SUPPORT_URL,
  PAYMENTS_HOW_IT_WORKS_PAY_STEP,
} from "@/lib/payments/cardFeeCopy";
import type { CardFeeEligibility } from "@/types/cardFees";

describe("card option subtitle", () => {
  it("tells the client debit cards have no fee", () => {
    expect(cardOptionSubtitle({ creditFeeCents: 750, debitCards: "absorb", internationalCards: "absorb" }))
      .toBe("Credit cards add a $7.50 fee. Debit cards don't.");
  });

  it("says credit only when debit is declined", () => {
    expect(cardOptionSubtitle({ creditFeeCents: 750, debitCards: "decline", internationalCards: "absorb" }))
      .toBe("Credit cards only, plus a $7.50 fee.");
  });

  it("adds the US-only sentence when non-US cards are declined", () => {
    expect(cardOptionSubtitle({ creditFeeCents: 750, debitCards: "decline", internationalCards: "decline" }))
      .toBe("Credit cards only, plus a $7.50 fee. US cards only.");
    expect(cardOptionSubtitle({ creditFeeCents: 1_234_56, debitCards: "absorb", internationalCards: "decline" }))
      .toBe("Credit cards add a $1,234.56 fee. Debit cards don't. US cards only.");
  });
});

describe("before and between checks", () => {
  it("pins the intro, the fee-changed error and the two way-out buttons", () => {
    expect(CARD_FORM_INTRO).toBe("Enter your card to see your total.");
    expect(FEE_CHANGED).toBe("Your total changed. Please review it.");
    expect(PAY_BY_BANK_INSTEAD).toBe("Pay by bank transfer instead");
    expect(USE_DIFFERENT_CARD).toBe("Use a different card");
  });
});

describe("card form controls and errors", () => {
  it("pins the check button, the unavailable notice and the fallback errors", () => {
    expect(CHECK_CARD).toBe("Check card");
    expect(CARD_FORM_UNAVAILABLE).toBe("Card payments are unavailable right now. Please pay by bank transfer.");
    expect(CARD_FORM_ERRORS).toEqual({
      details: "Check your card details.",
      check: "We couldn't check this card.",
      notVerified: "Your bank didn't confirm the payment.",
      notCharged: "Your card was not charged. Please try again or use a different card.",
      failed: "The payment didn't go through.",
    });
  });
});

describe("card result", () => {
  it("gives a credit card fee with the total and the way out, debit accepted", () => {
    expect(cardResultCopy(
      { outcome: "credit_fee", feeCents: 750, invoiceCents: 25_000, totalCents: 25_750 },
      { debitCards: "absorb" },
    )).toEqual({
      heading: "Credit card fee: $7.50",
      body: "Total $257.50. Pay by bank transfer or debit card to avoid the fee.",
      payLabel: "Pay $257.50",
      showBankInstead: true,
      showDifferentCard: false,
      footer: "The fee shows on your receipt.",
    });
  });

  it("does not suggest a debit card when the firm declines them", () => {
    expect(cardResultCopy(
      { outcome: "credit_fee", feeCents: 750, invoiceCents: 25_000, totalCents: 25_750 },
      { debitCards: "decline" },
    ).body).toBe("Total $257.50. Pay by bank transfer to avoid the fee.");
  });

  it("says a debit card has no fee", () => {
    expect(cardResultCopy(
      { outcome: "no_fee", reason: "debit", feeCents: 0, invoiceCents: 25_000, totalCents: 25_000 },
      { debitCards: "absorb" },
    )).toEqual({
      heading: "No card fee",
      body: "Debit cards have no fee. Total $250.00.",
      payLabel: "Pay $250.00",
      showBankInstead: false,
      showDifferentCard: false,
      footer: null,
    });
  });

  it("uses the same words for a prepaid card", () => {
    expect(cardResultCopy(
      { outcome: "no_fee", reason: "prepaid", feeCents: 0, invoiceCents: 25_000, totalCents: 25_000 },
      { debitCards: "absorb" },
    ).body).toBe("Debit cards have no fee. Total $250.00.");
  });

  it("charges no fee and says only the total when the card type is unknown", () => {
    expect(cardResultCopy(
      { outcome: "no_fee", reason: "unknown_funding", feeCents: 0, invoiceCents: 25_000, totalCents: 25_000 },
      { debitCards: "absorb" },
    )).toEqual({
      heading: "No card fee",
      body: "Total $250.00.",
      payLabel: "Pay $250.00",
      showBankInstead: false,
      showDifferentCard: false,
      footer: null,
    });
  });

  it("turns a declined debit card away with both ways forward and no pay button", () => {
    expect(cardResultCopy(
      { outcome: "refused", reason: "debit_not_accepted", invoiceCents: 25_000 },
      { debitCards: "decline" },
    )).toEqual({
      heading: "Debit cards aren't accepted",
      body: "Use a credit card or pay by bank transfer.",
      payLabel: null,
      showBankInstead: true,
      showDifferentCard: true,
      footer: null,
    });
  });

  it("gives a declined prepaid card the debit wording", () => {
    expect(cardResultCopy(
      { outcome: "refused", reason: "prepaid_not_accepted", invoiceCents: 25_000 },
      { debitCards: "decline" },
    ).heading).toBe("Debit cards aren't accepted");
  });

  it("turns a non-US card away", () => {
    expect(cardResultCopy(
      { outcome: "refused", reason: "non_us_not_accepted", invoiceCents: 25_000 },
      { debitCards: "absorb" },
    )).toEqual({
      heading: "Only US cards are accepted",
      body: "Use a US card or pay by bank transfer.",
      payLabel: null,
      showBankInstead: true,
      showDifferentCard: true,
      footer: null,
    });
  });
});

describe("Payments settings", () => {
  it("pins the card section wording", () => {
    expect(CARD_FEE_SETTINGS.toggleLabel).toBe("Clients pay a fee on credit cards");
    expect(CARD_FEE_SETTINGS.toggleDescription).toBe("You receive the full invoice amount.");
    expect(CARD_FEE_SETTINGS.howItWorksHeading).toBe("How card fees work");
    expect(CARD_FEE_SETTINGS.howItWorks).toEqual([
      "Credit cards only. Debit and prepaid cards can't have a fee.",
      "Up to 3% (2% in Colorado), never more than your Stripe cost.",
      "Clients see the fee before paying and can pay by bank transfer instead.",
      "Not allowed in California, Connecticut, Maine or Massachusetts.",
      "Paralegix takes no cut on these payments.",
      "If you refund a payment, refund the same share of the fee.",
    ]);
    expect(CARD_FEE_SETTINGS.debitLabel).toBe("Debit and prepaid cards");
    expect(CARD_FEE_SETTINGS.debitOptions).toEqual({
      absorb: "Accept (your firm pays the fee)",
      decline: "Don't accept",
    });
    expect(CARD_FEE_SETTINGS.internationalLabel).toBe("Cards from outside the US");
    expect(CARD_FEE_SETTINGS.internationalOptions).toEqual({
      absorb: "Accept (your firm pays an extra 1.5%)",
      decline: "Don't accept",
    });
    expect(CARD_FEE_SETTINGS.rateLabel).toBe("Your Stripe card rate");
    expect(CARD_FEE_SETTINGS.ratePercentLabel).toBe("Percent");
    expect(CARD_FEE_SETTINGS.rateFixedLabel).toBe("Cents");
    expect(CARD_FEE_SETTINGS.rateHelp).toBe("Change only if Stripe gave you a custom rate.");
    expect(CARD_FEE_SETTINGS.notifiedOnLabel).toBe("Date you told Stripe");
    expect(CARD_FEE_SETTINGS.notifiedOnHelp).toEqual([
      "Required 30 days before you start. ",
      { link: "Contact Stripe support", to: "stripe_support" },
      " and say you'll add a credit card fee.",
    ]);
    expect(STRIPE_SUPPORT_URL).toBe("https://support.stripe.com/contact");
    expect(CARD_FEE_SETTINGS.engagementLetter).toBe("Our engagement letters mention this fee.");
    expect(CARD_FEE_SETTINGS.stateLabel).toBe("Your firm's state");
    expect(CARD_FEE_SETTINGS.stateHelp).toBe("Card fee rules depend on your state.");
    expect(CARD_FEE_SETTINGS.stateAskAdmin).toBe("Ask a firm admin to add your firm's state.");
  });

  it("pins the Online Payment Fees intro", () => {
    expect(ONLINE_PAYMENT_FEES_INTRO).toBe("Your firm pays online processing fees unless you pass them on.");
  });

  it("pins the bank section wording", () => {
    expect(BANK_FEE_SETTINGS.toggleLabel).toBe("Clients pay the bank transfer fee");
    expect(BANK_FEE_SETTINGS.description).toBe("0.8% (max $5) plus 0.9%. You receive the full amount.");
  });

  it("says why card fees are not available, with no links", () => {
    const ctx = { state: "CT", availableFrom: "2026-10-31" };
    expect(cardFeeUnavailableReason("stripe_not_connected", ctx)).toEqual(["Connect Stripe above first."]);
    expect(cardFeeUnavailableReason("state_banned", ctx)).toEqual(["Not allowed for firms in Connecticut."]);
    expect(cardFeeUnavailableReason("notice_period", ctx)).toEqual(["Available from 10/31/2026."]);
  });

  it("names each state where card fees are blocked", () => {
    expect(copyText(cardFeeUnavailableReason("state_banned", { state: "CA", availableFrom: null }))).toBe("Not allowed for firms in California.");
    expect(copyText(cardFeeUnavailableReason("state_banned", { state: "MA", availableFrom: null }))).toBe("Not allowed for firms in Massachusetts.");
    expect(copyText(cardFeeUnavailableReason("state_banned", { state: "ME", availableFrom: null }))).toBe("Not allowed for firms in Maine.");
  });

  it("reads a linked sentence as plain text", () => {
    expect(copyText(requestFeeDescription({
      eligibility: { eligible: false, reasons: ["state_missing"], state: null },
      debitAccepted: true,
    }))).toBe("Applies to bank transfers only. Set up card fees to include cards.");
  });
});

describe("request payment dialog", () => {
  const eligible = { eligible: true, reasons: [] };

  it("pins the one checkbox label", () => {
    expect(REQUEST_FEE_LABEL).toBe("Client pays the processing fee");
  });

  it("says debit cards never have a fee when the firm accepts them", () => {
    expect(requestFeeDescription({ eligibility: eligible, debitAccepted: true }))
      .toEqual(["Applies to credit cards and bank transfers. Debit cards never have a fee."]);
  });

  it("says debit cards are refused when the firm declines them", () => {
    expect(requestFeeDescription({ eligibility: eligible, debitAccepted: false }))
      .toEqual(["Applies to credit cards and bank transfers. Debit cards aren't accepted."]);
  });

  it("treats a quote with no eligibility as eligible", () => {
    expect(copyText(requestFeeDescription({ eligibility: undefined, debitAccepted: true })))
      .toBe("Applies to credit cards and bank transfers. Debit cards never have a fee.");
  });

  it("says only bank transfers are covered, and links to card fee setup, for a firm that may not pass the card fee on", () => {
    const ineligible = (reasons: string[]) => ({
      eligibility: { eligible: false, reasons, state: "TX", availableFrom: "2026-10-31" } as CardFeeEligibility,
      debitAccepted: true,
    });
    for (const reasons of [["state_missing", "not_confirmed"], ["stripe_not_connected"], ["not_confirmed"], ["notice_period"]]) {
      expect(requestFeeDescription(ineligible(reasons))).toEqual([
        "Applies to bank transfers only. ",
        { link: "Set up card fees", to: "payments_settings" },
        " to include cards.",
      ]);
    }
  });

  it("names the state, with no link, where card fees are banned", () => {
    expect(requestFeeDescription({
      eligibility: { eligible: false, reasons: ["state_banned", "not_confirmed"], state: "CT", availableFrom: null },
      debitAccepted: true,
    })).toEqual(["Applies to bank transfers only. Card fees aren't allowed in Connecticut."]);
  });

  it("gives one short line per method when the firm pays both fees", () => {
    expect(paymentFeeLines([
      { method: "card", paidBy: "firm", feeCents: 1_015, clientPaysCents: 25_000, firmReceivesCents: 23_985 },
      { method: "bank", paidBy: "firm", feeCents: 430, clientPaysCents: 25_000, firmReceivesCents: 24_570 },
    ])).toEqual([
      { label: "Card", text: "Card: You pay the $10.15 fee. You get $239.85." },
      { label: "Bank transfer", text: "Bank transfer: You pay the $4.30 fee. You get $245.70." },
    ]);
  });

  it("gives the credit card, an accepted debit card and the bank transfer when the client pays, and no non-US line", () => {
    expect(paymentFeeLines([
      {
        method: "card",
        paidBy: "client",
        cardRows: [
          { kind: "us_credit", paidBy: "client", feeCents: 750, clientPaysCents: 25_750, firmReceivesCents: 24_973 },
          { kind: "debit", paidBy: "firm", feeCents: 1_000, clientPaysCents: 25_000, firmReceivesCents: 24_000 },
          { kind: "non_us_credit", paidBy: "client", feeCents: 750, clientPaysCents: 25_750, firmReceivesCents: 24_587 },
        ],
      },
      { method: "bank", paidBy: "client", feeCents: 430, clientPaysCents: 25_430, firmReceivesCents: 25_000 },
    ])).toEqual([
      { label: "Credit card", text: "Credit card: Client pays the $7.50 fee. You get $249.73." },
      { label: "Debit card", text: "Debit card: No fee. You pay about $10.00." },
      { label: "Bank transfer", text: "Bank transfer: Client pays the $4.30 fee. You get $250.00." },
    ]);
  });

  it("leaves out a declined debit card", () => {
    expect(paymentFeeLines([
      {
        method: "card",
        paidBy: "client",
        cardRows: [
          { kind: "us_credit", paidBy: "client", feeCents: 750, clientPaysCents: 25_750, firmReceivesCents: 24_973 },
          { kind: "debit", accepted: false },
          { kind: "non_us_credit", accepted: false },
        ],
      },
    ])).toEqual([{ label: "Credit card", text: "Credit card: Client pays the $7.50 fee. You get $249.73." }]);
  });

  it("gives a client-paid card with no rows the same shape as the bank line", () => {
    expect(paymentFeeLines([
      { method: "card", paidBy: "client", feeCents: 1_998, clientPaysCents: 51_998, firmReceivesCents: 50_000 },
    ])).toEqual([{ label: "Card", text: "Card: Client pays the $19.98 fee. You get $500.00." }]);
  });
});

describe("payment detail and Payments settings", () => {
  it("tells the firm how much card fee to refund", () => {
    expect(cardFeeRefundGuidance(750)).toBe("Includes a $7.50 card fee. Refund the same share of it with any refund.");
  });

  it("pins the How it works pay step", () => {
    expect(PAYMENTS_HOW_IT_WORKS_PAY_STEP).toBe(
      "The client gets a secure link and pays by card or bank transfer. If you pass on card fees, credit card payments include the fee and debit cards never do.",
    );
  });
});
