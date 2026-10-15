"use client";

import type { ReactNode } from "react";
import dayjs from "dayjs";
import type { BillingPlan, BillingPlanPeriod } from "@/types";
import Button from "@/components/ui/Button";
import StatusBadge from "@/components/ui/StatusBadge";
import { formatCurrency, getBillingPlanDestination } from "@/components/billingComp/utils";
import { billingPlanStatusMeta } from '@/constants/statusMeta';

interface RecurringRetainerSectionProps {
  title: string;
  description: string;
  onOpenWorkbench: () => void;
  children: ReactNode;
}

/** The bordered "Recurring Retainers" section wrapper shared by the matter invoices
 *  page and the client billing tab. */
export function RecurringRetainerSection({
  title,
  description,
  onOpenWorkbench,
  children,
}: RecurringRetainerSectionProps) {
  return (
    <section className="rounded-2xl border border-outline bg-surface-alt/40 p-4 md:p-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
            Recurring Retainers
          </p>
          <h3 className="mt-1 text-lg font-semibold text-on-surface">{title}</h3>
          <p className="mt-1 text-sm text-on-surface-secondary">{description}</p>
        </div>
        <Button
          type="secondary"
          size="small"
          onClick={onOpenWorkbench}
          className="w-full md:w-auto justify-center"
        >
          Open Billing Workbench
        </Button>
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

interface RecurringRetainerPlanCardProps {
  plan: BillingPlan;
  lawFirmId: string;
  navigate: (href: string) => void;
  /** Extra chips rendered after the "Recurring Retainer" badge. */
  badges?: ReactNode;
  /** Tail appended to the "$X every N months" line - included hours, or a matter name. */
  amountSuffix?: ReactNode;
  /** Where "View latest invoice" goes. Omit to hide the link. */
  latestInvoiceHref?: (draft: BillingPlanPeriod) => string | null;
}

export function RecurringRetainerPlanCard({
  plan,
  lawFirmId,
  navigate,
  badges,
  amountSuffix,
  latestInvoiceHref,
}: RecurringRetainerPlanCardProps) {
  const { readyPeriods, latestDraft } = getPlanSummary(plan);
  const invoiceHref = latestDraft && latestInvoiceHref ? latestInvoiceHref(latestDraft) : null;

  return (
    <div
      className="rounded-xl border border-outline bg-surface px-4 py-3 cursor-pointer transition-[border-color,box-shadow] hover:border-accent-border-soft hover:shadow-sm dark:hover:border-accent-border-soft"
      role="button"
      tabIndex={0}
      onClick={() => navigate(getBillingPlanDestination(lawFirmId, plan.id))}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigate(getBillingPlanDestination(lawFirmId, plan.id));
        }
      }}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-on-surface">
              {plan.name || "Evergreen Retainer"}
            </span>
            <StatusBadge variant="success">Recurring Retainer</StatusBadge>
            {badges}
            <StatusBadge variant={billingPlanStatusMeta(plan.status).variant}>
              {billingPlanStatusMeta(plan.status).label}
            </StatusBadge>
          </div>
          <p className="mt-1 text-sm text-on-surface-secondary">
            {formatCurrency(plan.amount)} every {plan.intervalCount} {plan.intervalUnit}
            {plan.intervalCount === 1 ? "" : "s"}
            {amountSuffix}
          </p>
          <p className="mt-1 text-xs text-on-surface-muted">
            {plan.nextRunDate
              ? `Next run ${dayjs(plan.nextRunDate).format("MMM D, YYYY")}`
              : "Next run TBD"}
            {readyPeriods > 0 ? ` • ${readyPeriods} ready to bill` : ""}
            {latestDraft?.generatedInvoiceId ? " • Invoice created" : ""}
          </p>
        </div>
        {invoiceHref ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              navigate(invoiceHref);
            }}
            className="text-sm font-medium text-accent-emphasis transition hover:underline"
          >
            View latest invoice
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A plan's ready-to-bill count and its most recently generated period.
 *
 * `latestDraft` is the period with the newest `periodEndDate`, not the first one
 * found: a `.find()` returns the OLDEST generated period on a long-running
 * retainer, so "View latest invoice" opened an invoice from years back.
 */
export function getPlanSummary(plan: BillingPlan): {
  readyPeriods: number;
  latestDraft?: BillingPlanPeriod;
} {
  const readyPeriods = (plan.periods || []).filter((period) => period.status === "ready_to_bill").length;
  const periodsWithInvoices = (plan.periods || []).filter((period) => period.generatedInvoiceId);
  const latestDraft = periodsWithInvoices.length
    ? periodsWithInvoices.reduce((latest, period) =>
        (period.periodEndDate || "") > (latest.periodEndDate || "") ? period : latest
      )
    : undefined;
  return { readyPeriods, latestDraft };
}
