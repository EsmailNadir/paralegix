import { Document, Page as PdfPage, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import dayjs from "dayjs";
import { formatCurrency } from "@/components/billingComp/utils";
import { PDF_COLORS, PDF_PAGE_SIZE, PdfFooter, pdfStyles as theme } from "@/components/pdf/pdfTheme";

interface PaymentReceiptPDFDocumentProps {
  receiptNumber: string;
  /** Client-facing reference for the invoice this payment was applied to. */
  invoiceReference: string;
  clientName: string;
  firmName: string;
  firmAddressLines?: string[];
  /** Base64 data URL. Remote URLs hang the renderer, so the caller pre-fetches. */
  logoDataUrl?: string | null;
  amount: number;
  date: string;
  paymentMethod: string;
  note?: string | null;
  recordedByName?: string | null;
}

const { success: SUCCESS } = PDF_COLORS;

// A receipt's only unique need is a success-coloured headline figure and a
// right-aligned detail value; the rest is shared stationery from pdfTheme.
const local = StyleSheet.create({
  amountValue: { fontSize: 16, fontWeight: "bold", color: SUCCESS },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 7, borderBottom: `1px solid ${PDF_COLORS.rule}` },
  detailLabel: { fontSize: 9, color: PDF_COLORS.muted },
  detailValue: { fontSize: 9.5, fontWeight: "bold", color: PDF_COLORS.ink, textAlign: "right", maxWidth: "65%" },
  statement: { marginTop: 20, fontSize: 9, color: PDF_COLORS.muted, lineHeight: 1.5 },
});

export default function PaymentReceiptPDFDocument({
  receiptNumber,
  invoiceReference,
  clientName,
  firmName,
  firmAddressLines = [],
  logoDataUrl,
  amount,
  date,
  paymentMethod,
  note,
  recordedByName,
}: PaymentReceiptPDFDocumentProps) {
  return (
    <Document>
      <PdfPage size={PDF_PAGE_SIZE} style={theme.page}>
        <View style={theme.header}>
          <View style={theme.headerLeft}>
            {logoDataUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image has no alt
              <Image src={logoDataUrl} style={theme.logo} />
            ) : (
              <Text style={theme.firmName}>{firmName}</Text>
            )}
            {firmAddressLines.filter(Boolean).map((line, i) => (
              <Text key={i} style={theme.address}>{line}</Text>
            ))}
          </View>

          <View style={theme.headerRight}>
            <Text style={theme.docTitle}>RECEIPT</Text>
            <View style={theme.metaRow}>
              <Text style={theme.metaLabel}>Receipt</Text>
              <Text style={theme.metaValue}>{receiptNumber}</Text>
            </View>
            <View style={theme.metaRow}>
              <Text style={theme.metaLabel}>Date</Text>
              <Text style={theme.metaValue}>{date ? dayjs(date).format("MMM D, YYYY") : "-"}</Text>
            </View>
            <View style={theme.metaRow}>
              <Text style={theme.metaLabel}>Invoice</Text>
              <Text style={theme.metaValue}>{invoiceReference}</Text>
            </View>
          </View>
        </View>

        {/* The figure the client is looking for, given the same treatment as the
            invoice's balance band. */}
        <View style={theme.band}>
          <Text style={theme.bandLabel}>Amount received</Text>
          <Text style={local.amountValue}>{formatCurrency(amount)}</Text>
        </View>

        <View style={theme.parties}>
          <View style={theme.partyColumn}>
            <Text style={theme.partyLabel}>Received from</Text>
            <Text style={theme.partyName}>{clientName}</Text>
          </View>
          <View style={theme.partyColumn}>
            <Text style={theme.partyLabel}>Received by</Text>
            <Text style={theme.partyName}>{firmName}</Text>
            {firmAddressLines.filter(Boolean).map((line, i) => (
              <Text key={i} style={theme.partyLine}>{line}</Text>
            ))}
          </View>
        </View>

        <View>
          <Text style={theme.sectionTitle}>Payment details</Text>
          <View style={local.detailRow} wrap={false}>
            <Text style={local.detailLabel}>Payment method</Text>
            <Text style={local.detailValue}>{paymentMethod}</Text>
          </View>
          <View style={local.detailRow} wrap={false}>
            <Text style={local.detailLabel}>Applied to invoice</Text>
            <Text style={local.detailValue}>{invoiceReference}</Text>
          </View>
          {note ? (
            <View style={local.detailRow} wrap={false}>
              <Text style={local.detailLabel}>Note</Text>
              <Text style={local.detailValue}>{note}</Text>
            </View>
          ) : null}
          {recordedByName ? (
            <View style={local.detailRow} wrap={false}>
              <Text style={local.detailLabel}>Recorded by</Text>
              <Text style={local.detailValue}>{recordedByName}</Text>
            </View>
          ) : null}
        </View>

        <Text style={local.statement}>
          This is an official payment receipt issued by {firmName}. Please retain it for your records.
        </Text>

        <PdfFooter left={`${firmName} · Receipt ${receiptNumber}`} />
      </PdfPage>
    </Document>
  );
}
