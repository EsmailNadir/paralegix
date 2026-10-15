/**
 * `MatterSplitInvoiceComposer`: splits one matter's billable work across
 * several client invoices.
 *
 * Rules that produce a wrong number if they slip:
 *
 *   EQUAL SPLIT MUST SUM TO THE EXACT TOTAL, not to whatever floating-point
 *   division happens to produce. `distributeAmount`'s own remainder fixup
 *   exists specifically because `total / n` rounded per-share can miss the
 *   original total by a cent; losing that fixup silently shorts (or
 *   overcounts) one client's invoice by a cent on every odd split.
 *
 *   A PERCENTAGE SPLIT MUST TOTAL EXACTLY 100%, and a FIXED-AMOUNT SPLIT MUST
 *   TOTAL THE FULL SELECTED AMOUNT, before either is applied - an accepted
 *   split that doesn't could over- or under-bill relative to the actual work
 *   done.
 *
 *   CREATING INVOICES WHILE A ROW IS UNDER/OVER ALLOCATED MUST BE REFUSED,
 *   not silently submitted with money unaccounted for.
 */
const mockCreateSplitInvoices = jest.fn();

jest.mock("@/services/billing.service", () => ({
  __esModule: true,
  default: {
    createSplitInvoices: (...args: unknown[]) => mockCreateSplitInvoices(...args),
  },
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MatterSplitInvoiceComposer from "@/components/billingComp/MatterSplitInvoiceComposer";
import type { MatterClient, InvoiceLineItem } from "@/types";

const CLIENT_A: MatterClient = { id: "client-a", name: "Alice Adams" } as MatterClient;
const CLIENT_B: MatterClient = { id: "client-b", name: "Bob Brown" } as MatterClient;
const CLIENT_C: MatterClient = { id: "client-c", name: "Cara Cole" } as MatterClient;

function renderComposer(
  matterClients: MatterClient[],
  timeEntries: InvoiceLineItem[],
  onValidationError: jest.Mock = jest.fn(),
  onCreated: jest.Mock = jest.fn(),
) {
  return render(
    <MatterSplitInvoiceComposer
      lawFirmId="firm-1"
      matterId="matter-1"
      matterClients={matterClients}
      invoiceDate="2026-09-01"
      dueDate="2026-09-15"
      notes=""
      remitTo={{ name: "", address: "", city: "", state: "", zip: "" }}
      baseInvoiceName="Invoice"
      baseInvoiceNumber=""
      timeEntries={timeEntries}
      flatFees={[]}
      onValidationError={onValidationError}
      onCreated={onCreated}
    />,
  );
}

beforeEach(() => {
  mockCreateSplitInvoices.mockReset().mockResolvedValue({ createdCount: 2, splitGroupId: "grp-1" });
});

describe("equal split rounding", () => {
  it("sums to the exact total across three clients, even when it doesn't divide evenly", async () => {
    // $100.01 split three ways is $33.34 + $33.34 + $33.33 (the remainder
    // lands on the last share) - never $33.33 x 3 = $99.99. Verified through
    // the submitted payload, which is what actually gets billed, rather than
    // scraping the preview text (several unrelated `$` amounts share the
    // screen with the per-client shares).
    renderComposer(
      [CLIENT_A, CLIENT_B, CLIENT_C],
      [{ id: "te-1", name: "Research", amount: 100.01, hours: 1 } as InvoiceLineItem],
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Split Invoices" }));

    await waitFor(() => expect(mockCreateSplitInvoices).toHaveBeenCalledTimes(1));
    const [, , payload] = mockCreateSplitInvoices.mock.calls[0];
    expect(payload.invoices).toHaveLength(3);
    const total = payload.invoices.reduce((sum: number, inv: any) => sum + inv.totalAmount, 0);
    expect(Math.round(total * 100) / 100).toBe(100.01);
  });
});

describe("percentage split validation", () => {
  it("refuses to apply a percentage split that does not total 100%", async () => {
    const onValidationError = jest.fn();
    renderComposer(
      [CLIENT_A, CLIENT_B],
      [{ id: "te-1", name: "Research", amount: 100, hours: 1 } as InvoiceLineItem],
      onValidationError,
    );

    fireEvent.click(screen.getByRole("button", { name: /By Percentage/ }));
    const [pctA, pctB] = screen.getAllByPlaceholderText("0");
    await userEvent.type(pctA, "50");
    await userEvent.type(pctB, "40");
    fireEvent.click(screen.getByRole("button", { name: "Apply Split" }));

    expect(onValidationError).toHaveBeenCalledWith(expect.stringContaining("100%"));
  });
});

describe("fixed-amount split validation", () => {
  it("refuses to apply a fixed split that does not total the full selected amount", async () => {
    const onValidationError = jest.fn();
    renderComposer(
      [CLIENT_A, CLIENT_B],
      [{ id: "te-1", name: "Research", amount: 100, hours: 1 } as InvoiceLineItem],
      onValidationError,
    );

    fireEvent.click(screen.getByRole("button", { name: /By Amount/ }));
    const [amtA, amtB] = screen.getAllByPlaceholderText("0.00");
    await userEvent.type(amtA, "40");
    await userEvent.type(amtB, "40");
    fireEvent.click(screen.getByRole("button", { name: "Apply Split" }));

    expect(onValidationError).toHaveBeenCalledWith(expect.stringContaining("$100"));
  });
});

describe("creating with an unbalanced allocation", () => {
  it("refuses to create invoices while a row is under-allocated", async () => {
    const onValidationError = jest.fn();
    renderComposer(
      [CLIENT_A, CLIENT_B],
      [{ id: "te-1", name: "Research", amount: 100, hours: 1 } as InvoiceLineItem],
      onValidationError,
    );

    // Switch to manual/per-entry mode and zero out one client's share,
    // leaving the row under-allocated relative to its $100 total.
    fireEvent.click(screen.getByRole("button", { name: /Per Entry/ }));
    const rowInputs = screen.getAllByRole("spinbutton").filter((el) => (el as HTMLInputElement).value !== "");
    fireEvent.change(rowInputs[0], { target: { value: "20" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Split Invoices" }));

    await waitFor(() =>
      expect(onValidationError).toHaveBeenCalledWith(expect.stringMatching(/under allocated/)),
    );
    expect(mockCreateSplitInvoices).not.toHaveBeenCalled();
  });
});

describe("the submitted payload", () => {
  it("sums each client's allocation amount to the source row's total", async () => {
    renderComposer(
      [CLIENT_A, CLIENT_B],
      [{ id: "te-1", name: "Research", amount: 100, hours: 2 } as InvoiceLineItem],
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Split Invoices" }));

    await waitFor(() => expect(mockCreateSplitInvoices).toHaveBeenCalledTimes(1));
    const [, , payload] = mockCreateSplitInvoices.mock.calls[0];
    const total = payload.invoices.reduce((sum: number, inv: any) => sum + inv.totalAmount, 0);
    expect(Math.round(total * 100) / 100).toBe(100);
  });

  it("sends a hand-typed row with no source id and a saved row with its activity id", async () => {
    renderComposer(
      [CLIENT_A, CLIENT_B],
      [
        { id: "te-1", name: "Research", amount: 100, hours: 2 } as InvoiceLineItem,
        { id: "manual-te-1700000000000", name: "Phone call", amount: 50, hours: 1 } as InvoiceLineItem,
      ],
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Split Invoices" }));

    await waitFor(() => expect(mockCreateSplitInvoices).toHaveBeenCalledTimes(1));
    const [, , payload] = mockCreateSplitInvoices.mock.calls[0];
    expect(payload.sourceSelection.timeEntries).toEqual(["te-1"]);
    for (const invoice of payload.invoices) {
      expect(invoice.timeEntries.map((line: any) => line.id)).toEqual(["te-1", undefined]);
      expect(invoice.timeEntries[1]).toMatchObject({ name: "Phone call", amount: 25 });
      expect("id" in invoice.timeEntries[1]).toBe(false);
    }
  });
});
