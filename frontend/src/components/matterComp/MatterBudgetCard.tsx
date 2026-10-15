"use client";

import { Pencil } from "lucide-react";
import type { Matter } from "@/types";
import { formatCents as fmtMoney } from "@/lib/utils/currency";

const BILLING_METHOD_LABELS: Record<string, string> = {
  hourly: "Hourly",
  flat: "Flat Fee",
  contingency: "Contingency",
  pro_bono: "Pro Bono",
};

/**
 * Budget burn-down for a matter: total invoiced-to-date against the matter's
 * budget cap, with the billing method and (for contingency matters) the agreed
 * percentage. When no budget is set, only the billing summary is shown.
 */
export default function MatterBudgetCard({
  matter,
  className = "",
  onEdit,
}: {
  matter: Matter;
  className?: string;
  onEdit?: () => void;
}) {
  const budgetCents = matter.budgetCents ?? null;
  const billedCents = matter.billedTotalCents ?? 0;
  const method = matter.billingMethod || "hourly";

  const hasBudget = budgetCents != null && budgetCents > 0;
  const pct = hasBudget ? Math.min(100, Math.round((billedCents / budgetCents!) * 100)) : 0;
  const over = hasBudget && billedCents > budgetCents!;
  const nearing = hasBudget && !over && pct >= 80;

  const barColor = over
    ? "bg-red-500"
    : nearing
      ? "bg-amber-500"
      : "bg-accent-selection";

  return (
    <div className={`bg-surface rounded-lg border border-outline p-5 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h4 className="text-sm font-semibold text-on-surface">Budget &amp; Billing</h4>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2 py-1 rounded-md bg-surface-alt border border-outline-subtle text-on-surface-secondary font-medium">
            {BILLING_METHOD_LABELS[method] || method}
          </span>
          {method === "contingency" && matter.contingencyPercent != null && (
            <span className="px-2 py-1 rounded-md bg-surface-alt border border-outline-subtle text-on-surface-secondary font-medium">
              {matter.contingencyPercent}%
            </span>
          )}
          {matter.isBillable === false && (
            <span className="px-2 py-1 rounded-md bg-surface-alt border border-outline-subtle text-on-surface-muted font-medium">
              Non-billable
            </span>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-md border border-outline bg-surface px-2 py-1 font-medium text-accent-emphasis transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:bg-blue-50 hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:bg-blue-950/30 dark:hover:text-accent-emphasis-hover"
            >
              <Pencil size={12} />
              Edit billing
            </button>
          )}
        </div>
      </div>

      {hasBudget ? (
        <>
          <div className="flex items-end justify-between mb-2">
            <div>
              <span className="text-2xl font-bold text-on-surface">{fmtMoney(billedCents)}</span>
              <span className="text-sm text-on-surface-secondary"> billed of {fmtMoney(budgetCents!)}</span>
            </div>
            <span className={`text-sm font-semibold ${over ? "text-red-600 dark:text-red-400" : nearing ? "text-amber-600 dark:text-amber-400" : "text-on-surface-secondary"}`}>
              {pct}%
            </span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-surface-alt overflow-hidden">
            <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
          </div>
          <p className={`mt-2 text-xs ${over ? "text-red-600 dark:text-red-400" : "text-on-surface-muted"}`}>
            {over
              ? `Over budget by ${fmtMoney(billedCents - budgetCents!)}`
              : `${fmtMoney(Math.max(0, budgetCents! - billedCents))} remaining`}
            {matter.budgetIncludesExpenses === false && " (fees only, excludes expenses)"}
          </p>
        </>
      ) : (
        <p className="text-sm text-on-surface-muted">
          No budget set. {fmtMoney(billedCents)} invoiced to date.
        </p>
      )}
    </div>
  );
}
