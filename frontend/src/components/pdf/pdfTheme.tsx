import { Text, View, StyleSheet } from "@react-pdf/renderer";

/**
 * One stationery set for every PDF the app generates.
 *
 * A client can receive an invoice, a payment receipt and a trust statement from
 * the same firm in the same week, so they have to look like they came from the
 * same place. Before this existed each document carried its own StyleSheet and
 * they had drifted into three different palettes, two page sizes and two type
 * scales. Style a new document from these tokens; only add a private style for
 * something genuinely unique to that document.
 */

/**
 * US legal practice prints on Letter, and every address field in the app is
 * US-shaped (state, ZIP, USD). The trust reports were already Letter; the
 * billing documents were A4, which is the odd one out. Change this single
 * constant to move every document at once.
 */
export const PDF_PAGE_SIZE = "LETTER" as const;

export const PDF_COLORS = {
  ink: "#111827",
  body: "#374151",
  muted: "#6b7280",
  rule: "#e5e7eb",
  ruleStrong: "#d1d5db",
  accent: "#2563eb",
  danger: "#b91c1c",
  success: "#15803d",
  wash: "#f9fafb",
} as const;

const C = PDF_COLORS;

export const pdfStyles = StyleSheet.create({
  // Bottom padding reserves the band the fixed footer occupies, so flowing
  // content never runs underneath it.
  page: {
    paddingTop: 40,
    paddingHorizontal: 44,
    paddingBottom: 64,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: C.body,
  },

  // ── Header ────────────────────────────────────────────────────────
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 },
  headerLeft: { width: "52%" },
  headerRight: { width: "42%", alignItems: "flex-end" },
  logo: { maxWidth: 150, maxHeight: 44, objectFit: "contain", marginBottom: 10 },
  firmName: { fontSize: 15, fontWeight: "bold", color: C.ink, marginBottom: 4 },
  address: { fontSize: 9, color: C.muted, marginBottom: 1.5 },

  docTitle: { fontSize: 22, fontWeight: "bold", color: C.ink, letterSpacing: 1.5, marginBottom: 10 },
  docSubtitle: { fontSize: 9, color: C.muted, marginBottom: 2 },

  metaRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 4 },
  metaLabel: { fontSize: 9, color: C.muted, marginRight: 10 },
  metaValue: { fontSize: 9, fontWeight: "bold", color: C.ink, textAlign: "right", minWidth: 92 },
  metaValueDanger: { fontSize: 9, fontWeight: "bold", color: C.danger, textAlign: "right", minWidth: 92 },

  // ── Headline figure ───────────────────────────────────────────────
  // The one number the reader is looking for, given its own band instead of
  // being buried in a column of totals.
  band: {
    marginBottom: 26,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: C.wash,
    borderLeft: `3px solid ${C.accent}`,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  bandLabel: { fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 1 },
  bandValue: { fontSize: 16, fontWeight: "bold", color: C.ink },
  bandValueDanger: { fontSize: 16, fontWeight: "bold", color: C.danger },
  bandValueSuccess: { fontSize: 16, fontWeight: "bold", color: C.success },

  // ── Two-column party block ────────────────────────────────────────
  parties: { flexDirection: "row", gap: 36, marginBottom: 26, paddingBottom: 22, borderBottom: `1px solid ${C.rule}` },
  partyColumn: { flex: 1 },
  partyLabel: { fontSize: 8, fontWeight: "bold", color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 },
  partyName: { fontSize: 11, fontWeight: "bold", color: C.ink, marginBottom: 3 },
  partyLine: { fontSize: 9, color: C.body, marginBottom: 1.5 },

  // ── Sections and tables ───────────────────────────────────────────
  section: { marginBottom: 22 },
  sectionTitle: { fontSize: 9, fontWeight: "bold", color: C.ink, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },

  tableHeader: { flexDirection: "row", paddingBottom: 6, borderBottom: `1px solid ${C.ink}` },
  headerCell: { fontSize: 8, fontWeight: "bold", color: C.ink, textTransform: "uppercase", letterSpacing: 0.6 },
  row: { flexDirection: "row", paddingVertical: 7, borderBottom: `1px solid ${C.rule}` },

  cellName: { fontSize: 9.5, color: C.ink },
  cellSub: { fontSize: 8, color: C.muted, marginTop: 1.5 },
  cell: { fontSize: 9.5, color: C.body },
  cellStrong: { fontSize: 9.5, fontWeight: "bold", color: C.ink },
  cellMuted: { fontSize: 9.5, color: C.muted },
  cellVoid: { fontSize: 9.5, color: "#9ca3af", textDecoration: "line-through" },

  // ── Totals ────────────────────────────────────────────────────────
  totals: { marginTop: 12, alignItems: "flex-end" },
  totalsBox: { width: 240 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  totalLabel: { fontSize: 9, color: C.muted },
  totalValue: { fontSize: 9, color: C.body },
  grandRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 5, paddingTop: 6, borderTop: `1px solid ${C.ink}` },
  grandLabel: { fontSize: 10, fontWeight: "bold", color: C.ink },
  grandValue: { fontSize: 12, fontWeight: "bold", color: C.ink },

  // ── Odds and ends ─────────────────────────────────────────────────
  note: { marginTop: 6, paddingTop: 16, borderTop: `1px solid ${C.rule}` },
  noteText: { fontSize: 9, color: C.body, lineHeight: 1.5 },
  emptyText: { fontSize: 9, color: C.muted, fontStyle: "italic", marginTop: 10 },

  footer: {
    position: "absolute",
    bottom: 28,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 8,
    borderTop: `1px solid ${C.rule}`,
  },
  footerText: { fontSize: 8, color: C.muted },
});

/**
 * Repeating page footer. `fixed` puts it on every page, and the page style's
 * bottom padding reserves the space it sits in.
 *
 * Only ever place this as a direct child of `<Page>`: `fixed` repeats an element
 * on every page its PARENT spans, so nesting it inside a section makes it vanish
 * from pages that section does not reach.
 */
export function PdfFooter({ left }: { left: string }) {
  return (
    <View style={pdfStyles.footer} fixed>
      <Text style={pdfStyles.footerText}>{left}</Text>
      <Text
        style={pdfStyles.footerText}
        render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
      />
    </View>
  );
}
