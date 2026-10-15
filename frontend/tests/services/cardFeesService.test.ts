/**
 * The firm's credit card fee setting, read and written through its own route,
 * which checks the firm may pass the fee on before switching it on.
 *
 * Red if either call misses `/lawfirms/:id/billing/card-fees`, if the body
 * drops a field the route requires, or if a refusal loses the server's reasons.
 */
import { installApiMock, type ApiMock } from "../support/apiMock";
import { ApiError } from "@/lib/utils/apiErrors";
import cardFeesService from "@/services/cardFees.service";

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

const STATE = {
  clientPays: false,
  debitCards: "absorb",
  internationalCards: "absorb",
  ratePercent: 2.9,
  fixedCents: 30,
  confirmation: null,
  eligibility: { eligible: false, reasons: ["not_confirmed"], state: "TX", capPercent: 3, availableFrom: null },
};

it("reads the setting with its eligibility", async () => {
  api.getExact("/api/lawfirms/firm-1/billing/card-fees", STATE);

  await expect(cardFeesService.getCardFees("firm-1")).resolves.toEqual(STATE);
});

it("writes the whole setting, confirmation included", async () => {
  api.putExact("/api/lawfirms/firm-1/billing/card-fees", { ...STATE, clientPays: true });
  const body = {
    clientPays: true,
    debitCards: "decline" as const,
    internationalCards: "absorb" as const,
    ratePercent: 2.9,
    fixedCents: 30,
    stripeNotifiedOn: "2026-08-01",
    engagementLetterConfirmed: true,
  };

  await cardFeesService.updateCardFees("firm-1", body);

  expect(api.calls("PUT")[0].body).toEqual(body);
});

it("keeps the server's refusal for the settings card to show", async () => {
  api.putExact("/api/lawfirms/firm-1/billing/card-fees", {
    status: 400,
    body: {
        error: "You can turn this on from 2026-11-04, 30 days after you told Stripe.",
        code: "VALIDATION_ERROR",
        details: { cardFees: ["You can turn this on from 2026-11-04, 30 days after you told Stripe."] },
      },
  });

  const err = await cardFeesService.updateCardFees("firm-1", {
    clientPays: true, debitCards: "absorb", internationalCards: "absorb", ratePercent: 2.9, fixedCents: 30,
  }).catch((e) => e);

  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(400);
  expect(err.details).toEqual({ cardFees: ["You can turn this on from 2026-11-04, 30 days after you told Stripe."] });
});
