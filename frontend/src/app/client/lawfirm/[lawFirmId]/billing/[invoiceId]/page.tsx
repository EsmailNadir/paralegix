"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import clientPortalService from '@/services/client-portal.service';
import LoadingSpinner from '@/components/LoadingSpinner';
import { Download, CreditCard, ChevronDown, ChevronUp, DollarSign, Eye, X } from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import { AutoPager } from '@/components/ui/ListPager';
import usePagedRows from '@/hooks/usePagedRows';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import { pdf } from '@react-pdf/renderer';
import InvoicePDFDocument from '@/components/billingComp/InvoicePDFDocument';
import PaymentSurchargeNote from '@/components/billingComp/PaymentSurchargeNote';
import { getInvoiceCreditBalance } from '@/components/billingComp/utils';
import type { Invoice } from '@/types';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDate } from '@/lib/utils/dateUtils';
import { formatHoursMinutes } from '@/lib/utils/format';
import Modal from '@/components/ui/Modal';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import StatusBadge from '@/components/ui/StatusBadge';
import { getInvoiceBillTo, getInvoiceStatus } from '@/components/billingComp/utils';
import ClientRecordPicker from '@/components/portalComp/ClientRecordPicker';
import PaymentMethodDialog from '@/components/portalComp/PaymentMethodDialog';
import usePortalPayment from '@/hooks/billingHooks/usePortalPayment';
import Card from '@/components/ui/Card';
import SectionLabel from '@/components/ui/SectionLabel';


export default function ClientInvoiceDetailPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  const invoiceId = params.invoiceId as string;
  // Firm letterhead comes from the shared client-portal firm list (fetched once
  // by the client layout) rather than a per-page /client-portal/my-lawfirms call.
  const { lawFirms, associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lawFirmName, setLawFirmName] = useState<string>('');
  const [lawFirmLogoUrl, setLawFirmLogoUrl] = useState<string | null>(null);
  const [lawFirmAddress, setLawFirmAddress] = useState<{ address?: string | null; city?: string | null; state?: string | null; zip?: string | null }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error && !loading) errorRef.current?.focus(); }, [error, loading]);
  const payment = usePortalPayment({ lawFirmId, clientRecordId, onError: setError });
  const paying = payment.startingInvoiceId !== null;
  const [paymentsExpanded, setPaymentsExpanded] = useState(true);
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!lawFirmId || !user || !invoiceId || associationsLoading || selectionRequired) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        const { invoice: found } = await clientPortalService.getInvoice(lawFirmId, invoiceId, clientRecordId);
        if (!found) {
          setError('Invoice not found');
          return;
        }
        setInvoice(found as Invoice);
      } catch (err) {
        setError(getErrorMessage(err, 'Failed to load invoice'));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [lawFirmId, invoiceId, user, associationsLoading, selectionRequired, clientRecordId]);

  // Resolve the firm's letterhead (name/logo/address) from the shared portal
  // firm list instead of re-requesting it per invoice.
  useEffect(() => {
    const firm = lawFirms.find((f) => f.id === lawFirmId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds letterhead from the shared portal firm list (external source)
    setLawFirmName(firm?.name || '');
    setLawFirmLogoUrl(firm?.logoUrl || null);
    setLawFirmAddress({ address: firm?.address, city: firm?.city, state: firm?.state, zip: firm?.zip });
  }, [lawFirms, lawFirmId]);

  const handleDownloadPDF = async () => {
    if (!invoice) return;
    setError(null);
    setGeneratingPDF(true);
    try {
      const blob = await pdf(<InvoicePDFDocument invoice={invoice} lawFirmName={lawFirmName} lawFirmLogoUrl={lawFirmLogoUrl} lawFirmAddress={lawFirmAddress} />).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Invoice-${invoice.invoiceName || invoice.id}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to generate PDF');
    } finally {
      setGeneratingPDF(false);
    }
  };

  const handlePreviewPDF = async () => {
    if (!invoice) return;
    setError(null);
    setGeneratingPDF(true);
    try {
      const blob = await pdf(<InvoicePDFDocument invoice={invoice} lawFirmName={lawFirmName} lawFirmLogoUrl={lawFirmLogoUrl} lawFirmAddress={lawFirmAddress} />).toBlob();
      setPreviewPdfUrl(URL.createObjectURL(blob));
    } catch {
      setError('Failed to generate PDF preview');
    } finally {
      setGeneratingPDF(false);
    }
  };

  const closePreviewPdf = () => {
    if (previewPdfUrl) {
      URL.revokeObjectURL(previewPdfUrl);
      setPreviewPdfUrl(null);
    }
  };

  const previewTitleId = useId();

  // The invoice's line items, and a pager for each. Derived above the early
  // returns below so the hooks run on every render. Every total on the page is
  // computed from the full arrays, so windowing the rows leaves the money alone.
  const flatFees = invoice?.flatFees || [];
  const timeEntries = invoice?.timeEntries || [];
  const expenses = invoice?.expenses || [];
  const payments = invoice?.payments || [];
  const flatFeesPager = usePagedRows(flatFees, 10);
  const timeEntriesPager = usePagedRows(timeEntries, 10);
  const expensesPager = usePagedRows(expenses, 10);
  const paymentsPager = usePagedRows(payments, 10);

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) return <LoadingSpinner fullPage />;

  if (!invoice) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <BackButton href={`/client/lawfirm/${lawFirmId}/billing`} label="Back to Invoices" variant="link" className="mb-6" />
        <div ref={errorRef} tabIndex={-1} role="alert" className="text-rose-600 dark:text-rose-400 text-sm">{error || 'Invoice not found'}</div>
      </div>
    );
  }

  const isPaid = invoice.status === 'paid' || invoice.status === 'credited' || invoice.isPaid === true;
  const totalAmount = invoice.totalAmount || 0;
  const amountPaid = invoice.amountPaid || 0;
  const totalWrittenOff = invoice.totalWrittenOff || 0;
  const remaining = invoice.remainingBalance ?? Math.max(0, totalAmount - amountPaid - totalWrittenOff);
  // Money the firm owes back, non-zero only when the invoice is settled past its
  // total. Without this the client sees a flat $0.00 on an over-settled invoice.
  const creditBalance = getInvoiceCreditBalance(invoice);
  const flatFeesTotal = flatFees.reduce((s, f) => s + (f.amount || 0), 0);
  const timeTotal = timeEntries.reduce((s, t) => s + (t.amount || 0), 0);
  const expensesTotal = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const hasStripePayment =
    invoice.stripePaymentRequested && invoice.stripePaymentStatus !== 'completed' && invoice.stripePaymentStatus !== 'voided';
  const statusStyle = getInvoiceStatus(invoice);

  // The invoice's own billed party, not the signed-in viewer: a roster contact
  // viewing a company invoice is not who the invoice is billed to. Snapshot-first
  // once the invoice has issued, falling back to the invoice's own draft fields
  // (never the viewer's account) before that.
  const billTo = getInvoiceBillTo(invoice);
  const clientName = billTo.name || '';
  const clientEmail = billTo.primaryEmail || '';
  const remitToObj = typeof invoice.remitTo === 'object' ? invoice.remitTo : null;
  const remitToName = remitToObj?.name || (typeof invoice.remitTo === 'string' ? invoice.remitTo : null) || lawFirmName;

  return (
    <div className="p-6 md:p-8 max-w-[1600px] mx-auto">
      {/* Back */}
      <BackButton href={`/client/lawfirm/${lawFirmId}/billing`} label="Back to Invoices" variant="link" className="mb-6" />

      {error && <div ref={errorRef} tabIndex={-1} role="alert" className="text-rose-600 dark:text-rose-400 text-sm">{error}</div>}

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* ===== Main Content ===== */}
        <div className="flex-1 min-w-0 space-y-5">
          {/* Invoice Header Card */}
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-6">
            {/* Title + badge */}
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-on-surface">
                {invoice.invoiceName || invoice.id.slice(0, 8).toUpperCase()}
              </h1>
              <StatusBadge variant={statusStyle.variant}>{statusStyle.label}</StatusBadge>
            </div>
            <p className="text-xs text-on-surface-muted mb-6">
              Created {formatDate(invoice.createdAt || invoice.invoiceDate)}
            </p>

            {/* Info grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 pb-6 border-b border-outline-subtle">
              <div>
                <SectionLabel gap="1.5">
                  Invoice Date
                </SectionLabel>
                <p className="text-sm font-medium text-on-surface">{formatDate(invoice.invoiceDate)}</p>
              </div>

              {(clientName || clientEmail) && (
                <div>
                  <SectionLabel gap="1.5">
                    Client
                  </SectionLabel>
                  {clientName && <p className="text-sm font-medium text-on-surface">{clientName}</p>}
                  {billTo.attentionLine && (
                    <p className="text-xs text-on-surface-muted">{billTo.attentionLine}</p>
                  )}
                  {clientEmail && <p className="text-xs text-on-surface-muted">{clientEmail}</p>}
                </div>
              )}

              {remitToName && (
                <div>
                  <SectionLabel gap="1.5">
                    Remit To
                  </SectionLabel>
                  <p className="text-sm font-medium text-on-surface">{remitToName}</p>
                  {remitToObj?.address && (
                    <p className="text-xs text-on-surface-muted">
                      {[remitToObj.address, remitToObj.city, remitToObj.state, remitToObj.zip]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Flat Fees */}
            {flatFees.length > 0 && (
              <div className="mt-6">
                <SectionLabel gap="4">
                  Flat Fees
                </SectionLabel>
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted border-b border-outline-subtle">
                      <th className="text-left pb-2.5">Description</th>
                      <th className="text-right pb-2.5">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-subtle">
                    {flatFeesPager.pagedRows.map((fee) => (
                      <tr key={fee.id}>
                        <td className="py-3 text-sm text-on-surface">
                          {fee.description}
                          {(fee as any).allocationPercent != null && (fee as any).allocationPercent < 100 && (
                            <span className="text-xs text-on-surface-muted font-normal ml-1">
                              ({(fee as any).allocationPercent}%)
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-right text-sm font-medium text-on-surface">
                          {formatCurrency((fee as any).allocationPercent != null && (fee as any).allocationPercent > 0 && (fee as any).allocationPercent < 100 ? fee.amount / ((fee as any).allocationPercent / 100) : fee.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-outline-subtle">
                    <tr>
                      <td className="pt-3 text-right text-xs text-on-surface-muted pr-6">Total Flat Fees:</td>
                      <td className="pt-3 text-right text-sm font-bold text-on-surface">
                        {formatCurrency(flatFeesTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {flatFeesPager.total > flatFeesPager.rowsPerPage && (
                  <div className="pt-3">
                    <AutoPager pager={flatFeesPager} />
                  </div>
                )}
              </div>
            )}

            {/* Time Entries */}
            {timeEntries.length > 0 && (
              <div className={flatFees.length > 0 ? 'mt-8' : 'mt-6'}>
                <SectionLabel gap="4">
                  Time Entries
                </SectionLabel>
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted border-b border-outline-subtle">
                      <th className="text-left pb-2.5">Description</th>
                      <th className="text-right pb-2.5">Hours</th>
                      <th className="text-right pb-2.5">Rate</th>
                      <th className="text-right pb-2.5">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-subtle">
                    {timeEntriesPager.pagedRows.map((entry) => (
                      <tr key={entry.id}>
                        <td className="py-3 text-sm text-on-surface">
                          {entry.name}
                          {(entry as any).allocationPercent != null && (entry as any).allocationPercent < 100 && (
                            <span className="text-xs text-on-surface-muted font-normal ml-1">
                              ({(entry as any).allocationPercent}%)
                            </span>
                          )}
                          {entry.description && (
                            <span className="text-on-surface-muted">, {entry.description}</span>
                          )}
                        </td>
                        <td className="py-3 text-right text-sm text-on-surface-secondary">
                          {(entry as any).allocationPercent != null && (entry as any).allocationPercent > 0 && (entry as any).allocationPercent < 100
                            ? formatHoursMinutes((entry.hours || 0) / ((entry as any).allocationPercent / 100))
                            : formatHoursMinutes(entry.hours || 0)}
                        </td>
                        <td className="py-3 text-right text-sm text-on-surface-secondary">
                          {formatCurrency(entry.rate ?? 0)}/hr
                        </td>
                        <td className="py-3 text-right text-sm font-medium text-on-surface">
                          {formatCurrency((entry as any).allocationPercent != null && (entry as any).allocationPercent > 0 && (entry as any).allocationPercent < 100 ? entry.amount / ((entry as any).allocationPercent / 100) : entry.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-outline-subtle">
                    <tr>
                      <td colSpan={3} className="pt-3 text-right text-xs text-on-surface-muted pr-6">
                        Total ({formatHoursMinutes(invoice.totalHours || 0)}):
                      </td>
                      <td className="pt-3 text-right text-sm font-bold text-on-surface">
                        {formatCurrency(timeTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {timeEntriesPager.total > timeEntriesPager.rowsPerPage && (
                  <div className="pt-3">
                    <AutoPager pager={timeEntriesPager} />
                  </div>
                )}
              </div>
            )}

            {/* Expenses */}
            {expenses.length > 0 && (
              <div className={flatFees.length > 0 || timeEntries.length > 0 ? 'mt-8' : 'mt-6'}>
                <SectionLabel gap="4">
                  Expenses
                </SectionLabel>
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted border-b border-outline-subtle">
                      <th className="text-left pb-2.5">Description</th>
                      <th className="text-right pb-2.5">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-subtle">
                    {expensesPager.pagedRows.map((expense, idx) => (
                      <tr key={expense.id || idx}>
                        <td className="py-3 text-sm text-on-surface">
                          {expense.description || 'Expense'}
                          {expense.vendor && (
                            <span className="text-xs text-on-surface-muted font-normal ml-1">
                              ({expense.vendor})
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-right text-sm font-medium text-on-surface">
                          {formatCurrency(expense.amount || 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-outline-subtle">
                    <tr>
                      <td className="pt-3 text-right text-xs text-on-surface-muted pr-6">Total Expenses:</td>
                      <td className="pt-3 text-right text-sm font-bold text-on-surface">
                        {formatCurrency(expensesTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {expensesPager.total > expensesPager.rowsPerPage && (
                  <div className="pt-3">
                    <AutoPager pager={expensesPager} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Payments Section */}
          {payments.length > 0 && (
            <Card>
              <button
                type="button"
                aria-expanded={paymentsExpanded}
                aria-controls={`${previewTitleId}-payments`}
                onClick={() => setPaymentsExpanded((e) => !e)}
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface-hover transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="p-1.5 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg">
                    <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <span className="text-sm font-semibold text-on-surface">
                    Payments ({payments.length})
                  </span>
                  <span className="text-sm text-on-surface-muted">
                    -- Total: {formatCurrency(amountPaid)}
                  </span>
                </div>
                {paymentsExpanded ? (
                  <ChevronUp className="w-4 h-4 text-on-surface-muted" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-on-surface-muted" />
                )}
              </button>

              {paymentsExpanded && (
                <div id={`${previewTitleId}-payments`} className="border-t border-outline-subtle overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-alt">
                      <tr className="text-[10px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
                        <th className="text-left px-6 py-3">Date</th>
                        <th className="text-right px-6 py-3">Amount</th>
                        <th className="text-left px-6 py-3">Note</th>
                        <th className="text-left px-6 py-3">Recorded By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-subtle">
                      {paymentsPager.pagedRows.map((pmt, idx) => {
                        const recordedBy =
                          pmt.recordedBy ||
                          (pmt.paymentSource === 'trust'
                            ? 'Trust'
                            : pmt.paymentSource === 'stripe' || (pmt as any).stripePaymentIntentId || (pmt as any).stripeSessionId
                            ? 'Stripe'
                            : '-');
                        return (
                          <tr key={idx} className="hover:bg-surface-hover transition-colors">
                            <td className="px-6 py-3 text-on-surface-secondary whitespace-nowrap">
                              {formatDate(pmt.date)}
                            </td>
                            <td className="px-6 py-3 text-right font-medium text-on-surface">
                              {formatCurrency(pmt.amount)}
                              <PaymentSurchargeNote surchargeCents={pmt.surchargeCents} />
                            </td>
                            <td className="px-6 py-3 text-on-surface-muted">
                              {pmt.note || (pmt as any).description || '-'}
                            </td>
                            <td className="px-6 py-3 text-on-surface-secondary">{recordedBy}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {paymentsPager.total > paymentsPager.rowsPerPage && (
                    <div className="px-6 py-3 border-t border-outline-subtle">
                      <AutoPager pager={paymentsPager} />
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}
        </div>

        {/* ===== Sidebar ===== */}
        <div className="lg:w-72 xl:w-80 flex-shrink-0 space-y-4 w-full">
          {/* Summary */}
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5">
            <SectionLabel gap="4">
              Summary
            </SectionLabel>
            <div className="space-y-2.5">
              {timeTotal > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-secondary">Time Entries</span>
                  <span className="text-on-surface">{formatCurrency(timeTotal)}</span>
                </div>
              )}
              {flatFeesTotal > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-secondary">Flat Fees</span>
                  <span className="text-on-surface">{formatCurrency(flatFeesTotal)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm pt-2.5 border-t border-outline-subtle">
                <span className="text-on-surface-secondary">Subtotal</span>
                <span className="font-medium text-on-surface">{formatCurrency(totalAmount)}</span>
              </div>
              {amountPaid > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-secondary">Paid</span>
                  <span className="text-emerald-600 dark:text-emerald-400">{formatCurrency(amountPaid)}</span>
                </div>
              )}
              {totalWrittenOff > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-on-surface-secondary">Adjustments</span>
                  <span className="text-emerald-600 dark:text-emerald-400">-{formatCurrency(totalWrittenOff)}</span>
                </div>
              )}
              <div className="flex justify-between items-center pt-2.5 border-t border-outline-subtle">
                <span className="text-sm font-semibold text-on-surface">
                  {creditBalance > 0 ? 'Credit Due' : 'Remaining Balance'}
                </span>
                <span
                  className={`text-lg font-bold ${
                    creditBalance > 0
                      ? 'text-amber-600 dark:text-amber-400'
                      : remaining === 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {formatCurrency(creditBalance > 0 ? creditBalance : remaining)}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5">
            <SectionLabel gap="4">
              Actions
            </SectionLabel>
            <div className="space-y-2.5">
              <button
                onClick={handlePreviewPDF}
                disabled={generatingPDF}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-outline-subtle text-sm font-medium text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] disabled:opacity-50 active:scale-[0.985] motion-reduce:active:scale-100"
              >
                <Eye className="w-4 h-4" />
                {generatingPDF ? 'Generating...' : 'Preview Invoice'}
              </button>

              <button
                onClick={handleDownloadPDF}
                disabled={generatingPDF}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-outline-subtle text-sm font-medium text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] disabled:opacity-50 active:scale-[0.985] motion-reduce:active:scale-100"
              >
                <Download className="w-4 h-4" />
                {generatingPDF ? 'Generating...' : 'Download Invoice'}
              </button>

              {!isPaid && hasStripePayment && (
                <button
                  onClick={() => {
                    setError(null);
                    void payment.start(invoice.id);
                  }}
                  disabled={paying}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent-solid hover:bg-accent-solid-hover text-accent-foreground text-sm font-medium transition-[background-color,border-color,color,transform] disabled:opacity-50 active:scale-[0.985] motion-reduce:active:scale-100"
                >
                  <CreditCard className="w-4 h-4" />
                  {paying ? 'Processing...' : 'Pay Now'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* PDF Preview Modal */}
      <Modal
        isOpen={!!previewPdfUrl}
        onClose={closePreviewPdf}
        labelledBy={previewTitleId}
        showClose={false}
        size="4xl"
        height="fill"
        className="rounded-xl border border-outline overflow-hidden"
        bodyClassName={null}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-outline shrink-0">
          <h2 id={previewTitleId} className="text-sm font-semibold text-on-surface">Invoice Preview</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { closePreviewPdf(); handleDownloadPDF(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-outline-subtle text-xs font-medium text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
            <button
              onClick={closePreviewPdf}
              className="p-1.5 rounded-md hover:bg-surface-hover transition-[background-color,color,transform] text-on-surface-muted hover:text-on-surface cursor-pointer active:scale-[0.96] motion-reduce:active:scale-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <iframe
            src={previewPdfUrl ?? undefined}
            className="w-full h-full border-0"
            title="Invoice PDF Preview"
          />
        </div>
      </Modal>

      <PaymentMethodDialog {...payment.dialogProps} />
    </div>
  );
}
