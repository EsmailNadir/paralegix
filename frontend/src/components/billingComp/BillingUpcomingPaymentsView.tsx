"use client";

import { useState } from "react";
import dayjs from "dayjs";
import { CalendarClock } from "lucide-react";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import ListSkeleton from "@/components/ui/ListSkeleton";
import StatusBadge from "@/components/ui/StatusBadge";
import EntityPicker from "@/components/ui/EntityPicker";
import DateRangePicker from "@/components/ui/DateRangePicker";
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";
import InvoiceDetailModal from "./InvoiceDetailModal";
import useFirmInvoicesTable, {
  type FirmInvoiceSortField,
} from "@/hooks/billingHooks/useFirmInvoicesTable";
import type { ServerSortModel } from "@/hooks/useServerTable";
import {
  formatCurrency,
  getInvoiceClientAttribution,
  getInvoiceDisplayName,
  getInvoiceNextPaymentInfo,
  getInvoiceRemainingBalance,
} from "./utils";
import type { EnrichedInvoice } from "@/hooks/billingHooks/useFirmInvoices";

type DueGroup = "overdue" | "this_week" | "this_month" | "later" | "no_date";
type GroupFilter = "all" | DueGroup;

/** Bucket order, then soonest due first. Mirrors the tiles left to right. */
const DEFAULT_SORT: ServerSortModel<FirmInvoiceSortField> = [{ field: "dueGroup", sort: "asc" }];

function getDueGroup(dateStr: string | null, today: dayjs.Dayjs): DueGroup {
  if (!dateStr) return "no_date";
  const date = dayjs(dateStr);
  if (date.isBefore(today, "day")) return "overdue";
  const diff = date.diff(today, "day");
  if (diff <= 7) return "this_week";
  if (diff <= 30) return "this_month";
  return "later";
}

function getDueLabel(dateStr: string | null, group: DueGroup, today: dayjs.Dayjs): string | null {
  if (!dateStr) return null;
  const diff = dayjs(dateStr).diff(today, "day");
  if (group === "overdue") return `${Math.abs(diff)} ${Math.abs(diff) === 1 ? "day" : "days"} overdue`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due ${dayjs(dateStr).format("MMM D, YYYY")}`;
}

interface GroupMeta {
  label: string;
  amountColor: string;
  activeBorder: string;
  badgeVariant: "danger" | "warning" | "info" | "neutral" | "purple" | "teal";
}

const GROUP_META: Record<DueGroup | "all", GroupMeta> = {
  all: {
    label: "All outstanding",
    amountColor: "text-on-surface",
    activeBorder: "border-accent-emphasis",
    badgeVariant: "neutral",
  },
  overdue: {
    label: "Overdue",
    amountColor: "text-red-600 dark:text-red-400",
    activeBorder: "border-red-500 dark:border-red-400",
    badgeVariant: "danger",
  },
  this_week: {
    label: "Due this week",
    amountColor: "text-amber-600 dark:text-amber-400",
    activeBorder: "border-amber-500 dark:border-amber-400",
    badgeVariant: "warning",
  },
  this_month: {
    label: "Due this month",
    amountColor: "text-accent-emphasis",
    activeBorder: "border-accent-emphasis",
    badgeVariant: "info",
  },
  later: {
    label: "Due later",
    amountColor: "text-purple-600 dark:text-purple-400",
    activeBorder: "border-purple-500 dark:border-purple-400",
    badgeVariant: "purple",
  },
  no_date: {
    label: "No due date",
    amountColor: "text-teal-600 dark:text-teal-400",
    activeBorder: "border-teal-500 dark:border-teal-400",
    badgeVariant: "teal",
  },
};

const FILTER_GROUPS: GroupFilter[] = [
  "all", "overdue", "this_week", "this_month", "later", "no_date",
];

const PAGE_HEIGHT_CLASS = "min-h-[722px]";

interface BillingUpcomingPaymentsViewProps {
  lawFirmId: string;
}

export default function BillingUpcomingPaymentsView({
  lawFirmId,
}: BillingUpcomingPaymentsViewProps) {
  const today = dayjs(dayjs().format("YYYY-MM-DD"));

  const [detailInvoice, setDetailInvoice] = useState<EnrichedInvoice | null>(null);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // below stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);

  // `awaitingOnly` restricts the list to invoices the firm is still owed money on
  // and asks the server for `dueGroupTotals`: per-bucket counts and outstanding
  // totals across EVERY awaiting invoice, which is what the tiles below show. They
  // could not be summed from these rows, which are one page.
  const {
    rows,
    total,
    dueGroupTotals,
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
  } = useFirmInvoicesTable(lawFirmId, { defaultSort: DEFAULT_SORT, awaitingOnly: true });

  const groupFilter = (filters.dueGroup as GroupFilter | undefined) || "all";
  const awaitingCount = dueGroupTotals.all?.count ?? 0;
  const hasFilters =
    Boolean(search) || Boolean(filters.clientId) || Boolean(filters.matterId) ||
    Boolean(filters.dueDateFrom) || Boolean(filters.dueDateTo);
  const totalPages = Math.max(1, Math.ceil(total / rowsPerPage));

  // A custom range composes with the bucket tiles rather than competing with
  // them: picking one narrows within whichever bucket (or "all") is active.
  const handleDueDateChange = ({ from, to }: { from?: string; to?: string }) => {
    setFilter("dueDateFrom", from);
    setFilter("dueDateTo", to);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 sm:gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-surface-alt animate-pulse" />
          ))}
        </div>
        <ListSkeleton
          rows={Math.min(rowsPerPage, 6)}
          rowHeight={72}
          label="Loading invoices"
        />
      </div>
    );
  }

  if (awaitingCount === 0) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-dashed border-outline bg-surface py-16 text-sm text-on-surface-muted">
        No outstanding invoices. You&apos;re all caught up.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary tiles: firm-wide totals per due bucket, independent of the
          search / client / matter filters narrowing the rows below. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 sm:gap-3">
        {FILTER_GROUPS.map((g) => {
          const meta = GROUP_META[g];
          const totals = dueGroupTotals[g];
          const isActive = groupFilter === g;
          const hasCount = Boolean(totals && totals.count > 0);
          const amountColorClass = hasCount || isActive ? meta.amountColor : "text-on-surface-muted";
          return (
            <button
              key={g}
              type="button"
              onClick={() => setFilter("dueGroup", g === "all" ? undefined : g)}
              className={`rounded-xl border px-3 py-3 text-left transition-all cursor-pointer outline-none ${
                isActive
                  ? `bg-surface-alt ${meta.activeBorder} shadow-sm`
                  : "border-outline bg-surface hover:bg-surface-hover"
              }`}
            >
              <p className={`text-[11px] font-medium truncate ${isActive ? "text-on-surface font-semibold" : "text-on-surface-muted"}`}>
                {meta.label}
              </p>
              <p className={`mt-1 truncate text-base sm:text-lg font-bold tabular-nums leading-none ${amountColorClass}`}>
                {totals ? formatCurrency(totals.amount) : "$0"}
              </p>
              <p className="mt-0.5 text-[11px] text-on-surface-secondary">
                {totals?.count ?? 0} {(totals?.count ?? 0) === 1 ? "invoice" : "invoices"}
              </p>
            </button>
          );
        })}
      </div>

      {/* Count, plus the inline "still working" line. It rides on this row - 
          already on screen and tall enough to hold it - so appearing mid-fetch
          doesn't push the list down. A page click is acknowledged by the pager
          button itself, so the line stays out of the way then. */}
      <div className="flex items-center gap-3">
        <p className="text-sm text-on-surface-secondary">
          {total} {total === 1 ? "invoice" : "invoices"}
        </p>
        <ListBusyIndicator busy={fetching && !pagerPending} />
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-outline bg-surface-alt/60 p-4 md:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
          <label className={`w-[220px] shrink-0 ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>Search</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Invoice, client, or matter..."
              className={INPUT_CLS}
            />
          </label>

          {/* Both pickers are backed by the server typeahead. Options built from
              the rows on screen would only ever offer one page's clients and
              matters. */}
          <div className="min-w-[200px]">
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

          <label className={`w-[220px] shrink-0 ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>Due date</span>
            <DateRangePicker
              from={filters.dueDateFrom}
              to={filters.dueDateTo}
              onChange={handleDueDateChange}
              placeholder="Any due date"
            />
          </label>

          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                // Keep the selected bucket: it is a tile, not one of the filters
                // this button clears.
                clearFilters(filters.dueGroup ? { dueGroup: filters.dueGroup } : {});
                setSearch("");
              }}
              className="rounded-xl border border-outline px-4 py-2 text-sm font-medium text-on-surface-secondary transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover"
            >
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* List - min-h reserves space for a full page so the page doesn't shrink */}
      <div className={PAGE_HEIGHT_CLASS}>
        {fetching && rows.length === 0 ? (
          <ListSkeleton rows={Math.min(rowsPerPage, 6)} rowHeight={72} label="Loading invoices" />
        ) : rows.length === 0 ? (
          // Keeps the reserved page height so switching to an empty bucket
          // doesn't collapse the page under the tiles above.
          <ListEmptyState
            className="flex h-[722px] flex-col items-center justify-center"
            icon={<CalendarClock size={32} />}
            title="No invoices match these filters"
            message="Try a different due bucket or date range, or clear the search, client, and matter filters."
          />
        ) : (
          <>
            <div
              className="relative overflow-hidden rounded-xl border border-outline bg-surface divide-y divide-outline-subtle"
              aria-busy={fetching}
            >
              {/* No skeleton overlay while paging: the rows on screen stay until
                  the next page arrives, and the footer carries the wait. */}
              {rows.map((inv) => {
                const nextPayment = getInvoiceNextPaymentInfo(inv);
                const remaining = getInvoiceRemainingBalance(inv);
                const group = getDueGroup(nextPayment.date, today);
                const dueLabel = getDueLabel(nextPayment.date, group, today);
                const { name: clientLabel, isAmbiguous } = getInvoiceClientAttribution(inv);
                const contextLabel =
                  [
                    inv.matterName || null,
                    // Say so rather than naming one of them as the payer.
                    clientLabel || (isAmbiguous ? "Multiple clients" : null),
                  ]
                    .filter(Boolean)
                    .join(" · ") || null;

                const isOverdue = group === "overdue";
                const meta = GROUP_META[group];
                const badgeShowsSpecificLabel = dueLabel === "Due today" || dueLabel === "Due tomorrow";
                const metaParts = [contextLabel, badgeShowsSpecificLabel ? null : dueLabel].filter(Boolean);

                return (
                  <button
                    key={inv.id}
                    type="button"
                    onClick={() => setDetailInvoice(inv)}
                    className="flex w-full cursor-pointer items-center gap-3 px-4 h-[72px] text-left transition-colors hover:bg-surface-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-base font-semibold text-on-surface truncate">
                          {getInvoiceDisplayName(inv)}
                        </span>
                        <StatusBadge variant={meta.badgeVariant} className="shrink-0 whitespace-nowrap">
                          {badgeShowsSpecificLabel ? dueLabel : meta.label}
                        </StatusBadge>
                      </div>
                      <p
                        className={`mt-0.5 truncate text-sm ${
                          isOverdue ? "text-red-500 dark:text-red-400" : "text-on-surface-muted"
                        }`}
                      >
                        {metaParts.length > 0 ? metaParts.join(" · ") : " "}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className={`text-lg font-semibold tabular-nums ${meta.amountColor}`}>
                        {formatCurrency(remaining)}
                      </p>
                      {nextPayment.fromPlan && nextPayment.amount !== null && nextPayment.amount !== remaining && (
                        <p className="text-sm text-on-surface-secondary tabular-nums">
                          Next: {formatCurrency(nextPayment.amount!)}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Reserve the exact height of the unfilled rows (mirrors a real row) without drawing borders */}
            {rows.length < rowsPerPage && (
              <div className="border-t border-transparent divide-y divide-transparent" aria-hidden="true">
                {Array.from({ length: rowsPerPage - rows.length }).map((_, i) => (
                  <div
                    key={`empty-${i}`}
                    className="invisible flex w-full items-center gap-3 px-4 h-[72px] select-none"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold">&nbsp;</span>
                        <StatusBadge variant="success">&nbsp;</StatusBadge>
                      </div>
                      <p className="mt-0.5 text-sm">&nbsp;</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-lg font-semibold tabular-nums">&nbsp;</p>
                      <p className="text-sm">&nbsp;</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4">
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
          </>
        )}
      </div>

      <InvoiceDetailModal
        invoice={detailInvoice}
        open={Boolean(detailInvoice)}
        onClose={() => setDetailInvoice(null)}
        lawFirmId={lawFirmId}
      />
    </div>
  );
}
