"use client";

import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { TrustTransaction } from "@/types/trust";
import { formatCents as fmtCents } from "@/lib/utils/currency";
import { PDF_PAGE_SIZE, PdfFooter, pdfStyles } from "@/components/pdf/pdfTheme";

// Column widths are the only thing unique to this statement; everything else
// comes from the shared stationery in pdfTheme.
const cols = StyleSheet.create({
  date: { width: "14%" },
  type: { width: "14%", textTransform: "capitalize" },
  desc: { width: "30%", paddingRight: 8 },
  ref: { width: "12%" },
  amount: { width: "15%", textAlign: "right" },
  balance: { width: "15%", textAlign: "right" },
});

function fmtDate(value?: string | null) {
  if (!value) return "-";
  // Parse day-only "YYYY-MM-DD" values into a local Date so the shown day is not
  // pulled back a day for viewers behind UTC (new Date("YYYY-MM-DD") is UTC).
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = dayOnly
    ? new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3]))
    : new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString("en-US");
}

interface ClientStatementReportProps {
  clientName: string;
  firmName?: string;
  accountName?: string;
  transactions: TrustTransaction[];
  currentBalanceCents: number;
}

export default function ClientStatementReport({
  clientName,
  firmName,
  accountName,
  transactions,
  currentBalanceCents,
}: ClientStatementReportProps) {
  // Distinct accounts represented in the ledger; surfaced in the header so a
  // cross-account statement names every account it draws from.
  const accountNames = Array.from(
    new Set(transactions.map((t) => t.trustAccountName).filter((n): n is string => !!n)),
  );
  const accountsLine = accountName || (accountNames.length > 0 ? accountNames.join(", ") : "All Trust Accounts");

  // Source is chronological (oldest first); show newest first to match the modal.
  const orderedTxns = [...transactions].reverse();

  const firm = firmName || "Law Firm";
  const statementDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return (
    <Document>
      <Page size={PDF_PAGE_SIZE} style={pdfStyles.page}>
        <View style={pdfStyles.header}>
          <View style={pdfStyles.headerLeft}>
            <Text style={pdfStyles.firmName}>{firm}</Text>
            <Text style={pdfStyles.address}>{accountsLine}</Text>
          </View>
          <View style={pdfStyles.headerRight}>
            <Text style={pdfStyles.docTitle}>STATEMENT</Text>
            <View style={pdfStyles.metaRow}>
              <Text style={pdfStyles.metaLabel}>Client</Text>
              <Text style={pdfStyles.metaValue}>{clientName}</Text>
            </View>
            <View style={pdfStyles.metaRow}>
              <Text style={pdfStyles.metaLabel}>Statement date</Text>
              <Text style={pdfStyles.metaValue}>{statementDate}</Text>
            </View>
          </View>
        </View>

        <View style={pdfStyles.band}>
          <Text style={pdfStyles.bandLabel}>Current trust balance</Text>
          <Text style={pdfStyles.bandValue}>{fmtCents(currentBalanceCents)}</Text>
        </View>

        <View style={pdfStyles.parties}>
          <View style={pdfStyles.partyColumn}>
            <Text style={pdfStyles.partyLabel}>Client</Text>
            <Text style={pdfStyles.partyName}>{clientName}</Text>
          </View>
          <View style={pdfStyles.partyColumn}>
            <Text style={pdfStyles.partyLabel}>Held by</Text>
            <Text style={pdfStyles.partyName}>{firm}</Text>
            <Text style={pdfStyles.partyLine}>{accountsLine}</Text>
          </View>
        </View>

        {/* A trust ledger is the document here most likely to run to many pages,
            so the column headings repeat and no row is split by a page break.
            Nothing follows inside this View: `fixed` repeats for every page its
            parent spans, so a trailing block would drag the headings onto a page
            with no rows. */}
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Transactions</Text>
          <View style={pdfStyles.tableHeader} fixed>
            <Text style={[pdfStyles.headerCell, cols.date]}>Date</Text>
            <Text style={[pdfStyles.headerCell, cols.type]}>Type</Text>
            <Text style={[pdfStyles.headerCell, cols.desc]}>Description</Text>
            <Text style={[pdfStyles.headerCell, cols.ref]}>Ref</Text>
            <Text style={[pdfStyles.headerCell, cols.amount]}>Amount</Text>
            <Text style={[pdfStyles.headerCell, cols.balance]}>Balance</Text>
          </View>
          {orderedTxns.length === 0 ? (
            <Text style={pdfStyles.emptyText}>No transactions for this client.</Text>
          ) : (
            orderedTxns.map((txn) => {
              const isVoid = txn.status === "void";
              const base = isVoid ? pdfStyles.cellVoid : pdfStyles.cell;
              const signed = `${txn.type === "deposit" ? "+" : "-"}${fmtCents(txn.amountCents)}`;
              return (
                <View key={txn.id} style={pdfStyles.row} wrap={false}>
                  <Text style={[base, cols.date]}>{fmtDate(txn.date)}</Text>
                  <Text style={[base, cols.type]}>{txn.type}</Text>
                  <Text style={[base, cols.desc]}>{txn.description || "-"}</Text>
                  <Text style={[isVoid ? pdfStyles.cellVoid : pdfStyles.cellMuted, cols.ref]}>
                    {txn.referenceNumber || "-"}
                  </Text>
                  <Text style={[base, cols.amount]}>{isVoid ? "VOID" : signed}</Text>
                  <Text style={[isVoid ? pdfStyles.cellVoid : pdfStyles.cellStrong, cols.balance]}>
                    {isVoid || txn.clientBalanceAfter == null ? "-" : fmtCents(txn.clientBalanceAfter)}
                  </Text>
                </View>
              );
            })
          )}
        </View>

        <PdfFooter left={`${firm} · Trust statement · ${clientName}`} />
      </Page>
    </Document>
  );
}
