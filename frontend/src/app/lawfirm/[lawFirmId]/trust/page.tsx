"use client";

import { useState, useCallback, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import trustService from "@/services/trust.service";
import useTrustAccounts from "@/hooks/trustHooks/useTrustAccounts";
import useTrustTransactions from "@/hooks/trustHooks/useTrustTransactions";
import useClientBalances from "@/hooks/trustHooks/useClientBalances";
import useMinimumBalances from "@/hooks/trustHooks/useMinimumBalances";
import TrustOverview from "@/components/trustComp/TrustOverview";
import TrustAccountList from "@/components/trustComp/TrustAccountList";
import TrustAccountsSummary from "@/components/trustComp/TrustAccountsSummary";
import TransactionList from "@/components/trustComp/TransactionList";
import ClientBalances from "@/components/trustComp/ClientBalances";
import MinimumBalances from "@/components/trustComp/MinimumBalances";
import InterestRemittances from "@/components/trustComp/InterestRemittances";
import TrustSettings from "@/components/trustComp/TrustSettings";
import ClientLedgerModal from "@/components/trustComp/ClientLedgerModal";
import ReconciliationHistory from "@/components/trustComp/ReconciliationHistory";
import TrustAuditReport from "@/components/trustComp/TrustAuditReport";
import ErrorNotification from "@/components/ErrorNotification";
import RequirePermission from "@/components/ui/RequirePermission";
import RequireFeature from "@/components/ui/RequireFeature";
import PageHeader from "@/components/ui/PageHeader";
import TabBar, { type TabBarTab } from "@/components/ui/TabBar";
import type { TrustReconciliation } from "@/types/trust";

type TabKey = "overview" | "transactions" | "accounts" | "retainers" | "interest" | "reconciliation" | "compliance" | "settings";

const TABS: TabBarTab<TabKey>[] = [
  { value: "overview", label: "Overview" },
  { value: "transactions", label: "Transactions" },
  { value: "accounts", label: "Accounts" },
  { value: "retainers", label: "Retainers" },
  { value: "interest", label: "Interest" },
  { value: "reconciliation", label: "Reconciliation" },
  { value: "compliance", label: "Compliance" },
  { value: "settings", label: "Settings" },
];

export default function TrustPage() {
  const { lawFirmId } = useParams<{ lawFirmId: string }>();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [viewingLedger, setViewingLedger] = useState<{ clientId: string; clientName?: string } | null>(null);
  // Bumped when Stripe redirects back from onboarding so the per-account
  // connection statuses (and account list) re-fetch to reflect the new state.
  const [connectRefreshSignal, setConnectRefreshSignal] = useState(0);

  const {
    accounts, loading: accountsLoading, error: accountsError, refresh: refreshAccounts,
  } = useTrustAccounts(lawFirmId);
  // Transactions are paged, filtered and counted server-side; the hook owns the
  // page/page-size/filter state and resets to page 1 whenever a filter changes.
  const {
    transactions,
    totalItems: txnTotal,
    loading: txnLoading,
    fetching: txnFetching,
    error: txnError,
    refresh: refreshTxns,
    filters: txnFilters,
    setFilters: setTxnFilters,
    page: txnPage,
    setPage: setTxnPage,
    rowsPerPage: txnRowsPerPage,
    setRowsPerPage: setTxnRowsPerPage,
    listParams: txnListParams,
  } = useTrustTransactions(lawFirmId);
  const {
    balances, loading: balancesLoading, error: balancesError, refresh: refreshBalances,
  } = useClientBalances(lawFirmId);
  const { minimums } = useMinimumBalances(lawFirmId);

  // This is money the firm holds for a client, not its own revenue, so a
  // failed read must never be silently indistinguishable from a genuinely
  // empty account: every hook above defaults to `[]` on error, which would
  // otherwise render as "$0.00 across 0 accounts" whether the firm holds
  // nothing or the request never landed. Mirrors the load-error banner
  // pattern in `MattersGrid`.
  const [dismissedLoadError, setDismissedLoadError] = useState<string | null>(null);
  const loadError = accountsError || balancesError || txnError || null;
  const showingLoadError = !!loadError && loadError !== dismissedLoadError;
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await Promise.allSettled([refreshAccounts(), refreshBalances(), refreshTxns()]);
    } finally {
      setRetryingLoad(false);
    }
  }, [refreshAccounts, refreshBalances, refreshTxns]);

  // Fetch latest reconciliation for the first active account
  const firstActiveAccount = accounts.find((a) => a.status === "active");
  const { data: latestRec, isLoading: latestRecLoading } = useQuery<TrustReconciliation | null>({
    queryKey: ["latestReconciliation", lawFirmId, firstActiveAccount?.id],
    queryFn: () => trustService.getLatestReconciliation(lawFirmId, firstActiveAccount!.id),
    enabled: !!lawFirmId && !!firstActiveAccount?.id,
  });

  // TrustOverview's four tiles share one skeleton gate: wait for every source
  // they draw from, not just accounts, so the balances- and reconciliation-backed
  // tiles don't pop in after the accounts-backed ones have already settled. The
  // reconciliation query only enters flight once an active account is known, so
  // it's only load-bearing when there is one to wait for.
  const overviewLoading = accountsLoading || balancesLoading || (!!firstActiveAccount && latestRecLoading);

  const refreshAll = useCallback(() => {
    refreshAccounts();
    refreshTxns();
    refreshBalances();
  }, [refreshAccounts, refreshTxns, refreshBalances]);

  // Deep-link support: `?tab=settings` opens a specific tab (e.g. the deposit
  // modal's "Go to Trust settings" action). Stripe onboarding redirects back
  // with `?stripe=return` (finished) or `?stripe=refresh` (link expired); either
  // way, re-fetch account state and per-account connection statuses on Settings.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- syncs the active tab from URL query params (deep link / Stripe return) */
    const stripeReturn = searchParams.get("stripe");
    const tabParam = searchParams.get("tab");
    if (stripeReturn === "return" || stripeReturn === "refresh") {
      setActiveTab("settings");
      refreshAccounts();
      setConnectRefreshSignal((n) => n + 1);
    } else if (tabParam && TABS.some((t) => t.value === tabParam)) {
      setActiveTab(tabParam as TabKey);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [searchParams, refreshAccounts]);

  // An account tile on the overview opens that account's activity, so the tile
  // is a way into the ledger rather than a dead-end number.
  const handleOpenAccountTransactions = (accountId: string) => {
    setTxnFilters({ ...txnFilters, trustAccountId: accountId });
    setActiveTab("transactions");
  };

  const handleViewLedger = (clientId: string) => {
    const balance = balances.find((b) => b.clientId === clientId);
    setViewingLedger({ clientId, clientName: balance?.clientName });
  };

  return (
    <RequirePermission permission="trust.view" page>
      <RequireFeature feature="trustAccounting">
        <div className="min-h-screen bg-page">
          <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">
            {/* Hero Banner */}
            <PageHeader
              eyebrow="Financial Management"
              title="Trust Accounting"
              description="Manage IOLTA trust accounts, client retainers, and reconciliation."
            />

            <ErrorNotification
              error={showingLoadError ? loadError : null}
              onClose={() => setDismissedLoadError(loadError)}
              onRetry={retryLoad}
              retrying={retryingLoad}
            />

            {/* Tabs. Pulled up out of the page stack's `space-y-6`: the strip belongs
                to the header above it, and a full 24px gap under the header's rule
                leaves it floating between the two. */}
            <TabBar
              className="-mt-5"
              tabs={TABS}
              value={activeTab}
              onChange={(tab) => { setActiveTab(tab); setViewingLedger(null); }}
            />

            {/* Tab Content */}
            {activeTab === "overview" && (
              <div className="space-y-6">
                <TrustOverview
                  accounts={accounts}
                  balances={balances}
                  latestReconciliation={latestRec}
                  loading={overviewLoading}
                  onViewAccounts={() => setActiveTab("accounts")}
                  onViewTransactions={() => setActiveTab("transactions")}
                  onViewReconciliation={() => setActiveTab("reconciliation")}
                />
                <TrustAccountsSummary
                  accounts={accounts}
                  loading={accountsLoading}
                  onManageAccounts={() => setActiveTab("accounts")}
                  onOpenAccount={handleOpenAccountTransactions}
                />
                <ClientBalances
                  balances={balances}
                  loading={balancesLoading}
                  onViewLedger={handleViewLedger}
                  minimums={minimums}
                />
              </div>
            )}

            {activeTab === "transactions" && (
              <TransactionList
                transactions={transactions}
                totalItems={txnTotal}
                accounts={accounts}
                loading={txnLoading}
                fetching={txnFetching}
                lawFirmId={lawFirmId}
                filters={txnFilters}
                onFiltersChange={setTxnFilters}
                page={txnPage}
                onPageChange={setTxnPage}
                rowsPerPage={txnRowsPerPage}
                onRowsPerPageChange={setTxnRowsPerPage}
                listParams={txnListParams}
                onRefresh={refreshAll}
              />
            )}

            {activeTab === "accounts" && (
              <TrustAccountList
                accounts={accounts}
                loading={accountsLoading}
                lawFirmId={lawFirmId}
                onRefresh={refreshAll}
                onViewSummary={() => {
                  setActiveTab("overview");
                }}
              />
            )}

            {activeTab === "retainers" && (
              <MinimumBalances
                lawFirmId={lawFirmId}
                accounts={accounts}
                balances={balances}
              />
            )}

            {activeTab === "interest" && (
              <InterestRemittances
                lawFirmId={lawFirmId}
                accounts={accounts}
              />
            )}

            {activeTab === "reconciliation" && (
              <ReconciliationHistory
                lawFirmId={lawFirmId}
                accounts={accounts}
              />
            )}

            {activeTab === "compliance" && (
              <TrustAuditReport lawFirmId={lawFirmId} />
            )}

            {activeTab === "settings" && (
              <TrustSettings
                lawFirmId={lawFirmId}
                accounts={accounts}
                connectRefreshSignal={connectRefreshSignal}
              />
            )}
          </div>
        </div>

        <ClientLedgerModal
          open={viewingLedger !== null}
          lawFirmId={lawFirmId}
          clientId={viewingLedger?.clientId ?? null}
          clientName={viewingLedger?.clientName}
          onClose={() => setViewingLedger(null)}
        />
      </RequireFeature>
    </RequirePermission>
  );
}
