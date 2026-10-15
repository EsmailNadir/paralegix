import React from "react";
import { render, screen, within } from "@testing-library/react";
import UpcomingPaymentModal from "@/components/dashboardComp/UpcomingPaymentModal";
import type { DashboardUpcomingPayment } from "@/services/dashboard.service";

const payment: DashboardUpcomingPayment = {
  id: "invoice-1", invoiceNumber: "INV-42", clientName: "Roe LLP",
  totalCents: 1250050, amountPaidCents: 100000, balanceDueCents: 1100050, totalWrittenOffCents: 50000,
  status: "partially_paid", invoiceDate: "2026-06-01", dueDate: "2026-06-30",
  daysRelative: 1, contextType: "matter", entityId: "matter-1",
};

/** Red if a cents amount is treated as dollars, adjustments disappear, or navigation loses its target guard. */
describe("dashboard invoice quick look", () => {
  it("shows the cents-based balance and the separate credit adjustment", () => {
    render(<UpcomingPaymentModal payment={payment} open onClose={jest.fn()} lawFirmId="firm-1" />);
    const amount = (label: string) => within(screen.getByText(label).parentElement!).getByText(/\$/).textContent;
    expect(amount("Invoice total")).toBe("$12,500.50");
    expect(amount("Amount paid")).toBe("$1,000.00");
    expect(amount("Credits / Adjustments")).toBe("$500.00");
    expect(amount("Balance due")).toBe("$11,000.50");
    expect(screen.getByText("Partially Paid")).toBeInTheDocument();
    expect(screen.getByText("1 day overdue")).toBeInTheDocument();
    expect(screen.getByText("Jun 30, 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open invoice" })).toBeEnabled();
  });

  it("prints the credit the server reports, not one inferred from totals that do not reconcile", () => {
    // Total less paid less balance is $500.00 here, but nothing was written off.
    const { unmount } = render(
      <UpcomingPaymentModal payment={{ ...payment, totalWrittenOffCents: 0 }} open onClose={jest.fn()} lawFirmId="firm-1" />,
    );
    expect(screen.getByText("Amount paid")).toBeInTheDocument();
    expect(screen.queryByText("Credits / Adjustments")).not.toBeInTheDocument();
    unmount();

    render(<UpcomingPaymentModal payment={{ ...payment, totalWrittenOffCents: 12345 }} open onClose={jest.fn()} lawFirmId="firm-1" />);
    expect(within(screen.getByText("Credits / Adjustments").parentElement!).getByText(/\$/).textContent).toBe("$123.45");
  });

  it("keeps the last invoice content during closing and disables links with no entity", () => {
    const { rerender } = render(<UpcomingPaymentModal payment={{ ...payment, entityId: null }} open onClose={jest.fn()} lawFirmId="firm-1" />);
    expect(screen.getByRole("button", { name: "Open invoice" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "View matter" })).toBeDisabled();
    rerender(<UpcomingPaymentModal payment={null} open={false} onClose={jest.fn()} lawFirmId="firm-1" />);
    expect(screen.getByRole("heading", { name: "Roe LLP" })).toBeInTheDocument();
    expect(screen.getByText("$11,000.50")).toBeInTheDocument();
  });
});
