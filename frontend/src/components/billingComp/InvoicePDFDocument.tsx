import { Document, Page as PdfPage, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import { isBeforeToday } from '@/lib/utils/dateUtils';
import dayjs from "dayjs";
import type { Invoice } from "@/types";
import { formatHoursMinutes } from "@/lib/utils/format";
import { formatCurrency, getInvoiceBillTo, getInvoiceCreditBalance, getInvoiceRemainingBalance, getInvoiceStatusKey, parseRemitTo } from "@/components/billingComp/utils";
import { PDF_COLORS, PDF_PAGE_SIZE, PdfFooter, pdfStyles as theme } from "@/components/pdf/pdfTheme";

interface InvoicePDFDocumentProps {
  invoice: Invoice;
  lawFirmName?: string;
  lawFirmLogoUrl?: string | null;
  lawFirmAddress?: Record<string, any> | null;
  billingClient?: Record<string, any> | null;
}

const { success: SUCCESS } = PDF_COLORS;

// Column widths and the two figures unique to an invoice; everything else is
// shared stationery from pdfTheme.
const local = StyleSheet.create({
  colDesc: { flex: 1, paddingRight: 10 },
  colRate: { width: 68, textAlign: "right" },
  colHours: { width: 58, textAlign: "right" },
  colAmount: { width: 78, textAlign: "right" },
  // Sits outside the line-item section (see the note at its call site), so it
  // carries that section's bottom margin itself.
  totalsSection: { marginTop: 12, marginBottom: 22, alignItems: "flex-end" },
  paidValue: { fontSize: 9, fontWeight: "bold", color: SUCCESS },
});

export default function InvoicePDFDocument({ invoice, lawFirmName, lawFirmLogoUrl, lawFirmAddress, billingClient }: InvoicePDFDocumentProps) {
  const timeEntries: any[] = invoice.timeEntries || [];
  const flatFees: any[] = invoice.flatFees || [];
  const expenses: any[] = invoice.expenses || [];
  const payments: any[] = invoice.payments || [];
  const totalAmount = Number(invoice.totalAmount) || 0;
  const taxAmount = Number(invoice.taxAmount) || 0;
  const taxRate = invoice.taxRate;
  const subtotalAmount = totalAmount - taxAmount;
  const amountPaid = Number(invoice.amountPaid) || 0;
  const totalHours = Number(invoice.totalHours) || 0;
  const flatFeesAmount = flatFees.reduce((s: number, f: any) => s + (f.amount || 0), 0);
  const expensesAmount = expenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
  const remitTo = parseRemitTo(invoice.remitTo);
  const firmDisplayName = remitTo?.name || lawFirmName || "Law Firm";
  // The one shared resolution for who this invoice bills, used identically here
  // whether the PDF is generated for an emailed attachment or a portal
  // download/preview - both go through this same component. Snapshot-first,
  // falling back to the live `billingClient` record only for a draft that has
  // never been issued.
  const billTo = getInvoiceBillTo(invoice, billingClient);

  const hasLineItems = timeEntries.length > 0 || flatFees.length > 0 || expenses.length > 0;
  const totalWrittenOff = Number(invoice.totalWrittenOff) || 0;
  // Settled in whole cents by the same helpers as the detail view, because float
  // dollars leave residue (0.3 - 0.1 - 0.2 is -2.8e-17) that would print a $0.00
  // credit or balance on an invoice that is exactly paid.
  const creditBalance = getInvoiceCreditBalance(invoice);
  const outstanding = creditBalance > 0 ? -creditBalance : getInvoiceRemainingBalance(invoice);
  const isCredit = outstanding < 0;
  const isSettled = outstanding <= 0;

  // A voided invoice owes nothing, so its zero balance must not read as settled
  // and no due date or next payment is shown for it.
  const isVoided = getInvoiceStatusKey(invoice) === "voided";

  const isOverdue =
    !isVoided &&
    !invoice.isPaid &&
    invoice.nextPaymentDate &&
    isBeforeToday(invoice.nextPaymentDate);

  // The invoice number is what a client quotes back when they pay. invoiceName is
  // the firm's internal label, so it only stands in when there is no number.
  const reference = invoice.invoiceNumber || invoice.invoiceName || invoice.id?.slice(0, 8).toUpperCase();

  return (
    <Document>
      <PdfPage size={PDF_PAGE_SIZE} style={theme.page}>
        {/* Header */}
        <View style={theme.header}>
          <View style={theme.headerLeft}>
            {lawFirmLogoUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={lawFirmLogoUrl} style={theme.logo} />
            ) : (
              <Text style={theme.firmName}>{firmDisplayName}</Text>
            )}
            {lawFirmAddress?.address && <Text style={theme.address}>{lawFirmAddress.address}</Text>}
            {(lawFirmAddress?.city || lawFirmAddress?.state || lawFirmAddress?.zip) && (
              <Text style={theme.address}>
                {[lawFirmAddress.city, lawFirmAddress.state, lawFirmAddress.zip].filter(Boolean).join(", ")}
              </Text>
            )}
          </View>

          <View style={theme.headerRight}>
            <Text style={theme.docTitle}>INVOICE</Text>
            <View style={theme.metaRow}>
              <Text style={theme.metaLabel}>Invoice</Text>
              <Text style={theme.metaValue}>{reference}</Text>
            </View>
            {invoice.invoiceDate && (
              <View style={theme.metaRow}>
                <Text style={theme.metaLabel}>Issued</Text>
                <Text style={theme.metaValue}>{dayjs(invoice.invoiceDate).format("MMM D, YYYY")}</Text>
              </View>
            )}
            {!isVoided && invoice.dueDate && (
              <View style={theme.metaRow}>
                <Text style={theme.metaLabel}>Due</Text>
                <Text style={theme.metaValue}>{dayjs(invoice.dueDate).format("MMM D, YYYY")}</Text>
              </View>
            )}
            {!isVoided && !invoice.isPaid && invoice.nextPaymentDate && (
              <View style={theme.metaRow}>
                <Text style={theme.metaLabel}>Next payment</Text>
                <Text style={isOverdue ? theme.metaValueDanger : theme.metaValue}>
                  {dayjs(invoice.nextPaymentDate).format("MMM D, YYYY")}
                  {isOverdue ? " (overdue)" : ""}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Balance band */}
        <View style={theme.band}>
          {isVoided ? (
            <>
              <Text style={theme.bandLabel}>Status</Text>
              <Text style={theme.bandValue}>Voided</Text>
            </>
          ) : (
            <>
              <Text style={theme.bandLabel}>
                {isCredit ? "Credit due to client" : isSettled ? "Paid in full" : "Balance due"}
              </Text>
              <Text
                style={
                  isCredit
                    ? theme.bandValueSuccess
                    : isSettled
                      ? theme.bandValueSuccess
                      : theme.bandValueDanger
                }
              >
                {formatCurrency(Math.abs(outstanding))}
              </Text>
            </>
          )}
        </View>

        {/* Parties */}
        <View style={theme.parties}>
          <View style={theme.partyColumn}>
            <Text style={theme.partyLabel}>Bill to</Text>
            {billTo.name ? (
              <>
                <Text style={theme.partyName}>{billTo.name}</Text>
                {billTo.attentionLine && <Text style={theme.partyLine}>{billTo.attentionLine}</Text>}
                {billTo.organization && <Text style={theme.partyLine}>{billTo.organization}</Text>}
                {billTo.address && <Text style={theme.partyLine}>{billTo.address}</Text>}
                {billTo.emails.length > 0 && <Text style={theme.partyLine}>{billTo.emails.join(", ")}</Text>}
              </>
            ) : (
              <Text style={theme.partyLine}>No client information available</Text>
            )}
          </View>
          <View style={theme.partyColumn}>
            <Text style={theme.partyLabel}>Remit to</Text>
            <Text style={theme.partyName}>{remitTo?.name || firmDisplayName}</Text>
            {remitTo?.address && <Text style={theme.partyLine}>{remitTo.address}</Text>}
            {(remitTo?.city || remitTo?.state || remitTo?.zip) && (
              <Text style={theme.partyLine}>
                {[remitTo.city, remitTo.state, remitTo.zip].filter(Boolean).join(", ")}
              </Text>
            )}
          </View>
        </View>

        {/* Professional services.
            The rows live in their own View and the totals sit OUTSIDE it. `fixed`
            repeats an element on every page its parent spans, so with the totals
            inside, a totals block that flowed onto a fresh page dragged the column
            headings with it and printed "Description / Rate / Hours / Amount" above
            a page that contains no rows. */}
        {hasLineItems && (
          <>
          <View style={theme.section}>
            <Text style={theme.sectionTitle}>Professional services</Text>

            {/* `fixed` repeats the column headings when the table spans pages, so
                page two is not a wall of unlabelled numbers. */}
            <View style={theme.tableHeader} fixed>
              <Text style={[theme.headerCell, local.colDesc]}>Description</Text>
              <Text style={[theme.headerCell, local.colRate]}>Rate</Text>
              <Text style={[theme.headerCell, local.colHours]}>Hours</Text>
              <Text style={[theme.headerCell, local.colAmount]}>Amount</Text>
            </View>

            {/* wrap={false} keeps a row whole: without it a line can be cut in half
                by a page break, with the description on one page and its amount on
                the next. */}
            {timeEntries.map((entry: any, index: number) => (
              <View key={entry.id || `te-${index}`} style={theme.row} wrap={false}>
                <View style={local.colDesc}>
                  <Text style={theme.cellName}>
                    {entry.name || "Service"}
                    {entry.allocationPercent != null && entry.allocationPercent < 100
                      ? ` (${entry.allocationPercent}%)`
                      : ""}
                  </Text>
                  {entry.description && <Text style={theme.cellSub}>{entry.description}</Text>}
                </View>
                <Text style={[theme.cell, local.colRate]}>{formatCurrency(entry.rate || 0)}</Text>
                {/* The stored hours and amount are this recipient's ALLOCATED share.
                    Grossing them back up to the full line printed a table that did
                    not add up to the total the client is asked to pay on a split
                    invoice. The share is labelled in the description instead. */}
                <Text style={[theme.cell, local.colHours]}>{formatHoursMinutes(entry.hours || 0)}</Text>
                <Text style={[theme.cellStrong, local.colAmount]}>{formatCurrency(entry.amount || 0)}</Text>
              </View>
            ))}

            {flatFees.map((fee: any, index: number) => (
              <View key={fee.id || `fee-${index}`} style={theme.row} wrap={false}>
                <View style={local.colDesc}>
                  <Text style={theme.cellName}>
                    {fee.description}
                    {fee.allocationPercent != null && fee.allocationPercent < 100
                      ? ` (${fee.allocationPercent}%)`
                      : ""}
                  </Text>
                  <Text style={theme.cellSub}>Flat fee</Text>
                </View>
                <Text style={[theme.cell, local.colRate]}>-</Text>
                <Text style={[theme.cell, local.colHours]}>-</Text>
                <Text style={[theme.cellStrong, local.colAmount]}>{formatCurrency(fee.amount || 0)}</Text>
              </View>
            ))}

            {expenses.map((expense: any, index: number) => (
              <View key={expense.id || `exp-${index}`} style={theme.row} wrap={false}>
                <View style={local.colDesc}>
                  <Text style={theme.cellName}>{expense.description || "Expense"}</Text>
                  <Text style={theme.cellSub}>{expense.vendor ? `Expense · ${expense.vendor}` : "Expense"}</Text>
                </View>
                <Text style={[theme.cell, local.colRate]}>-</Text>
                <Text style={[theme.cell, local.colHours]}>-</Text>
                <Text style={[theme.cellStrong, local.colAmount]}>{formatCurrency(expense.amount || 0)}</Text>
              </View>
            ))}

          </View>

            {/* Kept whole and pulled onto the next page rather than being stranded
                alone under a table that ended at the bottom of the previous one. */}
            <View style={local.totalsSection} wrap={false} minPresenceAhead={80}>
              <View style={theme.totalsBox}>
                {totalHours > 0 && (
                  <View style={theme.totalRow}>
                    <Text style={theme.totalLabel}>Total hours</Text>
                    <Text style={theme.totalValue}>{formatHoursMinutes(totalHours)}</Text>
                  </View>
                )}
                {flatFeesAmount > 0 && (
                  <View style={theme.totalRow}>
                    <Text style={theme.totalLabel}>Flat fees</Text>
                    <Text style={theme.totalValue}>{formatCurrency(flatFeesAmount)}</Text>
                  </View>
                )}
                {expensesAmount > 0 && (
                  <View style={theme.totalRow}>
                    <Text style={theme.totalLabel}>Expenses</Text>
                    <Text style={theme.totalValue}>{formatCurrency(expensesAmount)}</Text>
                  </View>
                )}
                {taxAmount > 0 && (
                  <>
                    <View style={theme.totalRow}>
                      <Text style={theme.totalLabel}>Subtotal</Text>
                      <Text style={theme.totalValue}>{formatCurrency(subtotalAmount)}</Text>
                    </View>
                    <View style={theme.totalRow}>
                      <Text style={theme.totalLabel}>Tax{taxRate ? ` (${taxRate}%)` : ""}</Text>
                      <Text style={theme.totalValue}>{formatCurrency(taxAmount)}</Text>
                    </View>
                  </>
                )}
                <View style={theme.grandRow}>
                  <Text style={theme.grandLabel}>Total</Text>
                  <Text style={theme.grandValue}>{formatCurrency(totalAmount)}</Text>
                </View>
                {payments.length === 0 && totalWrittenOff > 0 && (
                  <View style={theme.totalRow}>
                    <Text style={theme.totalLabel}>Credits / Adjustments</Text>
                    <Text style={theme.totalValue}>{formatCurrency(totalWrittenOff)}</Text>
                  </View>
                )}
                {payments.length === 0 && (amountPaid > 0 || totalWrittenOff > 0) && !isVoided && (
                  <View style={theme.grandRow}>
                    <Text style={theme.grandLabel}>{isCredit ? "Credit due" : "Balance due"}</Text>
                    <Text style={theme.grandValue}>{formatCurrency(Math.abs(outstanding))}</Text>
                  </View>
                )}
              </View>
            </View>
          </>
        )}

        {/* Payments received */}
        {payments.length > 0 && (
          <View style={theme.section} minPresenceAhead={90}>
            <Text style={theme.sectionTitle}>Payments received</Text>
            <View style={theme.tableHeader}>
              <Text style={[theme.headerCell, local.colDesc]}>Date</Text>
              <Text style={[theme.headerCell, local.colAmount]}>Amount</Text>
            </View>
            {payments.map((payment: any, idx: number) => (
              <View key={idx} style={theme.row} wrap={false}>
                <View style={local.colDesc}>
                  <Text style={theme.cellName}>
                    {payment.date ? dayjs(payment.date).format("MMM D, YYYY") : "-"}
                  </Text>
                  {payment.note && <Text style={theme.cellSub}>{payment.note}</Text>}
                </View>
                <Text style={[theme.cellStrong, local.colAmount]}>
                  {formatCurrency(payment.amount || 0)}
                </Text>
              </View>
            ))}
            <View style={theme.totals} wrap={false} minPresenceAhead={60}>
              <View style={theme.totalsBox}>
                <View style={theme.totalRow}>
                  <Text style={theme.totalLabel}>Total paid</Text>
                  <Text style={local.paidValue}>{formatCurrency(amountPaid)}</Text>
                </View>
                {totalWrittenOff > 0 && (
                  <View style={theme.totalRow}>
                    <Text style={theme.totalLabel}>Credits / Adjustments</Text>
                    <Text style={local.paidValue}>{formatCurrency(totalWrittenOff)}</Text>
                  </View>
                )}
                {/* Past full settlement the balance is money owed BACK, and printing
                    a clamped $0.00 would tell the client nothing about their credit. */}
                {!isVoided && (
                  <View style={theme.grandRow}>
                    <Text style={theme.grandLabel}>{isCredit ? "Credit due" : "Balance due"}</Text>
                    <Text style={theme.grandValue}>{formatCurrency(Math.abs(outstanding))}</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* Notes */}
        {invoice.notes && (
          <View style={theme.note} minPresenceAhead={50}>
            <Text style={theme.sectionTitle}>Notes</Text>
            <Text style={theme.noteText}>{invoice.notes}</Text>
          </View>
        )}

        <PdfFooter left={`${firmDisplayName}${reference ? ` · Invoice ${reference}` : ""}`} />
      </PdfPage>
    </Document>
  );
}
