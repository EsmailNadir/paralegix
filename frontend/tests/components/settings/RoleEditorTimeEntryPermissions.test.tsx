/**
 * The role editor lists `billing.manageOthersTimeEntries` under Billing, next to
 * the permission it refines, with its own label and description, and toggling it
 * is independent of `billing.manageTimeEntries`.
 *
 * WHAT BREAKS THIS: dropping the code from the frontend PERMISSIONS catalog
 * removes the row, so a firm could never grant or withdraw it from a role.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import RoleEditor from "@/components/settingsComp/RoleEditor";
import { BUILT_IN_ROLES, DEFAULT_PERMISSIONS } from "@/lib/constants/permissions";

const OTHERS = "billing.manageOthersTimeEntries";

describe("RoleEditor and the others' time entries permission", () => {
  it("lists it in the Billing group with its label and description", () => {
    render(<RoleEditor permissions={[]} onChange={jest.fn()} />);

    const label = screen.getByText("Manage Others' Time Entries");
    expect(label).toBeInTheDocument();
    expect(screen.getByText(/Edit and delete other members' time entries/)).toBeInTheDocument();
    const group = label.closest("div.rounded-xl") as HTMLElement;
    expect(within(group).getByText("Billing")).toBeInTheDocument();
  });

  it("toggles on its own, leaving manageTimeEntries as it was", async () => {
    const onChange = jest.fn();
    render(<RoleEditor permissions={["billing.manageTimeEntries"]} onChange={onChange} />);

    const row = screen.getByText("Manage Others' Time Entries").closest("label") as HTMLElement;
    await userEvent.click(within(row).getByRole("checkbox"));

    expect(onChange).toHaveBeenCalledWith([
      "billing.manageTimeEntries",
      OTHERS,
      "billing.viewTimeEntries",
      "billing.viewRates",
    ]);
  });
});

describe("the built-in roles", () => {
  it("give the code to every role that keeps time, and keep it out of the baseline", () => {
    expect(DEFAULT_PERMISSIONS).not.toContain(OTHERS);
    const roles = Object.values(BUILT_IN_ROLES);
    const timeKeepers = roles.filter((role) => role.permissions.includes("billing.manageTimeEntries"));
    expect(timeKeepers.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(role.permissions.includes(OTHERS)).toBe(role.permissions.includes("billing.manageTimeEntries"));
    }
  });
});
