"use client";

import { isBeforeToday } from '@/lib/utils/dateUtils';
import type { ReactNode } from "react";
import { Calendar } from "lucide-react";
import type { Invoice } from "@/types";
import StatusBadge from "@/components/ui/StatusBadge";
import RowActionMenu, { type RowAction } from "@/components/ui/RowActionMenu";
import {
  formatCurrency,
  getInvoiceDisplayName,
  getInvoiceNextPaymentInfo,
  getInvoiceRemainingBalance,
  getInvoiceStatus,
  getInvoiceStatusKey,
  getInvoiceTotal,
  isClosedStatusKey,
  isRecurringRetainerInvoice,
} from "@/components/billingComp/utils";
import dayjs from "dayjs";

export interface InvoiceListCardProps {
  invoice: Invoice;
  /** Opens the invoice (card click). Inline `actions`/`menuActions` must stop
   *  propagation themselves so they don't also trigger this. */
  onOpen: () => void;
  /** Extra badge(s) after the standard status/recurring badges, e.g. a "Plan" chip. */
  titleBadges?: ReactNode;
  /** Meta content under the title row · invoice date, client, plan name, etc. */
  children?: ReactNode;
  /** Inline right-side action buttons (e.g. Matter Billing / Stripe / Pay). */
  actions?: ReactNode;
  /** Kebab menu actions (e.g. View / Download PDF / Delete). */
  menuActions?: RowAction[];
}

/**
 * The invoice card shell shared by the matter invoices list and the client billing
 * tab's invoice list - same underlying data, same amount-column logic (mirrors the
 * firm billing view's row), with the surface-specific chips/actions left as slots.
 */
export default function InvoiceListCard({
  invoice,
  onOpen,
  titleBadges,
  children,
  actions,
  menuActions,
}: InvoiceListCardProps) {
  const { label: statusLabel, variant: statusVariant } = getInvoiceStatus(invoice);
  const statusKey = getInvoiceStatusKey(invoice);
  const total = getInvoiceTotal(invoice);
  const remaining = getInvoiceRemainingBalance(invoice);
  const nextPayment = getInvoiceNextPaymentInfo(invoice);
  const nextIsOverdue =
    !isClosedStatusKey(statusKey) && nextPayment.date
      ? isBeforeToday(nextPayment.date)
      : false;
  const dueLine =
    !isClosedStatusKey(statusKey) && nextPayment.date
      ? `${nextIsOverdue ? "Overdue" : "Due"} ${dayjs(nextPayment.date).format("MMM D, YYYY")}`
      : null;

  return (
    <div
      onClick={onOpen}
      className="cursor-pointer rounded-2xl border border-outline bg-surface p-5 hover:border-accent-border-soft hover:shadow-sm dark:hover:border-accent-border-soft transition-colors"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-on-surface truncate">
              {getInvoiceDisplayName(invoice)}
            </span>
            {isRecurringRetainerInvoice(invoice) && (
              <StatusBadge variant="success">Recurring Retainer</StatusBadge>
            )}
            <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
            {invoice.refundDue && <StatusBadge variant="warning">Refund due</StatusBadge>}
            {invoice.paymentPlan?.enabled && (
              <StatusBadge variant="purple">
                <Calendar size={10} /> Payment plan
              </StatusBadge>
            )}
            {invoice.splitGroupId && <StatusBadge variant="purple">Split Set</StatusBadge>}
            {titleBadges}
          </div>
          {children && <div className="mt-1.5 text-sm text-on-surface-muted">{children}</div>}
        </div>

        <div className="shrink-0 flex items-start gap-2">
          <div className="text-right">
            <p className="text-lg font-semibold text-on-surface tabular-nums">
              {formatCurrency(total)}
            </p>
            {remaining > 0 ? (
              <p
                className={`text-sm tabular-nums ${
                  nextIsOverdue ? "text-red-600 dark:text-red-400" : "text-on-surface-secondary"
                }`}
              >
                {formatCurrency(remaining)} left
                {dueLine ? ` · ${dueLine}` : ""}
              </p>
            ) : statusKey === "voided" ? (
              // Cancelled by the firm: nothing was owed, so neither a balance
              // nor a green "Fully paid".
              <p className="text-sm text-on-surface-secondary">Voided</p>
            ) : statusKey === "credited" ? (
              // Settled by a write-off, not by payment - green "Fully paid" here
              // claimed money the firm never collected.
              <p className="text-sm text-on-surface-secondary">
                Written off
                {Number(invoice.totalWrittenOff) > 0
                  ? ` ${formatCurrency(Number(invoice.totalWrittenOff))}`
                  : ""}
              </p>
            ) : total > 0 ? (
              <p className="text-sm text-green-600 dark:text-green-400">Fully paid</p>
            ) : null}
          </div>
          {(actions || menuActions?.length) && (
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              {actions}
              {menuActions && menuActions.length > 0 && (
                <RowActionMenu ariaLabel="Invoice actions" actions={menuActions} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
