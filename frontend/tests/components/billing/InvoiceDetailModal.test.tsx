import React from "react";
import { render, screen } from "@testing-library/react";

import InvoiceDetailModal from "@/components/billingComp/InvoiceDetailModal";

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    contextType: "matter",
    entityId: "matter-1",
    matterId: "matter-1",
    matterName: "Henderson v. Vance",
    matterClientNames: ["Robert Henderson", "Vance Construction LLC"],
    invoiceName: "March retainer",
    invoiceNumber: "INV-1002",
    invoiceDate: "2026-06-01",
    dueDate: "2026-06-20",
    totalAmount: 600,
    amountPaid: 0,
    totalWrittenOff: 0,
    clientId: null,
    clientName: null,
    ...overrides,
  };
}

function renderModal(invoice: Record<string, unknown>) {
  return render(
    React.createElement(InvoiceDetailModal, {
      invoice,
      open: true,
      onClose: jest.fn(),
      lawFirmId: "test-law-firm-id",
    } as any)
  );
}

describe("InvoiceDetailModal", () => {
  it("titles the dialog with the invoice name", () => {
    renderModal(makeInvoice());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("March retainer")).toBeInTheDocument();
  });

  it("falls back to the invoice number when there is no name", () => {
    renderModal(makeInvoice({ invoiceName: null }));
    // The number appears twice: as the heading and in the detail rows.
    expect(screen.getByRole("heading", { name: "INV-1002" })).toBeInTheDocument();
    expect(screen.queryByText("Untitled Invoice")).not.toBeInTheDocument();
  });

  it("lists every matter client when the invoice names no payer", () => {
    renderModal(makeInvoice({ clientId: null, clientName: null }));

    expect(screen.getByText("Matter clients")).toBeInTheDocument();
    expect(screen.getByText("Robert Henderson")).toBeInTheDocument();
    expect(screen.getByText("Vance Construction LLC")).toBeInTheDocument();
    expect(screen.getByText("Not billed to one client")).toBeInTheDocument();
  });

  it("names the single billed client when the invoice has one", () => {
    renderModal(makeInvoice({ clientId: "client-b", clientName: "Vance Construction LLC" }));

    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("Vance Construction LLC")).toBeInTheDocument();
    expect(screen.queryByText("Not billed to one client")).not.toBeInTheDocument();
  });

  it("shows the money summary", () => {
    renderModal(makeInvoice({ totalAmount: 600, amountPaid: 100 }));

    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("$600.00")).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText("Remaining")).toBeInTheDocument();
    expect(screen.getByText("$500.00")).toBeInTheDocument();
  });

  it("labels an invoice settled by a write-off as written off", () => {
    renderModal(
      makeInvoice({ totalAmount: 1001, amountPaid: 10, totalWrittenOff: 991, isPaid: false })
    );

    expect(screen.getByText("Written Off")).toBeInTheDocument();
    expect(screen.getByText("Credits / Adjustments")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      React.createElement(InvoiceDetailModal, {
        invoice: null,
        open: false,
        onClose: jest.fn(),
        lawFirmId: "test-law-firm-id",
      } as any)
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
