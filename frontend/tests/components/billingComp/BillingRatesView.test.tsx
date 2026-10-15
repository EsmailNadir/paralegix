/**
 * `BillingRatesView`: the rate table every invoice's line-item pricing flows
 * from - a charge code's own rate, or a per-member override of it.
 *
 * Rules that produce a wrong invoiced rate if they slip:
 *
 *   CLEARING A MEMBER'S OVERRIDE MUST DELETE THEIR KEY FROM `memberRates`,
 *   never leave it set to `null`/`0` - a lingering key would keep overriding
 *   the charge code's default instead of falling back to it.
 *
 *   SETTING ONE MEMBER'S OVERRIDE MUST NOT DROP ANY OTHER MEMBER'S OVERRIDE -
 *   the save always carries the FULL map, so a bug here silently erases every
 *   other member's already-configured rate.
 *
 *   A $0.00 OVERRIDE IS STILL AN OVERRIDE, not "no override" - it must render
 *   as its own rate, never as "Using default".
 *
 *   AN INVALID OR NEGATIVE DRAFT RATE MUST NEVER REACH THE SAVE CALL.
 *
 *   AN INACTIVE CHARGE CODE MUST NEVER APPEAR HERE FOR EDITING.
 */
const mockUpdateChargeCode = jest.fn();

jest.mock("@/services/billing.service", () => ({
  __esModule: true,
  default: {
    updateChargeCode: (...args: unknown[]) => mockUpdateChargeCode(...args),
    createChargeCode: jest.fn().mockResolvedValue({}),
  },
}));

import React from "react";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import BillingRatesView from "@/components/billingComp/BillingRatesView";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantReadOnly, resetPermissions } from "../../support/permissions";
import type { ChargeCode } from "@/types/chargeCode";
import type { User } from "@/types";

const ALICE = { uid: "user-1", name: "Alice Attorney", email: "alice@example.test" } as User;
const BOB = { uid: "user-2", name: "Bob Paralegal", email: "bob@example.test" } as User;

function chargeCode(overrides: Partial<ChargeCode> = {}): ChargeCode {
  return {
    id: "cc-1",
    lawFirmId: "firm-1",
    code: "TRV",
    name: "Travel",
    isActive: true,
    order: 0,
    defaultRate: 100,
    memberRates: {},
    createdBy: "user-1",
    ...overrides,
  } as ChargeCode;
}

function renderView(props: Partial<React.ComponentProps<typeof BillingRatesView>>) {
  return renderWithProviders(
    <BillingRatesView
      lawFirmId="firm-1"
      chargeCodes={[]}
      users={[ALICE, BOB]}
      isLoading={false}
      onRefresh={jest.fn()}
      {...props}
    />,
  );
}

// The "Member Rate Overrides" panel for a charge code is always in the DOM
// (its expand/collapse is a pure CSS grid-row animation), so no click is
// needed to reach its rows.
function overridesPanel() {
  const heading = screen.getByText("Member Rate Overrides");
  const panel = heading.closest("div.border-t");
  if (!panel) throw new Error("overrides panel not found");
  return within(panel as HTMLElement);
}

function memberOverrideRow(name: string) {
  const row = overridesPanel().getByText(name).closest("div.justify-between");
  if (!row) throw new Error(`override row for ${name} not found`);
  return within(row as HTMLElement);
}

function chargeCodeDefaultRateButton() {
  const label = screen.getByText("Default:");
  const container = label.closest("div.flex-shrink-0");
  if (!container) throw new Error("default-rate control not found");
  return within(container as HTMLElement).getByRole("button");
}

function setRateViaButton(button: HTMLElement, draft: string) {
  fireEvent.click(button);
  const input = screen.getByRole("spinbutton");
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  mockUpdateChargeCode.mockReset().mockResolvedValue({});
});

describe("clearing a member override", () => {
  it("deletes the member's key from memberRates rather than nulling it", async () => {
    renderView({ chargeCodes: [chargeCode({ memberRates: { "user-1": 0 } })] });

    const aliceButton = memberOverrideRow("Alice Attorney").getByRole("button");
    setRateViaButton(aliceButton, "");

    await waitFor(() => expect(mockUpdateChargeCode).toHaveBeenCalledTimes(1));
    const [, , body] = mockUpdateChargeCode.mock.calls[0];
    expect(body.memberRates).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(body.memberRates, "user-1")).toBe(false);
  });
});

describe("setting a member override", () => {
  it("keeps every other member's existing override in the same save", async () => {
    renderView({ chargeCodes: [chargeCode({ memberRates: { "user-1": 0 } })] });

    const bobButton = memberOverrideRow("Bob Paralegal").getByRole("button");
    setRateViaButton(bobButton, "120");

    await waitFor(() => expect(mockUpdateChargeCode).toHaveBeenCalledTimes(1));
    const [, , body] = mockUpdateChargeCode.mock.calls[0];
    expect(body.memberRates).toEqual({ "user-1": 0, "user-2": 120 });
  });
});

describe("a zero-dollar override", () => {
  it("renders as its own rate, not as 'Using default'", () => {
    renderView({ chargeCodes: [chargeCode({ defaultRate: 100, memberRates: { "user-1": 0 } })] });

    const aliceRow = memberOverrideRow("Alice Attorney");
    expect(aliceRow.getByText("$0.00")).toBeInTheDocument();
    expect(aliceRow.queryByText(/Using default/)).not.toBeInTheDocument();
  });

  it("shows 'Using default' for a member with no override at all", () => {
    renderView({ chargeCodes: [chargeCode({ defaultRate: 100, memberRates: {} })] });

    const bobRow = memberOverrideRow("Bob Paralegal");
    expect(bobRow.getByText(/Using default:/)).toBeInTheDocument();
    expect(bobRow.getByText(/\$100\.00\/hr/)).toBeInTheDocument();
  });
});

describe("invalid draft rates", () => {
  it("never saves a negative rate", async () => {
    renderView({ chargeCodes: [chargeCode({ defaultRate: 100 })] });

    setRateViaButton(chargeCodeDefaultRateButton(), "-5");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mockUpdateChargeCode).not.toHaveBeenCalled();
    expect(chargeCodeDefaultRateButton()).toHaveTextContent("$100.00");
  });
});

describe("inactive charge codes", () => {
  it("never appears in the rate list", () => {
    renderView({
      chargeCodes: [
        chargeCode({ id: "cc-active", code: "TRV", name: "Travel", isActive: true }),
        chargeCode({ id: "cc-inactive", code: "OLD", name: "Retired Code", isActive: false }),
      ],
    });

    expect(screen.getByText("Travel")).toBeInTheDocument();
    expect(screen.queryByText("Retired Code")).not.toBeInTheDocument();
  });
});

describe("permission gating", () => {
  afterEach(() => {
    resetPermissions();
  });

  it("shows rates as plain text, with no Add Charge Code control, for a viewer without billing.manageRates", () => {
    grantReadOnly();
    renderView({
      chargeCodes: [chargeCode({ defaultRate: 150 })],
    });

    // The rate is still visible...
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    // ...but not as an editable control, and nothing offers to create one.
    expect(screen.queryByRole("button", { name: /150\.00/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Charge Code" })).not.toBeInTheDocument();
  });
});
