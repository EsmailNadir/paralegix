import {
  getInvoiceClientAttribution,
  getInvoiceDisplayName,
  getInvoiceRemainingBalance,
  getInvoiceStatusKey,
  getInvoiceTotal,
  getTimeEntryClientAttribution,
  isAwaitingPayment,
} from "@/components/billingComp/utils";
import type { Invoice } from "@/types";

describe("billing invoice utils", () => {
  it("does not double count flat fees when totalAmount already includes them", () => {
    const invoice = {
      id: "inv-1",
      invoiceName: "Invoice",
      totalAmount: 163.17,
      flatFeesAmount: 14.67,
      amountPaid: 0,
      totalWrittenOff: 0,
      // Far-future due date so the invoice reads as outstanding (not overdue)
      // no matter when the suite runs.
      dueDate: "2999-04-15",
    } as Invoice;

    expect(getInvoiceTotal(invoice)).toBe(163.17);
    expect(getInvoiceRemainingBalance(invoice)).toBe(163.17);
    expect(getInvoiceStatusKey(invoice)).toBe("outstanding");
  });

  it("preserves canonical zero total and does not fall back to flat fees", () => {
    const invoice = {
      id: "inv-zero",
      invoiceName: "Zero Invoice",
      totalAmount: 0,
      flatFeesAmount: 55,
      amountPaid: 0,
      totalWrittenOff: 0,
    } as Invoice;

    expect(getInvoiceTotal(invoice)).toBe(0);
    expect(getInvoiceRemainingBalance(invoice)).toBe(0);
  });

  it("derives paid from the remaining balance instead of stale flags", () => {
    const invoice = {
      id: "inv-2",
      invoiceName: "Paid Invoice",
      totalAmount: 163.17,
      flatFeesAmount: 14.67,
      amountPaid: 163.17,
      totalWrittenOff: 0,
      isPaid: false,
      status: "outstanding",
    } as Invoice;

    expect(getInvoiceRemainingBalance(invoice)).toBe(0);
    expect(getInvoiceStatusKey(invoice)).toBe("paid");
  });

  it("reports an invoice closed by a write-off as credited, not paid", () => {
    // Real shape from the app: $1,001 billed, $10 collected, $991 forgiven.
    // Calling this "paid" credits the firm with money it never received.
    const invoice = {
      id: "inv-writeoff",
      invoiceName: "Mostly written off",
      totalAmount: 1001,
      amountPaid: 10,
      totalWrittenOff: 991,
      isPaid: false,
      status: "partial",
    } as Invoice;

    expect(getInvoiceRemainingBalance(invoice)).toBe(0);
    expect(getInvoiceStatusKey(invoice)).toBe("credited");
    expect(isAwaitingPayment(invoice)).toBe(false);
  });

  it("keeps a collected invoice paid even when part of it was written off", () => {
    const invoice = {
      id: "inv-collected",
      invoiceName: "Collected with a discount",
      totalAmount: 500,
      amountPaid: 450,
      totalWrittenOff: 50,
      isPaid: true,
    } as Invoice;

    expect(getInvoiceStatusKey(invoice)).toBe("paid");
  });

  it("does not treat a zero-total invoice as money owed", () => {
    const invoice = {
      id: "inv-empty",
      invoiceName: "Empty draft",
      totalAmount: 0,
      amountPaid: 0,
      totalWrittenOff: 0,
    } as Invoice;

    // Nothing to pay, so it must stay out of the payment lists and counts even
    // though the status rules can never move it off "outstanding".
    expect(getInvoiceStatusKey(invoice)).toBe("outstanding");
    expect(isAwaitingPayment(invoice)).toBe(false);
  });

  it("counts an unpaid invoice with a balance as awaiting payment", () => {
    const invoice = {
      id: "inv-owed",
      invoiceName: "Owed",
      totalAmount: 600,
      amountPaid: 0,
      totalWrittenOff: 0,
      dueDate: "2999-01-01",
    } as Invoice;

    expect(isAwaitingPayment(invoice)).toBe(true);
  });
});

describe("getInvoiceDisplayName", () => {
  it("prefers the invoice name", () => {
    expect(
      getInvoiceDisplayName({ invoiceName: "March retainer", invoiceNumber: "INV-9" })
    ).toBe("March retainer");
  });

  it("falls back to the invoice number rather than a placeholder", () => {
    // Most invoices carry a number and no name; the placeholder rendered whole
    // pages of identical "Untitled Invoice" rows.
    expect(getInvoiceDisplayName({ invoiceName: null, invoiceNumber: "INV-1002" })).toBe(
      "INV-1002"
    );
    expect(getInvoiceDisplayName({ invoiceName: "   ", invoiceNumber: "INV-1002" })).toBe(
      "INV-1002"
    );
  });

  it("uses the placeholder only when there is no identifier at all", () => {
    expect(getInvoiceDisplayName({ invoiceName: null, invoiceNumber: null })).toBe(
      "Untitled Invoice"
    );
  });
});

describe("getInvoiceClientAttribution", () => {
  it("attributes a client-context invoice to that client", () => {
    const attribution = getInvoiceClientAttribution({
      contextType: "client",
      entityId: "client-1",
      clientName: "Riverside Tech Inc",
    } as Invoice);

    expect(attribution.isAttributed).toBe(true);
    expect(attribution.name).toBe("Riverside Tech Inc");
    expect(attribution.clientId).toBe("client-1");
    expect(attribution.isAmbiguous).toBe(false);
  });

  it("attributes a matter invoice that names a client", () => {
    const attribution = getInvoiceClientAttribution({
      contextType: "matter",
      clientId: "client-2",
      clientName: "Vance Construction LLC",
      matterClientNames: ["Robert Henderson", "Vance Construction LLC"],
    } as Invoice & { matterClientNames: string[] });

    expect(attribution.isAttributed).toBe(true);
    expect(attribution.name).toBe("Vance Construction LLC");
    expect(attribution.clientId).toBe("client-2");
    expect(attribution.isAmbiguous).toBe(false);
  });

  it("names no payer for matter-level work on a multi-client matter", () => {
    // The API used to fill clientName with the matter's first client, which put
    // a payer on the invoice that nobody chose.
    const attribution = getInvoiceClientAttribution({
      contextType: "matter",
      clientId: null,
      clientName: null,
      matterClientNames: ["Robert Henderson", "Vance Construction LLC"],
    } as unknown as Invoice & { matterClientNames: string[] });

    expect(attribution.isAttributed).toBe(false);
    expect(attribution.name).toBeNull();
    expect(attribution.isAmbiguous).toBe(true);
    expect(attribution.matterClientNames).toHaveLength(2);
  });

  it("is not ambiguous when the matter has a single client", () => {
    const attribution = getInvoiceClientAttribution({
      contextType: "matter",
      clientId: null,
      clientName: null,
      matterClientNames: ["Eleanor Doyle"],
    } as unknown as Invoice & { matterClientNames: string[] });

    expect(attribution.isAmbiguous).toBe(false);
  });
});

describe("getTimeEntryClientAttribution", () => {
  const matterClients = [
    { id: "client-a", name: "Robert Henderson" },
    { id: "client-b", name: "Vance Construction LLC" },
  ];

  it("uses the clients the entry names", () => {
    const attribution = getTimeEntryClientAttribution(
      { context: "matter", matterClientIds: ["client-b"] },
      matterClients
    );

    expect(attribution.name).toBe("Vance Construction LLC");
    expect(attribution.isAmbiguous).toBe(false);
  });

  it("names no client for unattributed work on a multi-client matter", () => {
    const attribution = getTimeEntryClientAttribution(
      { context: "matter", matterClientIds: [], clientNames: matterClients.map((c) => c.name) },
      matterClients
    );

    expect(attribution.name).toBeNull();
    expect(attribution.isAmbiguous).toBe(true);
  });

  it("falls back to the matter's only client", () => {
    const attribution = getTimeEntryClientAttribution({ context: "matter" }, [
      { id: "client-a", name: "Eleanor Doyle" },
    ]);

    expect(attribution.name).toBe("Eleanor Doyle");
    expect(attribution.isAmbiguous).toBe(false);
  });

  it("uses the client directly for client-context work", () => {
    const attribution = getTimeEntryClientAttribution({
      context: "client",
      clientName: "Riverside Tech Inc",
    });

    expect(attribution.name).toBe("Riverside Tech Inc");
    expect(attribution.isAmbiguous).toBe(false);
  });
});
