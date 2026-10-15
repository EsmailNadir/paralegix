"use client";

import { isBeforeToday } from '@/lib/utils/dateUtils';
import { useState } from "react";
import dayjs from "dayjs";
import { Briefcase, FileText } from "lucide-react";
import Dropdown from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListPager from "@/components/ui/ListPager";
import BillingReportCardFiller from "./BillingReportCardFiller";
import useBillingByMatterReport from "@/hooks/billingHooks/useBillingByMatterReport";
import { useNavigation } from "@/contexts/NavigationContext";
import { formatCurrency } from "./utils";
import { formatHoursMinutes } from "@/lib/utils/format";
import MatterStatusBadge from "@/components/ui/MatterStatusBadge";

interface BillingByMatterViewProps {
  lawFirmId: string;
  /**
   * False while another report grouping is on screen, so this one's read is held
   * back rather than fetched behind a view nobody is looking at.
   */
  active: boolean;
}

function summarizeNames(names: string[], label: string) {
  if (names.length === 0) return `No ${label}`;
  if (names.length <= 2) return `${label}: ${names.join(", ")}`;
  return `${label}: ${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

/**
 * Billing grouped by matter.
 *
 * Every figure on a card is a lifetime total for that matter, so the rows are a
 * server-side GROUP BY over the firm's invoices and time entries rather than a
 * reduction over records held in the browser: the money has to cover the whole
 * matter, and downloading a firm's entire billing history to add it up is a read
 * that grows for as long as the firm does. Search, status and practice area are
 * applied by the server too, so a page always cuts the same filtered set the
 * count above the list describes.
 */
export default function BillingByMatterView({ lawFirmId, active }: BillingByMatterViewProps) {
  const { navigate } = useNavigation();
  const report = useBillingByMatterReport(lawFirmId, active);
  const {
    rows,
    total,
    totalPages,
    page,
    setPage,
    rowsPerPage,
    search,
    setSearch,
    filters,
    setFilter,
    clearFilters,
    practiceAreas,
    unlinkedInvoices,
    loading,
    fetching,
    error,
    refetch,
  } = report;

  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await refetch();
    } finally {
      setRetrying(false);
    }
  };

  const hasActiveFilters = Boolean(search) || Object.values(filters).some(Boolean);

  // Overdue is judged against the VIEWER's clock rather than the server's, which
  // is the same rule the rest of the billing screens follow.
  const isOverdue = (date: string | null) => !!date && isBeforeToday(date);

  return (
    <div className="space-y-5">
      <ErrorNotification error={error} onRetry={handleRetry} retrying={retrying} />

      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <p className="text-sm text-on-surface-secondary">
            {total} {total === 1 ? "matter" : "matters"}
          </p>
          <ListBusyIndicator busy={fetching && !pagerPending} />
        </div>
        {unlinkedInvoices.count > 0 && (
          <p className="text-sm text-on-surface-muted">
            {unlinkedInvoices.count}{" "}
            {unlinkedInvoices.count === 1 ? "invoice" : "invoices"} totalling{" "}
            {formatCurrency(unlinkedInvoices.totalAmount)}{" "}
            {unlinkedInvoices.count === 1 ? "is" : "are"} billed directly to a client and
            not counted above. Switch to Billing by client to see them.
          </p>
        )}
      </div>

      <div className="rounded-2xl border border-outline bg-surface-alt/60 p-4 md:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
          <label className={`min-w-[220px] flex-1 ${FIELD_CLS}`}>
            <span className={FIELD_LABEL_CLS}>
              Search
            </span>
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search matters or clients..."
              className={INPUT_CLS}
            />
          </label>

          <div className="min-w-[180px]">
            <Dropdown
              label="Status"
              value={filters.status || ""}
              onChange={(val) => setFilter("status", val)}
              options={[
                { label: "All", value: "" },
                { label: "Active", value: "active" },
                { label: "Completed", value: "completed" },
                { label: "Closed", value: "closed" },
                { label: "Blocked", value: "blocked" },
                { label: "Archived", value: "archived" },
              ]}
            />
          </div>

          {practiceAreas.length > 0 ? (
            <div className="min-w-[200px]">
              <Dropdown
                label="Practice Area"
                value={filters.practiceArea || ""}
                onChange={(val) => setFilter("practiceArea", val)}
                options={[
                  { label: "All", value: "" },
                  ...practiceAreas.map((area) => ({ label: area, value: area })),
                ]}
              />
            </div>
          ) : null}

          {hasActiveFilters ? (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                clearFilters();
              }}
              className="rounded-xl border border-outline px-4 py-2 text-sm font-medium text-on-surface-secondary transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover"
            >
              Clear Filters
            </button>
          ) : null}
        </div>
      </div>

      {/* Card-shaped placeholders rather than `ListSkeleton`: these rows are
          separate spaced cards, not the divided rows of a bordered list. The
          gate matches every other billing tab - the skeleton stands in only when
          there is nothing to show, so a filter change keeps the rows on screen
          and is carried by the indicator above. */}
      {loading || (fetching && rows.length === 0) ? (
        <div className="space-y-4 md:space-y-3" role="status" aria-label="Loading matters">
          {Array.from({ length: Math.min(rowsPerPage, 4) }).map((_, index) => (
            <div
              key={index}
              aria-hidden
              className="h-40 animate-pulse rounded-lg border border-outline bg-surface-alt/40"
            />
          ))}
        </div>
      ) : total === 0 ? (
        error ? null : (
          <ListEmptyState
            icon={<Briefcase size={32} />}
            title={hasActiveFilters ? "No matters match these filters" : "No billing activity yet"}
            message={
              hasActiveFilters
                ? "Try adjusting the search, status, or practice area filters."
                : "A matter appears here once it has tracked time or an invoice."
            }
          />
        )
      ) : (
        <div className="space-y-4 md:space-y-3">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${row.id}/invoices`)}
              className="block w-full rounded-lg border border-outline bg-surface p-4 max-sm:p-5 text-left transition-[border-color,box-shadow] hover:border-accent-border-soft hover:shadow-sm dark:hover:border-accent-control-ring"
            >
              <div className="flex flex-col gap-3 max-sm:gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 max-sm:mb-2 flex flex-wrap items-center gap-2">
                    <span className="truncate text-lg font-semibold text-on-surface">
                      {row.name}
                    </span>
                    <MatterStatusBadge status={row.status} />
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-on-surface-secondary">
                    {row.practiceAreaName ? <span>{row.practiceAreaName}</span> : null}
                    <span>{summarizeNames(row.clientNames, "Clients")}</span>
                  </div>

                  <p className="mt-2 max-sm:mt-3 text-sm text-on-surface-secondary">
                    {row.timeEntryCount} time {row.timeEntryCount === 1 ? "entry" : "entries"} tracked
                    {" · "}
                    {formatHoursMinutes(row.totalHours)} recorded
                    {" · "}
                    {row.invoiceCount} {row.invoiceCount === 1 ? "invoice" : "invoices"}
                  </p>

                  {row.nextPaymentDate ? (
                    <p
                      className={`mt-2 max-sm:mt-3 text-sm font-medium ${
                        isOverdue(row.nextPaymentDate)
                          ? "text-red-600 dark:text-red-400"
                          : "text-on-surface-secondary"
                      }`}
                    >
                      {row.nextPaymentInvoiceName || "Invoice"}{" · "}
                      {row.nextPaymentFromPlan
                        ? `${isOverdue(row.nextPaymentDate) ? "Overdue" : "Next payment"}${
                            row.nextPaymentAmount != null
                              ? ` ${formatCurrency(row.nextPaymentAmount)}`
                              : ""
                          } due ${dayjs(row.nextPaymentDate).format("MMM D, YYYY")}`
                        : `Due ${dayjs(row.nextPaymentDate).format("MMM D, YYYY")}${
                            isOverdue(row.nextPaymentDate) ? " · overdue" : ""
                          }`}
                    </p>
                  ) : (
                    /* Reserve the next-payment line even when there is none, so
                       every card is the same height and a full page is the same
                       height as a padded partial page. */
                    <p aria-hidden="true" className="invisible mt-2 max-sm:mt-3 text-sm font-medium">
                      &nbsp;
                    </p>
                  )}
                </div>

                <div className="shrink-0 text-left md:text-right">
                  <p className="text-lg font-bold text-on-surface">
                    {formatCurrency(row.totalBilled)}
                  </p>
                  {row.totalOutstanding > 0 ? (
                    <p className="text-sm text-red-600 dark:text-red-400">
                      Outstanding: {formatCurrency(row.totalOutstanding)}
                    </p>
                  ) : (
                    <p className="text-sm text-green-600 dark:text-green-400">
                      No outstanding balance
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-3 border-t border-outline-subtle pt-4 text-sm text-on-surface-secondary sm:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-on-surface-muted">
                    Clients
                  </p>
                  <p className="mt-1 font-medium text-on-surface">
                    {row.clientNames.length}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-on-surface-muted">
                    Time Entries
                  </p>
                  <p className="mt-1 font-medium text-on-surface">
                    {row.timeEntryCount}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-on-surface-muted">
                    Hours
                  </p>
                  <p className="mt-1 font-medium text-on-surface">
                    {formatHoursMinutes(row.totalHours)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-on-surface-muted">
                    Invoices
                  </p>
                  <p className="mt-1 flex items-center gap-1 font-medium text-on-surface">
                    <FileText className="h-3.5 w-3.5 text-on-surface-muted" />
                    {row.invoiceCount}
                  </p>
                </div>
              </div>
            </button>
          ))}

          {/* Pad a partial page up to a full page so the list keeps a constant
              height as you page through or narrow the filters. */}
          <BillingReportCardFiller count={rowsPerPage - rows.length} />

          {total > rowsPerPage && (
            <ListPager
              page={page}
              totalPages={totalPages}
              total={total}
              rowsPerPage={rowsPerPage}
              onPageChange={setPage}
              busy={fetching}
              serverPaged
              onPendingChange={setPagerPending}
            />
          )}
        </div>
      )}
    </div>
  );
}
