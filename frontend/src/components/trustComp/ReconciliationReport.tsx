"use client";

import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { TrustReconciliation } from "@/types/trust";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { formatCents as fmtCents } from "@/lib/utils/currency";
import { PDF_COLORS, PDF_PAGE_SIZE, PdfFooter, pdfStyles } from "@/components/pdf/pdfTheme";

// Only what is unique to a reconciliation worksheet; the rest is shared stationery.
const local = StyleSheet.create({
  worksheetRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderBottom: `1px solid ${PDF_COLORS.rule}` },
  label: { fontSize: 9.5, color: PDF_COLORS.body, flex: 2 },
  labelStrong: { fontSize: 9.5, fontWeight: "bold", color: PDF_COLORS.ink, flex: 2 },
  value: { fontSize: 9.5, color: PDF_COLORS.ink, flex: 1, textAlign: "right" },
  valueStrong: { fontSize: 9.5, fontWeight: "bold", color: PDF_COLORS.ink, flex: 1, textAlign: "right" },
  resultBox: { marginTop: 6, marginBottom: 22, padding: 12, borderLeftWidth: 3, borderLeftStyle: "solid" },
  resultText: { fontSize: 11, fontWeight: "bold" },
  resultDetail: { fontSize: 8, marginTop: 5, color: PDF_COLORS.muted },
});

interface ReconciliationReportProps {
  reconciliation: TrustReconciliation;
  accountName: string;
  firmName?: string;
}

export default function ReconciliationReport({ reconciliation: rec, accountName, firmName }: ReconciliationReportProps) {
  const adjustmentTotal = (rec.adjustments || []).reduce((s, a) => s + (a.amountCents || 0), 0);
  // discrepancyCents is the authoritative value computed by the backend; it
  // already accounts for outstanding (uncleared) transactions and adjustments,
  // so it must not be recomputed here as a naive bank-minus-book difference.
  const discrepancyCents = rec.discrepancyCents;
  const isReconciled = rec.isReconciled;
  const outstandingCount = rec.outstandingTransactionIds?.length || 0;
  // expectedBank is what the bank statement should read given the books:
  //   expectedBank = book - outstandingNet + adjustments,  and  discrepancy = bank - expectedBank.
  const expectedBank = rec.bankStatementBalanceCents - discrepancyCents;
  // Recover the net of the outstanding items from the stored figures so the
  // worksheet reconciles book -> expected bank line by line.
  const outstandingNet = rec.bookBalanceCents + adjustmentTotal - expectedBank;
  const ledgerMatchesBook = rec.bookBalanceCents === rec.clientLedgerTotalCents;

  const firm = firmName || "Law Firm";
  const reconciledOn = formatDateOnly(
    rec.reconciliationDate,
    { year: "numeric", month: "long", day: "numeric" },
    "N/A",
  );

  return (
    <Document>
      <Page size={PDF_PAGE_SIZE} style={pdfStyles.page}>
        <View style={pdfStyles.header}>
          <View style={pdfStyles.headerLeft}>
            <Text style={pdfStyles.firmName}>{firm}</Text>
            <Text style={pdfStyles.address}>{accountName}</Text>
          </View>
          <View style={pdfStyles.headerRight}>
            <Text style={pdfStyles.docTitle}>RECONCILIATION</Text>
            <Text style={pdfStyles.docSubtitle}>Three-way trust reconciliation</Text>
            <View style={pdfStyles.metaRow}>
              <Text style={pdfStyles.metaLabel}>Reconciled</Text>
              <Text style={pdfStyles.metaValue}>{reconciledOn}</Text>
            </View>
            <View style={pdfStyles.metaRow}>
              <Text style={pdfStyles.metaLabel}>By</Text>
              <Text style={pdfStyles.metaValue}>{rec.reconciledByName || rec.reconciledBy || "Unknown"}</Text>
            </View>
          </View>
        </View>

        <View style={pdfStyles.band}>
          <Text style={pdfStyles.bandLabel}>{isReconciled ? "Reconciled" : "Discrepancy"}</Text>
          <Text style={isReconciled ? pdfStyles.bandValueSuccess : pdfStyles.bandValueDanger}>
            {isReconciled ? "All three balances agree" : fmtCents(discrepancyCents)}
          </Text>
        </View>

        {/* Section A: Bank reconciliation worksheet (book -> expected bank statement).
            wrap={false} keeps a worksheet line's label with its figure. */}
        <View style={pdfStyles.section}>
          <Text style={pdfStyles.sectionTitle}>Section A · Bank reconciliation</Text>
          <View style={local.worksheetRow} wrap={false}>
            <Text style={local.label}>Book balance (system ledger)</Text>
            <Text style={local.value}>{fmtCents(rec.bookBalanceCents)}</Text>
          </View>
          {(outstandingCount > 0 || outstandingNet !== 0) && (
            <View style={local.worksheetRow} wrap={false}>
              <Text style={local.label}>
                {outstandingCount > 0
                  ? `Outstanding transactions (${outstandingCount})`
                  : "Outstanding transactions"}
              </Text>
              <Text style={local.value}>{fmtCents(-outstandingNet)}</Text>
            </View>
          )}
          {(rec.adjustments || []).map((adj, i) => (
            <View key={i} style={local.worksheetRow} wrap={false}>
              <Text style={local.label}>Adjustment: {adj.description || "Adjustment"}</Text>
              <Text style={local.value}>{fmtCents(adj.amountCents)}</Text>
            </View>
          ))}
          <View style={local.worksheetRow} wrap={false}>
            <Text style={local.labelStrong}>Expected bank balance</Text>
            <Text style={local.valueStrong}>{fmtCents(expectedBank)}</Text>
          </View>
          <View style={local.worksheetRow} wrap={false}>
            <Text style={local.label}>Bank statement balance</Text>
            <Text style={local.value}>{fmtCents(rec.bankStatementBalanceCents)}</Text>
          </View>
          <View style={local.worksheetRow} wrap={false}>
            <Text style={local.labelStrong}>Difference</Text>
            <Text style={local.valueStrong}>{fmtCents(discrepancyCents)}</Text>
          </View>
        </View>

        {/* Section B: Three-way verification (book vs sum of client ledgers) */}
        <View style={pdfStyles.section} minPresenceAhead={70}>
          <Text style={pdfStyles.sectionTitle}>Section B · Three-way verification</Text>
          <View style={local.worksheetRow} wrap={false}>
            <Text style={local.label}>Book balance (system ledger)</Text>
            <Text style={local.value}>{fmtCents(rec.bookBalanceCents)}</Text>
          </View>
          <View style={local.worksheetRow} wrap={false}>
            <Text style={local.label}>Client ledger total (sum of all client balances)</Text>
            <Text style={local.value}>{fmtCents(rec.clientLedgerTotalCents)}</Text>
          </View>
          <View style={local.worksheetRow} wrap={false}>
            <Text style={local.labelStrong}>Difference</Text>
            <Text style={local.valueStrong}>
              {fmtCents(rec.bookBalanceCents - rec.clientLedgerTotalCents)}
            </Text>
          </View>
        </View>

        {/* Outcome, kept whole so the verdict never splits from the figures behind it. */}
        <View
          style={[
            local.resultBox,
            {
              backgroundColor: isReconciled ? "#f0fdf4" : "#fefce8",
              borderLeftColor: isReconciled ? PDF_COLORS.success : "#ca8a04",
            },
          ]}
          wrap={false}
        >
          <Text style={[local.resultText, { color: isReconciled ? PDF_COLORS.success : "#ca8a04" }]}>
            {isReconciled
              ? "All three balances agree: reconciled"
              : `${ledgerMatchesBook ? "Bank discrepancy" : "Discrepancy"}: ${fmtCents(discrepancyCents)}`}
          </Text>
          <Text style={local.resultDetail}>
            Bank {fmtCents(rec.bankStatementBalanceCents)} · Book {fmtCents(rec.bookBalanceCents)} · Client ledger{" "}
            {fmtCents(rec.clientLedgerTotalCents)}
          </Text>
        </View>

        {rec.notes && (
          <View style={pdfStyles.note} minPresenceAhead={40}>
            <Text style={pdfStyles.sectionTitle}>Notes</Text>
            <Text style={pdfStyles.noteText}>{rec.notes}</Text>
          </View>
        )}

        <PdfFooter left={`${firm} · Reconciliation · ${accountName}`} />
      </Page>
    </Document>
  );
}
