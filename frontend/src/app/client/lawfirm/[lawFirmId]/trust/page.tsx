"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import clientPortalService from "@/services/client-portal.service";
import ErrorNotification from "@/components/ErrorNotification";
import ListPager from "@/components/ui/ListPager";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ListEmptyState from "@/components/ui/ListEmptyState";
import { Shield, ArrowDownLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { formatCents } from "@/lib/utils/currency";
import { formatDate } from "@/lib/utils/dateUtils";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useClientPortal } from "@/contexts/ClientPortalContext";
import ClientRecordPicker from "@/components/portalComp/ClientRecordPicker";
import Card from "@/components/ui/Card";
import SectionLabel from "@/components/ui/SectionLabel";

interface TrustBalance {
  clientId: string;
  totalBalanceCents: number;
  accountBalances: Array<{
    clientId: string;
    trustAccountId: string;
    accountName: string;
    balanceCents: number;
  }>;
}

interface TrustTransaction {
  id: string;
  type: "deposit" | "withdrawal" | "transfer" | "refund";
  amountCents: number;
  date: string;
  description: string;
  status: string;
  clientBalanceAfter: number;
  createdAt: string;
}

const getTypeDetails = (type: TrustTransaction["type"]) => {
  switch (type) {
    case "deposit":
      return {
        label: "Deposit",
        icon: ArrowDownLeft,
        className: "text-emerald-600 dark:text-emerald-400",
        bgClass: "bg-emerald-50 dark:bg-emerald-500/10",
        sign: "+",
      };
    case "withdrawal":
      return {
        label: "Withdrawal",
        icon: ArrowUpRight,
        className: "text-rose-600 dark:text-rose-400",
        bgClass: "bg-rose-50 dark:bg-rose-500/10",
        sign: "-",
      };
    case "transfer":
      return {
        label: "Transfer",
        icon: RefreshCw,
        className: "text-amber-600 dark:text-amber-400",
        bgClass: "bg-amber-50 dark:bg-amber-500/10",
        sign: "-",
      };
    case "refund":
      return {
        label: "Refund",
        icon: ArrowDownLeft,
        className: "text-accent-emphasis",
        bgClass: "bg-accent-soft dark:bg-accent-soft",
        sign: "+",
      };
  }
};

const PAGE_SIZE = 15;

export default function ClientTrustPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [balance, setBalance] = useState<TrustBalance | null>(null);
  const [transactions, setTransactions] = useState<TrustTransaction[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // A page change keeps the rows on screen and marks the pager busy, rather than
  // collapsing the ledger back to the initial-load spinner.
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stripe sends the client back here with `?deposit=success` or
  // `?deposit=cancelled` after an electronic trust deposit. The deposit itself
  // posts to the ledger when the bank confirms it, so "success" means the
  // request went through, not that the money has landed.
  const searchParams = useSearchParams();
  const depositOutcome = searchParams.get("deposit");

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

  useEffect(() => {
    if (!lawFirmId || !user || associationsLoading || selectionRequired) return;

    const fetchTrustData = async () => {
      try {
        setLoading(true);
        setError(null);
        const [balanceData, ledgerData] = await Promise.all([
          clientPortalService.getTrustBalance(lawFirmId, clientRecordId),
          clientPortalService.getTrustLedger(lawFirmId, { limit: PAGE_SIZE, offset: 0, clientRecordId }),
        ]);
        setBalance(balanceData);
        setTransactions(ledgerData.transactions || []);
        setTotalItems(ledgerData.totalItems || 0);
        setPage(1);
      } catch (err) {
        const msg = getErrorMessage(err, "Failed to load trust data");
        if (!msg.toLowerCase().includes("not associated")) {
          setError(msg);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchTrustData();
  }, [lawFirmId, user, associationsLoading, selectionRequired, clientRecordId]);

  // The ledger is paged by the server, so each page is one request and the whole
  // history is never held in memory. `totalItems` is refreshed from every
  // response so a deposit landing mid-browse is reflected in the page count.
  const goToPage = async (nextPage: number) => {
    const clamped = Math.min(Math.max(1, nextPage), totalPages);
    if (fetching || clamped === page) return;
    try {
      setFetching(true);
      const ledgerData = await clientPortalService.getTrustLedger(lawFirmId, {
        limit: PAGE_SIZE,
        offset: (clamped - 1) * PAGE_SIZE,
        clientRecordId,
      });
      setTransactions(ledgerData.transactions || []);
      setTotalItems(ledgerData.totalItems || 0);
      setPage(clamped);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load transactions"));
    } finally {
      setFetching(false);
    }
  };

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <ListSkeleton rows={8} label="Loading your trust ledger" />
      </div>
    );
  }

  const hasBalance = balance && balance.totalBalanceCents > 0;

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-on-surface">Trust Account</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Funds held in trust by your law firm on your behalf.
        </p>
      </div>

      {error && (
        <div className="mb-6">
          <ErrorNotification error={error} onClose={() => setError(null)} />
        </div>
      )}

      {depositOutcome === "success" && (
        <div role="status" className="mb-6 rounded-xl border border-outline-subtle bg-accent-soft px-4 py-3 text-sm text-on-surface">
          Your deposit was submitted. It will appear in your trust balance once your bank confirms the payment.
        </div>
      )}
      {depositOutcome === "cancelled" && (
        <div role="status" className="mb-6 rounded-xl border border-outline-subtle bg-surface px-4 py-3 text-sm text-on-surface-secondary">
          The deposit was cancelled. No payment was made.
        </div>
      )}

      {/* Balance Card */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-6">
          <div className="flex items-center gap-2 text-accent-emphasis mb-3">
            <div className="p-2 bg-accent-soft dark:bg-accent-soft rounded-xl">
              <Shield className="w-5 h-5" />
            </div>
            <SectionLabel as="span" tone="inherit">Trust Balance</SectionLabel>
          </div>
          <p className="text-3xl font-bold text-on-surface">
            {balance ? formatCents(balance.totalBalanceCents) : "$0.00"}
          </p>
          <p className="text-[10px] text-on-surface-muted mt-1">
            Total held across all trust accounts
          </p>
        </div>

        {/* Per-account breakdown */}
        {balance && balance.accountBalances.length > 0 && (
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-6">
            <SectionLabel gap="3">
              By Account
            </SectionLabel>
            <div className="space-y-3">
              {balance.accountBalances.map((acctBal) => (
                <div key={acctBal.trustAccountId} className="flex items-center justify-between">
                  <span className="text-sm text-on-surface-secondary">{acctBal.accountName}</span>
                  <span className="text-sm font-semibold text-on-surface">
                    {formatCents(acctBal.balanceCents)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Transaction History */}
      <Card>
        <div className="px-5 py-4 border-b border-outline-subtle flex items-center justify-between">
          <SectionLabel>
            Transaction History
          </SectionLabel>
          <p className="text-xs text-on-surface-muted">
            {totalItems} transaction{totalItems !== 1 ? "s" : ""}
          </p>
        </div>

        {transactions.length === 0 ? (
          <ListEmptyState
            compact
            icon={<Shield className="w-8 h-8" />}
            title="No transactions yet"
            message={
              hasBalance
                ? "Your transaction history will appear here."
                : "When your firm deposits funds into trust, they will appear here."
            }
            className="border-0"
          />
        ) : (
          <>
            <ul aria-label="Trust transactions" className="divide-y divide-outline-subtle" aria-busy={fetching}>
              {transactions.map((txn) => {
                const details = getTypeDetails(txn.type);
                const Icon = details.icon;
                const isCredit = txn.type === "deposit" || txn.type === "refund";

                return (
                  <li key={txn.id} className="px-5 py-4 flex items-center gap-4 hover:bg-surface-hover transition-colors">
                    <div className={`p-2 rounded-xl ${details.bgClass}`}>
                      <Icon className={`w-4 h-4 ${details.className}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-on-surface">{details.label}</p>
                        {txn.status === "void" && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-surface-alt text-on-surface-muted">
                            Voided
                          </span>
                        )}
                      </div>
                      {txn.description && (
                        <p className="text-[10px] text-on-surface-muted mt-0.5 truncate">{txn.description}</p>
                      )}
                      <p className="text-[10px] text-on-surface-muted">{formatDate(txn.date)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-semibold ${txn.status === "void" ? "text-on-surface-muted line-through" : isCredit ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                        {details.sign}{formatCents(txn.amountCents)}
                      </p>
                      {txn.status !== "void" && (
                        <p className="text-[10px] text-on-surface-muted">
                          Balance: {formatCents(txn.clientBalanceAfter)}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {totalItems > PAGE_SIZE && (
              <div className="px-5 py-3 border-t border-outline-subtle">
                <ListPager
                  page={page}
                  totalPages={totalPages}
                  total={totalItems}
                  rowsPerPage={PAGE_SIZE}
                  onPageChange={goToPage}
                  busy={fetching}
                  serverPaged
                />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
