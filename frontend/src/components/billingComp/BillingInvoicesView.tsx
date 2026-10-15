"use client";

import { isBeforeToday } from '@/lib/utils/dateUtils';
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import dayjs from "dayjs";
import { FileText } from "lucide-react";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import ListSkeleton from "@/components/ui/ListSkeleton";
import StatusBadge from "@/components/ui/StatusBadge";
import DateRangePicker from "@/components/ui/DateRangePicker";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";
import InvoiceDetailModal from "./InvoiceDetailModal";
import useFirmInvoicesTable, {
  type FirmInvoiceSortField,
} from "@/hooks/billingHooks/useFirmInvoicesTable";
import type { ServerSortModel } from "@/hooks/useServerTable";
import {
  formatCurrency,
  getRecurringRetainerPlanName,
  getInvoiceClientAttribution,
  getInvoiceDisplayName,
  getInvoiceNextPaymentInfo,
  getInvoiceRemainingBalance,
  getInvoiceStatusKey,
  getInvoiceStatus,
  getInvoiceTotal,
  isClosedStatusKey,
  isRecurringRetainerInvoice,
} from "./utils";
import type { EnrichedInvoice } from "@/hooks/billingHooks/useFirmInvoices";

/** Work-to-do order: still owed first, then soonest next payment. */
const DEFAULT_SORT: ServerSortModel<FirmInvoiceSortField> = [
  { field: "paymentPriority", sort: "asc" },
];

interface BillingInvoicesViewProps {
  lawFirmId: string;
  initialFilters?: Record<string, string>;
}

export default function BillingInvoicesView({
  lawFirmId,
  initialFilters,
}: BillingInvoicesViewProps) {
  const searchParams = useSearchParams();
  const highlightParam = searchParams.get("highlight");

  // Keep a persistent ref to the pinned highlight IDs captured from the initial URL navigation
  const pinnedHighlightIdsRef = useRef<Set<string>>(new Set());

  if (highlightParam && pinnedHighlightIdsRef.current.size === 0) {
    const ids = highlightParam.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length > 0) {
      pinnedHighlightIdsRef.current = new Set(ids);
    }
  }

  const [activeHighlights, setActiveHighlights] = useState<Set<string>>(
    () => new Set(pinnedHighlightIdsRef.current)
  );

  useEffect(() => {
    if (pinnedHighlightIdsRef.current.size === 0) return;

    // Clean up the `highlight` URL parameter so refreshing/tab-switching later won't re-highlight
    if (typeof window !== "undefined" && window.location.search.includes("highlight=")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("highlight");
      window.history.replaceState(null, "", url.toString());
    }

    const timer = setTimeout(() => {
      setActiveHighlights(new Set());
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  const [detailInvoice, setDetailInvoice] = useState<EnrichedInvoice | null>(null);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);

  // Search, filtering, ordering and paging all happen on the server, so a filter
  // covers every invoice in the firm rather than the page on screen.
  const {
    rows,
    total,
    loading,
    fetching,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    filters,
    setFilter,
    clearFilters,
    search,
    setSearch,
  } = useFirmInvoicesTable(lawFirmId, { defaultSort: DEFAULT_SORT, initialFilters });

  const hasActiveFilters = Boolean(search) || Object.values(filters).some(Boolean);
  const totalPages = Math.max(1, Math.ceil(total / rowsPerPage));

  // Show highlighted draft invoices at the top for this page view
  const displayedRows = useMemo(() => {
    const pinned = pinnedHighlightIdsRef.current;
    if (pinned.size === 0) return rows;
    const highlighted = rows.filter((inv) => pinned.has(inv.id));
    const others = rows.filter((inv) => !pinned.has(inv.id));
    return [...highlighted, ...others];
  }, [rows]);

  return (
    <div className="space-y-5">
      {/* Count, plus the "still working" line for a filter change. It rides on
          this row - already on screen - so appearing mid-fetch doesn't push the
          list down, and the stale count beside it is explained rather than just
          looking wrong. */}
      <div className="flex items-center gap-3">
        <p className="text-sm text-on-surface-secondary">
          {total} {total === 1 ? "invoice" : "invoices"}
        </p>
        <ListBusyIndicator busy={fetching && !pagerPending} />
      </div>

      <div className="rounded-2xl border border-outline bg-surface-alt/60 p-4 md:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
          <label className={`w-[220px] shrink-0 ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>
              Search
            </span>
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search invoices..."
              className={INPUT_CLS}
            />
          </label>

          <div className="min-w-[200px]">
            <EntityPicker
              entity="matters"
              lawFirmId={lawFirmId}
              label="Matter"
              value={filters.matterId || ""}
              onChange={(value) => setFilter("matterId", value)}
              emptyOption={{ label: "All matters", value: "" }}
              placeholder="All matters"
            />
          </div>

          <div className="min-w-[200px]">
            {/* Backed by the client typeahead, not by the invoices on screen: a
                dropdown built from one page would only offer that page's clients. */}
            <EntityPicker
              entity="clients"
              lawFirmId={lawFirmId}
              label="Client"
              value={filters.clientId || ""}
              onChange={(value) => setFilter("clientId", value)}
              emptyOption={{ label: "All clients", value: "" }}
              placeholder="All clients"
            />
          </div>

          <div className="min-w-[180px]">
            <Dropdown
              label="Status"
              value={filters.status || ""}
              onChange={(val) => setFilter("status", val)}
              options={[
                { label: "All", value: "" },
                { label: "All unpaid", value: "unpaid" },
                { label: "Unpaid", value: "outstanding" },
                { label: "Overdue", value: "overdue" },
                { label: "Due Within 30 Days", value: "due_soon" },
                { label: "Partially Paid", value: "partially_paid" },
                { label: "Paid", value: "paid" },
                { label: "Written Off", value: "credited" },
                { label: "Voided", value: "voided" },
              ]}
            />
          </div>

          <label className={`min-w-[260px] ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>
              Invoice Date
            </span>
            <DateRangePicker
              from={filters.dateFrom || ""}
              to={filters.dateTo || ""}
              onChange={(next) => {
                setFilter("dateFrom", next.from ?? "");
                setFilter("dateTo", next.to ?? "");
              }}
            />
          </label>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                clearFilters();
                setSearch("");
              }}
              className="rounded-xl border border-outline px-4 py-2 text-sm font-medium text-on-surface-secondary transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover"
            >
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {loading || (fetching && rows.length === 0) ? (
        <ListSkeleton rows={Math.min(rowsPerPage, 6)} label="Loading invoices" />
      ) : rows.length === 0 ? (
        <ListEmptyState
          icon={<FileText size={32} />}
          title={hasActiveFilters ? "No invoices match these filters" : "No invoices yet"}
          message={
            hasActiveFilters
              ? "Try adjusting the search, matter, status, or date range."
              : "Invoices from your matter and client billing will show up here."
          }
        />
      ) : (
        <div className="space-y-4">
          <div
            className="relative overflow-hidden rounded-xl border border-outline bg-surface divide-y divide-outline-subtle"
            aria-busy={fetching}
          >
            {/* No skeleton overlay while paging: the rows on screen stay until
                the next page arrives, and the footer carries the wait. */}
            {displayedRows.map((invoice) => {
              const isHighlighted = activeHighlights.has(invoice.id);
              const { label: statusLabel, variant: statusVariant } = getInvoiceStatus(
                invoice
              );
              const statusKey = getInvoiceStatusKey(invoice);
              const invoiceTotal = getInvoiceTotal(invoice);
              const remaining = getInvoiceRemainingBalance(invoice);
              const nextPayment = getInvoiceNextPaymentInfo(invoice);
              const nextIsOverdue =
                !isClosedStatusKey(statusKey) && nextPayment.date
                  ? isBeforeToday(nextPayment.date)
                  : false;
              const { name: clientLabel } = getInvoiceClientAttribution(invoice);

              // Secondary line: date · matter/client · plan · recipients
              const metaParts = [
                invoice.invoiceDate ? dayjs(invoice.invoiceDate).format("MMM D, YYYY") : null,
                invoice.matterName || (clientLabel ? `Client: ${clientLabel}` : null),
                isRecurringRetainerInvoice(invoice) && getRecurringRetainerPlanName(invoice)
                  ? `Plan: ${getRecurringRetainerPlanName(invoice)}`
                  : null,
                invoice.splitRecipientCount ? `${invoice.splitRecipientCount} recipients` : null,
              ].filter(Boolean);

              const dueLine =
                !isClosedStatusKey(statusKey) && nextPayment.date
                  ? `${nextIsOverdue ? "Overdue" : "Due"} ${dayjs(nextPayment.date).format("MMM D")}`
                  : null;

              return (
                <button
                  key={invoice.id}
                  type="button"
                  onClick={() => setDetailInvoice(invoice)}
                  className={`flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-hover ${
                    isHighlighted
                      ? "bg-accent-soft/60 dark:bg-accent-solid/20 ring-2 ring-inset ring-focus-ring/60 highlight-pulse"
                      : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-base font-semibold text-on-surface">
                        {getInvoiceDisplayName(invoice)}
                      </span>
                      <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
                      {invoice.refundDue && <StatusBadge variant="warning">Refund due</StatusBadge>}
                      {isRecurringRetainerInvoice(invoice) && (
                        <StatusBadge variant="success">Recurring</StatusBadge>
                      )}
                      {invoice.splitGroupId && (
                        <StatusBadge variant="purple">Split</StatusBadge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-on-surface-muted">
                      {metaParts.join(" · ")}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-lg font-semibold text-on-surface tabular-nums">
                      {formatCurrency(invoiceTotal)}
                    </p>
                    {remaining > 0 ? (
                      <p
                        className={`text-sm tabular-nums ${
                          nextIsOverdue
                            ? "text-red-600 dark:text-red-400"
                            : "text-on-surface-secondary"
                        }`}
                      >
                        {formatCurrency(remaining)} left
                        {dueLine ? ` · ${dueLine}` : ""}
                      </p>
                    ) : statusKey === "voided" ? (
                      // Cancelled by the firm: nothing was owed, so neither a
                      // balance nor a green "Fully paid".
                      <p className="text-sm text-on-surface-secondary">Voided</p>
                    ) : statusKey === "credited" ? (
                      // Settled by a write-off, not by payment. Green "Fully paid"
                      // here claimed money the firm never collected.
                      <p className="text-sm text-on-surface-secondary">
                        Written off
                        {Number(invoice.totalWrittenOff) > 0
                          ? ` ${formatCurrency(Number(invoice.totalWrittenOff))}`
                          : ""}
                      </p>
                    ) : (
                      <p className="text-sm text-green-600 dark:text-green-400">Fully paid</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Reserve the exact height of the unfilled rows (mirrors a real row) without drawing borders */}
          {rows.length < rowsPerPage && (
            <div className="-mt-4 border-t border-transparent divide-y divide-transparent" aria-hidden="true">
              {Array.from({ length: rowsPerPage - rows.length }).map((_, i) => (
                <div
                  key={`empty-${i}`}
                  className="invisible flex w-full items-center gap-3 px-4 py-3 select-none"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold">&nbsp;</span>
                      <StatusBadge variant="success">&nbsp;</StatusBadge>
                    </div>
                    <p className="mt-0.5 text-sm">&nbsp;</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-lg font-semibold">&nbsp;</p>
                    <p className="text-sm">&nbsp;</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <ListPager
            page={page}
            totalPages={totalPages}
            total={total}
            rowsPerPage={rowsPerPage}
            onPageChange={setPage}
            onRowsPerPageChange={setRowsPerPage}
            rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
            busy={fetching}
            serverPaged
            onPendingChange={setPagerPending}
          />
        </div>
      )}

      <InvoiceDetailModal
        invoice={detailInvoice}
        open={Boolean(detailInvoice)}
        onClose={() => setDetailInvoice(null)}
        lawFirmId={lawFirmId}
      />
    </div>
  );
}
