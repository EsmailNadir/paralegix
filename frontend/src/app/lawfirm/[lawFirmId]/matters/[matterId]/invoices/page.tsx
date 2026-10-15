"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";
import { useNavigation } from "@/contexts/NavigationContext";
import dayjs from "dayjs";
import Button from "@/components/ui/Button";
import billingService from "@/services/billing.service";
import type { BillingPlan, Invoice } from "@/types";
import { formatHoursMinutes } from "@/lib/utils/format";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import ConfirmModal from "@/components/ui/ConfirmModal";
import RequirePermission from "@/components/ui/RequirePermission";
import { usePermissions } from "@/contexts/PermissionsContext";
import { FileText, Trash2, Eye, Download, X } from "lucide-react";
import BackButton from "@/components/ui/BackButton";
import InvoiceListCard from "@/components/billingComp/InvoiceListCard";
import { downloadInvoicePdf } from "@/components/billingComp/invoicePdf";
import { RecurringRetainerPlanCard, RecurringRetainerSection } from "@/components/billingComp/RecurringRetainerPanel";
import type { RowAction } from "@/components/ui/RowActionMenu";
import {
  formatCurrency,
  getInvoiceNextPaymentInfo,
  getRecurringRetainerPlanName,
  isRecurringRetainerInvoice,
} from "@/components/billingComp/utils";
import LawFirmService from "@/services/lawfirm.service";
import type { LawFirm } from "@/types";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import useFirmInvoicesTable from "@/hooks/billingHooks/useFirmInvoicesTable";
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";
import DateRangePicker from "@/components/ui/DateRangePicker";

type StatusFilter = "all" | "outstanding" | "overdue" | "partially_paid" | "paid" | "credited" | "voided";

export default function InvoicesPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManageInvoices = hasPermission("billing.manageInvoices");

  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const matterId = Array.isArray(params?.matterId) ? params.matterId[0] : (params?.matterId as string);

  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [lawFirmData, setLawFirmData] = useState<LawFirm | null>(null);
  const [generatingPDF, setGeneratingPDF] = useState<string | null>(null);
  const [recurringRetainers, setRecurringRetainers] = useState<BillingPlan[]>([]);
  // Cleared locally (and dropped from local state, not the URL) so a refresh or
  // back-navigation to this page doesn't resurrect the "created N invoices" banner.
  const [createdSplitCount, setCreatedSplitCount] = useState(() => Number(searchParams.get("createdSplit") || 0));

  // Server-paged: a long retainer matter bills monthly for years, so the list is
  // a page and the filters below narrow every invoice on the matter rather than
  // the ones a first request happened to load. `includeDetails` because a row
  // expands to its line items and exports a PDF from them.
  const {
    rows: invoices,
    total: totalInvoices,
    statusCounts,
    loading,
    fetching,
    error: loadError,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    setFilter,
    setSearch: setServerSearch,
    refetch: loadInvoices,
  } = useFirmInvoicesTable(lawFirmId, {
    defaultSort: [{ field: "paymentPriority", sort: "asc" }],
    initialFilters: { matterId },
    includeDetails: true,
    enabled: Boolean(lawFirmId && matterId),
  });

  useEffect(() => {
    if (lawFirmId && matterId) {
      loadLawFirm();
      loadRecurringRetainers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lawFirmId, matterId]);

  // Every control below is a server filter now, so it narrows the whole matter.
  useEffect(() => { setServerSearch(search); }, [search, setServerSearch]);
  useEffect(() => { setFilter("status", statusFilter === "all" ? undefined : statusFilter); }, [statusFilter, setFilter]);
  useEffect(() => { setFilter("dateFrom", dateFrom || undefined); }, [dateFrom, setFilter]);
  useEffect(() => { setFilter("dateTo", dateTo || undefined); }, [dateTo, setFilter]);

  const loadLawFirm = async () => {
    try {
      const firm = await LawFirmService.getLawFirmById(lawFirmId);
      setLawFirmData(firm);
    } catch {
      // non-critical
    }
  };

  const loadRecurringRetainers = async () => {
    try {
      const plans = await billingService.listPlans(lawFirmId);
      setRecurringRetainers(
        plans.filter((plan) => plan.contextType === "matter" && plan.entityId === matterId)
      );
    } catch {
      setRecurringRetainers([]);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    setDeleting(true);
    try {
      await billingService.deleteInvoice({ type: "matter", lawFirmId, entityId: matterId }, deleteConfirmId);
      // Re-read rather than splice locally: the row is gone from a server page,
      // so the page behind it and the status counts both have to be refreshed.
      await loadInvoices();
      setDeleteConfirmId(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete invoice"));
    } finally {
      setDeleting(false);
    }
  };

  const handleDownloadPDF = async (invoice: Invoice) => {
    setGeneratingPDF(invoice.id);
    try {
      await downloadInvoicePdf(invoice, {
        lawFirmName: lawFirmData?.name,
        lawFirmLogoUrl: lawFirmData?.logoUrl,
        lawFirmAddress: lawFirmData,
        billingClient: invoice.clientName ? { name: invoice.clientName } : null,
      });
    } catch {
      setError("Failed to generate PDF");
    } finally {
      setGeneratingPDF(null);
    }
  };

  // Already the server's page: filtered, ordered and windowed there.
  const filteredInvoices = invoices;
  const totalPages = Math.max(1, Math.ceil(totalInvoices / Math.max(1, rowsPerPage)));

  const hasFilters = Boolean(search || dateFrom || dateTo || statusFilter !== "all");

  if (loading) return <LoadingSpinner fullPage />;

  return (
    <RequirePermission permission="billing.viewInvoices" page>
      <div className="px-4 py-5 md:px-6 md:py-6 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
          <div className="flex items-start gap-3 md:items-center">
            <BackButton
              href={`/lawfirm/${lawFirmId}/matters/${matterId}?tab=billing`}
              label="Back to Matter Billing"
            />
            <div>
              <h1 className="text-2xl font-bold text-on-surface">Invoices</h1>
              <p className="text-sm text-on-surface-secondary">Manage invoices for this matter</p>
            </div>
          </div>
          {canManageInvoices && (
            <Button
              type="primary"
              onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/generate-invoice`)}
              className="w-full md:w-auto justify-center"
            >
              + Generate Invoice
            </Button>
          )}
        </div>

        {(error || loadError) && (
          <div className="mb-4">
            <ErrorNotification
              error={error || getErrorMessage(loadError, "Failed to load invoices")}
              onClose={() => setError(null)}
            />
          </div>
        )}

        {createdSplitCount > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
            <span>
              Created {createdSplitCount} split {createdSplitCount === 1 ? "invoice" : "invoices"} for this matter.
            </span>
            <button
              type="button"
              onClick={() => setCreatedSplitCount(0)}
              aria-label="Dismiss"
              className="cursor-pointer p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 shrink-0 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {recurringRetainers.length > 0 && (
          <div className="mb-6">
            <RecurringRetainerSection
              title="Evergreen retainers on this matter"
              description="These plans live on the matter and create recurring invoices over time."
              onOpenWorkbench={() => navigate(`/lawfirm/${lawFirmId}/billing`)}
            >
              {recurringRetainers.map((plan) => (
                <RecurringRetainerPlanCard
                  key={plan.id}
                  plan={plan}
                  lawFirmId={lawFirmId}
                  navigate={navigate}
                  amountSuffix={
                    plan.includedHours > 0 ? ` • ${formatHoursMinutes(plan.includedHours)} included` : ""
                  }
                  latestInvoiceHref={(draft) =>
                    `/lawfirm/${lawFirmId}/matters/${matterId}/invoices/${draft.generatedInvoiceId}`
                  }
                />
              ))}
            </RecurringRetainerSection>
          </div>
        )}

        {/* Search + date filters */}
        <div className="mb-4 rounded-2xl border border-outline bg-surface-alt/60 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
            <label className={`min-w-[200px] flex-1 ${FIELD_CLS}`}>
              <span className={FIELD_LABEL_CLS}>Search</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search invoices..."
                className={INPUT_CLS}
              />
            </label>
            <DateRangePicker
              from={dateFrom}
              to={dateTo}
              onChange={(next) => { setDateFrom(next.from ?? ""); setDateTo(next.to ?? ""); }}
              placeholder="Invoice date range"
              className="min-w-[200px]"
            />
            {(search || dateFrom || dateTo) && (
              <button
                type="button"
                onClick={() => { setSearch(""); setDateFrom(""); setDateTo(""); }}
                className="rounded-xl border border-outline px-4 py-2 text-sm font-medium text-on-surface-secondary transition active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover"
              >
                Clear Filters
              </button>
            )}
          </div>
        </div>

        {/* Status Filter Tabs */}
        <div className="mb-6 -mx-4 px-4 overflow-x-auto scrollbar-hide md:mx-0 md:px-0">
          <div className="flex items-center gap-2 flex-nowrap md:flex-wrap">
            {(
              [
                { key: "all", label: "All" },
                { key: "outstanding", label: "Unpaid" },
                { key: "overdue", label: "Overdue" },
                { key: "partially_paid", label: "Partial" },
                { key: "paid", label: "Paid" },
                { key: "credited", label: "Written Off" },
                { key: "voided", label: "Voided" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={`px-3 py-1.5 text-sm rounded-full font-medium transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${
                  statusFilter === key
                    ? "bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis"
                    : "bg-surface-alt text-on-surface-secondary hover:bg-surface-hover"
                }`}
              >
                {label}
                {(statusCounts[key] || 0) > 0 && (
                  <span className="ml-1.5 text-xs opacity-70">{statusCounts[key]}</span>
                )}
              </button>
            ))}
            {/* Rides on the chip row, which is already on screen, so a chip or
                search change is acknowledged without pushing the list down. */}
            <ListBusyIndicator busy={fetching && !pagerPending} className="ml-1" />
          </div>
        </div>

        {/* Invoice Cards */}
        {filteredInvoices.length === 0 && !error ? (
          <div className="text-center py-16 text-on-surface-secondary">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p className="text-lg font-medium">
              {invoices.length === 0 ? "No invoices yet" : "No invoices match this filter"}
            </p>
            {invoices.length === 0 && (
              <p className="text-sm mt-1">Generate an invoice from unbilled time entries and flat fees.</p>
            )}
            {invoices.length > 0 && hasFilters && (
              <p className="text-sm mt-1">Try adjusting your search or filters.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4 md:space-y-3">
            {filteredInvoices.map((invoice) => {
              const menuActions: RowAction[] = [
                {
                  label: "View Details",
                  icon: <Eye className="w-4 h-4" />,
                  onClick: () => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices/${invoice.id}`),
                },
                {
                  label: generatingPDF === invoice.id ? "Generating..." : "Download Invoice",
                  icon: <Download className="w-4 h-4" />,
                  onClick: () => handleDownloadPDF(invoice),
                },
                ...(canManageInvoices
                  ? [
                      {
                        label: "Delete",
                        icon: <Trash2 className="w-4 h-4" />,
                        onClick: () => setDeleteConfirmId(invoice.id),
                        danger: true,
                      },
                    ]
                  : []),
              ];
              const nextPayment = getInvoiceNextPaymentInfo(invoice);

              return (
                <InvoiceListCard
                  key={invoice.id}
                  invoice={invoice}
                  onOpen={() => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}/invoices/${invoice.id}`)}
                  menuActions={menuActions}
                >
                  {[
                    invoice.invoiceDate ? dayjs(invoice.invoiceDate).format("MMM D, YYYY") : null,
                    invoice.clientName ? `Client: ${invoice.clientName}` : null,
                    isRecurringRetainerInvoice(invoice) && getRecurringRetainerPlanName(invoice)
                      ? `Plan: ${getRecurringRetainerPlanName(invoice)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {nextPayment.fromPlan && nextPayment.amount != null && (
                    <span className="ml-1 text-on-surface-muted">
                      · Installment {formatCurrency(nextPayment.amount)}
                    </span>
                  )}
                </InvoiceListCard>
              );
            })}
            <ListPager
              page={page}
              totalPages={totalPages}
              total={totalInvoices}
              rowsPerPage={rowsPerPage}
              onPageChange={setPage}
              onRowsPerPageChange={setRowsPerPage}
              rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
              busy={fetching}
              onPendingChange={setPagerPending}
              serverPaged
            />
          </div>
        )}

        {/* Delete Confirmation */}
        <ConfirmModal
          isOpen={!!deleteConfirmId}
          onClose={() => { if (!deleting) setDeleteConfirmId(null); }}
          onConfirm={handleDelete}
          title="Delete Invoice"
          message="Are you sure you want to delete this invoice? This action cannot be undone."
          confirmText="Delete"
          confirmType="danger"
        />

      </div>
    </RequirePermission>
  );
}
