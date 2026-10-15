/**
 * The card form for an invoice whose card fee the client pays. The card is
 * checked before anything is charged, so the client always sees the exact fee,
 * or why there is none, or why the card is not accepted, before a pay button.
 *
 * Stripe.js is faked at the React Stripe.js boundary; the three server calls are
 * props. Red if a pay button appears before the check or for a refused card, if
 * the charge is sent with a total other than the one on screen, if the bank's
 * verification step is skipped, if a changed fee or a decline leaves a stale pay
 * button, or if the result panel fails the accessibility scan.
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/utils/apiErrors";
import { scanAccessibility } from "../../support/accessibility";

const mockStripe = { createConfirmationToken: jest.fn(), handleNextAction: jest.fn() };
const mockElements = { submit: jest.fn() };
const mockStripeForAccount = jest.fn();
let mockElementsOptions: Record<string, unknown> | null = null;
let mockPaymentElementOptions: Record<string, unknown> | null = null;
let mockPaymentElementChange: (() => void) | null = null;

jest.mock("@stripe/react-stripe-js", () => {
  const ReactLib = require("react");
  return {
    Elements: ({ children, options }: { children: React.ReactNode; options: Record<string, unknown> }) => {
      mockElementsOptions = options;
      return ReactLib.createElement(ReactLib.Fragment, null, children);
    },
    PaymentElement: ({ onChange, options }: { onChange: () => void; options: Record<string, unknown> }) => {
      mockPaymentElementChange = onChange;
      mockPaymentElementOptions = options;
      return ReactLib.createElement("div", { "data-testid": "payment-element" });
    },
    useStripe: () => mockStripe,
    useElements: () => mockElements,
  };
});
jest.mock("@/lib/payments/stripeClient", () => ({
  stripeForAccount: (...args: unknown[]) => mockStripeForAccount(...args),
}));

import CardPaymentPanel from "@/components/portalComp/CardPaymentPanel";
import type { CardSetup } from "@/types/cardFees";

const SETUP: CardSetup = {
  flow: "card_form",
  stripeAccountId: "acct_card",
  creditFeeCents: 750,
  debitCards: "absorb",
  internationalCards: "absorb",
};
const CARD = { brand: "visa", last4: "4242", funding: "credit", country: "US" };
const CREDIT = { outcome: "credit_fee", feeCents: 750, invoiceCents: 25_000, totalCents: 25_750, card: CARD } as const;

let quote: jest.Mock;
let confirm: jest.Mock;
let complete: jest.Mock;
let onPaid: jest.Mock;
let onPayByBank: jest.Mock;

beforeEach(() => {
  mockElementsOptions = null;
  mockPaymentElementOptions = null;
  mockPaymentElementChange = null;
  mockStripeForAccount.mockReset().mockResolvedValue({ fake: "stripe" });
  mockElements.submit.mockReset().mockResolvedValue({});
  mockStripe.createConfirmationToken.mockReset().mockResolvedValue({ confirmationToken: { id: "ctoken_test" } });
  mockStripe.handleNextAction.mockReset();
  quote = jest.fn().mockResolvedValue(CREDIT);
  confirm = jest.fn().mockResolvedValue({ status: "succeeded" });
  complete = jest.fn();
  onPaid = jest.fn();
  onPayByBank = jest.fn();
});

function renderPanel(props: Partial<React.ComponentProps<typeof CardPaymentPanel>> = {}) {
  return render(
    <CardPaymentPanel
      setup={SETUP}
      invoiceCents={25_000}
      api={{ quote, confirm, complete }}
      onPaid={onPaid}
      onPayByBank={onPayByBank}
      {...props}
    />,
  );
}

async function checkCard() {
  await userEvent.click(await screen.findByRole("button", { name: "Check card" }));
}

it("loads Stripe on the firm's account with a card-only form and no wallets", async () => {
  renderPanel();

  expect(await screen.findByTestId("payment-element")).toBeInTheDocument();
  expect(mockStripeForAccount).toHaveBeenCalledWith("acct_card");
  expect(mockElementsOptions).toMatchObject({ mode: "payment", amount: 25_000, currency: "usd", allowedPaymentMethodTypes: ["card"] });
  expect(mockPaymentElementOptions).toMatchObject({ wallets: { applePay: "never", googlePay: "never", link: "never" } });
  expect(screen.getByText("Enter your card to see your total.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Pay \$/ })).not.toBeInTheDocument();
});

it("checks the card, shows the credit card fee, and pays the quoted total", async () => {
  renderPanel();

  await checkCard();

  expect(await screen.findByRole("heading", { name: "Credit card fee: $7.50" })).toBeInTheDocument();
  expect(quote).toHaveBeenCalledWith("ctoken_test");
  expect(screen.getByText(
    "Total $257.50. Pay by bank transfer or debit card to avoid the fee.",
  )).toBeInTheDocument();
  expect(screen.getByText("The fee shows on your receipt.")).toBeInTheDocument();
  expect(screen.queryByText("Enter your card to see your total.")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Pay $257.50" }));

  expect(confirm).toHaveBeenCalledWith("ctoken_test", 25_750);
  await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
});

it("offers bank transfer instead of paying the fee", async () => {
  renderPanel();
  await checkCard();

  await userEvent.click(await screen.findByRole("button", { name: "Pay by bank transfer instead" }));

  expect(onPayByBank).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
});

it("charges a debit card the invoice amount with no fee", async () => {
  quote.mockResolvedValue({ outcome: "no_fee", reason: "debit", feeCents: 0, invoiceCents: 25_000, totalCents: 25_000, card: CARD });
  renderPanel();
  await checkCard();

  expect(await screen.findByRole("heading", { name: "No card fee" })).toBeInTheDocument();
  expect(screen.getByText("Debit cards have no fee. Total $250.00.")).toBeInTheDocument();
  expect(screen.queryByText("The fee shows on your receipt.")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Pay $250.00" }));

  expect(confirm).toHaveBeenCalledWith("ctoken_test", 25_000);
});

it("never shows a pay button for a declined debit card, and offers bank transfer or another card", async () => {
  quote.mockResolvedValue({ outcome: "refused", reason: "debit_not_accepted", invoiceCents: 25_000, card: CARD });
  renderPanel({ setup: { ...SETUP, debitCards: "decline" } });
  await checkCard();

  expect(await screen.findByRole("heading", { name: "Debit cards aren't accepted" })).toBeInTheDocument();
  expect(screen.getByText(
    "Use a credit card or pay by bank transfer.",
  )).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Pay \$/ })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Use a different card" }));
  expect(screen.queryByRole("heading", { name: "Debit cards aren't accepted" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check card" })).toBeInTheDocument();

  await checkCard();
  await userEvent.click(await screen.findByRole("button", { name: "Pay by bank transfer instead" }));
  expect(onPayByBank).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
});

it("clears the result when the client edits the card, so a stale total is never paid", async () => {
  renderPanel();
  await checkCard();
  expect(await screen.findByRole("button", { name: "Pay $257.50" })).toBeInTheDocument();

  act(() => mockPaymentElementChange?.());

  expect(screen.queryByRole("button", { name: "Pay $257.50" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check card" })).toBeInTheDocument();
});

it("runs the bank verification step and then completes", async () => {
  confirm.mockResolvedValue({ status: "requires_action", clientSecret: "pi_card_2_secret" });
  mockStripe.handleNextAction.mockResolvedValue({ paymentIntent: { id: "pi_card_2" } });
  complete.mockResolvedValue({ status: "succeeded" });
  renderPanel();
  await checkCard();

  await userEvent.click(await screen.findByRole("button", { name: "Pay $257.50" }));

  await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
  expect(mockStripe.handleNextAction).toHaveBeenCalledWith({ clientSecret: "pi_card_2_secret" });
  expect(complete).toHaveBeenCalledWith("pi_card_2");
});

it("shows the bank's refusal and does not complete when verification fails", async () => {
  confirm.mockResolvedValue({ status: "requires_action", clientSecret: "pi_card_2_secret" });
  mockStripe.handleNextAction.mockResolvedValue({ error: { message: "We are unable to authenticate your payment method." } });
  renderPanel();
  await checkCard();

  await userEvent.click(await screen.findByRole("button", { name: "Pay $257.50" }));

  expect(await screen.findByText("We are unable to authenticate your payment method.")).toBeInTheDocument();
  expect(complete).not.toHaveBeenCalled();
  expect(onPaid).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Check card" })).toBeInTheDocument();
});

it("asks the client to review again when the fee changed", async () => {
  confirm.mockRejectedValue(new ApiError("Your total changed. Please review it.", { status: 409, code: "FEE_CHANGED" }));
  renderPanel();
  await checkCard();

  await userEvent.click(await screen.findByRole("button", { name: "Pay $257.50" }));

  expect(await screen.findByText("Your total changed. Please review it.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pay $257.50" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check card" })).toBeInTheDocument();
  expect(onPaid).not.toHaveBeenCalled();
});

it("shows Stripe's own decline message and returns to the check step", async () => {
  confirm.mockRejectedValue(new ApiError("Your card has insufficient funds.", { status: 402, code: "CARD_DECLINED" }));
  renderPanel();
  await checkCard();

  await userEvent.click(await screen.findByRole("button", { name: "Pay $257.50" }));

  expect(await screen.findByText("Your card has insufficient funds.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check card" })).toBeInTheDocument();
  expect(onPaid).not.toHaveBeenCalled();
});

it("says the card was not charged when the payment ends failed", async () => {
  confirm.mockResolvedValue({ status: "failed" });
  renderPanel();
  await checkCard();

  await userEvent.click(await screen.findByRole("button", { name: "Pay $257.50" }));

  expect(await screen.findByText("Your card was not charged. Please try again or use a different card.")).toBeInTheDocument();
  expect(onPaid).not.toHaveBeenCalled();
});

it("treats a payment still processing as paid", async () => {
  confirm.mockResolvedValue({ status: "processing" });
  renderPanel();
  await checkCard();

  await userEvent.click(await screen.findByRole("button", { name: "Pay $257.50" }));

  await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
});

it("shows the form's own message for incomplete card details and asks the server nothing", async () => {
  mockElements.submit.mockResolvedValue({ error: { message: "Your card number is incomplete." } });
  renderPanel();

  await checkCard();

  expect(await screen.findByText("Your card number is incomplete.")).toBeInTheDocument();
  expect(mockStripe.createConfirmationToken).not.toHaveBeenCalled();
  expect(quote).not.toHaveBeenCalled();
});

it("points the client to bank transfer when card payments cannot load", async () => {
  mockStripeForAccount.mockResolvedValue(null);
  renderPanel();

  expect(await screen.findByText("Card payments are unavailable right now. Please pay by bank transfer.")).toBeInTheDocument();
  expect(screen.queryByTestId("payment-element")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Pay by bank transfer instead" }));
  expect(onPayByBank).toHaveBeenCalledTimes(1);
});

it("has no accessibility violations in the result state", async () => {
  const { container } = renderPanel();
  await checkCard();
  await screen.findByRole("heading", { name: "Credit card fee: $7.50" });

  expect((await scanAccessibility(container)).violations).toEqual([]);
});
