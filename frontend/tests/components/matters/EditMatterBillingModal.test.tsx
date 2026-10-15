import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const updateMatter = jest.fn();

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    updateMatter: (...args: unknown[]) => updateMatter(...args),
  },
}));

import EditMatterBillingModal from "@/components/matterComp/EditMatterBillingModal";

const matter = {
  id: "matter-1",
  name: "Test Matter",
  status: "active",
  billingMethod: "hourly",
  isBillable: true,
  budget: 5000,
  budgetIncludesExpenses: true,
  contingencyPercent: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} as any;

describe("EditMatterBillingModal", () => {
  beforeEach(() => {
    updateMatter.mockReset();
    updateMatter.mockResolvedValue({ message: "updated" });
  });

  it("shows only the focused billing editor", () => {
    render(
      <EditMatterBillingModal
        open
        onClose={jest.fn()}
        lawFirmId="firm-1"
        matter={matter}
      />,
    );

    expect(screen.getByRole("heading", { name: "Edit Billing" })).toBeInTheDocument();
    expect(screen.getByText("Billing Method")).toBeInTheDocument();
    expect(screen.getByText("Budget (USD)")).toBeInTheDocument();
    expect(screen.queryByText("Matter Title")).not.toBeInTheDocument();
    expect(screen.queryByText("Team Members")).not.toBeInTheDocument();
  });

  it("saves only matter billing fields", async () => {
    const onClose = jest.fn();
    const onAfter = jest.fn();
    render(
      <EditMatterBillingModal
        open
        onClose={onClose}
        lawFirmId="firm-1"
        matter={matter}
        onAfter={onAfter}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save Billing" }));

    await waitFor(() =>
      expect(updateMatter).toHaveBeenCalledWith({
        lawFirmId: "firm-1",
        matterId: "matter-1",
        billingMethod: "hourly",
        isBillable: true,
        budget: 5000,
        budgetIncludesExpenses: true,
        contingencyPercent: null,
      }),
    );
    expect(onAfter).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
