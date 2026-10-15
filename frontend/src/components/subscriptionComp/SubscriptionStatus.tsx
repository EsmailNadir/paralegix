"use client";

import {
  Crown,
  AlertTriangle,
  Clock,
  CreditCard,
  ExternalLink,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { SubscriptionStatus as SubStatus } from "@/types/subscription";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import { billingStatusMeta } from "@/constants/statusMeta";
import { isTrialing } from "@/lib/plans/billingAccess";
import { formatPlanPrice, intervalAdverb } from "@/lib/plans/planLabels";
import { formatDate as formatDateShared } from "@/lib/utils/dateUtils";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  return formatDateShared(iso, "-");
}

interface UsageBarProps {
  label: string;
  current: number;
  limit: number;
  /** Breakdown shown under the bar when `current` needs explaining. */
  hint?: string;
  formatValue?: (v: number) => string;
}

function UsageBar({
  label,
  current,
  limit,
  hint,
  formatValue = (v) => v.toLocaleString(),
}: UsageBarProps) {
  const isUnlimited = limit === -1;
  const pct = isUnlimited ? 0 : Math.min((current / limit) * 100, 100);
  const isOver = !isUnlimited && current >= limit;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-on-surface-secondary">
          {label}
        </span>
        <span className="text-xs text-on-surface-muted">
          {formatValue(current)} / {isUnlimited ? "Unlimited" : formatValue(limit)}
        </span>
      </div>
      <div className="h-2 bg-surface-alt rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isOver
              ? "bg-red-500"
              : pct > 80
                ? "bg-amber-500"
                : "bg-accent-solid"
          }`}
          style={{ width: isUnlimited ? "0%" : `${pct}%` }}
        />
      </div>
      {hint && (
        <p className="mt-1 text-[11px] text-on-surface-muted">{hint}</p>
      )}
    </div>
  );
}


interface Props {
  status: SubStatus;
  onManagePayment: () => void;
  onCancel: () => void;
  onReactivate: () => void;
  managingPayment?: boolean;
  cancelling?: boolean;
  reactivating?: boolean;
}

export default function SubscriptionStatusCard({
  status,
  onManagePayment,
  onCancel,
  onReactivate,
  managingPayment,
  cancelling,
  reactivating,
}: Props) {
  const billing = billingStatusMeta(status.billingStatus);

  return (
    <div className="rounded-xl border border-outline-subtle p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent-soft flex items-center justify-center">
            <Crown className="w-5 h-5 text-accent-emphasis" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-on-surface">
                {status.planName}
              </h3>
              <StatusBadge variant={billing.variant}>{billing.label}</StatusBadge>
              {status.unlimitedOverride && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400">
                  Unlimited
                </span>
              )}
            </div>
            {status.billingInterval && (
              <p className="text-xs text-on-surface-muted mt-0.5">
                Billed {intervalAdverb(status.billingInterval)}
                {status.pricing?.[status.billingInterval] != null &&
                  ` · ${formatPlanPrice({
                    billingInterval: status.billingInterval,
                    planPriceCents: status.pricing[status.billingInterval],
                  })}`}
                {status.currentPeriodEnd &&
                  ` \u00B7 ${status.cancelAtPeriodEnd ? "Cancels" : "Renews"} ${formatDate(status.currentPeriodEnd)}`}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Alerts */}
      {status.cancelAtPeriodEnd && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Your plan will cancel on {formatDate(status.currentPeriodEnd)}
            </p>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/70 mt-0.5">
              You&apos;ll keep access until then. After that you&apos;ll be on the free Starter plan.
            </p>
          </div>
          <button
            onClick={onReactivate}
            disabled={reactivating}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 dark:hover:bg-amber-500/30 rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
          >
            {reactivating ? (
              <Spinner size={12} />
            ) : (
              <RotateCcw className="w-3 h-3" />
            )}
            Reactivate
          </button>
        </div>
      )}

      {status.billingStatus === "past_due" && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
          <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800 dark:text-red-300">
              Payment failed
            </p>
            <p className="text-xs text-red-700/80 dark:text-red-400/70 mt-0.5">
              Please update your payment method to avoid losing access.
            </p>
          </div>
          <button
            onClick={onManagePayment}
            disabled={managingPayment}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-500/20 hover:bg-red-200 dark:hover:bg-red-500/30 rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
          >
            {managingPayment ? (
              <Spinner size={12} />
            ) : (
              <CreditCard className="w-3 h-3" />
            )}
            Update Payment
          </button>
        </div>
      )}

      {isTrialing(status.billingStatus) && status.trialEndsAt && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-accent-control-ring/20">
          <Clock className="w-4 h-4 text-accent-emphasis flex-shrink-0" />
          <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
            Trial ends on {formatDate(status.trialEndsAt)}.{" "}
            {status.stripeSubscriptionId
              ? "You'll be charged automatically after that."
              : "Choose a plan below to keep access after that."}
          </p>
        </div>
      )}

      {/* Usage */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
          Usage
        </h4>
        <UsageBar
          label="Matters"
          current={status.usage.matters.current}
          limit={status.usage.matters.limit}
        />
        <UsageBar
          label="Members"
          current={status.usage.members.current}
          limit={status.usage.members.limit}
          hint={
            status.usage.members.pendingInvites > 0
              ? `${status.usage.members.activeMembers} joined + ${status.usage.members.pendingInvites} invited`
              : undefined
          }
        />
        <UsageBar
          label="Storage"
          current={status.usage.storage.currentBytes}
          limit={status.usage.storage.limitBytes}
          formatValue={formatBytes}
        />
      </div>

      {/* Actions */}
      {status.stripeSubscriptionId && !status.cancelAtPeriodEnd && (
        <div className="flex items-center gap-3 pt-2 border-t border-outline-subtle">
          <button
            onClick={onManagePayment}
            disabled={managingPayment}
            className="inline-flex items-center gap-2 px-4 py-2 bg-surface hover:bg-surface-hover text-on-surface text-sm font-medium rounded-xl border border-outline-subtle transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
          >
            {managingPayment ? (
              <Spinner size={16} />
            ) : (
              <ExternalLink className="w-4 h-4" />
            )}
            Manage Payment
          </button>
          <button
            onClick={onCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-2 px-4 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium rounded-xl border border-red-200 dark:border-red-500/20 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
          >
            {cancelling ? (
              <Spinner size={16} />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            Cancel Plan
          </button>
        </div>
      )}
    </div>
  );
}
