/**
 * The one screen a locked firm sees.
 *
 * It is the whole workspace for as long as billing is inactive, so its copy IS
 * the product at that moment: it has to name which of the four causes applies,
 * when access stopped, and who can restore it. A member without
 * `settings.manageFirm` cannot pay at all, and telling them to "update billing"
 * hands them a button that leads nowhere.
 *
 * What has to break for these to go red: a cause that stops being distinguished
 * (every state falling back to the trial wording was the previous behaviour),
 * a date that stops rendering, the owner contact disappearing for a member who
 * cannot pay, or the pay action appearing for someone who cannot use it.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockNavigate = jest.fn();

jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import BillingLockScreen from "@/components/billingComp/BillingLockScreen";
import { grantPermissions, resetPermissions } from "../../support/permissions";

const FIRM_ID = "firm-1";

afterEach(() => {
  resetPermissions();
  mockNavigate.mockReset();
});

describe("cause-specific copy", () => {
  it("asks a firm that never checked out to choose a plan", async () => {
    render(<BillingLockScreen lawFirmId={FIRM_ID} billingStatus="incomplete" />);

    expect(screen.getByRole("heading", { name: "Start your subscription" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Choose a plan" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/onboarding/plan?firmId=${FIRM_ID}`);
  });

  it("tells an expired trial when it ended", () => {
    render(
      <BillingLockScreen
        lawFirmId={FIRM_ID}
        billingStatus="trialing"
        trialEndsAt="2026-08-30T12:00:00.000Z"
      />,
    );

    expect(screen.getByRole("heading", { name: "Your trial has ended" })).toBeInTheDocument();
    expect(screen.getByText(/Your trial ended on Aug 30, 2026\./)).toBeInTheDocument();
  });

  it("sends a failed payment to billing settings, not to the plan picker", async () => {
    render(<BillingLockScreen lawFirmId={FIRM_ID} billingStatus="past_due" />);

    expect(screen.getByRole("heading", { name: "A payment didn't go through" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Update payment method" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM_ID}/settings/billing`);
  });

  it("tells a canceled firm when access ended and offers a restart", async () => {
    render(
      <BillingLockScreen
        lawFirmId={FIRM_ID}
        billingStatus="canceled"
        currentPeriodEnd="2026-07-15T12:00:00.000Z"
      />,
    );

    expect(screen.getByRole("heading", { name: "Your subscription has ended" })).toBeInTheDocument();
    expect(screen.getByText(/Access ended on Jul 15, 2026\./)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Restart subscription" }));
    expect(mockNavigate).toHaveBeenCalledWith(`/onboarding/plan?firmId=${FIRM_ID}`);
  });

  it("states the lock plainly for a status it does not recognize", () => {
    render(<BillingLockScreen lawFirmId={FIRM_ID} billingStatus="suspended" />);

    expect(screen.getByRole("heading", { name: "Your workspace is paused" })).toBeInTheDocument();
    // No invented cause and no invented date.
    expect(screen.queryByText(/trial/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ended on/i)).not.toBeInTheDocument();
  });

  it("shows no paused date for a failed payment, which has none", () => {
    render(
      <BillingLockScreen
        lawFirmId={FIRM_ID}
        billingStatus="past_due"
        trialEndsAt="2026-08-30T12:00:00.000Z"
        currentPeriodEnd="2026-07-15T12:00:00.000Z"
      />,
    );

    expect(screen.queryByText(/ended on/i)).not.toBeInTheDocument();
  });
});

describe("what the firm is losing", () => {
  it("names the firm and the plan being restored", () => {
    render(
      <BillingLockScreen
        lawFirmId={FIRM_ID}
        billingStatus="canceled"
        firmName="Aker & Vance"
        planName="Professional"
      />,
    );

    expect(screen.getByText("Aker & Vance · Professional plan")).toBeInTheDocument();
  });

  it("always offers a support address", () => {
    render(<BillingLockScreen lawFirmId={FIRM_ID} billingStatus="canceled" />);

    expect(screen.getByRole("link", { name: "contact@paralegix.com" }))
      .toHaveAttribute("href", "mailto:contact@paralegix.com");
  });
});

describe("a member who cannot pay", () => {
  it("names the owner and links their address instead of offering a dead button", () => {
    grantPermissions(["matters.view"]);

    render(
      <BillingLockScreen
        lawFirmId={FIRM_ID}
        billingStatus="past_due"
        owner={{ name: "Dana Okafor", email: "dana@firm.test" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Update payment method" })).not.toBeInTheDocument();
    expect(screen.getByText(/Dana Okafor owns this firm/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dana@firm.test" }))
      .toHaveAttribute("href", "mailto:dana@firm.test");
  });

  it("falls back to the generic owner sentence when no owner came back", () => {
    grantPermissions(["matters.view"]);

    render(<BillingLockScreen lawFirmId={FIRM_ID} billingStatus="past_due" />);

    expect(screen.getByText("Your firm owner needs to update the subscription.")).toBeInTheDocument();
  });

  it("gives the pay action to a member holding settings.manageFirm", () => {
    grantPermissions(["settings.manageFirm"]);

    render(<BillingLockScreen lawFirmId={FIRM_ID} billingStatus="past_due" />);

    expect(screen.getByRole("button", { name: "Update payment method" })).toBeInTheDocument();
  });
});
