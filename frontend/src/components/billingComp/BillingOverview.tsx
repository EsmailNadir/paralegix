"use client";

import { useState } from "react";
import dayjs from "dayjs";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  FileClock,
  HandCoins,
  Receipt,
  RefreshCw,
  Wallet,
  X,
} from "lucide-react";
import Button from "@/components/ui/Button";
import ListPager from "@/components/ui/ListPager";
import { useNavigation } from "@/contexts/NavigationContext";
import Modal from "@/components/ui/Modal";
import { formatHoursMinutes } from "@/lib/utils/format";
import { formatCurrency, getInvoiceDestination } from "./utils";
import type {
  BillingAttentionRow,
  BillingReadyItem,
  BillingWorkbenchResponse,
} from "@/types";

type AttentionRow = BillingAttentionRow;

interface RowDetail {
  key: string;
  tag: string;
  rowKind: keyof typeof ROW_KINDS;
  title: string;
  subtitle: string;
  amount?: string;
  amountClass: string;
  fields: Array<{ label: string; value: string; onNavigate?: () => void }>;
  onNavigate?: () => void;
  navigateLabel?: string;
  action: React.ReactNode;
  footerAction: React.ReactNode;
}

interface BillingOverviewProps {
  lawFirmId: string;
  summary: BillingWorkbenchResponse["summary"] | undefined;
  /**
   * One page of the "needs attention" list, already ordered by the server, plus
   * the pre-window count. The rows are not derived here: the full list is every
   * overdue invoice and every ready-to-bill item in the firm, which is far too
   * much to ship just to render five rows.
   */
  attentionRows: AttentionRow[];
  attentionTotal: number;
  page: number;
  onPageChange: (page: number) => void;
  /**
   * True while a page of the attention list is in flight. The pager carries the
   * wait on the button that was clicked, so paging doesn't look ignored while
   * the previous page stays on screen.
   */
  attentionFetching?: boolean;
  /**
   * Accounts receivable and collections, aggregated firm-wide by the billing
   * summary endpoint. They are passed in rather than derived from an invoice list
   * because the lists on this page are paginated, so anything summed from one
   * would total a page instead of the firm.
   */
  awaitingAmount: number;
  awaitingCount: number;
  collectedAmount: number;
  loading: boolean;
  creatingPlanDraftId: string | null;
  onViewUnbilled: () => void;
  onViewAwaiting: () => void;
  onViewOverdue: () => void;
  onViewCollected: () => void;
  onCreatePlanDraft: (item: BillingReadyItem) => void;
  onBillItem: (item: BillingReadyItem) => void;
}

/**
 * Rows of the attention list shown at once. Exported because the page has to ask
 * the server for exactly this many - the list is paged server-side, so the page
 * size is part of the request, not just a local slice.
 */
export const ATTENTION_PAGE_SIZE = 5;
const PAGE_SIZE = ATTENTION_PAGE_SIZE;

const ITEM_TYPE_LABELS: Record<string, string> = {
  time_entry: "Time entry",
  flat_fee: "Flat fee",
  expense: "Expense",
  plan_period: "Recurring plan",
};

const ROW_KINDS = {
  overdue: {
    icon: AlertTriangle,
    chip: "bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400",
  },
  ready: {
    icon: RefreshCw,
    chip: "bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis",
  },
  unbilled: {
    icon: Receipt,
    chip: "bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
  },
} as const;

export default function BillingOverview({
  lawFirmId,
  summary,
  attentionRows,
  attentionTotal,
  page,
  onPageChange,
  attentionFetching = false,
  awaitingAmount,
  awaitingCount,
  collectedAmount,
  loading,
  creatingPlanDraftId,
  onViewUnbilled,
  onViewAwaiting,
  onViewOverdue,
  onViewCollected,
  onCreatePlanDraft,
  onBillItem,
}: BillingOverviewProps) {
  const { navigate } = useNavigation();

  // --- Band A: headline numbers (read-only KPIs) ---
  const unbilledTotal = summary?.readyToBillAmount ?? 0;
  const unbilledHours = summary?.unbilledHours ?? 0;
  const overdueAmount = summary?.overdueAmount ?? 0;
  const overdueCount = summary?.overdueCount ?? 0;

  // --- Band B: a single prioritized to-do list, ordered and paged by the server ---
  const rows = attentionRows;
  const totalPages = Math.max(1, Math.ceil(attentionTotal / PAGE_SIZE));
  const isEmpty = attentionTotal === 0;

  // Build the normalized display model for a row, shared by the list row and
  // the detail modal so both stay in sync (including live action busy state).
  const buildDetail = (row: AttentionRow): RowDetail => {
    if (row.kind === "overdue") {
      const dateStr = row.item.nextPaymentDate || row.item.dueDate;
      const context =
        [row.item.matterName, row.item.clientName].filter(Boolean).join(" • ") || "Open invoice";
      const goToInvoice = () => {
        const dest = getInvoiceDestination(lawFirmId, row.item);
        if (dest) navigate(dest);
      };
      const matterId =
        row.item.matterId || (row.item.contextType === "matter" ? row.item.entityId : null);
      const clientId =
        row.item.clientContextId ||
        row.item.clientId ||
        (row.item.contextType === "client" ? row.item.entityId : null);
      const goToMatter = matterId
        ? () => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}`)
        : undefined;
      const goToClient = clientId
        ? () => navigate(`/lawfirm/${lawFirmId}/clients/${clientId}`)
        : undefined;
      return {
        key: row.key,
        tag: "Overdue",
        rowKind: "overdue",
        title: row.item.invoiceName || row.item.id,
        subtitle: `Invoice · ${context}${dateStr ? ` · was due ${dayjs(dateStr).format("MMM D, YYYY")}` : ""}`,
        amount:
          typeof row.item.remainingBalance === "number"
            ? formatCurrency(row.item.remainingBalance)
            : undefined,
        amountClass: "text-red-600 dark:text-red-400",
        fields: [
          { label: "Type", value: "Overdue invoice" },
          row.item.matterName
            ? { label: "Matter", value: row.item.matterName, onNavigate: goToMatter }
            : null,
          row.item.clientName
            ? { label: "Client", value: row.item.clientName, onNavigate: goToClient }
            : null,
          row.item.taskId
            ? {
                label: "Task",
                value: "View task",
                onNavigate: () => navigate(`/lawfirm/${lawFirmId}/tasks/${row.item.taskId}`),
              }
            : null,
          dateStr ? { label: "Was due", value: dayjs(dateStr).format("MMM D, YYYY") } : null,
        ].filter(Boolean) as RowDetail["fields"],
        onNavigate: getInvoiceDestination(lawFirmId, row.item) ? goToInvoice : undefined,
        navigateLabel: "Open invoice",
        action: (
          <Button type="secondary" size="small" onClick={goToInvoice}>
            Record payment
          </Button>
        ),
        footerAction: (
          <Button type="secondary" onClick={goToInvoice}>
            Record payment
          </Button>
        ),
      };
    }

    if (row.kind === "plan") {
      const actionId = `${row.item.planId}:${row.item.periodId}`;
      const busy = creatingPlanDraftId === actionId;
      const matterId =
        row.item.matterId || (row.item.contextType === "matter" ? row.item.entityId : null);
      const clientId =
        row.item.clientId || (row.item.contextType === "client" ? row.item.entityId : null);
      const goToMatter = matterId
        ? () => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}`)
        : undefined;
      const goToClient = clientId
        ? () => navigate(`/lawfirm/${lawFirmId}/clients/${clientId}`)
        : undefined;
      const goTo = goToMatter || goToClient;
      return {
        key: row.key,
        tag: "Ready to bill",
        rowKind: "ready",
        title: row.item.description,
        subtitle: [
          "Recurring plan",
          [row.item.matterName, row.item.clientName].filter(Boolean).join(" • ") || null,
        ]
          .filter(Boolean)
          .join(" · "),
        amount: typeof row.item.amount === "number" ? formatCurrency(row.item.amount) : undefined,
        amountClass: "text-on-surface",
        fields: [
          { label: "Type", value: "Recurring plan" },
          row.item.matterName
            ? { label: "Matter", value: row.item.matterName, onNavigate: goToMatter }
            : null,
          row.item.clientName
            ? { label: "Client", value: row.item.clientName, onNavigate: goToClient }
            : null,
          row.item.date
            ? { label: "Period", value: dayjs(row.item.date).format("MMM D, YYYY") }
            : null,
        ].filter(Boolean) as RowDetail["fields"],
        onNavigate: goTo,
        navigateLabel: goToMatter ? "Open matter" : goToClient ? "Open client" : undefined,
        action: (
          <Button type="primary" size="small" loading={busy} onClick={() => onCreatePlanDraft(row.item)}>
            Create invoice
          </Button>
        ),
        footerAction: (
          <Button type="primary" loading={busy} onClick={() => onCreatePlanDraft(row.item)}>
            Create invoice
          </Button>
        ),
      };
    }

    const matterId =
      row.item.matterId || (row.item.contextType === "matter" ? row.item.entityId : null);
    const clientId =
      row.item.clientId || (row.item.contextType === "client" ? row.item.entityId : null);
    const goToMatter = matterId
      ? () => navigate(`/lawfirm/${lawFirmId}/matters/${matterId}`)
      : undefined;
    const goToClient = clientId
      ? () => navigate(`/lawfirm/${lawFirmId}/clients/${clientId}`)
      : undefined;
    const goTo = goToMatter || goToClient;
    return {
      key: row.key,
      tag: "Unbilled",
      rowKind: "unbilled",
      title: row.item.description,
      subtitle: [
        ITEM_TYPE_LABELS[row.item.itemType] || null,
        [row.item.matterName, row.item.clientName].filter(Boolean).join(" • ") || "Unbilled work",
        row.item.hours ? formatHoursMinutes(row.item.hours) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      amount: typeof row.item.amount === "number" ? formatCurrency(row.item.amount) : "Set in draft",
      amountClass: "text-on-surface",
      fields: [
        { label: "Type", value: ITEM_TYPE_LABELS[row.item.itemType] || row.item.itemType },
        row.item.matterName
          ? { label: "Matter", value: row.item.matterName, onNavigate: goToMatter }
          : null,
        row.item.clientName
          ? { label: "Client", value: row.item.clientName, onNavigate: goToClient }
          : null,
        row.item.date ? { label: "Date", value: dayjs(row.item.date).format("MMM D, YYYY") } : null,
        row.item.hours ? { label: "Hours", value: formatHoursMinutes(row.item.hours) } : null,
      ].filter(Boolean) as RowDetail["fields"],
      onNavigate: goTo,
      navigateLabel: goToMatter ? "Open matter" : goToClient ? "Open client" : undefined,
      action: (
        <Button type="primary" size="small" onClick={() => onBillItem(row.item)}>
          Bill now
        </Button>
      ),
      footerAction: (
        <Button type="primary" onClick={() => onBillItem(row.item)}>
          Bill now
        </Button>
      ),
    };
  };

  // Detail modal: keep the row key while the exit animation plays so content
  // doesn't blank mid-close (see frontend modal conventions).
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailRow = detailKey ? rows.find((r) => r.key === detailKey) : undefined;
  const detail = detailRow ? buildDetail(detailRow) : null;
  const openDetail = (key: string) => {
    setDetailKey(key);
    setDetailOpen(true);
  };

  return (
    <div className="mb-6 space-y-4">
      {/* Band A: headline numbers */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5 sm:gap-3">
        <KpiTile
          icon={HandCoins}
          iconTint="bg-blue-500/10 text-accent-emphasis dark:bg-blue-500/15 dark:text-accent-emphasis"
          label="Awaiting payment"
          loading={loading}
          value={formatCurrency(awaitingAmount)}
          subtitle={`${awaitingCount} open ${awaitingCount === 1 ? "invoice" : "invoices"}`}
          onClick={onViewAwaiting}
        />
        <KpiTile
          icon={FileClock}
          iconTint="bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
          label="Unbilled work"
          loading={loading}
          value={formatCurrency(unbilledTotal)}
          subtitle={`${formatHoursMinutes(unbilledHours)} not yet invoiced`}
          onClick={onViewUnbilled}
        />
        <KpiTile
          icon={AlertTriangle}
          iconTint="bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400"
          label="Overdue"
          loading={loading}
          value={formatCurrency(overdueAmount)}
          valueClass={overdueAmount > 0 ? "text-red-600 dark:text-red-400" : undefined}
          subtitle={
            overdueCount > 0
              ? `${overdueCount} past due`
              : "Nothing past due"
          }
          onClick={onViewOverdue}
        />
        <KpiTile
          icon={Wallet}
          iconTint="bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
          label="Collected"
          loading={loading}
          value={formatCurrency(collectedAmount)}
          subtitle="Payments received"
          onClick={onViewCollected}
        />
      </div>

      {/* Band B: single to-do list */}
      <section className="bg-surface border border-outline rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="whitespace-nowrap text-base font-semibold text-on-surface">Needs attention</h3>
          {attentionTotal > 0 && (
            <span className="shrink-0 rounded-full bg-surface-alt px-2 py-0.5 text-xs font-semibold text-on-surface-secondary">
              {attentionTotal}
            </span>
          )}
          <span className="ml-auto hidden truncate text-xs text-on-surface-muted sm:inline">
            Unbilled work ready to invoice
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-11 rounded-lg bg-surface-alt animate-pulse" />
            ))}
          </div>
        ) : isEmpty ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-outline px-4 py-3 text-sm text-on-surface-secondary">
            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
            You&apos;re all caught up, no overdue invoices or unbilled work right now.
          </div>
        ) : (
          <div className="space-y-1.5">
            {rows.map((row) => {
              const d = buildDetail(row);
              return (
                <AttentionRowView
                  key={d.key}
                  tag={d.tag}
                  kind={d.rowKind}
                  title={d.title}
                  subtitle={d.subtitle}
                  amount={d.amount}
                  amountClass={d.amountClass}
                  action={d.action}
                  onOpen={() => openDetail(d.key)}
                />
              );
            })}


            <div className="pt-1">
              <ListPager
                page={page}
                totalPages={totalPages}
                total={attentionTotal}
                rowsPerPage={PAGE_SIZE}
                onPageChange={onPageChange}
                busy={attentionFetching}
                serverPaged
              />
            </div>
          </div>
        )}
      </section>

      {detail && (
        <Modal
          isOpen={detailOpen}
          onClose={() => setDetailOpen(false)}
          labelledBy="billing-overview-detail-title"
          size="md"
          showClose={false}
          className="rounded-2xl shadow-2xl ring-1 ring-outline/60 relative overflow-hidden"
          bodyClassName={null}
        >
        {/* Header: icon, status chip, title, and a highlighted amount */}
        <div className="relative shrink-0 px-6 pt-6 pb-5 border-b border-outline">
          <button
            type="button"
            onClick={() => setDetailOpen(false)}
            className="absolute top-4 right-4 flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-muted hover:bg-surface-hover hover:text-on-surface transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex items-start gap-3 pr-8">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${ROW_KINDS[detail.rowKind].chip}`}
            >
              {(() => {
                const Icon = ROW_KINDS[detail.rowKind].icon;
                return <Icon className="h-5 w-5" />;
              })()}
            </span>
            <div className="min-w-0">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${ROW_KINDS[detail.rowKind].chip}`}
              >
                {detail.tag}
              </span>
              <h2 id="billing-overview-detail-title" className="mt-1.5 text-lg font-semibold leading-snug text-on-surface break-words">
                {detail.title}
              </h2>
            </div>
          </div>

          {detail.amount && (
            <div className="mt-4 flex items-center justify-between gap-4 rounded-xl bg-surface-alt px-4 py-3">
              <span className="text-sm text-on-surface-secondary">Amount</span>
              {/* One step above the rows below, not a KPI tile: the tinted
                  panel is what marks it as the headline, so the figure only
                  needs the app's largest in-page size to lead them. */}
              <span className={`text-lg font-semibold ${detail.amountClass}`}>
                {detail.amount}
              </span>
            </div>
          )}
        </div>

        {/* Detail rows - matter / client / task navigate on click */}
        <div className="px-3 py-3 overflow-y-auto overflow-x-hidden styled-scrollbar">
          {detail.fields.map((field) => {
            const clickable = !!field.onNavigate;
            const inner = (
              <>
                <span className="text-sm text-on-surface-secondary">{field.label}</span>
                <span
                  className={`flex items-center gap-1 text-sm font-medium text-right break-words ${
                    clickable ? "text-accent-emphasis" : "text-on-surface"
                  }`}
                >
                  {field.value}
                  {clickable && (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                  )}
                </span>
              </>
            );
            return clickable ? (
              <button
                key={field.label}
                type="button"
                onClick={() => {
                  setDetailOpen(false);
                  field.onNavigate?.();
                }}
                className="group flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-hover cursor-pointer"
              >
                {inner}
              </button>
            ) : (
              <div
                key={field.label}
                className="flex items-center justify-between gap-4 px-3 py-2.5"
              >
                {inner}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 bg-surface-alt border-t border-outline shrink-0">
          {detail.onNavigate ? (
            <Button
              type="secondary"
              onClick={() => {
                setDetailOpen(false);
                detail.onNavigate?.();
              }}
            >
              {detail.navigateLabel || "Open"}
            </Button>
          ) : (
            <span />
          )}
          <div onClick={() => setDetailOpen(false)}>{detail.footerAction}</div>
        </div>
        </Modal>
      )}
    </div>
  );
}

function KpiTile({
  icon: Icon,
  iconTint,
  label,
  loading,
  value,
  valueClass,
  subtitle,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconTint: string;
  label: string;
  loading: boolean;
  value: string;
  valueClass?: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left bg-surface border border-outline rounded-xl p-4 sm:p-5 flex flex-col transition-colors hover:border-accent-control-ring/40 hover:bg-surface-hover cursor-pointer"
    >
      <div className="flex items-center gap-2 sm:gap-2.5 mb-2.5 sm:mb-3 min-w-0">
        <span className={`flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-lg ${iconTint}`}>
          <Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
        </span>
        <span className="text-xs sm:text-sm font-semibold text-on-surface-secondary truncate">{label}</span>
      </div>

      {loading ? (
        <div className="h-8 sm:h-9 w-24 sm:w-28 bg-surface-alt rounded animate-pulse" />
      ) : (
        <p className={`text-2xl sm:text-3xl font-bold tracking-tight ${valueClass || "text-on-surface"}`}>{value}</p>
      )}

      <p className="text-[11px] sm:text-xs text-on-surface-muted mt-1 sm:mt-1.5 inline-flex items-center gap-1">
        <span className="truncate">{subtitle}</span>
        <ArrowRight size={12} className="shrink-0 opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
      </p>
    </button>
  );
}

function AttentionRowView({
  tag,
  kind,
  title,
  subtitle,
  amount,
  amountClass = "text-on-surface",
  action,
  onOpen,
}: {
  tag: string;
  kind: keyof typeof ROW_KINDS;
  title: string;
  subtitle: string;
  amount?: string;
  amountClass?: string;
  action: React.ReactNode;
  onOpen: () => void;
}) {
  const { icon: Icon, chip } = ROW_KINDS[kind];
  // The ring is `focus-visible`, not `focus`: closing the detail modal hands
  // focus back to the row it was opened from, and a plain `focus:` ring would
  // leave that row outlined after a mouse click even though nothing is selected.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex items-start gap-3 rounded-xl border border-outline p-3 cursor-pointer transition-colors hover:border-accent-control-ring/40 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:items-center sm:rounded-lg sm:px-3 sm:py-2.5"
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${chip}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        {/* Tag, with the title inline on desktop and the amount pushed right on mobile. */}
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip}`}>
            {tag}
          </span>
          <span className="hidden min-w-0 flex-1 truncate text-base font-semibold text-on-surface sm:inline">
            {title}
          </span>
          {amount && (
            <span className={`ml-auto shrink-0 text-base font-semibold sm:hidden ${amountClass}`}>
              {amount}
            </span>
          )}
        </div>
        {/* Title on its own line on mobile so it can use the full width. */}
        <p className="mt-1 break-words text-sm font-semibold text-on-surface sm:hidden">{title}</p>
        <p className="mt-0.5 truncate text-sm text-on-surface-muted">{subtitle}</p>
        {/* Mobile: action sits right-aligned beneath the text. Stop propagation
            so the inline action doesn't also open the detail modal. */}
        <div className="mt-2.5 flex justify-end sm:hidden" onClick={(e) => e.stopPropagation()}>
          {action}
        </div>
      </div>
      {/* Desktop: amount and action sit on the right of the row. */}
      {amount && (
        <p className={`hidden text-base font-semibold sm:block sm:w-24 sm:shrink-0 sm:text-right ${amountClass}`}>
          {amount}
        </p>
      )}
      <div className="hidden sm:block sm:shrink-0" onClick={(e) => e.stopPropagation()}>
        {action}
      </div>
    </div>
  );
}
