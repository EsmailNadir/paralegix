/**
 * The generic firm-settings PUT and the card fee. The credit card fee is turned
 * on only through PUT /billing/card-fees, which checks the firm may use it, so
 * the generic route refuses `billing.cardFees` and any `processingFees.card`
 * other than 'firm'. Every billing setting on the page saves by spreading the
 * whole `settings.billing` it holds, so those two keys must never ride along.
 * The server deep-merges the patch, so leaving them out keeps what is stored.
 *
 * Red if either key reaches the generic route (every billing save would then be
 * refused once a firm has card fees on), or if the bank fee or another billing
 * setting is dropped with them.
 */
jest.unmock("@/services/settings.service");

import { installApiMock, type ApiMock } from "../support/apiMock";
import settingsService from "@/services/settings.service";

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

it("never sends the card fee's own keys through the generic firm settings route", async () => {
  api.put("/lawfirms/firm-1/settings/firm", { message: "ok" });

  await settingsService.updateFirmSettings("firm-1", {
    billing: {
      tax: { enabled: true, defaultRate: 8, label: "Tax" },
      processingFees: { card: "client", bank: "client" },
      cardFees: { debitCards: "absorb", internationalCards: "absorb", ratePercent: 2.9, fixedCents: 30, confirmation: null },
    },
  } as never);

  expect(api.calls("PUT")[0].body).toEqual({
    settings: {
      billing: {
        tax: { enabled: true, defaultRate: 8, label: "Tax" },
        processingFees: { bank: "client" },
      },
    },
  });
});

it("leaves settings without a billing group untouched", async () => {
  api.put("/lawfirms/firm-1/settings/firm", { message: "ok" });

  await settingsService.updateFirmSettings("firm-1", { sidebar: { collapsed: true } } as never);

  expect(api.calls("PUT")[0].body).toEqual({ settings: { sidebar: { collapsed: true } } });
});
