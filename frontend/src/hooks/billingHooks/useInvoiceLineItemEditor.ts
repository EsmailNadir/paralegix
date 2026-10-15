"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import BillingService from "@/services/billing.service";
import { ApiError } from "@/lib/utils/apiErrors";
import { hmToHours, hoursToHm } from "@/lib/utils/format";
import { hoursTimesRateCents, hoursToHundredths, percentOfCents } from "@/lib/utils/currency";
import type { BillingContext, Invoice, InvoiceLineItemInput } from "@/types";

/**
 * A draft line carries a `rowKey` alongside the source id. Two lines can share a
 * source id only in malformed data, but a row also has to survive being blanked
 * out mid-typing, so the key is positional and assigned once when the editor
 * opens rather than derived from the values being edited.
 *
 * Time is held as the hours/minutes strings the shared HoursMinutesInput works
 * in, never as decimal hours - the decimal is derived only when a payload is
 * built. All three transient fields are stripped before anything is sent.
 */
export type EditableLine = InvoiceLineItemInput & {
  rowKey: string;
  hoursInput?: string;
  minutesInput?: string;
};

/** Decimal hours for a draft line, from the h/m it is actually edited in. */
export function lineHours(line: EditableLine): number {
  if (line.hoursInput === undefined && line.minutesInput === undefined) {
    return Number(line.hours) || 0;
  }
  return hmToHours(line.hoursInput, line.minutesInput);
}

function toEditable(items: any[] = [], kind: string, withTime = false): EditableLine[] {
  return items.map((item, i) => {
    const line: EditableLine = { ...item, rowKey: `${kind}-${item?.id ?? "line"}-${i}` };
    if (withTime) {
      const { h, m } = hoursToHm(Number(item?.hours) || 0);
      // Blank rather than "0" for an empty half, matching how HoursMinutesInput's
      // own steppers clear a field when they step it down to zero.
      line.hoursInput = h > 0 ? String(h) : "";
      line.minutesInput = m > 0 ? String(m) : "";
    }
    return line;
  });
}

function toPayload(lines: EditableLine[]): InvoiceLineItemInput[] {
  return lines.map((line) => {
    const rest: EditableLine = { ...line, hours: lineHours(line) };
    delete (rest as Partial<EditableLine>).rowKey;
    delete rest.hoursInput;
    delete rest.minutesInput;
    return rest;
  });
}

/** Money in, cents out - mirrors the server's integer-cent arithmetic. */
function toCents(value: unknown) {
  return Math.round((Number(value) || 0) * 100);
}

/**
 * Draft state for editing an invoice's line items.
 *
 * The server owns the arithmetic; the totals here exist so the editor can show
 * what a change will do before it is saved, and they use the same integer-cent
 * rounding so the preview cannot disagree with the saved result by a cent.
 */
export function useInvoiceLineItemEditor({
  context,
  invoice,
  onSaved,
}: {
  context: BillingContext;
  invoice: Invoice | null;
  onSaved: (updated: Invoice) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpenState] = useState(false);
  const [timeEntries, setTimeEntries] = useState<EditableLine[]>([]);
  const [flatFees, setFlatFees] = useState<EditableLine[]>([]);
  const [expenses, setExpenses] = useState<EditableLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | Error | null>(null);
  // Set when the server refuses a total below what has been settled; holds the
  // credit the change would create so the confirm copy can name the figure.
  const [overpayCredit, setOverpayCredit] = useState<number | null>(null);

  const reset = useCallback(() => {
    setTimeEntries(toEditable(invoice?.timeEntries as any[], "time", true));
    setFlatFees(toEditable(invoice?.flatFees as any[], "fee"));
    setExpenses(toEditable(invoice?.expenses as any[], "expense"));
    setError(null);
    setOverpayCredit(null);
  }, [invoice]);

  // Re-seed as the editor opens so a cancelled edit never leaks into the next one
  // and a refetched invoice is picked up. Seeding here rather than in an effect
  // keyed on `invoice` keeps a parent refetch mid-edit from wiping the draft.
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) reset();
      setOpenState(next);
    },
    [reset],
  );

  const preview = useMemo(() => {
    // Hourly lines are priced hours x rate, matching the server, which recomputes
    // `amount` for time entries and ignores whatever the client sent.
    const timeCents = timeEntries.reduce(
      (sum, line) => sum + hoursTimesRateCents(hoursToHundredths(lineHours(line)), toCents(line.rate)),
      0,
    );
    const feeCents = flatFees.reduce((sum, line) => sum + toCents(line.amount), 0);
    const expenseCents = expenses.reduce((sum, line) => sum + toCents(line.amount), 0);
    const subtotalCents = timeCents + feeCents + expenseCents;

    const taxRate = Number(invoice?.taxRate) || 0;
    const taxCents = taxRate > 0 ? percentOfCents(subtotalCents, taxRate) : 0;
    // Amounts added after creation (add-amount, late fee) stay in the total, and
    // tax is levied on the lines only, as the server does.
    const adjustmentsCents = (invoice?.amountAdjustmentNotes || []).reduce(
      (sum, adjustment) => sum + toCents(adjustment.amount),
      0,
    );
    const totalCents = subtotalCents + taxCents + adjustmentsCents;

    const settledCents = toCents(invoice?.amountPaid) + toCents(invoice?.totalWrittenOff);
    const hours = timeEntries.reduce((sum, line) => sum + lineHours(line), 0);

    return {
      subtotal: subtotalCents / 100,
      tax: taxCents / 100,
      total: totalCents / 100,
      hours,
      settled: settledCents / 100,
      // Positive when saving would leave the invoice settled past its own total.
      creditIfSaved: Math.max(0, settledCents - totalCents) / 100,
      delta: (totalCents - toCents(invoice?.totalAmount)) / 100,
    };
  }, [timeEntries, flatFees, expenses, invoice]);

  const submit = useCallback(
    async (acknowledgeOverpayment = false) => {
      if (!invoice) return false;
      setSubmitting(true);
      setError(null);
      try {
        const updated = await BillingService.updateInvoiceLineItems(context, invoice.id, {
          timeEntries: toPayload(timeEntries),
          flatFees: toPayload(flatFees),
          expenses: toPayload(expenses),
          ...(acknowledgeOverpayment ? { acknowledgeOverpayment: true } : {}),
        });
        onSaved(updated);
        queryClient.invalidateQueries({ queryKey: ["billing"] });
        setOverpayCredit(null);
        setOpenState(false);
        return true;
      } catch (err) {
        // The server refuses an over-settling total once, reporting the credit it
        // would create; the same payload goes back with the acknowledgement after
        // the user confirms.
        if (err instanceof ApiError && err.code === "INVOICE_TOTAL_BELOW_SETTLED") {
          const details = err.details as { creditAmount?: number } | undefined;
          setOverpayCredit(Number(details?.creditAmount) || 0);
          return false;
        }
        setError(err instanceof Error ? err : String(err));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [context, invoice, timeEntries, flatFees, expenses, onSaved, queryClient],
  );

  return {
    open,
    setOpen,
    timeEntries,
    setTimeEntries,
    flatFees,
    setFlatFees,
    expenses,
    setExpenses,
    submitting,
    error,
    setError,
    overpayCredit,
    setOverpayCredit,
    preview,
    submit,
    reset,
  };
}
