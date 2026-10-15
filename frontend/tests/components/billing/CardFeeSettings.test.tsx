/**
 * The credit card fee setting on the Payments settings page. A firm may pass the card fee
 * on only when it is connected to Stripe, in a state that allows the fee, and
 * 30 days past telling Stripe, and it must confirm that notice and its
 * engagement-letter disclosure to switch it on.
 *
 * A firm with no state on record picks it right here, since the fee's rules
 * depend on it; the pick saves onto the firm and the setting is read again.
 *
 * Driven through the real card-fees and law firm services with only the
 * transport faked. Red if a firm that may not use card fees is offered the
 * switch, if a reason's wording drifts, if the state picker shows for any other
 * reason or to a member who cannot change firm information, if picking a state
 * saves anything but its full name or skips re-reading the setting, if the fee
 * can be saved on without both confirmations, if the saved body drops or
 * invents a field, or if the card fails the accessibility scan.
 */
jest.unmock("@/services/lawfirm.service");
jest.unmock("@/services/requestDeduplicator");
// The real context, so the spec can hand the card its own `refetchLawFirm`.
jest.unmock("@/contexts/LawFirmContext");

import React from "react";
import dayjs from "dayjs";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CardFeeSettings from "@/components/billingComp/CardFeeSettings";
import { renderWithProviders } from "../../support/renderWithProviders";
import { installApiMock, sequence, type ApiMock } from "../../support/apiMock";
import { scanAccessibility } from "../../support/accessibility";
import { grantPermissions, resetPermissions } from "../../support/permissions";
import { LawFirmContext } from "@/contexts/LawFirmContext";

const URL = "/api/lawfirms/firm-a/billing/card-fees";
const FIRM_URL = "/api/lawfirms/firm-a";
const STATE_PICKER = /^Your firm's state/;
const TOGGLE = "Clients pay a fee on credit cards";

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

function state(overrides: Record<string, unknown> = {}) {
  return {
    clientPays: false,
    debitCards: "absorb",
    internationalCards: "absorb",
    ratePercent: 2.9,
    fixedCents: 30,
    confirmation: null,
    eligibility: { eligible: false, reasons: ["not_confirmed"], state: "TX", capPercent: 3, availableFrom: null },
    ...overrides,
  };
}

const CONFIRMED = {
  stripeNotifiedOn: "2026-08-01",
  engagementLetterConfirmed: true,
  confirmedBy: "uid-owner",
  confirmedAt: "2026-08-01T00:00:00.000Z",
};

const refetchLawFirm = jest.fn(async () => {});

function renderCard(canEdit = true) {
  refetchLawFirm.mockClear();
  return renderWithProviders(
    <LawFirmContext.Provider value={{ lawFirm: null, refetchLawFirm, subscriptionStatus: null, subscriptionStatusLoaded: true }}>
      <CardFeeSettings lawFirmId="firm-a" canEdit={canEdit} />
    </LawFirmContext.Provider>,
  );
}

const MISSING_STATE = { eligible: false, reasons: ["state_missing", "not_confirmed"], state: null, capPercent: 0, availableFrom: null };

describe("a firm that may not pass the card fee on", () => {
  it("sees each reason instead of the switch", async () => {
    api.getExact(URL, state({
      eligibility: { eligible: false, reasons: ["stripe_not_connected", "state_banned", "not_confirmed"], state: "CT", capPercent: 0, availableFrom: null },
    }));

    renderCard();

    // The Stripe connection is on this same page, so the reason points up rather than linking.
    expect(await screen.findByText("Connect Stripe above first.")).toBeInTheDocument();
    expect(screen.getByText("Not allowed for firms in Connecticut.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(TOGGLE)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: TOGGLE })).not.toBeInTheDocument();
    // The confirmation is what the firm gives to turn it on, not a reason it cannot.
    expect(screen.getByText("Connect Stripe above first.").closest("ul")?.children).toHaveLength(2);
  });

  it("is not offered the state picker when its state is on record", async () => {
    api.getExact(URL, state({
      eligibility: { eligible: false, reasons: ["stripe_not_connected", "state_banned"], state: "CT", capPercent: 0, availableFrom: null },
    }));

    renderCard();

    await screen.findByText("Not allowed for firms in Connecticut.");
    expect(screen.queryByRole("button", { name: STATE_PICKER })).not.toBeInTheDocument();
    expect(screen.queryByText("Ask a firm admin to add your firm's state.")).not.toBeInTheDocument();
  });

  it("is told when the notice period ends", async () => {
    api.getExact(URL, state({
      confirmation: { ...CONFIRMED, stripeNotifiedOn: "2026-10-01" },
      eligibility: { eligible: false, reasons: ["notice_period"], state: "TX", capPercent: 3, availableFrom: "2026-10-31" },
    }));

    renderCard();

    expect(await screen.findByText("Available from 10/31/2026.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: TOGGLE })).not.toBeInTheDocument();
    // The setup form is this card, so there is nowhere to link to.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

it("explains how card fees work in six lines", async () => {
  api.getExact(URL, state());

  renderCard();

  expect(await screen.findByText("How card fees work")).toBeInTheDocument();
  const list = screen.getByRole("list", { name: "How card fees work" });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Credit cards only. Debit and prepaid cards can't have a fee.",
    "Up to 3% (2% in Colorado), never more than your Stripe cost.",
    "Clients see the fee before paying and can pay by bank transfer instead.",
    "Not allowed in California, Connecticut, Maine or Massachusetts.",
    "Paralegix takes no cut on these payments.",
    "If you refund a payment, refund the same share of the fee.",
  ]);
  expect(screen.getByText("You receive the full invoice amount.")).toBeInTheDocument();
});

describe("an eligible firm turning the fee on for the first time", () => {
  it("must confirm the notice date and the engagement letters before saving", async () => {
    api.getExact(URL, state());
    api.putExact(URL, state({ clientPays: true, debitCards: "decline", confirmation: CONFIRMED, eligibility: { eligible: true, reasons: [], state: "TX", capPercent: 3, availableFrom: "2026-08-31" } }));
    const user = userEvent.setup();
    renderCard();

    const toggle = await screen.findByRole("switch", { name: TOGGLE });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();

    await user.click(toggle);

    const debit = screen.getByRole("group", { name: "Debit and prepaid cards" });
    const international = screen.getByRole("group", { name: "Cards from outside the US" });
    expect(within(debit).getByRole("radio", { name: "Accept (your firm pays the fee)" })).toBeChecked();
    expect(within(debit).getByRole("radio", { name: "Don't accept" })).not.toBeChecked();
    expect(within(international).getByRole("radio", { name: "Accept (your firm pays an extra 1.5%)" })).toBeChecked();
    expect(within(international).getByRole("radio", { name: "Don't accept" })).not.toBeChecked();
    const support = screen.getByRole("link", { name: "Contact Stripe support" });
    expect(support.closest("p")).toHaveTextContent(
      "Required 30 days before you start. Contact Stripe support and say you'll add a credit card fee.",
    );
    expect(support).toHaveAttribute("href", "https://support.stripe.com/contact");
    expect(support).toHaveAttribute("target", "_blank");
    expect(support).toHaveAttribute("rel", "noopener noreferrer");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.click(within(debit).getByRole("radio", { name: "Don't accept" }));
    await user.click(screen.getByRole("button", { name: /Date you told Stripe/ }));
    const firstOfMonth = dayjs().startOf("month");
    await user.click(within(screen.getByRole("dialog", { name: "Choose a date" })).getAllByRole("button", { name: "1" })[0]);
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Our engagement letters mention this fee." }));
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(api.calls("PUT")).toHaveLength(1));
    expect(api.calls("PUT")[0].body).toEqual({
      clientPays: true,
      debitCards: "decline",
      internationalCards: "absorb",
      ratePercent: 2.9,
      fixedCents: 30,
      stripeNotifiedOn: firstOfMonth.format("YYYY-MM-DD"),
      engagementLetterConfirmed: true,
    });
    await waitFor(() => expect(screen.getByRole("switch", { name: TOGGLE })).toHaveAttribute("aria-checked", "true"));
  });

  it("shows the server's refusal when the notice was less than 30 days ago", async () => {
    api.getExact(URL, state());
    api.putExact(URL, {
      status: 400,
      body: {
        error: "You can turn this on from 2026-11-04, 30 days after you told Stripe.",
        code: "VALIDATION_ERROR",
        details: { cardFees: ["You can turn this on from 2026-11-04, 30 days after you told Stripe."] },
      },
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("switch", { name: TOGGLE }));
    await user.click(screen.getByRole("button", { name: /Date you told Stripe/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Choose a date" })).getAllByRole("button", { name: "1" })[0]);
    await user.click(screen.getByRole("checkbox", { name: "Our engagement letters mention this fee." }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("You can turn this on from 2026-11-04, 30 days after you told Stripe.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: TOGGLE })).toHaveAttribute("aria-checked", "true");
  });
});

it("does not ask an already-confirmed firm to confirm again", async () => {
  api.getExact(URL, state({ confirmation: CONFIRMED, eligibility: { eligible: true, reasons: [], state: "TX", capPercent: 3, availableFrom: "2026-08-31" } }));
  api.putExact(URL, state({ clientPays: true, confirmation: CONFIRMED, eligibility: { eligible: true, reasons: [], state: "TX", capPercent: 3, availableFrom: "2026-08-31" } }));
  const user = userEvent.setup();
  renderCard();

  await user.click(await screen.findByRole("switch", { name: TOGGLE }));

  expect(screen.queryByRole("checkbox", { name: /engagement letters/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(api.calls("PUT")).toHaveLength(1));
  expect(api.calls("PUT")[0].body).toEqual({
    clientPays: true, debitCards: "absorb", internationalCards: "absorb", ratePercent: 2.9, fixedCents: 30,
  });
});

it("saves a negotiated Stripe rate", async () => {
  const on = state({ clientPays: true, confirmation: CONFIRMED, eligibility: { eligible: true, reasons: [], state: "TX", capPercent: 3, availableFrom: "2026-08-31" } });
  api.getExact(URL, on);
  api.putExact(URL, { ...on, ratePercent: 2.5, fixedCents: 25 });
  const user = userEvent.setup();
  renderCard();

  const rate = await screen.findByRole("group", { name: "Your Stripe card rate" });
  expect(screen.getByText("Change only if Stripe gave you a custom rate.")).toBeInTheDocument();
  const percent = within(rate).getByRole("spinbutton", { name: "Percent" });
  const cents = within(rate).getByRole("spinbutton", { name: "Cents" });
  expect(percent).toHaveValue(2.9);
  expect(cents).toHaveValue(30);
  await user.clear(percent);
  await user.type(percent, "2.5");
  await user.clear(cents);
  await user.type(cents, "25");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(api.calls("PUT")).toHaveLength(1));
  expect(api.calls("PUT")[0].body).toEqual({
    clientPays: true, debitCards: "absorb", internationalCards: "absorb", ratePercent: 2.5, fixedCents: 25,
  });
});

it("turns the fee off without any confirmation", async () => {
  api.getExact(URL, state({ clientPays: true, confirmation: CONFIRMED, eligibility: { eligible: true, reasons: [], state: "TX", capPercent: 3, availableFrom: "2026-08-31" } }));
  api.putExact(URL, state({ confirmation: CONFIRMED, eligibility: { eligible: true, reasons: [], state: "TX", capPercent: 3, availableFrom: "2026-08-31" } }));
  const user = userEvent.setup();
  renderCard();

  await user.click(await screen.findByRole("switch", { name: TOGGLE }));
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(api.calls("PUT")).toHaveLength(1));
  expect(api.calls("PUT")[0].body).toEqual({
    clientPays: false, debitCards: "absorb", internationalCards: "absorb", ratePercent: 2.9, fixedCents: 30,
  });
});

it("keeps the switch available to turn the fee off after the firm stops being eligible", async () => {
  api.getExact(URL, state({
    clientPays: true,
    confirmation: CONFIRMED,
    eligibility: { eligible: false, reasons: ["stripe_not_connected"], state: "TX", capPercent: 3, availableFrom: "2026-08-31" },
  }));

  renderCard();

  expect(await screen.findByRole("switch", { name: TOGGLE })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByText("Connect Stripe above first.")).toBeInTheDocument();
});

it("is read-only to a member who cannot manage firm settings", async () => {
  api.getExact(URL, state({ clientPays: true, confirmation: CONFIRMED, eligibility: { eligible: true, reasons: [], state: "TX", capPercent: 3, availableFrom: "2026-08-31" } }));

  renderCard(false);

  expect(await screen.findByRole("switch", { name: TOGGLE })).toBeDisabled();
  expect(screen.getByRole("radio", { name: "Accept (your firm pays the fee)" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

it("has no accessibility violations with every field showing", async () => {
  api.getExact(URL, state());
  const user = userEvent.setup();
  const { container } = renderCard();
  await user.click(await screen.findByRole("switch", { name: TOGGLE }));

  expect((await scanAccessibility(container)).violations).toEqual([]);
});

describe("a firm with no state on record", () => {
  // Saving a state reads the card fee setting again on purpose, which the
  // dev-only duplicate request warning would otherwise report.
  beforeEach(() => { process.env.NEXT_PUBLIC_DUP_FETCH_WARN = "off"; });
  afterEach(() => { delete process.env.NEXT_PUBLIC_DUP_FETCH_WARN; });

  it("picks its state above the switch instead of following a link", async () => {
    api.getExact(URL, state({ eligibility: MISSING_STATE }));
    const user = userEvent.setup();

    renderCard();

    const picker = await screen.findByRole("button", { name: STATE_PICKER });
    expect(picker).toHaveTextContent("Select…");
    expect(picker).toHaveAccessibleDescription("Card fee rules depend on your state.");
    expect(screen.getByText("Your firm's state").tagName).toBe("LABEL");
    // The picker replaces the old linked reason, and nothing on the card links away.
    expect(screen.queryByText(/first\.$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: TOGGLE })).not.toBeInTheDocument();
    expect(picker.compareDocumentPosition(screen.getByText(TOGGLE)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(picker);
    const options = within(screen.getByRole("listbox")).getAllByRole("option").map((option) => option.textContent);
    expect(options).toHaveLength(51);
    expect(options).toEqual([...options].sort((a, b) => (a ?? "").localeCompare(b ?? "")));
    expect(options.slice(0, 3)).toEqual(["Alabama", "Alaska", "Arizona"]);
    expect(options).toContain("District of Columbia");
    expect(options).toContain("Texas");
    expect(options[50]).toBe("Wyoming");
  });

  it("saves the full state name on the firm, then reads the card fee setting again", async () => {
    api.getExact(URL, sequence(
      state({ eligibility: MISSING_STATE }),
      state({ eligibility: { eligible: false, reasons: ["not_confirmed"], state: "TX", capPercent: 3, availableFrom: null } }),
    ));
    api.putExact(FIRM_URL, { id: "firm-a", name: "Firm A", state: "Texas" });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: STATE_PICKER }));
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Texas" }));

    await waitFor(() => expect(api.callsTo("/lawfirms/firm-a")).toHaveLength(1));
    expect(api.callsTo("/lawfirms/firm-a")[0].method).toBe("PUT");
    expect(api.callsTo("/lawfirms/firm-a")[0].body).toEqual({ state: "Texas" });
    await waitFor(() => expect(api.calls("GET").filter((call) => call.pathname === URL)).toHaveLength(2));
    // The eligible firm now gets the switch, and the picker is gone.
    expect(await screen.findByRole("switch", { name: TOGGLE })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: STATE_PICKER })).not.toBeInTheDocument();
    // The shared firm record is refreshed so every other page sees the new state.
    expect(refetchLawFirm).toHaveBeenCalledTimes(1);
  });

  it("is told card fees are not allowed when the chosen state bans them", async () => {
    api.getExact(URL, sequence(
      state({ eligibility: MISSING_STATE }),
      state({ eligibility: { eligible: false, reasons: ["state_banned", "not_confirmed"], state: "CT", capPercent: 0, availableFrom: null } }),
    ));
    api.putExact(FIRM_URL, { id: "firm-a", name: "Firm A", state: "Connecticut" });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: STATE_PICKER }));
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Connecticut" }));

    expect(await screen.findByText("Not allowed for firms in Connecticut.")).toBeInTheDocument();
    expect(api.callsTo("/lawfirms/firm-a")[0].body).toEqual({ state: "Connecticut" });
    expect(screen.queryByRole("button", { name: STATE_PICKER })).not.toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the picker when the save fails", async () => {
    api.getExact(URL, state({ eligibility: MISSING_STATE }));
    api.putExact(FIRM_URL, { status: 400, body: { error: "Choose your firm's state first.", code: "VALIDATION_ERROR" } });
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: STATE_PICKER }));
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Texas" }));

    expect(await screen.findByText("Choose your firm's state first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: STATE_PICKER })).toBeEnabled();
    expect(api.calls("GET").filter((call) => call.pathname === URL)).toHaveLength(1);
    expect(refetchLawFirm).not.toHaveBeenCalled();
  });

  it("asks a member who cannot change firm information to get an admin to add it", async () => {
    grantPermissions(["settings.manageFirm"]);
    api.getExact(URL, state({ eligibility: MISSING_STATE }));

    renderCard();

    expect(await screen.findByText("Ask a firm admin to add your firm's state.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: STATE_PICKER })).not.toBeInTheDocument();
    expect(screen.queryByText(/first\.$/)).not.toBeInTheDocument();
  });

  it("has no accessibility violations with the state picker showing", async () => {
    api.getExact(URL, state({ eligibility: MISSING_STATE }));
    const { container } = renderCard();
    await screen.findByRole("button", { name: STATE_PICKER });

    expect((await scanAccessibility(container)).violations).toEqual([]);
  });
});
