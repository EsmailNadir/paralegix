/**
 * Ticking a manage permission ticks the reads it implies and locks them on while
 * any manage permission that implies them is held. Unticking the manage code
 * unlocks the reads but leaves them ticked, which is what the backend stores.
 *
 * WHAT BREAKS THIS: dropping an entry from MANAGE_IMPLIES_VIEW, or computing the
 * lock from a single manage code instead of every held one, so unticking one of
 * two managers of a shared read unlocks it early.
 */
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import RoleEditor from "@/components/settingsComp/RoleEditor";
import { PERMISSIONS } from "@/lib/constants/permissions";

type Code = keyof typeof PERMISSIONS;

const checkboxFor = (code: Code) => {
  const label = screen.getByText(PERMISSIONS[code].name, { selector: "p" }).closest("label") as HTMLElement;
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

function Harness({ initial, spy }: { initial: string[]; spy?: (next: string[]) => void }) {
  const [permissions, setPermissions] = useState(initial);
  return (
    <RoleEditor
      permissions={permissions}
      onChange={(next) => {
        spy?.(next);
        setPermissions(next);
      }}
    />
  );
}

describe("RoleEditor manage permissions imply their reads", () => {
  it("ticks and locks the implied reads when manage time entries is ticked", async () => {
    render(<Harness initial={[]} />);
    expect(checkboxFor("billing.viewTimeEntries")).not.toBeChecked();
    expect(checkboxFor("billing.viewTimeEntries")).toBeEnabled();

    await userEvent.click(checkboxFor("billing.manageTimeEntries"));

    for (const view of ["billing.viewTimeEntries", "billing.viewRates"] as Code[]) {
      expect(checkboxFor(view)).toBeChecked();
      expect(checkboxFor(view)).toBeDisabled();
    }
    expect(screen.getAllByText(/Included with Manage Time Entries/).length).toBe(2);
  });

  it("sends the implied reads in the change payload", async () => {
    const spy = jest.fn();
    render(<Harness initial={[]} spy={spy} />);

    await userEvent.click(checkboxFor("trust.reconcile"));

    expect(spy).toHaveBeenCalledWith(["trust.reconcile", "trust.view"]);
  });

  it("keeps a shared read locked until the last manage code that implies it is cleared", async () => {
    render(<Harness initial={[]} />);
    await userEvent.click(checkboxFor("billing.manageInvoices"));
    await userEvent.click(checkboxFor("billing.manageRates"));
    expect(checkboxFor("billing.viewRates")).toBeDisabled();

    await userEvent.click(checkboxFor("billing.manageInvoices"));
    expect(checkboxFor("billing.viewRates")).toBeDisabled();
    expect(checkboxFor("billing.viewRates")).toBeChecked();
    expect(checkboxFor("billing.viewInvoices")).toBeEnabled();
    expect(checkboxFor("billing.viewInvoices")).toBeChecked();

    await userEvent.click(checkboxFor("billing.manageRates"));
    expect(checkboxFor("billing.viewRates")).toBeEnabled();
    expect(checkboxFor("billing.viewRates")).toBeChecked();
  });

  it("lets an unlocked implied read be unticked after its manage code is cleared", async () => {
    const spy = jest.fn();
    render(<Harness initial={[]} spy={spy} />);
    await userEvent.click(checkboxFor("billing.managePlans"));
    await userEvent.click(checkboxFor("billing.managePlans"));
    expect(spy).toHaveBeenLastCalledWith(["billing.viewPlans"]);

    await userEvent.click(checkboxFor("billing.viewPlans"));
    expect(spy).toHaveBeenLastCalledWith([]);
  });

  it("shows a stored manage code's reads as locked even when the reads are missing", () => {
    render(<Harness initial={["billing.manageExpenses"]} />);
    expect(checkboxFor("billing.viewExpenses")).toBeChecked();
    expect(checkboxFor("billing.viewExpenses")).toBeDisabled();
  });

  it("leaves an unrelated permission unchanged", async () => {
    const spy = jest.fn();
    render(<Harness initial={[]} spy={spy} />);

    await userEvent.click(checkboxFor("billing.viewInvoices"));

    expect(spy).toHaveBeenCalledWith(["billing.viewInvoices"]);
    expect(screen.queryByText(/Included with/)).not.toBeInTheDocument();
  });
});
