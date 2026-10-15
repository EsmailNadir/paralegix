"use client";

import { useEffect, useState } from "react";
import {
  X,
  FileText,
  Briefcase,
  UserRound,
  CalendarClock,
  CalendarDays,
  Hash,
  Mail,
  Clock,
  Repeat,
  Users,
} from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import StatusBadge from "@/components/ui/StatusBadge";
import { formatDateOnly, isBeforeToday } from "@/lib/utils/dateUtils";
import { formatHoursMinutes } from "@/lib/utils/format";
import {
  formatCurrency,
  getBillingPlanDestination,
  getInvoiceClientAttribution,
  getInvoiceDestination,
  getInvoiceDisplayName,
  getInvoiceNextPaymentInfo,
  getInvoiceCreditBalance,
  getInvoiceRemainingBalance,
  getInvoiceStatus,
  getInvoiceStatusKey,
  getInvoiceTotal,
  getRecurringRetainerPlanName,
  isRecurringRetainerInvoice,
  isClosedStatusKey,
} from "./utils";
import type { EnrichedInvoice } from "@/hooks/billingHooks/useFirmInvoices";
import InvoiceDetailRow from "./InvoiceDetailRow";
import InvoiceMoneySummary from "./InvoiceMoneySummary";
import SectionLabel from "@/components/ui/SectionLabel";

interface InvoiceDetailModalProps {
  invoice: EnrichedInvoice | null;
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
}

const SPLIT_MODE_LABELS: Record<string, string> = {
  manual: "Manual",
  equal: "Split evenly",
  percentage: "By percentage",
  fixed_amount: "Fixed amounts",
};

/** Day-only or ISO date → "Jun 21, 2026", rendered without a timezone shift. */
function formatDay(date?: string | null, fallback = "-"): string {
  return formatDateOnly(date, { month: "short", day: "numeric", year: "numeric" }, fallback);
}

/** One tile in the money summary grid. */
function AmountTile({
  label,
  value,
  valueClass = "text-on-surface",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-outline-subtle bg-surface-alt/60 px-3 py-2">
      <SectionLabel>
        {label}
      </SectionLabel>
      <p className={`mt-1 text-base font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

/**
 * Quick-look panel for a firm invoice, opened from the billing lists instead of
 * navigating straight to the full invoice page. Shows the money summary,
 * schedule and context of a single invoice, with links out to the matter,
 * client, recurring plan, and the invoice itself.
 */
export default function InvoiceDetailModal({
  invoice,
  open,
  onClose,
  lawFirmId,
}: InvoiceDetailModalProps) {
  const { navigate } = useNavigation();

  // Retain the last non-null invoice so the content does not blank out while the
  // exit animation plays (the parent clears `invoice` the moment it closes).
  const [shown, setShown] = useState<EnrichedInvoice | null>(invoice);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- retains the last non-null invoice so content doesn't blank during the exit animation
    if (invoice) setShown(invoice);
  }, [invoice]);

  if (!shown) return null;

  const { label: statusLabel, variant: statusVariant } = getInvoiceStatus(shown);
  const statusKey = getInvoiceStatusKey(shown);
  const isSettled = isClosedStatusKey(statusKey);

  const total = getInvoiceTotal(shown);
  const paid = Number(shown.amountPaid) || 0;
  const writtenOff = Number(shown.totalWrittenOff) || 0;
  const remaining = getInvoiceRemainingBalance(shown);
  // Non-zero only when the invoice is settled past its total; the remaining tile
  // reads 0 in that case and would say nothing about money owed back.
  const credit = getInvoiceCreditBalance(shown);

  const nextPayment = getInvoiceNextPaymentInfo(shown);
  const nextIsOverdue = !isSettled && isBeforeToday(nextPayment.date);

  const isRecurring = isRecurringRetainerInvoice(shown);
  const planName = getRecurringRetainerPlanName(shown);

  const {
    name: clientLabel,
    clientId: clientDestinationId,
    matterClientNames,
    isAmbiguous: isAmbiguousClient,
  } = getInvoiceClientAttribution(shown);

  const destination = getInvoiceDestination(lawFirmId, shown);
  const scheduledPayments = shown.paymentPlan?.enabled
    ? shown.paymentPlan.expectedPayments || []
    : [];

  const goTo = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      labelledBy="invoice-detail-title"
      size="lg"
      showClose={false}
      className="relative"
      bodyClassName={null}
    >
      <div className="flex items-start justify-between px-6 py-4 border-b border-outline shrink-0">
        <div className="min-w-0">
          <SectionLabel tone="secondary" gap="1">
            Invoice
          </SectionLabel>
          <h2 id="invoice-detail-title" className="text-lg font-semibold text-on-surface truncate">
            {getInvoiceDisplayName(shown)}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="text-on-surface-muted hover:text-on-surface transition-colors shrink-0 ml-3 cursor-pointer"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
          {isRecurring && <StatusBadge variant="success">Recurring</StatusBadge>}
          {shown.splitGroupId && <StatusBadge variant="purple">Split</StatusBadge>}
          {shown.stripePaymentRequested && (
            <StatusBadge variant="indigo">Payment requested</StatusBadge>
          )}
        </div>

        <InvoiceMoneySummary presentation="tiles"
          className={`grid gap-2.5 ${writtenOff > 0 ? "grid-cols-2" : "grid-cols-3"}`}
          renderTile={(item) => <AmountTile label={item.label} value={String(item.value)} valueClass={item.valueClass} />}
          items={[
            { label: "Total", value: formatCurrency(total) },
            { label: "Paid", value: formatCurrency(paid) },
            ...(writtenOff > 0 ? [{ label: "Credits / Adjustments", value: formatCurrency(writtenOff) }] : []),
            { label: credit > 0 ? "Credit due" : "Remaining", value: formatCurrency(credit > 0 ? credit : remaining),
              valueClass: credit > 0 ? "text-amber-600 dark:text-amber-400" : remaining <= 0
                ? "text-emerald-600 dark:text-emerald-400" : nextIsOverdue ? "text-red-600 dark:text-red-400" : "text-on-surface" },
          ]} />

        <dl className="space-y-3">
          {shown.invoiceNumber && (
            <InvoiceDetailRow icon={<Hash size={15} />} label="Invoice number">
              {shown.invoiceNumber}
            </InvoiceDetailRow>
          )}

          <InvoiceDetailRow icon={<CalendarDays size={15} />} label="Invoice date">
            {formatDay(shown.invoiceDate)}
          </InvoiceDetailRow>

          <InvoiceDetailRow icon={<CalendarClock size={15} />} label="Due date">
            <span className={nextIsOverdue ? "text-red-600 dark:text-red-400" : ""}>
              {formatDay(shown.dueDate, "No due date")}
            </span>
          </InvoiceDetailRow>

          {nextPayment.fromPlan && nextPayment.date && (
            <InvoiceDetailRow icon={<CalendarClock size={15} />} label="Next payment">
              <span className={nextIsOverdue ? "text-red-600 dark:text-red-400" : ""}>
                {formatDay(nextPayment.date)}
                {nextPayment.amount !== null ? ` · ${formatCurrency(nextPayment.amount)}` : ""}
              </span>
            </InvoiceDetailRow>
          )}

          <InvoiceDetailRow icon={<Briefcase size={15} />} label="Matter">
            {shown.matterId ? (
              <button
                type="button"
                onClick={() => goTo(`/lawfirm/${lawFirmId}/matters/${shown.matterId}`)}
                className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium hover:underline truncate cursor-pointer max-w-full"
              >
                {shown.matterName || "View matter"}
              </button>
            ) : (
              <span>{shown.matterName || "-"}</span>
            )}
          </InvoiceDetailRow>

          <InvoiceDetailRow
            icon={<UserRound size={15} />}
            label={isAmbiguousClient ? "Matter clients" : "Client"}
          >
            {isAmbiguousClient ? (
              <span className="flex flex-col items-end gap-0.5">
                {matterClientNames.map((name) => (
                  <span key={name} className="truncate max-w-full">
                    {name}
                  </span>
                ))}
                <span className="text-xs font-normal text-on-surface-muted">
                  Not billed to one client
                </span>
              </span>
            ) : clientDestinationId && clientLabel ? (
              <button
                type="button"
                onClick={() => goTo(`/lawfirm/${lawFirmId}/clients/${clientDestinationId}`)}
                className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium hover:underline truncate cursor-pointer max-w-full"
              >
                {clientLabel}
              </button>
            ) : (
              <span className="truncate">{clientLabel || "-"}</span>
            )}
          </InvoiceDetailRow>

          {shown.billingEmail && (
            <InvoiceDetailRow icon={<Mail size={15} />} label="Billing email">
              <span className="truncate">{shown.billingEmail}</span>
            </InvoiceDetailRow>
          )}

          {Number(shown.totalHours) > 0 && (
            <InvoiceDetailRow icon={<Clock size={15} />} label="Hours billed">
              {formatHoursMinutes(Number(shown.totalHours))}
            </InvoiceDetailRow>
          )}

          {isRecurring && (
            <InvoiceDetailRow icon={<Repeat size={15} />} label="Recurring plan">
              {shown.billingPlanId ? (
                <button
                  type="button"
                  onClick={() =>
                    goTo(getBillingPlanDestination(lawFirmId, shown.billingPlanId!))
                  }
                  className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium hover:underline truncate cursor-pointer max-w-full"
                >
                  {planName || "View plan"}
                </button>
              ) : (
                <span className="truncate">{planName || "Retainer"}</span>
              )}
            </InvoiceDetailRow>
          )}

          {shown.splitGroupId && (
            <InvoiceDetailRow icon={<Users size={15} />} label="Split billing">
              {[
                shown.splitMode ? SPLIT_MODE_LABELS[shown.splitMode] || null : null,
                shown.splitRecipientCount
                  ? `${shown.splitRecipientCount} recipients`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Split invoice"}
            </InvoiceDetailRow>
          )}
        </dl>

        {scheduledPayments.length > 0 && (
          <div>
            <SectionLabel gap="2">
              Payment schedule
            </SectionLabel>
            <div className="rounded-lg border border-outline-subtle divide-y divide-outline-subtle">
              {scheduledPayments.map((payment, index) => {
                const isPaidInstallment = payment.status === "paid";
                const isOverdueInstallment =
                  !isPaidInstallment && isBeforeToday(payment.dueDate);
                return (
                  <div
                    key={payment.id || `${payment.dueDate}-${index}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span
                      className={
                        isOverdueInstallment
                          ? "text-red-600 dark:text-red-400"
                          : "text-on-surface-secondary"
                      }
                    >
                      {formatDay(payment.dueDate)}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums font-medium text-on-surface">
                        {formatCurrency(payment.amount)}
                      </span>
                      <StatusBadge
                        variant={
                          isPaidInstallment
                            ? "success"
                            : isOverdueInstallment
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {isPaidInstallment
                          ? "Paid"
                          : isOverdueInstallment
                            ? "Overdue"
                            : "Scheduled"}
                      </StatusBadge>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {shown.notes && (
          <div>
            <SectionLabel gap="2">
              Notes
            </SectionLabel>
            <p className="rounded-lg border border-outline-subtle bg-surface-alt/60 px-3 py-2 text-sm text-on-surface-secondary whitespace-pre-wrap break-words">
              {shown.notes}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg border-t border-outline shrink-0">
        <Button type="secondary" onClick={onClose}>
          Close
        </Button>
        {destination && (
          <Button
            type="primary"
            onClick={() => goTo(destination)}
            icon={<FileText size={15} />}
          >
            Open invoice
          </Button>
        )}
      </div>
    </Modal>
  );
}
