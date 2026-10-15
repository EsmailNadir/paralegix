/**
 * `BillingUnbilledWorkPanel`: the firm Billing dashboard's backlog of
 * completed work with no time logged yet.
 *
 * PERMISSION GATING. Both "Timer" and "Log" ultimately create a time entry
 * (`POST .../billing/time-entries`, which requires `billing.manageTimeEntries`
 * - `backend/src/modules/billing/timeEntries/timeEntries.routes.ts`). A viewer
 * without that permission must not see either control.
 */
import React from "react";
import { screen } from "@testing-library/react";
import BillingUnbilledWorkPanel from "@/components/billingComp/BillingUnbilledWorkPanel";
import { renderWithProviders } from "../../support/renderWithProviders";
import type { UnbilledWorkItem } from "@/types";

const ITEM: UnbilledWorkItem = {
  id: "item-1",
  workType: "task",
  title: "Draft motion",
  matterName: "Smith v. Jones",
  clientName: "Jane Smith",
  date: "2026-09-01",
} as UnbilledWorkItem;

function renderPanel(canManage: boolean) {
  return renderWithProviders(
    <BillingUnbilledWorkPanel
      items={[ITEM]}
      total={1}
      page={1}
      rowsPerPage={5}
      onPageChange={jest.fn()}
      isLoading={false}
      onLogTime={jest.fn()}
      onStartTimer={jest.fn()}
      canManage={canManage}
    />,
  );
}

describe("permission gating", () => {
  it("hides Timer and Log for a viewer without billing.manageTimeEntries", () => {
    renderPanel(false);

    expect(screen.getByText("Draft motion")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Timer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Log/ })).not.toBeInTheDocument();
  });

  it("shows Timer and Log for a viewer with billing.manageTimeEntries", () => {
    renderPanel(true);

    expect(screen.getByRole("button", { name: /Timer/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Log/ })).toBeInTheDocument();
  });
});
