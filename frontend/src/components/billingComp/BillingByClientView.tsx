"use client";

import { isBeforeToday } from '@/lib/utils/dateUtils';
import { useRef, useState } from "react";
import dayjs from "dayjs";
import { FileText, Users } from "lucide-react";
import ErrorNotification from "@/components/ErrorNotification";
import MatterStatusBadge from "@/components/ui/MatterStatusBadge";
import StatusBadge from "@/components/ui/StatusBadge";
import { FIELD_CLS, FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListEmptyState from "@/components/ui/ListEmptyState";
import Spinner from "@/components/ui/Spinner";
import ListPager from "@/components/ui/ListPager";
import BillingReportCardFiller from "./BillingReportCardFiller";
import useBillingByClientReport, {
  useBillingClientMatterBreakdown,
} from "@/hooks/billingHooks/useBillingByClientReport";
import { useNavigation } from "@/contexts/NavigationContext";
import Modal from "@/components/ui/Modal";
import { formatCurrency } from "./utils";
import { formatHoursMinutes } from "@/lib/utils/format";
import type { BillingByClientRow } from "@/services/billing.service";

interface BillingByClientViewProps {
  lawFirmId: string;
  /**
   * False while another report grouping is on screen, so this one's read is held
   * back rather than fetched behind a view nobody is looking at.
   */
  active: boolean;
}

function summarizeMatters(names: string[]) {
  if (names.length === 0) return "No linked matters yet";
  if (names.length <= 2) return `Matters: ${names.join(", ")}`;
  return `Matters: ${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

/**
 * Billing grouped by the client the work is billed to.
 *
 * Like the by-matter report, every figure on a card is a lifetime total, so the
 * rows are a server-side GROUP BY rather than a reduction over records held in
 * the browser. Attribution lives in that query too: work naming a client belongs
 * to them, and work naming nobody belongs to the matter's sole client and to no
 * one at all on a multi-client matter - charging it to everyone on the matter
 * counted the same hours and the same receivable two or three times.
 */
export default function BillingByClientView({ lawFirmId, active }: BillingByClientViewProps) {
  const { navigate } = useNavigation();
  const [selectedClient, setSelectedClient] = useState<BillingByClientRow | null>(null);
  // Mirrors the footer's own click acknowledgement, so the inline indicator
  // stays quiet while the pager button already carries the wait.
  const [pagerPending, setPagerPending] = useState(false);
  const report = useBillingByClientReport(lawFirmId, active);
  const {
    rows,
    total,
    totalPages,
    page,
    setPage,
    rowsPerPage,
    search,
    setSearch,
    unattributedInvoices,
    loading,
    fetching,
    error,
    refetch,
  } = report;

  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await refetch();
    } finally {
      setRetrying(false);
    }
  };

  const hasActiveFilters = Boolean(search);

  // Overdue is judged against the VIEWER's clock, the same rule the rest of the
  // billing screens follow.
  const isOverdue = (date: string | null) => !!date && isBeforeToday(date);

  return (
    <div className="space-y-5">
      <ErrorNotification error={error} onRetry={handleRetry} retrying={retrying} />

      {/* Count, plus the "still working" line for a filter change. It rides on
          this row - already on screen - so appearing mid-fetch doesn't push the
          list down, and the stale count beside it is explained. */}
      <div className="flex items-center gap-3">
        <p className="text-sm text-on-surface-secondary">
          {total} {total === 1 ? "client" : "clients"}
        </p>
        <ListBusyIndicator busy={fetching && !pagerPending} />
      </div>
      {unattributedInvoices.count > 0 && (
        <p className="text-sm text-on-surface-muted">
          {unattributedInvoices.count}{" "}
          {unattributedInvoices.count === 1 ? "invoice" : "invoices"} totalling{" "}
          {formatCurrency(unattributedInvoices.totalAmount)}{" "}
          {unattributedInvoices.count === 1 ? "names" : "name"} no client on a matter with
          several, so {unattributedInvoices.count === 1 ? "it is" : "they are"} counted under
          no client above. Switch to Billing by matter to see {unattributedInvoices.count === 1 ? "it" : "them"}.
        </p>
      )}

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
              placeholder="Search clients or matters..."
              className={INPUT_CLS}
            />
          </label>

          {hasActiveFilters ? (
            <button
              type="button"
              onClick={() => setSearch("")}
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
        <div className="space-y-4 md:space-y-3" role="status" aria-label="Loading clients">
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
            icon={<Users size={32} />}
            title={hasActiveFilters ? "No clients match these filters" : "No billing activity yet"}
            message={
              hasActiveFilters
                ? "Try adjusting the search terms to find a client or linked matter."
                : "A client appears here once they have tracked time or an invoice."
            }
          />
        )
      ) : (
        <div className="space-y-4 md:space-y-3">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => {
                if (row.clientId) {
                  navigate(`/lawfirm/${lawFirmId}/clients/${row.clientId}?tab=billing`);
                  return;
                }
                setSelectedClient(row);
              }}
              className="block w-full rounded-lg border border-outline bg-surface p-4 max-sm:p-5 text-left transition-[border-color,box-shadow] hover:border-accent-border-soft hover:shadow-sm dark:hover:border-accent-control-ring"
            >
              <div className="flex flex-col gap-3 max-sm:gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 max-sm:mb-2 flex flex-wrap items-center gap-2">
                    <span className="truncate text-lg font-semibold text-on-surface">
                      {row.name}
                    </span>
                    <StatusBadge variant="info">
                      {row.matterCount > 0
                        ? `${row.matterCount} ${row.matterCount === 1 ? "matter" : "matters"}`
                        : "Client billing"}
                    </StatusBadge>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-on-surface-secondary">
                    <span>{summarizeMatters(row.matterNames)}</span>
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
                    Matters
                  </p>
                  <p className="mt-1 font-medium text-on-surface">
                    {row.matterCount}
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

      <ClientDetailModal
        open={!!selectedClient}
        client={selectedClient}
        lawFirmId={lawFirmId}
        onClose={() => setSelectedClient(null)}
      />
    </div>
  );
}

function ClientDetailModal({
  open,
  client,
  lawFirmId,
  onClose,
}: {
  open: boolean;
  client: BillingByClientRow | null;
  lawFirmId: string;
  onClose: () => void;
}) {
  // Retain the last selected client so the exit animation still has data to
  // render after the parent clears the selection.
  const lastClientRef = useRef<BillingByClientRow | null>(client);
  if (client) lastClientRef.current = client;
  const activeClient = client ?? lastClientRef.current;

  // Read on demand from the same query that produced the card, so the breakdown
  // applies identical attribution rules and cannot disagree with the totals above
  // it. Deriving it here would mean a second implementation of those rules.
  const { matters: matterBreakdown, loading: breakdownLoading } =
    useBillingClientMatterBreakdown(lawFirmId, activeClient?.clientId);

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={activeClient?.name}
      subtitle={
        activeClient
          ? `Billing breakdown across ${activeClient.matterCount} ${activeClient.matterCount === 1 ? "matter" : "matters"}`
          : undefined
      }
      size="2xl"
      bodyClassName={null}
      footer={
        <button
          onClick={onClose}
          className="cursor-pointer rounded-md border border-outline bg-surface px-4 py-2 text-sm font-medium text-on-surface-secondary transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-surface-hover hover:text-on-surface"
        >
          Close
        </button>
      }
    >
      {activeClient && (
        <>
          <div className="grid grid-cols-3 gap-4 border-b border-outline-subtle px-6 py-4">
            <div>
              <p className="text-xs text-on-surface-muted">Total Hours</p>
              <p className="text-lg font-bold text-on-surface">
                {formatHoursMinutes(activeClient.totalHours)}
              </p>
            </div>
            <div>
              <p className="text-xs text-on-surface-muted">Total Billed</p>
              <p className="text-lg font-bold text-on-surface">
                {formatCurrency(activeClient.totalBilled)}
              </p>
            </div>
            <div>
              <p className="text-xs text-on-surface-muted">Outstanding</p>
              <p
                className={`text-lg font-bold ${
                  activeClient.totalOutstanding > 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-on-surface"
                }`}
              >
                {formatCurrency(activeClient.totalOutstanding)}
              </p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
            <p className="mb-3 text-sm font-medium text-on-surface">Matters</p>
            {breakdownLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size={20} />
              </div>
            ) : matterBreakdown.length === 0 ? (
              <p className="text-sm text-on-surface-muted">No matters found.</p>
            ) : (
              <div className="space-y-3">
                {matterBreakdown.map((billingMatter) => (
                  <div
                    key={billingMatter.id}
                    className="rounded-lg border border-outline-subtle p-4"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-medium text-on-surface">
                        {billingMatter.name}
                      </span>
                      <MatterStatusBadge status={billingMatter.status} />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-on-surface-muted">Hours</p>
                        <p className="font-medium">{formatHoursMinutes(billingMatter.hours)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-on-surface-muted">Billed</p>
                        <p className="font-medium">
                          {formatCurrency(billingMatter.billed)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-on-surface-muted">Outstanding</p>
                        <p
                          className={`font-medium ${
                            billingMatter.outstanding > 0
                              ? "text-red-600 dark:text-red-400"
                              : ""
                          }`}
                        >
                          {formatCurrency(billingMatter.outstanding)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-on-surface-muted">Invoices</p>
                        <p className="font-medium">{billingMatter.invoiceCount}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
