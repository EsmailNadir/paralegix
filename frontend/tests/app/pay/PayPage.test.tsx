/**
 * The no-login pay page a secure payment link opens. A client who has never
 * had a portal account sees the invoice, chooses card or bank transfer with
 * any processing fee shown, and is sent to checkout for that method.
 *
 * Driven through the real service with only the transport faked. Red if a
 * method's fee or total is missing, if the choice does not reach the server,
 * or if a dead, paid or returning link shows a pay button.
 */
import React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../../setup";
import { setupApiMock } from "../../support/apiMock";
import { renderWithProviders } from "../../support/renderWithProviders";
import { scanAccessibility } from "../../support/accessibility";

let mockSearch = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useParams: () => ({ token: "tok_pay_page" }),
  useSearchParams: () => mockSearch,
}));

// The card form talks to Stripe.js; fake it at the React Stripe.js boundary so
// the pay page and the real pay link service run as they are.
const mockStripe = { createConfirmationToken: jest.fn(), handleNextAction: jest.fn() };
jest.mock("@stripe/react-stripe-js", () => {
  const ReactLib = require("react");
  return {
    Elements: ({ children }: { children: React.ReactNode }) => ReactLib.createElement(ReactLib.Fragment, null, children),
    PaymentElement: () => ReactLib.createElement("div", { "data-testid": "payment-element" }),
    useStripe: () => mockStripe,
    useElements: () => ({ submit: () => Promise.resolve({}) }),
  };
});
jest.mock("@/lib/payments/stripeClient", () => ({ stripeForAccount: () => Promise.resolve({ fake: "stripe" }) }));

import PayPage from "@/app/pay/[token]/page";

const api = setupApiMock();
let startUrl: string;

const page = {
  firmName: "Pay Link LLP",
  invoiceName: "INV-PAY-1",
  dueDate: "2026-11-03",
  isPaid: false,
  invoiceCents: 25_000,
  methods: [
    { method: "card", feeCents: 1_019, totalCents: 26_019 },
    { method: "bank", feeCents: 0, totalCents: 25_000 },
  ],
};

beforeEach(() => {
  mockSearch = new URLSearchParams();
  startUrl = window.location.href.split("#")[0];
});

afterEach(() => {
  window.history.replaceState(null, "", startUrl);
});

it("shows who is asking, for what, and what each method costs", async () => {
  api.get("/pay/tok_pay_page", page);

  renderWithProviders(<PayPage />);

  expect(await screen.findByRole("heading", { name: "Pay Pay Link LLP" })).toBeInTheDocument();
  expect(screen.getByText(/INV-PAY-1/)).toBeInTheDocument();
  const card = screen.getByRole("button", { name: /Card/ });
  expect(card).toHaveTextContent("+ $10.19 processing fee");
  expect(card).toHaveTextContent("You pay $260.19");
  expect(screen.getByRole("button", { name: /Bank transfer/ })).toHaveTextContent("No fee");
});

it("sends the client to checkout for the method they pick", async () => {
  api.get("/pay/tok_pay_page", page);
  api.post("/pay/tok_pay_page/checkout", { checkoutUrl: `${window.location.href.split("#")[0]}#stripe-bank` });
  const user = userEvent.setup();
  renderWithProviders(<PayPage />);

  await user.click(await screen.findByRole("button", { name: /Bank transfer/ }));

  await waitFor(() => expect(window.location.hash).toBe("#stripe-bank"));
  expect(api.calls("POST")[0].body).toEqual({ method: "bank" });
});

it("says a link that matches nothing is no longer valid, with nothing to pay", async () => {
  api.get("/pay/tok_pay_page", { status: 404, body: { error: "Payment link not found" } });
  api.allowUnhandled();

  renderWithProviders(<PayPage />);

  expect(await screen.findByRole("heading", { name: "This payment link is no longer valid" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Card/ })).not.toBeInTheDocument();
});

it("says a paid invoice is paid", async () => {
  api.get("/pay/tok_pay_page", { ...page, isPaid: true, invoiceCents: 0, methods: [] });

  renderWithProviders(<PayPage />);

  expect(await screen.findByRole("heading", { name: "This invoice is paid" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Card/ })).not.toBeInTheDocument();
});

it("thanks a client who comes back from checkout", async () => {
  mockSearch = new URLSearchParams("payment=success");
  api.get("/pay/tok_pay_page", page);

  renderWithProviders(<PayPage />);

  expect(await screen.findByRole("heading", { name: "Thank you for your payment" })).toBeInTheDocument();
  // A bank transfer takes days to clear, so the page must not offer to pay again.
  expect(screen.queryByRole("button", { name: /Card/ })).not.toBeInTheDocument();
});

it("still thanks a returning client once the paid link answers 404", async () => {
  // A paid link ends its request, so the page the client returns to no longer resolves.
  mockSearch = new URLSearchParams("payment=success");
  api.get("/pay/tok_pay_page", { status: 404, body: { error: "Payment link not found" } });
  api.allowUnhandled();

  renderWithProviders(<PayPage />);

  expect(await screen.findByRole("heading", { name: "Thank you for your payment" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "This payment link is no longer valid" })).not.toBeInTheDocument();
});

it("names the installment a link is for", async () => {
  api.get("/pay/tok_pay_page", { ...page, installmentNumber: 3 });

  renderWithProviders(<PayPage />);

  expect(await screen.findByText(/Installment 3 of invoice INV-PAY-1/)).toBeInTheDocument();
});

describe("an invoice whose card fee the client pays", () => {
  const cardFormPage = {
    ...page,
    methods: [
      { method: "card", feeCents: 0, totalCents: 25_000 },
      { method: "bank", feeCents: 0, totalCents: 25_000 },
    ],
    card: { flow: "card_form", stripeAccountId: "acct_card", creditFeeCents: 750, debitCards: "absorb", internationalCards: "absorb" },
  };

  beforeEach(() => {
    mockStripe.createConfirmationToken.mockReset().mockResolvedValue({ confirmationToken: { id: "ctoken_pay" } });
  });

  it("says what a credit card adds, and no card total before the card is known", async () => {
    api.get("/pay/tok_pay_page", cardFormPage);

    renderWithProviders(<PayPage />);

    const card = await screen.findByRole("button", { name: /Card/ });
    expect(card).toHaveTextContent("Credit cards add a $7.50 fee. Debit cards don't.");
    expect(card).not.toHaveTextContent("You pay");
    expect(screen.getByRole("button", { name: /Bank transfer/ })).toHaveTextContent("You pay $250.00");
  });

  it("opens the card form instead of checkout, and Back returns to the choice", async () => {
    api.get("/pay/tok_pay_page", cardFormPage);
    const user = userEvent.setup();
    renderWithProviders(<PayPage />);

    await user.click(await screen.findByRole("button", { name: /Card/ }));

    expect(await screen.findByRole("button", { name: "Check card" })).toBeInTheDocument();
    expect(api.calls("POST")).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /Bank transfer/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check card" })).not.toBeInTheDocument();
  });

  it("checks the card, pays the quoted total and thanks the client", async () => {
    api.get("/pay/tok_pay_page", cardFormPage);
    api.post("/pay/tok_pay_page/card/quote", {
      outcome: "credit_fee", feeCents: 750, invoiceCents: 25_000, totalCents: 25_750,
      card: { brand: "visa", last4: "4242", funding: "credit", country: "US" },
    });
    api.post("/pay/tok_pay_page/card/confirm", { status: "succeeded" });
    const user = userEvent.setup();
    renderWithProviders(<PayPage />);

    await user.click(await screen.findByRole("button", { name: /Card/ }));
    await user.click(await screen.findByRole("button", { name: "Check card" }));
    expect(await screen.findByRole("heading", { name: "Credit card fee: $7.50" })).toBeInTheDocument();
    expect(screen.getByText("Total $257.50. Pay by bank transfer or debit card to avoid the fee.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pay $257.50" }));

    expect(await screen.findByRole("heading", { name: "Thank you for your payment" })).toBeInTheDocument();
    expect(api.callsTo("/pay/tok_pay_page/card/quote")[0].body).toEqual({ confirmationTokenId: "ctoken_pay" });
    expect(api.callsTo("/pay/tok_pay_page/card/confirm")[0].body).toEqual({ confirmationTokenId: "ctoken_pay", expectedTotalCents: 25_750 });
  });

  it("sends a client who would rather avoid the fee to bank transfer checkout", async () => {
    api.get("/pay/tok_pay_page", cardFormPage);
    api.post("/pay/tok_pay_page/card/quote", {
      outcome: "credit_fee", feeCents: 750, invoiceCents: 25_000, totalCents: 25_750,
      card: { brand: "visa", last4: "4242", funding: "credit", country: "US" },
    });
    api.post("/pay/tok_pay_page/checkout", { checkoutUrl: `${window.location.href.split("#")[0]}#stripe-bank` });
    const user = userEvent.setup();
    renderWithProviders(<PayPage />);

    await user.click(await screen.findByRole("button", { name: /Card/ }));
    await user.click(await screen.findByRole("button", { name: "Check card" }));
    await user.click(await screen.findByRole("button", { name: "Pay by bank transfer instead" }));

    await waitFor(() => expect(window.location.hash).toBe("#stripe-bank"));
    expect(api.callsTo("/pay/tok_pay_page/checkout")[0].body).toEqual({ method: "bank" });
  });

  it("completes the payment and thanks a client who comes back from their bank's verification page", async () => {
    mockSearch = new URLSearchParams("payment=card_return&payment_intent=pi_3ds&payment_intent_client_secret=pi_3ds_secret");
    api.post("/pay/tok_pay_page/card/complete", { status: "succeeded" });

    renderWithProviders(<PayPage />);

    expect(await screen.findByRole("heading", { name: "Thank you for your payment" })).toBeInTheDocument();
    expect(api.callsTo("/pay/tok_pay_page/card/complete")[0].body).toEqual({ paymentIntentId: "pi_3ds" });
    expect(screen.queryByRole("button", { name: /Card/ })).not.toBeInTheDocument();
    // A recorded payment ends the link, so the page itself is not reloaded.
    expect(api.calls("GET")).toEqual([]);
  });

  it("thanks a client whose verified payment is still processing", async () => {
    mockSearch = new URLSearchParams("payment=card_return&payment_intent=pi_3ds");
    api.post("/pay/tok_pay_page/card/complete", { status: "processing" });

    renderWithProviders(<PayPage />);

    expect(await screen.findByRole("heading", { name: "Thank you for your payment" })).toBeInTheDocument();
  });

  it("says the card was not charged, with the choices again, when verification failed", async () => {
    mockSearch = new URLSearchParams("payment=card_return&payment_intent=pi_3ds");
    api.post("/pay/tok_pay_page/card/complete", { status: "failed" });
    api.get("/pay/tok_pay_page", cardFormPage);

    renderWithProviders(<PayPage />);

    expect(await screen.findByText("Your card was not charged. Please try again or use a different card.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Card/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bank transfer/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Thank you for your payment" })).not.toBeInTheDocument();
  });

  it("loads the page as usual when the return carries no payment", async () => {
    mockSearch = new URLSearchParams("payment=card_return");
    api.get("/pay/tok_pay_page", cardFormPage);

    renderWithProviders(<PayPage />);

    expect(await screen.findByRole("button", { name: /Card/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Thank you for your payment" })).not.toBeInTheDocument();
    expect(api.calls("POST")).toEqual([]);
  });

  it("still sends a card to hosted checkout when the firm pays the card fee", async () => {
    api.get("/pay/tok_pay_page", { ...page, card: { flow: "checkout" } });
    api.post("/pay/tok_pay_page/checkout", { checkoutUrl: `${window.location.href.split("#")[0]}#stripe-card` });
    const user = userEvent.setup();
    renderWithProviders(<PayPage />);

    await user.click(await screen.findByRole("button", { name: /Card/ }));

    await waitFor(() => expect(window.location.hash).toBe("#stripe-card"));
    expect(api.calls("POST")[0].body).toEqual({ method: "card" });
    expect(screen.queryByRole("button", { name: "Check card" })).not.toBeInTheDocument();
  });

  it("has no accessibility violations with the card form open", async () => {
    api.get("/pay/tok_pay_page", cardFormPage);
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PayPage />);

    await user.click(await screen.findByRole("button", { name: /Card/ }));
    await screen.findByRole("button", { name: "Check card" });

    expect((await scanAccessibility(container)).violations).toEqual([]);
  });
});
