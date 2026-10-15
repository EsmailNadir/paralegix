import type { Invoice } from "@/types";
import { formatDate, localDayKey, toLocalDate } from "@/lib/utils/dateUtils";

export interface StatementEntry {
  date: string;
  description: string;
  charge: number;
  payment: number;
  balance: number;
}

/** Same-day order: the charge first, then what was paid, then credits. */
const TYPE_RANK = { invoice: 0, payment: 1, credit: 2 } as const;

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A client's statement over its whole history, oldest first, with a running
 * balance. Invoice and payment dates are day-only and credit notes carry an
 * instant, so rows are ordered by the viewer's calendar day, then by type, then
 * by creation instant; input order breaks any remaining tie. The balance is
 * summed in integer cents.
 */
export function buildStatementEntries(invoices: Invoice[]): StatementEntry[] {
  type Row = Omit<StatementEntry, "balance"> & { day: string; rank: number; at: number; seq: number };
  const rows: Row[] = [];
  const push = (raw: unknown, rank: number, at: number, entry: Omit<StatementEntry, "date" | "balance">) => {
    rows.push({
      ...entry,
      date: formatDate(raw),
      day: localDayKey(raw as string | null) ?? "",
      rank,
      at,
      seq: rows.length,
    });
  };

  for (const inv of invoices) {
    // A voided invoice was never owed: the portal reports it with a zero
    // balance, so it adds no charge row and nothing to the running balance.
    if (inv.status === "voided") continue;
    const label = inv.invoiceName || inv.id.slice(0, 8);
    const invoiceDate = inv.invoiceDate || inv.createdAt;
    push(invoiceDate, TYPE_RANK.invoice, 0, {
      description: `Invoice: ${label}`,
      charge: money(inv.totalAmount),
      payment: 0,
    });
    for (const pmt of inv.payments || []) {
      const source = pmt.paymentSource === "trust" ? "Trust Payment" : pmt.paymentSource === "stripe" ? "Stripe Payment" : "Payment";
      push(pmt.date, TYPE_RANK.payment, 0, {
        description: `${source} for "${label}"${pmt.note ? ` · ${pmt.note}` : ""}`,
        charge: 0,
        payment: money(pmt.amount),
      });
    }
    for (const cn of inv.creditNotes || []) {
      push(cn.createdAt, TYPE_RANK.credit, toLocalDate(cn.createdAt)?.getTime() ?? 0, {
        description: `${cn.label || cn.type?.replace("_", " ") || "Adjustment"} for "${label}"`,
        charge: 0,
        payment: money(cn.amount),
      });
    }
  }

  rows.sort((a, b) => a.day.localeCompare(b.day) || a.rank - b.rank || a.at - b.at || a.seq - b.seq);

  let balanceCents = 0;
  return rows.map(({ date, description, charge, payment }) => {
    balanceCents += Math.round(charge * 100) - Math.round(payment * 100);
    return { date, description, charge, payment, balance: balanceCents / 100 };
  });
}
