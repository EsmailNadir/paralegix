"use client";

import { useCallback, useState, type ReactNode } from "react";
import Tooltip from "@/components/ui/Tooltip";
import { Plus, Ban, BookOpen, Download, CreditCard, Wallet } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import ClearFiltersButton from "@/components/ui/ClearFiltersButton";
import Dropdown from "@/components/ui/Dropdown";
import ListToolbar from "@/components/ui/ListToolbar";
import ListView, { type ListRow } from "@/components/ui/ListView";
import StatusBadge from "@/components/ui/StatusBadge";
import ErrorNotification from "@/components/ErrorNotification";
import { STATUS_VARIANTS } from "@/constants/statusMeta";
import type { TrustTransaction, TrustAccount, TransactionFilters, TrustTransactionType } from "@/types/trust";
import { TRUST_TRANSACTION_TYPES } from "./trustTransactionTypes";
import TransactionForm from "./TransactionForm";
import VoidTransactionModal from "./VoidTransactionModal";
import MatterLedgerModal from "./MatterLedgerModal";
import RequestDepositModal from "./RequestDepositModal";
import { usePermissions } from "@/contexts/PermissionsContext";
import trustService from "@/services/trust.service";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { formatCents } from "@/lib/utils/currency";
import { toCsv, downloadCsv } from "@/lib/utils/csv";
import Button from "@/components/ui/Button";

const capitalize = (s?: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const centsToDollars = (cents: number) => (cents / 100).toFixed(2);

/** CSV export batch size. Matches the transactions endpoint's maximum `limit`. */
const EXPORT_PAGE_SIZE = 200;
/** Hard stop on the export loop, so an inconsistent total can't spin forever. */
const MAX_EXPORT_PAGES = 40;

const CSV_COLUMNS = [
  { key: "date", header: "Date" },
  { key: "type", header: "Type" },
  { key: "client", header: "Client" },
  { key: "matter", header: "Matter" },
  { key: "account", header: "Account" },
  { key: "description", header: "Description" },
  { key: "reference", header: "Reference" },
  { key: "amount", header: "Amount" },
  { key: "status", header: "Status" },
  { key: "cleared", header: "Cleared" },
] as const;

interface TransactionListProps {
  /** The current server page of transactions, not the whole filtered set. */
  transactions: TrustTransaction[];
  /** Total matching the active filters across every page, from the server. */
  totalItems: number;
  accounts: TrustAccount[];
  loading?: boolean;
  fetching?: boolean;
  lawFirmId: string;
  filters: TransactionFilters;
  onFiltersChange: (filters: TransactionFilters) => void;
  /** 1-based. */
  page: number;
  onPageChange: (page: number) => void;
  rowsPerPage: number;
  onRowsPerPageChange: (rowsPerPage: number) => void;
  /** Active filters without the paging window, so the CSV export can re-request the full set. */
  listParams: TransactionFilters;
  onRefresh: () => void;
}

export default function TransactionList({
  transactions,
  totalItems,
  accounts,
  loading,
  fetching,
  lawFirmId,
  filters,
  onFiltersChange,
  page,
  onPageChange,
  rowsPerPage,
  onRowsPerPageChange,
  listParams,
  onRefresh,
}: TransactionListProps) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("trust.manage");
  const [showForm, setShowForm] = useState(false);
  const [showDeposit, setShowDeposit] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidingTxn, setVoidingTxn] = useState<TrustTransaction | null>(null);
  const [ledgerMatter, setLedgerMatter] = useState<{ matterId: string; matterName?: string } | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  // CSV export covers the WHOLE filtered result set, not just the page on screen.
  // The list holds a single server page, so the export re-requests the same
  // filters in backend-max windows and concatenates them.
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Every key the parent hands over is an applied server filter (the paging
  // window is held separately), so their count is what the clear control shows.
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const handleExportCsv = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const collected: TrustTransaction[] = [];
      let truncated = false;
      for (let pageNumber = 1; pageNumber <= MAX_EXPORT_PAGES; pageNumber += 1) {
        const { transactions: batch, totalItems: total } = await trustService.listTransactionsPaged(
          lawFirmId,
          {
            ...listParams,
            limit: EXPORT_PAGE_SIZE,
            offset: (pageNumber - 1) * EXPORT_PAGE_SIZE,
          },
        );
        collected.push(...batch);
        if (batch.length < EXPORT_PAGE_SIZE || collected.length >= total) break;
        // Reaching the cap with rows still unfetched means the file is short of
        // what the filters actually match. Say so, rather than handing over a
        // partial export that looks complete.
        if (pageNumber === MAX_EXPORT_PAGES) truncated = true;
      }

      const rows = collected.map((txn) => ({
        date: formatDateOnly(txn.date),
        type: capitalize(txn.type),
        client: txn.clientName || "",
        matter: txn.matterName || "",
        account: txn.trustAccountName || "",
        description: txn.description || "",
        reference: txn.referenceNumber || "",
        amount: centsToDollars(txn.amountCents),
        status: capitalize(txn.status),
        cleared: txn.clearedAt ? "Yes" : "No",
      }));
      downloadCsv("trust-transactions.csv", toCsv(rows, [...CSV_COLUMNS]));

      if (truncated) {
        setExportNotice(
          `Export stopped at the first ${collected.length} transactions. Narrow the filters to export the rest.`,
        );
      }
    } catch (e) {
      setExportNotice(e instanceof Error ? e.message : "Failed to export transactions");
    } finally {
      setExporting(false);
    }
  }, [exporting, lawFirmId, listParams]);

  // Maps a transaction to its card content for ListView: the coloured type tile
  // and the entry's own description on the title line, its state beside that, and
  // the type/date/client/matter/account/reference trail underneath. The tile's
  // colour and the sign on the amount already say which way the money went, so
  // the type word rides the muted line rather than taking a chip of its own.
  const renderRow = useCallback((txn: TrustTransaction): ListRow => {
    const config = TRUST_TRANSACTION_TYPES[txn.type];
    const Icon = config.icon;
    const isVoid = txn.status === "void";
    const dim = isVoid ? "opacity-50" : "";
    // A voided entry keeps its shape but loses its colour: it is no longer money
    // that moved, so it should not read as loudly as one that did.
    const tone = STATUS_VARIANTS[isVoid ? "neutral" : config.variant];

    // Built as nodes rather than a joined string because the matter opens its
    // ledger, so that one segment is a button.
    const metaParts: ReactNode[] = [config.label];
    if (txn.date) metaParts.push(formatDateOnly(txn.date));
    if (txn.clientName) metaParts.push(txn.clientName);
    if (txn.matterName) {
      metaParts.push(
        txn.matterId ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setLedgerMatter({ matterId: txn.matterId!, matterName: txn.matterName });
              setLedgerOpen(true);
            }}
            className="inline-flex items-center gap-1 align-baseline text-accent-emphasis hover:underline cursor-pointer dark:text-accent-emphasis"
          >
            <BookOpen size={11} />
            {txn.matterName}
          </button>
        ) : (
          txn.matterName
        ),
      );
    }
    if (txn.trustAccountName) metaParts.push(txn.trustAccountName);
    if (txn.referenceNumber) metaParts.push(`Ref: ${txn.referenceNumber}`);

    return {
      title: (
        <span className={`inline-flex min-w-0 items-center gap-2.5 ${dim}`}>
          <Tooltip title={isVoid ? `${config.label} (voided)` : config.label} enterDelay={300}>
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone.tint} ${tone.text}`}>
              {isVoid ? <Ban size={16} /> : <Icon size={16} />}
            </span>
          </Tooltip>
          <span className="truncate">{txn.description || config.label}</span>
        </span>
      ),
      badges: (
        <>
          {isVoid && <StatusBadge variant="danger">Void</StatusBadge>}
          {!isVoid && txn.status === "completed" && (
            txn.clearedAt ? (
              <Tooltip title={`Cleared ${new Date(txn.clearedAt).toLocaleDateString()}`} enterDelay={300}>
                <span className="inline-flex">
                  <StatusBadge variant="success">Cleared</StatusBadge>
                </span>
              </Tooltip>
            ) : (
              <StatusBadge variant="warning">Outstanding</StatusBadge>
            )
          )}
        </>
      ),
      meta: (
        <span className={dim}>
          {metaParts.map((part, i) => (
            <span key={i}>
              {i > 0 && <span aria-hidden className="px-1.5 opacity-50">•</span>}
              {part}
            </span>
          ))}
        </span>
      ),
      right: (
        <p
          className={`text-sm font-semibold tabular-nums ${
            isVoid
              ? "text-on-surface-muted line-through"
              : txn.type === "deposit"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
          }`}
        >
          {txn.type === "deposit" ? "+" : "-"}
          {formatCents(txn.amountCents)}
        </p>
      ),
    };
  }, []);

  // Void is the only per-row action, and voided rows have nothing left to do.
  const rowActions = useCallback((txn: TrustTransaction) => {
    if (!canManage || txn.status === "void") return null;
    return (
      <ActionIconButton
        label="Void transaction"
        onClick={() => { setVoidingTxn(txn); setVoidOpen(true); }}
        tone="danger"
      >
        <Ban size={14} />
      </ActionIconButton>
    );
  }, [canManage]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Transactions</h3>
          <p className="text-xs text-on-surface-muted mt-0.5">
            Every deposit, disbursement, transfer and refund across your trust accounts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip title="Export all matching transactions to CSV" enterDelay={300}>
            <span>
              <Button
                type="secondary"
                size="compact"
                onClick={handleExportCsv}
                disabled={totalItems === 0 || exporting}
                icon={<Download size={14} />}
              >
                {exporting ? "Exporting..." : "Export CSV"}
              </Button>
            </span>
          </Tooltip>
          {canManage && (
            <Button
              type="secondary"
              size="compact"
              onClick={() => setShowDeposit(true)}
              icon={<CreditCard size={14} />}
            >
              Request deposit
            </Button>
          )}
          {canManage && (
            <Button
              size="compact"
              onClick={() => setShowForm(true)}
              icon={<Plus size={14} strokeWidth={2.2} />}
            >
              Record Transaction
            </Button>
          )}
        </div>
      </div>

      {/* Export outcome (a failure, or a file cut short by the page cap) gets its
          own dismissible banner, separate from the list's load errors. */}
      <ErrorNotification error={exportNotice} onClose={() => setExportNotice(null)} />

      <ListToolbar>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Dropdown
            label="Account"
            value={filters.trustAccountId || ""}
            onChange={(value) => onFiltersChange({ ...filters, trustAccountId: value || undefined })}
            options={[
              { value: "", label: "All accounts" },
              ...accounts.map((account) => ({ value: account.id, label: account.name })),
            ]}
            className="text-sm"
          />
          <Dropdown
            label="Type"
            value={filters.type || ""}
            onChange={(value) => onFiltersChange({ ...filters, type: (value || undefined) as TrustTransactionType | undefined })}
            options={[
              { value: "", label: "All types" },
              { value: "deposit", label: "Deposit" },
              { value: "withdrawal", label: "Withdrawal" },
              { value: "transfer", label: "Transfer" },
              { value: "refund", label: "Refund" },
            ]}
            className="text-sm"
          />
          <Dropdown
            label="Status"
            value={filters.status || ""}
            onChange={(value) => onFiltersChange({ ...filters, status: (value || undefined) as any })}
            options={[
              { value: "", label: "All statuses" },
              { value: "completed", label: "Completed" },
              { value: "void", label: "Void" },
            ]}
            className="text-sm"
          />
        </div>
        {activeFilterCount > 0 && (
          <div className="mt-3 flex justify-end">
            <ClearFiltersButton count={activeFilterCount} onClear={() => onFiltersChange({})} />
          </div>
        )}
      </ListToolbar>

      {/* Server-driven pagination: the list renders just the current server page
          and calls back to re-query on page/page-size changes. No sort controls,
          because the endpoint's ordering is fixed (transaction date descending). */}
      <ListView<TrustTransaction>
        rows={transactions}
        loading={loading}
        fetching={fetching}
        getRowId={(txn) => txn.id}
        renderRow={renderRow}
        rowActions={rowActions}
        // The count line doubles as the row the "Updating results…" indicator
        // rides on, so a filter change is acknowledged without pushing the list
        // down the page.
        leading={
          <p className="text-xs text-on-surface-muted">
            {totalItems} transaction{totalItems === 1 ? "" : "s"}
            {activeFilterCount > 0 ? " matching your filters" : ""}
          </p>
        }
        paginationMode="server"
        page={page - 1}
        pageSize={rowsPerPage}
        rowCount={totalItems}
        onPageChange={(p) => onPageChange(p + 1)}
        onPageSizeChange={onRowsPerPageChange}
        pageSizeOptions={[10, 25, 50]}
        defaultPageSize={rowsPerPage}
        reserveFullPage
        emptyIcon={<Wallet size={40} />}
        emptyTitle={activeFilterCount > 0 ? "No matching transactions" : "No transactions yet"}
        emptyMessage={
          activeFilterCount > 0
            ? "Try adjusting the account, type, or status filters."
            : "Record a deposit or disbursement and it will appear on this ledger."
        }
      />

      <TransactionForm
        open={showForm}
        lawFirmId={lawFirmId}
        accounts={accounts}
        onClose={() => setShowForm(false)}
        onSaved={() => { setShowForm(false); onRefresh(); }}
      />

      <RequestDepositModal
        open={showDeposit}
        lawFirmId={lawFirmId}
        accounts={accounts}
        onClose={() => setShowDeposit(false)}
      />

      <VoidTransactionModal
        open={voidOpen}
        lawFirmId={lawFirmId}
        transaction={voidingTxn}
        onClose={() => setVoidOpen(false)}
        onVoided={() => { setVoidOpen(false); onRefresh(); }}
      />

      <MatterLedgerModal
        open={ledgerOpen}
        lawFirmId={lawFirmId}
        matterId={ledgerMatter?.matterId ?? null}
        matterName={ledgerMatter?.matterName}
        onClose={() => setLedgerOpen(false)}
      />
    </div>
  );
}
