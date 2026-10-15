/**
 * A voided invoice is cancelled: not owed, not overdue, not chased.
 *
 * The status helpers derive everything from amounts, and a voided invoice's
 * amounts can still say it is owed, so every list, badge and total that reads
 * them showed a cancelled bill as unpaid or overdue and counted it as
 * outstanding. The backend sends `status: 'voided'`; these helpers must let
 * it override the amounts.
 *
 * RED IF: getInvoiceStatusKey ignores status 'voided'; getInvoiceStatus does
 * not badge it neutral "Voided"; isAwaitingPayment, getInvoiceRemainingBalance
 * or summarizeInvoiceMoney count it; sortInvoicesForList does not sink it with
 * the other closed invoices.
 */
import {
  getInvoiceRemainingBalance,
  getInvoiceStatus,
  getInvoiceStatusKey,
  isAwaitingPayment,
  isClosedStatusKey,
  isInvoiceEffectivelyOverdue,
  sortInvoicesForList,
  summarizeInvoiceMoney,
} from "@/components/billingComp/utils";
import type { Invoice } from "@/types";

function localDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PAST = localDay(-30);
const FUTURE = localDay(30);

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    invoiceName: "Invoice",
    totalAmount: 1000,
    amountPaid: 0,
    totalWrittenOff: 0,
    dueDate: FUTURE,
    ...overrides,
  } as Invoice;
}

describe("a voided invoice", () => {
  it("is voided even when its amounts say it is overdue", () => {
    const inv = invoice({ status: "voided", dueDate: PAST });

    expect(getInvoiceStatusKey(inv)).toBe("voided");
    expect(isInvoiceEffectivelyOverdue(inv)).toBe(false);
  });

  it("is voided even with a payment on it (a Stripe payment that landed after the void)", () => {
    expect(getInvoiceStatusKey(invoice({ status: "voided", amountPaid: 250 }))).toBe("voided");
  });

  it("is badged as a neutral Voided, like the other terminal states", () => {
    expect(getInvoiceStatus(invoice({ status: "voided", dueDate: PAST })))
      .toEqual({ label: "Voided", variant: "neutral" });
  });

  it("is not awaiting payment and has nothing remaining", () => {
    const inv = invoice({ status: "voided", totalAmount: 1000 });

    expect(isAwaitingPayment(inv)).toBe(false);
    expect(getInvoiceRemainingBalance(inv)).toBe(0);
    expect(isClosedStatusKey(getInvoiceStatusKey(inv))).toBe(true);
  });

  it("is left out of billed, paid and outstanding totals", () => {
    const totals = summarizeInvoiceMoney([
      invoice({ id: "live", totalAmount: 400, amountPaid: 100 }),
      invoice({ id: "void", status: "voided", totalAmount: 1000, amountPaid: 250 }),
    ]);

    // The voided 1000 (and the 250 that landed on it) appear nowhere.
    expect(totals).toEqual({ totalBilled: 400, totalPaid: 100, outstanding: 300 });
  });

  it("sinks below an open invoice, with the other closed ones", () => {
    const voided = invoice({ id: "void", status: "voided", dueDate: PAST });
    const open = invoice({ id: "open", dueDate: FUTURE });

    expect(sortInvoicesForList([voided, open]).map((i) => i.id)).toEqual(["open", "void"]);
  });
});

describe("neighbouring statuses are unchanged", () => {
  it("still reads an unpaid past-due invoice as overdue", () => {
    const inv = invoice({ status: "overdue", dueDate: PAST });

    expect(getInvoiceStatusKey(inv)).toBe("overdue");
    expect(isAwaitingPayment(inv)).toBe(true);
    expect(getInvoiceRemainingBalance(inv)).toBe(1000);
  });

  it("still derives paid from amounts when the stored status is stale", () => {
    expect(getInvoiceStatusKey(invoice({ status: "outstanding", amountPaid: 1000, isPaid: true }))).toBe("paid");
  });

  it("treats paid and written off as closed, and open states as not", () => {
    expect(["paid", "credited", "voided"].map(isClosedStatusKey)).toEqual([true, true, true]);
    expect(["outstanding", "overdue", "partially_paid"].map(isClosedStatusKey)).toEqual([false, false, false]);
  });

  it("totals open invoices to the cent", () => {
    expect(summarizeInvoiceMoney([
      invoice({ totalAmount: 0.1, amountPaid: 0 }),
      invoice({ totalAmount: 0.2, amountPaid: 0 }),
    ])).toEqual({ totalBilled: 0.3, totalPaid: 0, outstanding: 0.3 });
  });
});
