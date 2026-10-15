import { paymentDatePayableAmount, paymentDateRemaining } from "@/lib/billing/paymentDateBalance";
import type { PaymentDate } from "@/types";

function payment(overrides: Partial<PaymentDate> = {}): PaymentDate {
  return {
    id: "pay-1",
    invoiceId: "inv-1",
    billingItemType: "installment",
    totalAmount: 1000,
    amountPaid: 0,
    dueDate: null,
    nextPaymentDate: null,
    ...overrides,
  } as PaymentDate;
}

describe("paymentDateRemaining", () => {
  it("nets payments and credits in whole cents, so float noise never reaches the result", () => {
    // In float dollars 1000.07 - 500.03 - 0.01 is 500.0300000000001.
    expect(paymentDateRemaining(payment({ totalAmount: 1000.07, amountPaid: 500.03, totalWrittenOff: 0.01 }))).toBe(500.03);
    // 19.99 - 9.99 is 9.999999999999998 in float dollars.
    expect(paymentDateRemaining(payment({ totalAmount: 19.99, amountPaid: 9.99 }))).toBe(10);
  });

  it("is exactly zero when payments and credits settle the invoice, not a float residue", () => {
    // 1.1 - 1.0 - 0.1 is 8.3e-17 in float dollars, which reads as still owed.
    expect(paymentDateRemaining(payment({ totalAmount: 1.1, amountPaid: 1, totalWrittenOff: 0.1 }))).toBe(0);
  });

  it("treats a missing totalWrittenOff as no credit", () => {
    expect(paymentDateRemaining(payment({ totalAmount: 1000, amountPaid: 300, totalWrittenOff: undefined }))).toBe(700);
  });

  it("never goes below zero for an overpaid invoice", () => {
    expect(paymentDateRemaining(payment({ totalAmount: 100, amountPaid: 80, totalWrittenOff: 50 }))).toBe(0);
  });

  it("uses the server's cents-netted scheduledAmount for an invoice due date item", () => {
    // The server figure wins even where the client fields would compute a different value.
    expect(
      paymentDateRemaining(payment({ billingItemType: "invoice_due_date", totalAmount: 1000, amountPaid: 0, scheduledAmount: 640.5 })),
    ).toBe(640.5);
  });

  it("does not read an installment's scheduledAmount as the invoice balance", () => {
    expect(
      paymentDateRemaining(payment({ billingItemType: "installment", totalAmount: 1000, amountPaid: 250, scheduledAmount: 250 })),
    ).toBe(750);
  });

  it("falls back to the invoice fields when an invoice due date item carries no scheduledAmount", () => {
    const p = payment({ billingItemType: "invoice_due_date", totalAmount: 1000, amountPaid: 300, totalWrittenOff: 200 });
    (p as { scheduledAmount?: number | null }).scheduledAmount = null;
    expect(paymentDateRemaining(p)).toBe(500);
  });
});

describe("paymentDatePayableAmount", () => {
  it("pays an installment's scheduled amount, rounded to whole cents", () => {
    expect(
      paymentDatePayableAmount(payment({ billingItemType: "installment", installmentIndex: 1, scheduledAmount: 0.1 + 0.2 })),
    ).toBe(0.3);
  });

  it("pays the invoice's remaining balance for an invoice due date item", () => {
    expect(
      paymentDatePayableAmount(payment({ billingItemType: "invoice_due_date", totalAmount: 1000.07, amountPaid: 500.03, totalWrittenOff: 0.01 })),
    ).toBe(500.03);
  });

  it("has nothing payable once an invoice due date item is settled", () => {
    expect(
      paymentDatePayableAmount(payment({ billingItemType: "invoice_due_date", totalAmount: 1.1, amountPaid: 1, totalWrittenOff: 0.1 })),
    ).toBe(0);
  });

  it("has nothing payable for an installment without an index to pay against", () => {
    expect(paymentDatePayableAmount(payment({ billingItemType: "installment", scheduledAmount: 250 }))).toBe(0);
  });

  it("has nothing payable for a payment already received", () => {
    expect(
      paymentDatePayableAmount(payment({ billingItemType: "payment_received", totalAmount: 1000, amountPaid: 200, paidAmount: 200 })),
    ).toBe(0);
  });
});
