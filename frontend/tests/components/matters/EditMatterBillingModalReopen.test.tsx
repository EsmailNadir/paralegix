/**
 * `EditMatterBillingModal` opened after the matter changed elsewhere.
 *
 * The modal stays mounted on the matter page. Its form must be read from the
 * matter as it is when the modal OPENS: the full Edit Matter modal can change
 * the same billing fields in the meantime, and a form still holding the old
 * values would write them back over the change on the next "Save Billing".
 */
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
import type { Matter } from "@/types";

const before = {
  id: "matter-1",
  name: "Test Matter",
  status: "active",
  billingMethod: "hourly",
  isBillable: true,
  budget: 5000,
  budgetIncludesExpenses: true,
  contingencyPercent: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Matter;

const after = { ...before, billingMethod: "flat", budget: 8000 } as unknown as Matter;

beforeEach(() => {
  updateMatter.mockReset().mockResolvedValue({ message: "updated" });
});

// Red if: the form keeps the values it was seeded with at mount (or at the last
// close), so saving sends `hourly` / 5000 back over the newer `flat` / 8000.
it("opens on the matter's current billing, and saves that unless changed", async () => {
  const { rerender } = render(
    <EditMatterBillingModal open={false} onClose={jest.fn()} lawFirmId="firm-1" matter={before} />,
  );
  rerender(<EditMatterBillingModal open={false} onClose={jest.fn()} lawFirmId="firm-1" matter={after} />);
  rerender(<EditMatterBillingModal open onClose={jest.fn()} lawFirmId="firm-1" matter={after} />);

  expect(screen.getByLabelText("Budget (USD)")).toHaveValue(8000);
  await userEvent.click(screen.getByRole("button", { name: "Save Billing" }));

  await waitFor(() => expect(updateMatter).toHaveBeenCalledTimes(1));
  expect(updateMatter.mock.calls[0][0]).toEqual(expect.objectContaining({ billingMethod: "flat", budget: 8000 }));
});
