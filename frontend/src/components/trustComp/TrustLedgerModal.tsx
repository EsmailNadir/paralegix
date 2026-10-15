"use client";

import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS, pagerWillRender } from "@/components/ui/ListPager";
import type { PagedTrustLedger } from "@/hooks/trustHooks/usePagedTrustLedger";
import { formatCents } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";
import { STATUS_VARIANTS } from "@/constants/statusMeta";
import { TRUST_TRANSACTION_TYPES } from "./trustTransactionTypes";

/** Tint-chip shape for the ledger's type and void chips. */
const CHIP_CLS = "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold";

interface TrustLedgerModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One page of the ledger, from `useClientLedger` or `useMatterLedger`. */
  ledger: PagedTrustLedger;
  /** The party's balance endpoint response, which sums every transaction in SQL. */
  balance?: { totalBalanceCents: number; accountBalances: { balanceCents: number }[] };
  emptyMessage: string;
  /** Header controls beside the close button, shown only once the ledger has rows. */
  headerActions?: ReactNode;
  /** Rendered between the header and the table, e.g. an export error. */
  banner?: ReactNode;
}

/**
 * The trust ledger dialog shared by a client and a matter: a header with the
 * current balance, then the ledger newest first, one server page at a time.
 */
export default function TrustLedgerModal({
  open,
  onClose,
  title,
  ledger,
  balance,
  emptyMessage,
  headerActions,
  banner,
}: TrustLedgerModalProps) {
  const titleId = useId();
  const {
    transactions,
    totalItems,
    loading,
    fetching,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    totalPages,
  } = ledger;

  // The ledger can span multiple trust accounts. A single cross-account running
  // total is meaningless (it intermixes balances from separate accounts), so the
  // per-row balance uses the account-scoped snapshot the backend stored at insert
  // time (`clientBalanceAfter`), and we surface the account column when the
  // party has funds in more than one account.
  //
  // The header total comes from the balance endpoint, which sums EVERY
  // transaction in SQL. Adding up the rows on screen would report one page of an
  // append-only ledger as the balance.
  const currentBalance = balance?.totalBalanceCents ?? 0;
  const multiAccount = (balance?.accountBalances ?? []).filter((a) => a.balanceCents !== 0).length > 1;
  // Already newest-first: the hook asks the server for descending pages, so page
  // one is the most recent activity across the whole ledger.
  const orderedTxns = transactions;

  const closeButton = (
    <button
      onClick={onClose}
      aria-label="Close"
      className="p-1.5 rounded-lg text-on-surface-muted hover:bg-surface-alt transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
    >
      <X size={16} />
    </button>
  );

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="3xl"
      className="rounded-2xl border border-outline shadow-2xl relative"
      showClose={false}
      labelledBy={titleId}
      bodyClassName={null}
    >
          <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
            <div>
              <h2 id={titleId} className="text-base font-semibold text-on-surface">
                {title}
              </h2>
              {!loading && (
                <p className="text-xs text-on-surface-muted mt-0.5">
                  Current balance: {formatCents(currentBalance)}
                </p>
              )}
            </div>
            {headerActions === undefined ? (
              closeButton
            ) : (
              <div className="flex items-center gap-1.5">
                {!loading && orderedTxns.length > 0 && headerActions}
                {closeButton}
              </div>
            )}
          </div>

          {banner}

          <div className="overflow-y-auto overflow-x-hidden styled-scrollbar flex-1">
            {loading ? (
              <div className="px-6 py-6 space-y-3 animate-pulse">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-10 bg-surface-alt rounded" />
                ))}
              </div>
            ) : orderedTxns.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-on-surface-muted">
                {emptyMessage}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface z-10">
                    <tr className="border-b border-outline-subtle">
                      <th className="px-6 py-2.5 text-left text-xs font-medium text-on-surface-muted">Date</th>
                      <th className="px-3 py-2.5 text-left text-xs font-medium text-on-surface-muted">Type</th>
                      {multiAccount && (
                        <th className="px-3 py-2.5 text-left text-xs font-medium text-on-surface-muted">Account</th>
                      )}
                      <th className="px-3 py-2.5 text-left text-xs font-medium text-on-surface-muted">Description</th>
                      <th className="px-3 py-2.5 text-left text-xs font-medium text-on-surface-muted">Ref #</th>
                      <th className="px-3 py-2.5 text-right text-xs font-medium text-on-surface-muted">Amount</th>
                      <th className="px-6 py-2.5 text-right text-xs font-medium text-on-surface-muted">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-subtle">
                    {orderedTxns.map((txn) => {
                      const config = TRUST_TRANSACTION_TYPES[txn.type];
                      const Icon = config.icon;
                      const isVoid = txn.status === "void";
                      // A voided entry keeps its shape but loses its colour: it is
                      // no longer money that moved.
                      const tone = STATUS_VARIANTS[isVoid ? "neutral" : config.variant];
                      return (
                        <tr key={txn.id} className={isVoid ? "opacity-40" : ""}>
                          <td className="px-6 py-2.5 text-xs text-on-surface whitespace-nowrap">
                            {formatDateOnly(txn.date, undefined, "-")}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <span className={`${CHIP_CLS} ${tone.tint} ${tone.text}`}>
                                <Icon size={12} />
                                {config.label}
                              </span>
                              {isVoid && (
                                <span className={`${CHIP_CLS} ${STATUS_VARIANTS.danger.tint} ${STATUS_VARIANTS.danger.text}`}>
                                  Void
                                </span>
                              )}
                            </div>
                          </td>
                          {multiAccount && (
                            <td className="px-3 py-2.5 text-xs text-on-surface-secondary max-w-[140px] truncate">
                              {txn.trustAccountName || "-"}
                            </td>
                          )}
                          <td className="px-3 py-2.5 text-xs text-on-surface-secondary max-w-[200px] truncate">
                            {txn.description || "-"}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-on-surface-muted">
                            {txn.referenceNumber || "-"}
                          </td>
                          <td className={`px-3 py-2.5 text-xs font-medium text-right tabular-nums ${
                            isVoid ? "line-through text-on-surface-muted" :
                            txn.type === "deposit" ? "text-emerald-600 dark:text-emerald-400" :
                            "text-red-600 dark:text-red-400"
                          }`}>
                            {txn.type === "deposit" ? "+" : "-"}{formatCents(txn.amountCents)}
                          </td>
                          <td className="px-6 py-2.5 text-xs font-semibold text-right tabular-nums text-on-surface">
                            {isVoid || txn.clientBalanceAfter == null ? "-" : formatCents(txn.clientBalanceAfter)}
                          </td>
                        </tr>
                      );
                    })}
                    {pagerWillRender(totalItems) && (
                      <tr>
                        <td colSpan={99} className="px-4 py-3">
                          <ListPager
                            page={page}
                            totalPages={totalPages}
                            total={totalItems}
                            rowsPerPage={rowsPerPage}
                            onPageChange={setPage}
                            onRowsPerPageChange={setRowsPerPage}
                            rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
                            busy={fetching}
                            serverPaged
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
    </Modal>
  );
}
