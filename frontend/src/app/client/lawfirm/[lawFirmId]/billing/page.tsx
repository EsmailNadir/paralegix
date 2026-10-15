"use client";

import { useEffect, useRef, useState, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import clientPortalService from '@/services/client-portal.service';
import ErrorNotification from '@/components/ErrorNotification';
import { AlertCircle, FileText, CheckCircle, ChevronDown, Calendar, CreditCard, Download, Receipt, Eye } from 'lucide-react';
import Button from '@/components/ui/Button';
import NavigationLink from '@/components/ui/NavigationLink';
import useFormFeedback from '@/hooks/useFormFeedback';
import Tooltip from "@/components/ui/Tooltip";
import { pdf } from '@react-pdf/renderer';
import type { Invoice } from '@/types';
import InvoiceDetailPanel from '@/components/billingComp/InvoiceDetailPanel';
import InvoicePDFDocument from '@/components/billingComp/InvoicePDFDocument';
import { formatCurrency } from '@/lib/utils/currency';
import { formatDate } from '@/lib/utils/dateUtils';
import { buildStatementEntries } from '@/lib/billing/statementEntries';
import ListPager, { AutoPager, DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from '@/components/ui/ListPager';
import TabBar from '@/components/ui/TabBar';
import ListBusyIndicator from '@/components/ui/ListBusyIndicator';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import ListSkeleton from '@/components/ui/ListSkeleton';
import ListEmptyState from '@/components/ui/ListEmptyState';
import usePagedRows from '@/hooks/usePagedRows';
import StatusBadge from '@/components/ui/StatusBadge';
import { getInvoiceStatus, getInvoiceStatusKey, isClosedStatusKey, paymentPlanCadenceLabel } from '@/components/billingComp/utils';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import ClientRecordPicker from '@/components/portalComp/ClientRecordPicker';
import PaymentMethodDialog from '@/components/portalComp/PaymentMethodDialog';
import usePortalPayment from '@/hooks/billingHooks/usePortalPayment';
import Card from '@/components/ui/Card';
import SectionLabel from '@/components/ui/SectionLabel';

/** Invoices per page in the list view. The statement tab reads the full history. */
const INVOICES_PER_PAGE = 10;
/**
 * Statement rows per page. The running balance is computed over every entry
 * before this window is applied, so a page shows true balances rather than ones
 * restarted per page.
 */
const STATEMENT_ROWS_PER_PAGE = 15;

interface BillingData {
  invoices: Invoice[];
  summary: {
    totalBilled: number;
    totalPaid: number;
    totalOutstanding: number;
  };
}

type StatusFilter = 'all' | 'outstanding' | 'overdue' | 'partially_paid' | 'paid' | 'credited' | 'voided';
type ViewTab = 'invoices' | 'statement';

// --- Helpers ---
const toNumber = (value: any, fallback: number = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getInvoiceContextLabel = (invoice: Invoice) => {
  if (invoice.contextType === 'client') return 'Client-direct';
  if (invoice.contextType === 'matter') return 'Matter-linked';
  if (invoice.matterId) return 'Matter-linked';
  return 'Client-direct';
};

export default function ClientBillingPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  const searchParams = useSearchParams();
  const paymentStatus = searchParams?.get('payment');
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [billingData, setBillingData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  // Separate from `loading` so only the FIRST read swaps the page for a
  // skeleton. A status chip or a page click re-runs the same fetch, and blanking
  // the header, tiles and chips for it would take away the control that was just
  // used.
  const [initialLoad, setInitialLoad] = useState(true);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);
  const { errorMessage: error, setErrorMessage: setError, feedbackRef } = useFormFeedback();
  const lastActionRef = useRef<HTMLElement | null>(null);
  const [expandedInvoices, setExpandedInvoices] = useState<Set<string>>(new Set());
  const [retryCount, setRetryCount] = useState(0);
  const payment = usePortalPayment({ lawFirmId, clientRecordId, onError: setError });
  const [generatingPDF, setGeneratingPDF] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewTab, setViewTab] = useState<ViewTab>('invoices');

  // Invoices accumulate for the life of the relationship, so the list is a
  // server page. The totals and chip counts come from the server too, computed
  // over every invoice rather than the page.
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(INVOICES_PER_PAGE);
  const [totalItems, setTotalItems] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});

  // The statement is a running balance over the client's WHOLE history, so it
  // needs every invoice with its payments and credit notes. Loaded only when
  // that tab is opened, which is what keeps the default view off the full read.
  const [statementInvoices, setStatementInvoices] = useState<Invoice[] | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState('');
  // Bumped by "Try again" on a failed statement read. A failure leaves
  // `statementInvoices` null, which alone never re-runs the effect below.
  const [statementRetryCount, setStatementRetryCount] = useState(0);

  useEffect(() => {
    if (!lawFirmId || !user || associationsLoading || selectionRequired) return;

    const fetchBilling = async () => {
      try {
        setLoading(true);
        setError('');
        // One page of invoices. `summary` and `statusCounts` in the response
        // describe every invoice regardless, so the tiles and the filter chips
        // do not shrink to whatever is on screen.
        const data = await clientPortalService.getBilling(lawFirmId, {
          page,
          limit: rowsPerPage,
          status: statusFilter === 'all' ? undefined : statusFilter,
          clientRecordId,
        });

        const normalizedData: BillingData = {
          invoices: data.invoices.map((invoice: any) => ({
            ...invoice,
            contextType: invoice.contextType || (invoice.matterId ? 'matter' : 'client'),
            entityId: invoice.entityId || invoice.matterId || invoice.clientContextId || null,
            totalAmount: toNumber(invoice.totalAmount),
            totalHours: toNumber(invoice.totalHours),
            flatFeesAmount: toNumber(invoice.flatFeesAmount),
            // Only money actually collected counts as paid. A 'credited' invoice was
            // closed by a write-off, and `getInvoiceStatus` labels it "Written Off"
            // as long as `isPaid` stays false, matching the invoice detail page.
            isPaid: invoice.isPaid === true || invoice.status === 'paid',
            amountPaid: toNumber(invoice.amountPaid),
            payments: invoice.payments || [],
            nextPaymentDate: invoice.nextPaymentDate || null,
            timeEntries: Array.isArray(invoice.timeEntries)
              ? invoice.timeEntries.map((entry: any, idx: number) => {
                  const rate = toNumber(entry?.rate);
                  const hours = toNumber(entry?.hours);
                  return {
                    id: entry?.id || `${invoice.id}-te-${idx}`,
                    name: entry?.name || 'Legal Service',
                    description: entry?.description || '',
                    rate, hours,
                    amount: toNumber(entry?.amount, rate * hours),
                  };
                })
              : [],
            flatFees: Array.isArray(invoice.flatFees)
              ? invoice.flatFees.map((fee: any, idx: number) => ({
                  id: fee?.id || `${invoice.id}-ff-${idx}`,
                  description: fee?.description || 'Flat Fee',
                  amount: toNumber(fee?.amount),
                }))
              : [],
            creditNotes: invoice.creditNotes || [],
            totalWrittenOff: toNumber(invoice.totalWrittenOff),
            remainingBalance: invoice.remainingBalance,
            paymentPlan: invoice.paymentPlan || null,
          })),
          summary: {
            totalBilled: typeof data.summary.totalBilled === 'number' ? data.summary.totalBilled : 0,
            totalPaid: typeof data.summary.totalPaid === 'number' ? data.summary.totalPaid : 0,
            totalOutstanding: typeof data.summary.totalOutstanding === 'number' ? data.summary.totalOutstanding : 0,
          }
        };

        setBillingData(normalizedData);
        setTotalItems(data.totalItems ?? normalizedData.invoices.length);
        setStatusCounts(data.statusCounts ?? {});
        setRetryCount(0);
      } catch (err) {
        console.error('Error fetching billing:', err);
        const errorMessage = getErrorMessage(err, 'Failed to load billing information');
        if (!errorMessage.toLowerCase().includes('not associated')) {
          setError(errorMessage);
        }
        if (retryCount < 1) setTimeout(() => setRetryCount(prev => prev + 1), 2000);
      } finally {
        setLoading(false);
        setInitialLoad(false);
      }
    };

    fetchBilling();
  }, [lawFirmId, user, retryCount, page, rowsPerPage, statusFilter, associationsLoading, selectionRequired, clientRecordId]);

  // A narrowing filter can leave the view past the end of the new result set, so
  // the page resets with the filter itself rather than in a follow-up effect
  // (which would render the out-of-range page once before correcting it).
  const applyStatusFilter = (next: StatusFilter) => {
    setStatusFilter(next);
    setPage(1);
  };

  // A different page size re-cuts the list, so the current page no longer holds
  // the same invoices. Rewind to the most recent ones.
  const changeRowsPerPage = (next: number) => {
    setRowsPerPage(next);
    setPage(1);
  };

  // Full history, fetched the first time the statement is opened.
  useEffect(() => {
    if (viewTab !== 'statement' || !lawFirmId || !user || statementInvoices || associationsLoading || selectionRequired) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: marks the statement request in flight as it starts
    setStatementLoading(true);
    setStatementError('');
    clientPortalService
      .getBilling(lawFirmId, { clientRecordId })
      .then((data) => { if (!cancelled) setStatementInvoices(data.invoices as Invoice[]); })
      .catch(err => { if (!cancelled) setStatementError(getErrorMessage(err, 'Failed to load statement')); })
      .finally(() => { if (!cancelled) setStatementLoading(false); });
    return () => { cancelled = true; };
  }, [viewTab, lawFirmId, user, statementInvoices, associationsLoading, selectionRequired, clientRecordId, statementRetryCount]);

  const retryStatement = () => {
    setStatementError('');
    setStatementRetryCount(prev => prev + 1);
  };

  const toggleInvoiceExpansion = (invoiceId: string) => {
    setExpandedInvoices(prev => {
      const newSet = new Set(prev);
      if (newSet.has(invoiceId)) newSet.delete(invoiceId);
      else newSet.add(invoiceId);
      return newSet;
    });
  };

  const handleDownloadPDF = async (invoice: Invoice) => {
    setGeneratingPDF(invoice.id);
    try {
      const blob = await pdf(<InvoicePDFDocument invoice={invoice} />).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Invoice-${invoice.invoiceName || invoice.id}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to generate PDF');
    } finally {
      setGeneratingPDF(null);
    }
  };

  // Server-computed over EVERY invoice. Summing the rows on screen would report
  // the totals of one page as the client's account.
  const summary = billingData?.summary ?? { totalBilled: 0, totalPaid: 0, totalOutstanding: 0 };

  // The server applies the status filter and the soonest-payment-first ordering,
  // so the page arrives ready to render.
  const filteredInvoices = billingData?.invoices ?? [];
  const totalPages = Math.max(1, Math.ceil(totalItems / rowsPerPage));

  // Counts across every invoice. `totalItems` narrows with the active filter, so
  // anything describing the whole account has to come from `statusCounts`.
  const allInvoiceCount = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);
  const unpaidInvoiceCount = (statusCounts['outstanding'] || 0)
    + (statusCounts['overdue'] || 0)
    + (statusCounts['partially_paid'] || 0);

  // Statement data: running balance ledger. Built from the full history, not
  // the page: a running balance that started partway through would be wrong
  // from its first line.
  const statementEntries = useMemo(
    () => (statementInvoices ? buildStatementEntries(statementInvoices) : []),
    [statementInvoices],
  );

  // The statement reads the whole history, so its rows are windowed here.
  const statementPager = usePagedRows(statementEntries, STATEMENT_ROWS_PER_PAGE);

  // The footer closes the ledger, so it is the last running balance rather than
  // `summary.totalOutstanding`, which clamps each invoice at zero and so drops
  // an overpayment the ledger still nets. Below zero the firm owes the client.
  const statementBalance = statementEntries.length ? statementEntries[statementEntries.length - 1].balance : 0;
  const statementInCredit = statementBalance < 0;

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (initialLoad && retryCount === 0) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <ListSkeleton rows={8} label="Loading your invoices" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-on-surface">Billing & Invoices</h1>
        <p className="text-sm text-on-surface-muted mt-1">Track payments, review invoices, and manage your billing history.</p>
      </div>

      {error && (
        <div ref={feedbackRef} tabIndex={-1} className="mb-6">
          <ErrorNotification error={error} onClose={() => { setError(''); lastActionRef.current?.focus(); }} />
        </div>
      )}

      {paymentStatus === 'success' && (
        <div className="mb-6 bg-emerald-50 dark:bg-emerald-500/10 rounded-2xl border border-emerald-200 dark:border-emerald-500/20 p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            Payment processed successfully. Your invoice will be updated shortly.
          </p>
        </div>
      )}

      {paymentStatus === 'cancelled' && (
        <div className="mb-6 bg-amber-50 dark:bg-amber-500/10 rounded-2xl border border-amber-200 dark:border-amber-500/20 p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            Payment was cancelled. You can try again at any time.
          </p>
        </div>
      )}

      {/* Summary Cards */}
      {billingData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5">
            <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 mb-2">
              <div className="p-1.5 bg-rose-50 dark:bg-rose-500/10 rounded-lg">
                <AlertCircle className="w-4 h-4" />
              </div>
              <SectionLabel as="span" tone="inherit">Outstanding</SectionLabel>
            </div>
            <p className="text-2xl font-bold text-on-surface">{formatCurrency(summary.totalOutstanding)}</p>
            <p className="text-[10px] text-on-surface-muted mt-1">
              Due across {unpaidInvoiceCount} invoice(s)
            </p>
          </div>

          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5">
            <div className="flex items-center gap-2 text-accent-emphasis mb-2">
              <div className="p-1.5 bg-accent-soft dark:bg-accent-soft rounded-lg">
                <FileText className="w-4 h-4" />
              </div>
              <SectionLabel as="span" tone="inherit">Total Billed</SectionLabel>
            </div>
            <p className="text-2xl font-bold text-on-surface">{formatCurrency(summary.totalBilled)}</p>
            <p className="text-[10px] text-on-surface-muted mt-1">{allInvoiceCount} total invoice(s)</p>
          </div>

          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5">
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 mb-2">
              <div className="p-1.5 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg">
                <CheckCircle className="w-4 h-4" />
              </div>
              <SectionLabel as="span" tone="inherit">Total Paid</SectionLabel>
            </div>
            <p className="text-2xl font-bold text-on-surface">{formatCurrency(summary.totalPaid)}</p>
            <p className="text-[10px] text-on-surface-muted mt-1">Thank you for your business</p>
          </div>
        </div>
      )}

      {/* View Tabs + Status Filters */}
      {billingData && allInvoiceCount > 0 && (
        <div className="mb-6 space-y-4">
          {/* View Tabs */}
          <TabBar
            tabs={[
              { value: 'invoices' as const, label: 'Invoices', icon: FileText },
              { value: 'statement' as const, label: 'Statement', icon: Receipt },
            ]}
            value={viewTab}
            onChange={setViewTab}
          />

          {/* Status Filter Pills (invoices tab only) */}
          {viewTab === 'invoices' && (
            <div className="flex flex-wrap items-center gap-2">
              {([
                { key: 'all' as const, label: 'All', count: allInvoiceCount },
                { key: 'outstanding' as const, label: 'Unpaid', count: statusCounts['outstanding'] || 0 },
                { key: 'overdue' as const, label: 'Overdue', count: statusCounts['overdue'] || 0 },
                { key: 'partially_paid' as const, label: 'Partial', count: statusCounts['partially_paid'] || 0 },
                // Written-off invoices get their own chip: the server filters on the exact
                // status, so counting them under Paid would promise rows Paid never shows.
                { key: 'paid' as const, label: 'Paid', count: statusCounts['paid'] || 0 },
                { key: 'credited' as const, label: 'Written Off', count: statusCounts['credited'] || 0 },
                { key: 'voided' as const, label: 'Voided', count: statusCounts['voided'] || 0 },
              ]).map(({ key, label, count }) => (
                <button
                  key={key}
                  aria-pressed={statusFilter === key}
                  onClick={() => applyStatusFilter(key)}
                  className={`px-3 py-1.5 text-xs rounded-full font-medium transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${
                    statusFilter === key
                      ? 'bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis'
                      : 'bg-surface-alt text-on-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  {label}
                  {count > 0 && <span className="ml-1.5 opacity-60">{count}</span>}
                </button>
              ))}
              {/* Rides on the chip row, which is already on screen, so the
                  acknowledgement for a chip click appears next to the chip
                  instead of pushing the list down. */}
              <ListBusyIndicator busy={loading && !pagerPending} className="ml-1" />
            </div>
          )}
        </div>
      )}

      {/* Invoices Tab */}
      {viewTab === 'invoices' && (
        <Card>
          {!billingData || filteredInvoices.length === 0 ? (
            <ListEmptyState
              compact
              icon={<FileText className="w-8 h-8" />}
              title={allInvoiceCount === 0 ? 'No invoices yet' : 'No matching invoices'}
              message={
                allInvoiceCount === 0
                  ? 'When the firm sends an invoice, it will appear here.'
                  : 'Try adjusting the status filter above.'
              }
              className="border-0"
            />
          ) : (
            <div className="divide-y divide-outline-subtle">
              {filteredInvoices.map((invoice) => {
                const isExpanded = expandedInvoices.has(invoice.id);
                const invoiceAmount = toNumber(invoice.totalAmount);
                const { label: statusLabel, variant: statusVariant } = getInvoiceStatus(invoice);
                const statusKey = getInvoiceStatusKey(invoice);
                const derivedIsPaid = isClosedStatusKey(statusKey);
                const writtenOff = toNumber(invoice.totalWrittenOff);
                const paidAmount = toNumber(invoice.amountPaid);
                const remaining = invoice.remainingBalance ?? Math.max(0, invoiceAmount - paidAmount - writtenOff);
                const issuedDate = invoice.invoiceDate || invoice.createdAt || null;
                const hasDetails = (invoice.timeEntries?.length || 0) > 0 || (invoice.flatFees?.length || 0) > 0 || (invoice.payments?.length || 0) > 0 || (invoice.creditNotes?.length || 0) > 0;

                return (
                  <div key={invoice.id} className="transition-colors hover:bg-surface-hover">
                    {/* Main Row */}
                    <div
                      className={`px-5 py-4 grid grid-cols-1 md:grid-cols-12 gap-4 items-center ${hasDetails ? 'cursor-pointer' : ''}`}
                      onClick={() => hasDetails && toggleInvoiceExpansion(invoice.id)}
                    >
                      {/* Invoice Info */}
                      <div className="md:col-span-4">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-xl ${derivedIsPaid ? 'bg-surface-alt text-on-surface-muted' : 'bg-accent-soft dark:bg-accent-soft text-accent-emphasis'}`}>
                            <FileText className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-on-surface">
                              {invoice.invoiceName || invoice.id.slice(0, 8).toUpperCase()}
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                              {invoice.nextPaymentDate
                                ? <p className="text-[10px] text-on-surface-muted">Next payment: {formatDate(invoice.nextPaymentDate)}</p>
                                : invoice.dueDate
                                  ? <p className="text-[10px] text-on-surface-muted">Due: {formatDate(invoice.dueDate)}</p>
                                  : <p className="text-[10px] text-on-surface-muted">Issued: {formatDate(issuedDate)}</p>
                              }
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-semibold ${
                                invoice.contextType === 'client'
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                                  : 'bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis'
                              }`}>
                                {getInvoiceContextLabel(invoice)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Status */}
                      <div className="md:col-span-3">
                        {(() => {
                          // The badge is the detail page's own label. "Written Off"
                          // already says the invoice was adjusted, so only an
                          // invoice still settling some other way adds "Adjusted".
                          const hasAdjustments = toNumber(invoice.totalWrittenOff) > 0 || (invoice.creditNotes?.length || 0) > 0;
                          const showAdjustedBadge = hasAdjustments && statusKey !== 'credited';
                          return (
                            <div className="flex flex-wrap items-center gap-1">
                              <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
                              {showAdjustedBadge && <StatusBadge variant="neutral">Adjusted</StatusBadge>}
                            </div>
                          );
                        })()}
                        {!derivedIsPaid && paidAmount > 0 && (
                          <p className="text-[10px] text-accent-emphasis mt-1">
                            {formatCurrency(paidAmount)} of {formatCurrency(invoiceAmount)} paid
                          </p>
                        )}
                        {!derivedIsPaid && invoice.dueDate && !invoice.paymentPlan?.enabled && !(invoice.amountPaid || 0) && (
                          <p className="text-[10px] text-on-surface-muted mt-1">Due: {formatDate(invoice.dueDate)}</p>
                        )}
                        {invoice.paymentPlan?.enabled && (
                          <div className="flex items-center gap-1 mt-1">
                            <Calendar className="w-3 h-3 text-accent-emphasis" />
                            <span className="text-[10px] text-accent-emphasis">
                              Payment plan: {formatCurrency(invoice.paymentPlan.installmentAmount)}/{paymentPlanCadenceLabel(invoice.paymentPlan.frequencyDays)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Totals + Actions */}
                      <div className="md:col-span-5 flex items-center justify-between md:justify-end gap-4">
                        <div className="flex items-center gap-3">
                          {/* Pay Now */}
                          {!derivedIsPaid && invoice.stripePaymentRequested && invoice.stripePaymentStatus !== 'completed' && (
                            <Button
                              aria-label={`Pay invoice ${invoice.invoiceName || invoice.id.slice(0, 8).toUpperCase()}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                lastActionRef.current = e.currentTarget;
                                void payment.start(invoice.id);
                              }}
                              disabled={payment.startingInvoiceId === invoice.id}
                              loading={payment.startingInvoiceId === invoice.id}
                              icon={<CreditCard className="w-4 h-4" />}
                              type="primary"
                              size="small"
                            >
                              Pay Now
                            </Button>
                          )}

                          {/* View Invoice */}
                          <Tooltip title="View Invoice" enterDelay={300}>
                            <NavigationLink aria-label={`View invoice ${invoice.invoiceName || invoice.id.slice(0, 8).toUpperCase()}`}
                              href={`/client/lawfirm/${lawFirmId}/billing/${invoice.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="p-1.5 rounded-lg text-on-surface-muted hover:text-accent-emphasis hover:bg-accent-soft dark:hover:bg-accent-soft dark:hover:text-accent-emphasis transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                            >
                              <Eye className="w-4 h-4" />
                            </NavigationLink>
                          </Tooltip>

                          {/* PDF Download */}
                          <Tooltip title="Download PDF" enterDelay={300}>
                            <span>
                              <button aria-label={`Download PDF for ${invoice.invoiceName || invoice.id.slice(0, 8).toUpperCase()}`}
                                onClick={(e) => { e.stopPropagation(); lastActionRef.current = e.currentTarget; handleDownloadPDF(invoice); }}
                                disabled={generatingPDF === invoice.id}
                                className="p-1.5 rounded-lg text-on-surface-muted hover:text-accent-emphasis hover:bg-accent-soft dark:hover:bg-accent-soft dark:hover:text-accent-emphasis transition-[background-color,color,transform] disabled:opacity-50 active:scale-[0.96] motion-reduce:active:scale-100"
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            </span>
                          </Tooltip>

                          <div className="text-right">
                            <p className="text-base font-bold text-on-surface font-mono tracking-tight">
                              {formatCurrency(invoiceAmount)}
                            </p>
                            {!derivedIsPaid && remaining > 0 && (
                              <p className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">
                                {formatCurrency(remaining)} remaining
                              </p>
                            )}
                          </div>
                        </div>

                        {hasDetails && (
                          <button type="button" aria-label={`Details for ${invoice.invoiceName || invoice.id.slice(0, 8).toUpperCase()}`} aria-expanded={isExpanded} aria-controls={`invoice-details-${invoice.id}`} onClick={(event) => { event.stopPropagation(); toggleInvoiceExpansion(invoice.id); }} className={`text-on-surface-muted transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>
                            <ChevronDown className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Expanded Details */}
                    {isExpanded && hasDetails && (
                      <div id={`invoice-details-${invoice.id}`} className="bg-surface-alt border-t border-outline-subtle px-5 py-5">
                        <InvoiceDetailPanel invoice={invoice} formatDate={formatDate} />
                      </div>
                    )}
                  </div>
                );
              })}
              {pagerWillRender(totalItems) && (
                <div className="px-4 py-3">
                  <ListPager
                    page={page}
                    totalPages={totalPages}
                    total={totalItems}
                    rowsPerPage={rowsPerPage}
                    onPageChange={setPage}
                    onRowsPerPageChange={changeRowsPerPage}
                    rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
                    busy={loading}
                    serverPaged
                    onPendingChange={setPagerPending}
                  />
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Statement Tab */}
      {viewTab === 'statement' && (
        <Card>
          <div className="px-5 py-4 border-b border-outline-subtle flex items-center justify-between">
            <SectionLabel>
              Statement of Account
            </SectionLabel>
            <p className="text-xs text-on-surface-muted">
              {statementEntries.length} transaction{statementEntries.length !== 1 ? 's' : ''}
            </p>
          </div>

          {statementLoading ? (
            // The statement reads the whole history, so it is fetched when this
            // tab opens rather than on every visit to the billing page.
            <ListSkeleton rows={6} bordered={false} label="Building your statement" />
          ) : statementError ? (
            <ErrorNotification error={statementError} onRetry={retryStatement} />
          ) : statementEntries.length === 0 ? (
            <ListEmptyState
              compact
              icon={<Receipt className="w-8 h-8" />}
              title="No transactions to display"
              className="border-0"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-alt">
                  <tr className="text-[10px] text-on-surface-muted uppercase tracking-[0.08em]">
                    <th className="text-left font-medium px-5 py-3">Date</th>
                    <th className="text-left font-medium px-5 py-3">Description</th>
                    <th className="text-right font-medium px-5 py-3">Charges</th>
                    <th className="text-right font-medium px-5 py-3">Payments</th>
                    <th className="text-right font-medium px-5 py-3">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-subtle">
                  {statementPager.pagedRows.map((entry, idx) => (
                    <tr
                      key={`${statementPager.page}-${idx}`}
                      className="hover:bg-surface-hover transition-colors"
                    >
                      <td className="px-5 py-3 text-xs text-on-surface-secondary whitespace-nowrap">{entry.date}</td>
                      <td className="px-5 py-3 text-xs text-on-surface">{entry.description}</td>
                      <td className="px-5 py-3 text-right text-xs">
                        {entry.charge > 0 ? (
                          <span className="text-on-surface font-medium">{formatCurrency(entry.charge)}</span>
                        ) : (
                          <span className="text-on-surface-muted">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right text-xs">
                        {entry.payment > 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium">{formatCurrency(entry.payment)}</span>
                        ) : (
                          <span className="text-on-surface-muted">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right text-xs font-semibold">
                        <span className={entry.balance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}>
                          {formatCurrency(entry.balance)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-surface-alt border-t border-outline-subtle">
                  <tr>
                    <td colSpan={4} className="px-5 py-3 text-right text-xs font-semibold text-on-surface">
                      {statementInCredit ? 'Credit Balance' : 'Current Balance'}
                    </td>
                    <td className="px-5 py-3 text-right text-sm font-bold">
                      <span className={statementBalance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}>
                        {formatCurrency(Math.abs(statementBalance))}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              </table>
              {statementPager.total > statementPager.rowsPerPage && (
                <div className="px-5 py-3 border-t border-outline-subtle">
                  <AutoPager pager={statementPager} />
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <PaymentMethodDialog {...payment.dialogProps} />
    </div>
  );
}
