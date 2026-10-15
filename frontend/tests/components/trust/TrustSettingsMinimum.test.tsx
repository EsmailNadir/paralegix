/**
 * The firm's default low-balance threshold, on the trust settings screen.
 *
 * The figure decides when a client is told their retainer is running dry. Three
 * states have to stay distinct, and two of them look the same in a number input:
 *
 *   BLANK means "use the built-in $100". The API takes that as null.
 *   ZERO means "no client alerts at all". A form that sent 0 for a cleared field
 *   would silence every low-balance warning in the firm, and nothing on screen
 *   would look wrong.
 *   A TYPED FIGURE is dollars here and integer cents on the wire, like every
 *   other money field in the app.
 */
const mockGetTrustSettings = jest.fn();
const mockUpdateTrustSettings = jest.fn();

jest.mock("@/services/trust.service", () => ({
  __esModule: true,
  default: {
    getTrustSettings: (...args: unknown[]) => mockGetTrustSettings(...args),
    updateTrustSettings: (...args: unknown[]) => mockUpdateTrustSettings(...args),
    getTrustConnectStatus: jest.fn().mockResolvedValue({ connected: false }),
  },
}));

import React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TrustSettings from "@/components/trustComp/TrustSettings";
import type { TrustSettings as TrustSettingsType } from "@/types/trust";
import { renderWithProviders } from "../../support/renderWithProviders";

function settings(overrides: Partial<TrustSettingsType> = {}): TrustSettingsType {
  return {
    reconcileCadence: "monthly",
    retentionYears: 5,
    flatFeeToOperatingAllowed: false,
    electronicTrustDepositsAllowed: false,
    enforceMatterTrustBalance: false,
    defaultMinimumCents: null,
    retentionCutoffDate: "2021-09-05",
    ...overrides,
  } as TrustSettingsType;
}

const minimumField = () => screen.getByLabelText(/default low-balance alert/i);

async function renderSettings(loaded: TrustSettingsType) {
  mockGetTrustSettings.mockResolvedValue(loaded);
  mockUpdateTrustSettings.mockResolvedValue(undefined);
  renderWithProviders(<TrustSettings lawFirmId="firm-1" accounts={[]} />);
  // Wait for the FIELD, not for the fetch call: the query firing only means the
  // component is still rendering its loading state, where no form exists yet.
  await screen.findByLabelText(/default low-balance alert/i);
  return screen.getByRole("button", { name: /save settings/i });
}

beforeEach(() => {
  jest.clearAllMocks();
});

it("shows a stored minimum in dollars", async () => {
  await renderSettings(settings({ defaultMinimumCents: 50_000 }));

  await waitFor(() => expect(minimumField()).toHaveValue(500));
});

it("leaves the field blank when the firm has set none", async () => {
  await renderSettings(settings({ defaultMinimumCents: null }));

  // Blank, not "0". Rendering the built-in default as a real value would make a
  // firm that never chose it look like a firm that did.
  await waitFor(() => expect(minimumField()).toHaveValue(null));
});

it("sends a typed figure as integer cents", async () => {
  const save = await renderSettings(settings());

  await userEvent.clear(minimumField());
  await userEvent.type(minimumField(), "250.50");
  await userEvent.click(save);

  await waitFor(() => expect(mockUpdateTrustSettings).toHaveBeenCalledWith(
    "firm-1",
    expect.objectContaining({ defaultMinimumCents: 25_050 }),
  ));
});

it("sends null when the field is cleared, not zero", async () => {
  const save = await renderSettings(settings({ defaultMinimumCents: 50_000 }));
  await waitFor(() => expect(minimumField()).toHaveValue(500));

  await userEvent.clear(minimumField());
  await userEvent.click(save);

  // Zero here would mean "no client ever alerts", which is the opposite of
  // "go back to the default" and is invisible on screen.
  await waitFor(() => expect(mockUpdateTrustSettings).toHaveBeenCalledWith(
    "firm-1",
    expect.objectContaining({ defaultMinimumCents: null }),
  ));
});

it("keeps an explicit zero, which means no client alerts", async () => {
  const save = await renderSettings(settings());

  await userEvent.clear(minimumField());
  await userEvent.type(minimumField(), "0");
  await userEvent.click(save);

  await waitFor(() => expect(mockUpdateTrustSettings).toHaveBeenCalledWith(
    "firm-1",
    expect.objectContaining({ defaultMinimumCents: 0 }),
  ));
});
