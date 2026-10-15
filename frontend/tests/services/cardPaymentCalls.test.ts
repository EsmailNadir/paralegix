/**
 * The card form's three server calls, on the no-login pay link and in the
 * client portal: check a card (quote), charge it (confirm), and finish after the
 * bank's verification step (complete).
 *
 * Driven through the real services with only the transport faked. Red if a call
 * goes to the wrong route, drops the confirmation token or the total the client
 * saw, puts the portal's client record anywhere but the query, or loses the
 * error code the card form branches on (FEE_CHANGED and friends).
 */
jest.unmock("@/services/client-portal.service");
jest.unmock("@/services/requestDeduplicator");

import { installApiMock, type ApiMock } from "../support/apiMock";
import { ApiError } from "@/lib/utils/apiErrors";
import payLinkService from "@/services/payLink.service";
import clientPortalService from "@/services/client-portal.service";

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

const CREDIT_QUOTE = {
  outcome: "credit_fee",
  feeCents: 750,
  invoiceCents: 25_000,
  totalCents: 25_750,
  card: { brand: "visa", last4: "4242", funding: "credit", country: "US" },
};

describe("pay link", () => {
  it("quotes a card by its confirmation token", async () => {
    api.postExact("/api/pay/tok_1/card/quote", CREDIT_QUOTE);

    await expect(payLinkService.quoteCard("tok_1", "ctoken_a")).resolves.toEqual(CREDIT_QUOTE);

    expect(api.calls("POST")[0].body).toEqual({ confirmationTokenId: "ctoken_a" });
  });

  it("confirms with the total the client saw", async () => {
    api.postExact("/api/pay/tok_1/card/confirm", { status: "requires_action", clientSecret: "pi_2_secret" });

    await expect(payLinkService.confirmCard("tok_1", "ctoken_a", 25_750))
      .resolves.toEqual({ status: "requires_action", clientSecret: "pi_2_secret" });

    expect(api.calls("POST")[0].body).toEqual({ confirmationTokenId: "ctoken_a", expectedTotalCents: 25_750 });
  });

  it("completes by PaymentIntent id", async () => {
    api.postExact("/api/pay/tok_1/card/complete", { status: "succeeded" });

    await expect(payLinkService.completeCard("tok_1", "pi_2")).resolves.toEqual({ status: "succeeded" });

    expect(api.calls("POST")[0].body).toEqual({ paymentIntentId: "pi_2" });
  });

  it("keeps the server's error code so the form can tell a changed fee from a decline", async () => {
    api.postExact("/api/pay/tok_1/card/confirm", {
      status: 409,
      body: { error: "Your total changed. Please review it.", code: "FEE_CHANGED" },
    });

    const err = await payLinkService.confirmCard("tok_1", "ctoken_a", 25_000).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("FEE_CHANGED");
    expect(err.status).toBe(409);
    expect(err.message).toBe("Your total changed. Please review it.");
  });
});

describe("client portal", () => {
  const base = "/api/client-portal/lawfirm/firm-1/billing/pay/inv-1/card";

  it("quotes with the client record in the query", async () => {
    api.post(`${base}/quote`, CREDIT_QUOTE);

    await expect(clientPortalService.quoteCard("firm-1", "inv-1", "rec-3", "ctoken_a")).resolves.toEqual(CREDIT_QUOTE);

    const [call] = api.calls("POST");
    expect(call.pathname).toBe(`${base}/quote`);
    expect(call.query).toEqual({ clientRecordId: ["rec-3"] });
    expect(call.body).toEqual({ confirmationTokenId: "ctoken_a" });
  });

  it("confirms with the total the client saw", async () => {
    api.post(`${base}/confirm`, { status: "succeeded" });

    await expect(clientPortalService.confirmCard("firm-1", "inv-1", undefined, "ctoken_a", 25_750))
      .resolves.toEqual({ status: "succeeded" });

    const [call] = api.calls("POST");
    expect(call.pathname).toBe(`${base}/confirm`);
    expect(call.query).toEqual({});
    expect(call.body).toEqual({ confirmationTokenId: "ctoken_a", expectedTotalCents: 25_750 });
  });

  it("completes by PaymentIntent id", async () => {
    api.post(`${base}/complete`, { status: "processing" });

    await expect(clientPortalService.completeCard("firm-1", "inv-1", "rec-3", "pi_2")).resolves.toEqual({ status: "processing" });

    expect(api.calls("POST")[0].body).toEqual({ paymentIntentId: "pi_2" });
  });

  it("keeps the server's error code and message for a declined card", async () => {
    api.post(`${base}/confirm`, { status: 402, body: { error: "Your card was declined.", code: "CARD_DECLINED" } });

    const err = await clientPortalService.confirmCard("firm-1", "inv-1", "rec-3", "ctoken_a", 25_750).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("CARD_DECLINED");
    expect(err.message).toBe("Your card was declined.");
  });
});
