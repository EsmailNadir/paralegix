"use client";

import { useEffect, useState } from "react";
import { X, FileText, Briefcase, User } from "lucide-react";
import InvoiceDetailRow from "@/components/billingComp/InvoiceDetailRow";
import InvoiceMoneySummary from "@/components/billingComp/InvoiceMoneySummary";
import Modal from "@/components/ui/Modal";
import { useNavigation } from "@/contexts/NavigationContext";
import { formatCents as formatMoneyCents } from "@/lib/utils/currency";
import Button from "@/components/ui/Button";
import type { DashboardUpcomingPayment } from "@/services/dashboard.service";
import { formatDate as formatDateShared, toLocalDate } from "@/lib/utils/dateUtils";

interface UpcomingPaymentModalProps {
  payment: DashboardUpcomingPayment | null;
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
}

function formatCents(cents: number | null | undefined): string {
  return formatMoneyCents(cents ?? 0);
}

/** 'YYYY-MM-DD' → "Jun 21, 2026". Renders the raw date without a timezone shift. */
function formatDate(date: string | null): string {
  return formatDateShared(date, "-");
}

/** snake_case / lowercase enum → Title Case (e.g. "partially_paid" → "Partially Paid"). */
function titleCase(s?: string | null): string {
  return (s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Urgency pill for the invoice's due date, matching the widget's row badge. */
function urgency(days: number, dueDate: string | null): { label: string; classes: string } {
  if (days > 0) {
    return {
      label: days === 1 ? "1 day overdue" : `${days} days overdue`,
      classes: "bg-rose-50 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400",
    };
  }
  if (days === 0) {
    return { label: "Due Today", classes: "bg-amber-50 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400" };
  }
  if (days === -1) {
    return { label: "Due Tomorrow", classes: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300" };
  }
  const d = toLocalDate(dueDate);
  const when = d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "later";
  return { label: `Due ${when}`, classes: "bg-surface-alt text-on-surface-secondary" };
}

export default function UpcomingPaymentModal({ payment, open, onClose, lawFirmId }: UpcomingPaymentModalProps) {
  const { navigate } = useNavigation();

  // Retain the last non-null payment so the content does not blank out while the
  // exit animation plays (the parent clears `payment` the moment it closes).
  const [shown, setShown] = useState<DashboardUpcomingPayment | null>(payment);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- retains the last non-null payment so content doesn't blank during the exit animation
    if (payment) setShown(payment);
  }, [payment]);

  if (!shown) return null;

  const isMatter = shown.contextType === "matter";
  const hasEntity = !!shown.entityId;
  const entityBase = isMatter
    ? `/lawfirm/${lawFirmId}/matters/${shown.entityId}`
    : `/lawfirm/${lawFirmId}/clients/${shown.entityId}`;

  const goToInvoice = () => {
    if (!hasEntity) return;
    onClose();
    navigate(`${entityBase}/invoices/${shown.id}`);
  };

  const goToEntity = () => {
    if (!hasEntity) return;
    onClose();
    navigate(entityBase);
  };

  const u = urgency(shown.daysRelative, shown.dueDate);
  // The stored write-off, not total - paid - balance: that difference is only a
  // credit while every other figure reconciles, and otherwise prints one nobody gave.
  const writeOffCents = Math.max(0, shown.totalWrittenOffCents ?? 0);

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={shown.clientName}
      subtitle={shown.invoiceNumber ? <span className="font-mono">{shown.invoiceNumber}</span> : undefined}
      closeIcon={<X size={18} />}
      size="md"
      bodyClassName="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar"
      footer={
        <>
          <Button type="secondary" onClick={goToEntity} disabled={!hasEntity} icon={isMatter ? <Briefcase size={15} /> : <User size={15} />}>
            {isMatter ? "View matter" : "View client"}
          </Button>
          <Button type="primary" onClick={goToInvoice} disabled={!hasEntity} icon={<FileText size={15} />}>
            Open invoice
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${u.classes}`}>
          {u.label}
        </span>
        {shown.status && (
          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-surface-alt text-on-surface-secondary border border-outline-subtle">
            {titleCase(shown.status)}
          </span>
        )}
      </div>

      <dl className="space-y-3">
        <InvoiceDetailRow presentation="dashboard" label="Client" truncate>{shown.clientName}</InvoiceDetailRow>
        <InvoiceDetailRow presentation="dashboard" label="Invoice date">{formatDate(shown.invoiceDate)}</InvoiceDetailRow>
        <InvoiceDetailRow presentation="dashboard" label="Due date">{formatDate(shown.dueDate)}</InvoiceDetailRow>
      </dl>

      <InvoiceMoneySummary presentation="rows" items={[
        { label: "Invoice total", value: formatCents(shown.totalCents) },
        { label: "Amount paid", value: formatCents(shown.amountPaidCents) },
        ...(writeOffCents > 0 ? [{ label: "Credits / Adjustments", value: formatCents(writeOffCents) }] : []),
        { label: "Balance due", value: formatCents(shown.balanceDueCents) },
      ]} />
    </Modal>
  );
}
