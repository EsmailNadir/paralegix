"use client";

import React from "react";
import { ArrowRight, CheckCircle2, Landmark, Users, Wallet } from "lucide-react";
import type { ClientTrustBalance, TrustAccount, TrustReconciliation } from "@/types/trust";
import { formatCents } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";

interface TrustOverviewProps {
  accounts: TrustAccount[];
  /** Per-(client, account) balances, used for the client-held headline. */
  balances?: ClientTrustBalance[];
  latestReconciliation?: TrustReconciliation | null;
  loading?: boolean;
  onViewAccounts: () => void;
  onViewTransactions: () => void;
  onViewReconciliation: () => void;
}

/**
 * The four headline numbers above the Trust overview, built to the same tile
 * language as the billing workbench: a tinted icon square, a large figure, and a
 * subtitle that says where the tile goes.
 */
export default function TrustOverview({
  accounts,
  balances = [],
  latestReconciliation,
  loading,
  onViewAccounts,
  onViewTransactions,
  onViewReconciliation,
}: TrustOverviewProps) {
  const totalBalance = accounts.reduce((sum, a) => sum + (a.bookBalance || 0), 0);
  const activeAccounts = accounts.filter((a) => a.status === "active").length;
  const clientsHolding = new Set(balances.filter((b) => b.balanceCents !== 0).map((b) => b.clientId)).size;

  const reconciled = latestReconciliation?.isReconciled;

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5 sm:gap-3">
      <KpiTile
        icon={Landmark}
        iconTint="bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis"
        label="Total trust held"
        loading={loading}
        value={formatCents(totalBalance)}
        subtitle="Across all trust accounts"
        onClick={onViewAccounts}
      />
      <KpiTile
        icon={Wallet}
        iconTint="bg-blue-500/10 text-accent-emphasis dark:bg-blue-500/15 dark:text-accent-emphasis"
        label="Trust accounts"
        loading={loading}
        value={String(accounts.length)}
        subtitle={`${activeAccounts} active`}
        onClick={onViewAccounts}
      />
      <KpiTile
        icon={Users}
        iconTint="bg-teal-500/10 text-teal-600 dark:bg-teal-500/15 dark:text-teal-400"
        label="Clients with funds"
        loading={loading}
        value={String(clientsHolding)}
        subtitle="Holding a trust balance"
        onClick={onViewTransactions}
      />
      <KpiTile
        icon={CheckCircle2}
        iconTint={
          reconciled
            ? "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
            : "bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
        }
        label="Last reconciliation"
        loading={loading}
        value={
          latestReconciliation
            ? formatDateOnly(latestReconciliation.reconciliationDate, undefined, "Never")
            : "Never"
        }
        valueClass={latestReconciliation ? undefined : "text-amber-600 dark:text-amber-400"}
        subtitle={
          latestReconciliation
            ? reconciled
              ? "Balanced"
              : "Out of balance"
            : "Never reconciled"
        }
        onClick={onViewReconciliation}
      />
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
  loading?: boolean;
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
        <div className="h-8 w-24 bg-surface-alt rounded animate-pulse" />
      ) : (
        <p className={`text-2xl font-bold tabular-nums ${valueClass || "text-on-surface"}`}>
          {value}
        </p>
      )}

      <p className="text-[11px] sm:text-xs text-on-surface-muted mt-1 sm:mt-1.5 inline-flex items-center gap-1">
        <span className="truncate">{subtitle}</span>
        <ArrowRight size={12} className="shrink-0 opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
      </p>
    </button>
  );
}
