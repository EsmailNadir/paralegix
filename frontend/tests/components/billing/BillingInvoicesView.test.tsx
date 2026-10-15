import React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../support/renderWithProviders";

const mockLookupMatters = jest.fn();
const mockLookupClients = jest.fn();
const mockListFirmInvoicesPage = jest.fn();

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    lookupMatters: (...args: unknown[]) => mockLookupMatters(...args),
  },
}));

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    lookupClients: (...args: unknown[]) => mockLookupClients(...args),
  },
}));

// The view owns its data: it reads one server-filtered, server-paged window of
// the firm's invoices rather than receiving the whole list as a prop.
jest.mock("@/services/billing.service", () => ({
  __esModule: true,
  default: {
    listFirmInvoicesPage: (...args: unknown[]) => mockListFirmInvoicesPage(...args),
  },
}));

import BillingInvoicesView from "@/components/billingComp/BillingInvoicesView";

function renderView() {
  return renderWithProviders(React.createElement(BillingInvoicesView, { lawFirmId: "test-law-firm-id" }));
}

/** Serve one page of invoices from the mocked service. */
function servePage(invoices: any[]) {
  mockListFirmInvoicesPage.mockResolvedValue({ invoices, totalItems: invoices.length });
}

describe("BillingInvoicesView", () => {
  beforeEach(() => {
    mockLookupMatters.mockReset();
    mockLookupMatters.mockResolvedValue({ items: [], hasMore: false });
    mockLookupClients.mockReset();
    mockLookupClients.mockResolvedValue({ items: [], hasMore: false });
    mockListFirmInvoicesPage.mockReset();
    servePage([]);
  });

  it("shows the matter filter's All matters option without loading the firm's matters", async () => {
    renderView();

    expect(await screen.findByText("Matter")).toBeInTheDocument();
    expect(screen.getByText("All matters")).toBeInTheDocument();
    // The picker only queries once its menu opens, so a closed filter costs
    // nothing. The old dropdown loaded every matter in the firm up front.
    expect(mockLookupMatters).not.toHaveBeenCalled();
  });

  it("offers the client filter from the server typeahead, not from the invoices on screen", async () => {
    renderView();

    expect(await screen.findByText("Client")).toBeInTheDocument();
    expect(screen.getByText("All clients")).toBeInTheDocument();
    expect(mockLookupClients).not.toHaveBeenCalled();
  });

  it("renders the server's match count, not the number of rows on the page", async () => {
    mockListFirmInvoicesPage.mockResolvedValue({ invoices: [], totalItems: 42 });
    renderView();
    expect(await screen.findByText("42 invoices")).toBeInTheDocument();
  });

  it("asks the server for one page rather than the whole list", async () => {
    renderView();
    await waitFor(() => expect(mockListFirmInvoicesPage).toHaveBeenCalled());
    const params = mockListFirmInvoicesPage.mock.calls[0][1];
    expect(params.page).toBe(1);
    expect(params.limit).toBeGreaterThan(0);
  });

  it("shows the invoice number when an invoice has no name", async () => {
    servePage([
      {
        id: "inv-1",
        contextType: "matter",
        matterId: "case-1",
        matterName: "Smith v. Jones",
        matterClientNames: [],
        invoiceName: null,
        invoiceNumber: "INV-1002",
        invoiceDate: "2026-06-01",
        dueDate: "2999-01-01",
        totalAmount: 600,
        amountPaid: 0,
        totalWrittenOff: 0,
      },
    ]);
    renderView();

    expect(await screen.findByText("INV-1002")).toBeInTheDocument();
    expect(screen.queryByText("Untitled Invoice")).not.toBeInTheDocument();
  });

  it("labels an invoice settled by a write-off rather than calling it paid", async () => {
    servePage([
      {
        id: "inv-2",
        contextType: "matter",
        matterId: "case-1",
        matterName: "Smith v. Jones",
        matterClientNames: [],
        invoiceName: "Mostly written off",
        totalAmount: 1001,
        amountPaid: 10,
        totalWrittenOff: 991,
        isPaid: false,
      },
    ]);
    renderView();

    expect(await screen.findByText("Written Off")).toBeInTheDocument();
    expect(screen.queryByText("Fully paid")).not.toBeInTheDocument();
  });

  it("labels a voided invoice voided rather than unpaid or paid", async () => {
    servePage([
      {
        id: "inv-v",
        contextType: "matter",
        matterId: "case-1",
        matterName: "Smith v. Jones",
        matterClientNames: [],
        invoiceName: "Cancelled bill",
        status: "voided",
        totalAmount: 1000,
        amountPaid: 0,
        totalWrittenOff: 0,
        dueDate: "2020-01-01",
        isPaid: false,
      },
    ]);
    renderView();

    expect(await screen.findByText("Cancelled bill")).toBeInTheDocument();
    expect(screen.getAllByText("Voided").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Unpaid")).not.toBeInTheDocument();
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
    expect(screen.queryByText("Fully paid")).not.toBeInTheDocument();
  });
  it("offers Voided last in the status filter and requests status=voided when it is picked", async () => {
    renderView();
    await waitFor(() => expect(mockListFirmInvoicesPage).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels[labels.length - 1]).toBe("Voided");

    mockListFirmInvoicesPage.mockClear();
    await userEvent.click(screen.getByRole("option", { name: "Voided" }));

    await waitFor(() =>
      expect(mockListFirmInvoicesPage.mock.calls.some((call) => call[1].status === "voided")).toBe(true),
    );
  });

  it("marks a row whose invoice has a refund due, and only that row", async () => {
    servePage([
      { id: "inv-r", invoiceName: "Owes refund", totalAmount: 100, amountPaid: 150, totalWrittenOff: 0, refundDue: { amount: 50, reason: "overpaid" } },
      { id: "inv-n", invoiceName: "Plain", totalAmount: 100, amountPaid: 0, totalWrittenOff: 0, refundDue: null },
    ]);

    renderView();

    const row = (await screen.findByText("Owes refund")).closest("button") as HTMLElement;
    expect(row).toHaveTextContent("Refund due");
    const plain = screen.getByText("Plain").closest("button") as HTMLElement;
    expect(plain).not.toHaveTextContent("Refund due");
  });
});
