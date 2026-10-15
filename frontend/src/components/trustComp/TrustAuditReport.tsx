"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ShieldCheck, TriangleAlert } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ListView, { type ListRow } from "@/components/ui/ListView";
import StatusBadge from "@/components/ui/StatusBadge";
import trustService from "@/services/trust.service";
import type { TrustAuditAccount, TrustAuditReport as TrustAuditReportData } from "@/types/trust";
import { TRUST_ACCOUNT_TYPE_LABELS } from "@/types/trust";
import { formatCents, centsToDollars } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { toCsv, downloadCsv } from "@/lib/utils/csv";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";

interface TrustAuditReportProps {
  lawFirmId: string;
}

/**
 * The firm-wide three-way position, across every trust account at once.
 *
 * A bar examination does not ask for one client's statement or one month's
 * reconciliation. It asks the firm to show that the bank balance, the book
 * balance and the sum of every client's ledger agree, and that no client is
 * negative inside a pooled account whose total looks healthy. Both of those
 * were previously answerable only one account and one client at a time.
 */
export default function TrustAuditReport({ lawFirmId }: TrustAuditReportProps) {
  const { data, isLoading, error } = useQuery<TrustAuditReportData>({
    queryKey: ["trustAuditReport", lawFirmId],
    queryFn: () => trustService.getAuditReport(lawFirmId),
    enabled: !!lawFirmId,
  });

  const accounts = useMemo(() => data?.accounts ?? [], [data]);

  function handleExportCsv() {
    if (!data) return;
    const rows = data.accounts.map((a) => ({
      account: a.name,
      type: TRUST_ACCOUNT_TYPE_LABELS[a.accountType] ?? a.accountType,
      bank: a.bankName || "",
      last4: a.accountNumberLast4 || "",
      bookBalance: centsToDollars(a.bookBalanceCents),
      ledgerBalance: centsToDollars(a.ledgerBalanceCents),
      clientLedgerTotal: centsToDollars(a.clientLedgerTotalCents),
      drift: centsToDollars(a.driftCents),
      negativeClients: String(a.negativeClientBalances.length),
      outstanding: String(a.outstandingCount),
      outstandingNet: centsToDollars(a.outstandingNetCents),
      lastReconciled: a.lastReconciliationDate ? formatDateOnly(a.lastReconciliationDate) : "Never",
      nextDue: a.nextReconciliationDueDate ? formatDateOnly(a.nextReconciliationDueDate) : "",
      status: a.balanced ? "Balanced" : "Needs review",
    }));
    const csv = toCsv(rows, [
      { key: "account", header: "Account" },
      { key: "type", header: "Type" },
      { key: "bank", header: "Bank" },
      { key: "last4", header: "Last 4" },
      { key: "bookBalance", header: "Book Balance" },
      { key: "ledgerBalance", header: "Ledger Balance" },
      { key: "clientLedgerTotal", header: "Client Ledger Total" },
      { key: "drift", header: "Drift" },
      { key: "negativeClients", header: "Negative Client Balances" },
      { key: "outstanding", header: "Outstanding Items" },
      { key: "outstandingNet", header: "Outstanding Net" },
      { key: "lastReconciled", header: "Last Reconciled" },
      { key: "nextDue", header: "Next Due" },
      { key: "status", header: "Status" },
    ]);
    downloadCsv(`trust-audit-report-${data.generatedAt.slice(0, 10)}.csv`, csv);
  }

  const renderRow = useCallback((account: TrustAuditAccount): ListRow => {
    const negatives = account.negativeClientBalances;
    const typeLabel = TRUST_ACCOUNT_TYPE_LABELS[account.accountType] ?? account.accountType;
    const lastReconciled = account.lastReconciliationDate
      ? `Reconciled through ${formatDateOnly(account.lastReconciliationDate)}`
      : "Never reconciled";

    return {
      title: account.name,
      badges: (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {account.balanced ? (
            <StatusBadge variant="success">Balanced</StatusBadge>
          ) : (
            <StatusBadge variant="danger">Needs review</StatusBadge>
          )}
          {negatives.length > 0 && (
            <Tooltip
              title={negatives
                .map((c) => `${c.clientName}: ${formatCents(c.balanceCents)}`)
                .join(", ")}
              enterDelay={300}
            >
              <span className="inline-flex">
                <StatusBadge variant="danger">
                  {negatives.length} negative client{negatives.length === 1 ? "" : "s"}
                </StatusBadge>
              </span>
            </Tooltip>
          )}
          {account.driftCents !== 0 && (
            <Tooltip
              title={`The stored book balance is ${formatCents(account.driftCents)} away from the ledger it should mirror.`}
              enterDelay={300}
            >
              <span className="inline-flex">
                <StatusBadge variant="warning">Drift {formatCents(account.driftCents)}</StatusBadge>
              </span>
            </Tooltip>
          )}
          {account.reconciliationOverdue && (
            <Tooltip
              title={
                account.nextReconciliationDueDate
                  ? `Due ${formatDateOnly(account.nextReconciliationDueDate)}`
                  : "This account has never been reconciled."
              }
              enterDelay={300}
            >
              <span className="inline-flex">
                <StatusBadge variant="warning">Reconciliation overdue</StatusBadge>
              </span>
            </Tooltip>
          )}
          {account.outstandingCount > 0 && (
            <Tooltip
              title={`Net ${formatCents(account.outstandingNetCents)} has not yet cleared the bank.`}
              enterDelay={300}
            >
              <span className="inline-flex">
                <StatusBadge variant="neutral">
                  {account.outstandingCount} outstanding
                </StatusBadge>
              </span>
            </Tooltip>
          )}
        </span>
      ),
      meta: `${typeLabel} · ${lastReconciled} · ${account.clientBalances.length} client${account.clientBalances.length === 1 ? "" : "s"}`,
      right: (
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums text-on-surface">
            {formatCents(account.bookBalanceCents)}
          </p>
          <p className="text-[11px] text-on-surface-muted tabular-nums">
            ledger {formatCents(account.ledgerBalanceCents)} · clients{" "}
            {formatCents(account.clientLedgerTotalCents)}
          </p>
        </div>
      ),
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Compliance Overview</h3>
          <p className="text-xs text-on-surface-muted mt-0.5">
            Every trust account&apos;s three figures side by side, with the balances an examiner
            looks for first.
          </p>
        </div>
        <button
          onClick={handleExportCsv}
          disabled={!data}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-on-surface bg-surface-alt border border-outline-subtle hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          <Download size={13} />
          Export CSV
        </button>
      </div>

      <ErrorNotification
        error={error ? getErrorMessage(error, "Could not load the audit report") : null}
        compact
      />

      {data && (
        <div className="bg-surface rounded-xl border border-outline-subtle px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <div>
              <p className="text-[11px] font-medium text-on-surface-secondary">Total held in trust</p>
              <p className="text-lg font-semibold tabular-nums text-on-surface">
                {formatCents(data.totals.bookBalanceCents)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-on-surface-secondary">Sum of client ledgers</p>
              <p className="text-lg font-semibold tabular-nums text-on-surface">
                {formatCents(data.totals.clientLedgerTotalCents)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {data.totals.balanced ? (
                <>
                  <ShieldCheck size={16} className="text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    Every account balances
                  </span>
                </>
              ) : (
                <>
                  <TriangleAlert size={16} className="text-red-600 dark:text-red-400" />
                  <span className="text-xs font-medium text-red-600 dark:text-red-400">
                    One or more accounts need review
                  </span>
                </>
              )}
            </div>
          </div>
          <p className="text-[11px] text-on-surface-muted mt-3">
            Records before {formatDateOnly(data.retentionCutoffDate)} fall outside the firm&apos;s{" "}
            {data.retentionYears}-year retention period.
          </p>
        </div>
      )}

      <ListView<TrustAuditAccount>
        rows={accounts}
        loading={isLoading}
        getRowId={(account) => account.trustAccountId}
        renderRow={renderRow}
        sortColumns={[
          {
            label: "Balance",
            value: "balance",
            defaultDir: "desc",
            compare: (a, b) => a.bookBalanceCents - b.bookBalanceCents,
          },
          {
            label: "Account",
            value: "account",
            compare: (a, b) => (a.name || "").localeCompare(b.name || ""),
          },
        ]}
        defaultPageSize={10}
        pageSizeOptions={[10, 25, 50]}
        emptyIcon={<ShieldCheck size={40} />}
        emptyTitle="No trust accounts"
        emptyMessage="Add a trust account and its compliance position will appear here."
      />
    </div>
  );
}
