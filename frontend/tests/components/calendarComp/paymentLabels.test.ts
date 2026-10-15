import { paymentMonthCellLabel, paymentTooltipTitle } from "@/components/calendarComp/paymentLabels";
import type { PaymentDate } from "@/types";

function payment(overrides: Partial<PaymentDate> = {}): PaymentDate {
  return {
    id: "pay-1",
    invoiceId: "inv-1",
    billingItemType: "invoice_due_date",
    totalAmount: 1000,
    amountPaid: 0,
    dueDate: "2026-09-05",
    nextPaymentDate: null,
    ...overrides,
  } as PaymentDate;
}

describe("paymentTooltipTitle", () => {
  it("names the matter when there is one", () => {
    expect(paymentTooltipTitle(payment({ matterName: "Estate Plan", clientName: "Jane Doe" }))).toBe("Payment: Estate Plan");
  });

  it("names the client for a client-level invoice with no matter", () => {
    expect(paymentTooltipTitle(payment({ matterName: null, clientName: "Jane Doe" }))).toBe("Payment: Jane Doe");
  });

  it("falls back to Invoice rather than printing null when neither name is known", () => {
    expect(paymentTooltipTitle(payment({ matterName: null, clientName: null }))).toBe("Payment: Invoice");
  });

  it("says Payment received for money already in", () => {
    expect(
      paymentTooltipTitle(payment({ billingItemType: "payment_received", matterName: "", clientName: "Jane Doe" })),
    ).toBe("Payment received: Jane Doe");
  });
});

describe("paymentMonthCellLabel", () => {
  it("leads with the client", () => {
    expect(paymentMonthCellLabel(payment({ matterName: "Estate Plan", clientName: "Jane Doe" }))).toBe("Jane Doe");
  });

  it("uses the matter when the client is unknown", () => {
    expect(paymentMonthCellLabel(payment({ matterName: "Estate Plan", clientName: null }))).toBe("Estate Plan");
  });

  it("falls back to Payment when neither name is known", () => {
    expect(paymentMonthCellLabel(payment({ matterName: "", clientName: "" }))).toBe("Payment");
  });
});
