/**
 * The Summary card lists money in (Paid) as a plain amount beside the credits
 * line. Red if the Paid amount is printed as a negative again, or if the
 * Remaining Balance stops netting credits as well as payments.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import InvoiceDetailSummary from "@/components/billingComp/InvoiceDetailSummary";

function detail(overrides: Record<string, unknown> = {}) {
  return {
    lawFirmId: "firm-1",
    navigate: jest.fn(),
    canManageInvoices: false,
    canRecordPayments: false,
    readOnlyInvoice: true,
    invoice: { id: "inv-1" },
    updatingPayment: false,
    viewingReceiptIdx: null,
    stripeStatus: "not_connected",
    clientTrustBalance: null,
    trustAccounts: [],
    selectedTrustAccountId: null,
    requestingStripePayment: false,
    voidingStripePayment: false,
    totalAmount: 500,
    amountPaid: 150,
    totalWrittenOff: 100,
    remainingBalance: 250,
    creditBalance: 0,
    payments: [],
    timeEntries: [],
    timeEntriesTotal: 0,
    flatFeesTotal: 0,
    expensesTotal: 0,
    adjustmentsTotal: 0,
    isPaid: false,
    status: "sent",
    taxAmount: 0,
    subtotalAmount: 500,
    taxLabel: "Tax",
    showStripeSetupCard: false,
    openPaymentModal: jest.fn(),
    handleViewPaymentReceipt: jest.fn(),
    ...overrides,
  } as any;
}

const rowAmount = (label: string) => within(screen.getByText(label).parentElement!).getByText(/\$/).textContent;

describe("InvoiceDetailSummary money rows", () => {
  it("prints Paid as a plain amount with no minus sign", () => {
    render(<InvoiceDetailSummary detail={detail()} />);
    expect(rowAmount("Paid")).toBe("$150.00");
  });

  it("keeps credits as a deduction and nets both into the remaining balance", () => {
    render(<InvoiceDetailSummary detail={detail()} />);
    expect(rowAmount("Credits / Adjustments")).toBe("-$100.00");
    expect(rowAmount("Remaining Balance")).toBe("$250.00");
  });

  it("leaves the Paid row out when nothing has been paid", () => {
    render(<InvoiceDetailSummary detail={detail({ amountPaid: 0, remainingBalance: 400 })} />);
    expect(screen.getByText("Remaining Balance")).toBeInTheDocument();
    expect(screen.queryByText("Paid")).not.toBeInTheDocument();
  });
});
