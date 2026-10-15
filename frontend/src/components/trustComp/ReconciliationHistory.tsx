"use client";

import { useCallback, useState } from "react";
import { Plus, CheckCircle2, AlertCircle, Download } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Dropdown from "@/components/ui/Dropdown";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from "@/components/ui/ListPager";
import { usePermissions } from "@/contexts/PermissionsContext";
import trustService from "@/services/trust.service";
import type { TrustAccount, TrustReconciliation } from "@/types/trust";
import ReconciliationForm from "./ReconciliationForm";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { pdf } from "@react-pdf/renderer";
import ReconciliationReport from "./ReconciliationReport";
import { formatCents } from "@/lib/utils/currency";

interface ReconciliationHistoryProps {
  lawFirmId: string;
  accounts: TrustAccount[];
}

/** Reconciliations shown at once. The reader pages back through the rest. */
const RECONCILIATION_PAGE_SIZE = 20;

export default function ReconciliationHistory({ lawFirmId, accounts }: ReconciliationHistoryProps) {
  const { hasPermission } = usePermissions();
  const canReconcile = hasPermission("trust.reconcile");
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [filterAccountId, setFilterAccountId] = useState<string>("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [page, setPage] = useState(1); // 1-based
  const [rowsPerPage, setRowsPerPageState] = useState(RECONCILIATION_PAGE_SIZE);

  // Narrowing to one account is a different result set, so the current page number
  // no longer points at the same reconciliations.
  function handleFilterChange(value: string) {
    setFilterAccountId(value);
    setPage(1);
  }

  // A different page size re-cuts the history the same way.
  const setRowsPerPage = useCallback((next: number) => {
    setRowsPerPageState(next);
    setPage(1);
  }, []);

  async function handleDownloadPdf(rec: TrustReconciliation) {
    setDownloadingId(rec.id);
    try {
      const account = accounts.find((a) => a.id === rec.trustAccountId);
      const blob = await pdf(
        <ReconciliationReport
          reconciliation={rec}
          accountName={account?.name || "Trust Account"}
        />
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `reconciliation-${rec.reconciliationDate || rec.id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // non-blocking
    } finally {
      setDownloadingId(null);
    }
  }

  // A true page, not a growing window. The previous "load more" raised `limit`
  // against a fixed `offset: 0`, so every click re-fetched everything already on
  // screen plus twenty more - five clicks on a 100-row history read 300 rows. A
  // reconciliation is also a record you look up rather than scroll, so paging is
  // the better fit for reading it as well as for the bandwidth.
  const { data, isLoading, isFetching, refetch } = useQuery<{ reconciliations: TrustReconciliation[]; totalItems: number }>({
    queryKey: ["trustReconciliations", lawFirmId, filterAccountId, page, rowsPerPage],
    queryFn: () =>
      trustService.listReconciliationsPaged(lawFirmId, filterAccountId || undefined, {
        limit: rowsPerPage,
        offset: (page - 1) * rowsPerPage,
      }),
    enabled: !!lawFirmId,
    // Keeps the current page on screen while the next one loads, so the pager can
    // carry its own pending state instead of the list blanking out. Guarded on
    // the firm id so switching firms does not briefly show the previous firm's
    // trust reconciliations under the new firm's chrome.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });
  const reconciliations = data?.reconciliations ?? [];
  const totalItems = data?.totalItems ?? 0;

  return (
    <div className="bg-surface rounded-xl border border-outline-subtle">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-outline-subtle">
        <h3 className="text-sm font-semibold text-on-surface">Reconciliation History</h3>
        <div className="flex items-center gap-2">
          <Dropdown
            value={filterAccountId}
            onChange={handleFilterChange}
            options={[
              { value: "", label: "All Accounts" },
              ...accounts.map((account) => ({
                value: account.id,
                label: account.name,
              })),
            ]}
            className="w-[180px]"
            buttonClassName="px-2 py-1 text-xs bg-input-bg border-input-border"
          />
          {canReconcile && (
            <button
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              <Plus size={14} />
              New Reconciliation
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="px-5 py-6 space-y-3 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-surface-alt rounded" />
          ))}
        </div>
      ) : reconciliations.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-on-surface-muted">
          No reconciliations yet.
        </div>
      ) : (
        <div className="divide-y divide-outline-subtle">
          {reconciliations.map((rec) => {
            const account = accounts.find((a) => a.id === rec.trustAccountId);
            return (
              <div key={rec.id} className="px-5 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {rec.isReconciled ? (
                      <CheckCircle2 size={16} className="text-emerald-500" />
                    ) : (
                      <AlertCircle size={16} className="text-amber-500" />
                    )}
                    <div>
                      <p className="text-sm font-medium text-on-surface">
                        {formatDateOnly(rec.reconciliationDate, undefined, "N/A")}
                      </p>
                      <p className="text-xs text-on-surface-muted">
                        {account?.name || "Unknown Account"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <p className={`text-xs font-semibold ${rec.isReconciled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                        {rec.isReconciled ? "Reconciled" : `Discrepancy: ${formatCents(rec.discrepancyCents)}`}
                      </p>
                      <p className="text-xs text-on-surface-muted mt-0.5">
                        Bank: {formatCents(rec.bankStatementBalanceCents)} | Book: {formatCents(rec.bookBalanceCents)} | Ledger: {formatCents(rec.clientLedgerTotalCents)}
                      </p>
                    </div>
                    <Tooltip title="Download PDF Report" enterDelay={300}>
                      <span>
                        <button aria-label="Download PDF Report"
                          onClick={() => handleDownloadPdf(rec)}
                          disabled={downloadingId === rec.id}
                          className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50"
                        >
                          <Download size={14} />
                        </button>
                      </span>
                    </Tooltip>
                  </div>
                </div>
                {rec.notes && (
                  <p className="text-xs text-on-surface-secondary mt-1.5 pl-7">{rec.notes}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pagerWillRender(totalItems) && (
        <div className="px-5 py-3 border-t border-outline-subtle">
          <ListPager
            page={page}
            totalPages={Math.max(1, Math.ceil(totalItems / Math.max(1, rowsPerPage)))}
            total={totalItems}
            rowsPerPage={rowsPerPage}
            onPageChange={setPage}
            onRowsPerPageChange={setRowsPerPage}
            rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
            busy={isFetching}
            serverPaged
          />
        </div>
      )}

      <ReconciliationForm
        open={showForm}
        lawFirmId={lawFirmId}
        accounts={accounts}
        onClose={() => setShowForm(false)}
        onSaved={() => {
          setShowForm(false);
          refetch();
          // The Trust Overview tile reads a separate query rooted at
          // "latestReconciliation" (see trust/page.tsx) - invalidate it too so a
          // new reconciliation shows up there without a full page reload.
          void queryClient.invalidateQueries({ queryKey: ["latestReconciliation", lawFirmId] });
        }}
      />
    </div>
  );
}
