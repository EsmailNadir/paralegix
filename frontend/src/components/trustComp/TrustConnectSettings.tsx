"use client";

import { useState } from "react";
import { Landmark, ExternalLink, RefreshCw } from "lucide-react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { TrustAccount, TrustConnectStatus } from "@/types/trust";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import type { StatusVariant } from "@/constants/statusMeta";
import useStripeConnect from "@/hooks/useStripeConnect";

interface TrustConnectSettingsProps {
  lawFirmId: string;
  accounts: TrustAccount[];
  /** Bumping this value forces every account's status to re-fetch (e.g. on Stripe return). */
  refreshSignal?: number;
}

type StatusLabel = "active" | "pending" | "not_connected";

function deriveLabel(status: TrustConnectStatus): StatusLabel {
  if (!status.connected) return "not_connected";
  if (status.chargesEnabled && status.onboardingComplete) return "active";
  return "pending";
}

const LABEL_TEXT: Record<StatusLabel, string> = {
  active: "Active",
  pending: "Pending",
  not_connected: "Not connected",
};

const LABEL_VARIANT: Record<StatusLabel, StatusVariant> = {
  active: "success",
  pending: "warning",
  not_connected: "neutral",
};

interface AccountRowProps {
  lawFirmId: string;
  account: TrustAccount;
  canManage: boolean;
  refreshSignal?: number;
}

function AccountRow({ lawFirmId, account, canManage, refreshSignal }: AccountRowProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const {
    status, loading, error, setError, busy,
    connect: handleConnect,
    openDashboard: handleDashboard,
    disconnect,
    refresh: loadStatus,
  } = useStripeConnect(
    { kind: "trust", lawFirmId, trustAccountId: account.id },
    { refreshKey: refreshSignal ?? null },
  );

  const handleDisconnect = async () => {
    // The confirmation closes only on success, so a failure leaves the dialog
    // up with the reason on it rather than dismissing itself silently.
    if (await disconnect()) setConfirmDisconnect(false);
  };

  const label = status ? deriveLabel(status as TrustConnectStatus) : "not_connected";
  const isActive = label === "active";
  const isPending = label === "pending";

  const actionBtnClass =
    "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="px-4 py-3 border border-outline-subtle rounded-lg space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface truncate">{account.name}</p>
          <p className="text-[11px] text-on-surface-muted truncate">
            {account.bankName}
            {account.accountNumberLast4 ? ` ••••${account.accountNumberLast4}` : ""}
          </p>
        </div>
        {loading ? (
          <Spinner size={16} className="text-on-surface-muted shrink-0" />
        ) : (
          <StatusBadge variant={LABEL_VARIANT[label]} className="shrink-0">
            {LABEL_TEXT[label]}
          </StatusBadge>
        )}
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} compact />

      {!loading && canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {label === "not_connected" && (
            <button
              onClick={handleConnect}
              disabled={busy}
              className={`${actionBtnClass} text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover`}
            >
              {busy ? <Spinner size={13} /> : <Landmark size={13} />}
              Connect
            </button>
          )}

          {isPending && (
            <button
              onClick={handleConnect}
              disabled={busy}
              className={`${actionBtnClass} text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover`}
            >
              {busy ? <Spinner size={13} /> : <ExternalLink size={13} />}
              Continue onboarding
            </button>
          )}

          {isActive && (
            <>
              <button
                onClick={handleDashboard}
                disabled={busy}
                className={`${actionBtnClass} text-on-surface bg-surface-alt border border-outline-subtle hover:bg-surface-hover`}
              >
                <ExternalLink size={13} />
                Stripe dashboard
              </button>
              <button
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy}
                className={`${actionBtnClass} text-red-600 dark:text-red-400 bg-surface-alt border border-outline-subtle hover:bg-surface-hover`}
              >
                Disconnect
              </button>
            </>
          )}

          {!loading && (
            <button
              onClick={loadStatus}
              disabled={busy}
              className={`${actionBtnClass} text-on-surface-muted hover:bg-surface-hover`}
            >
              <RefreshCw size={13} />
              Refresh
            </button>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={handleDisconnect}
        title="Disconnect trust bank account"
        message={`Disconnect the Stripe connected account for "${account.name}"? Clients will no longer be able to fund this account electronically until you reconnect.`}
        confirmText="Disconnect"
        confirmType="danger"
        loading={busy}
      />
    </div>
  );
}

// Per trust-account Stripe connected-account management. Each active trust
// account can onboard its own connected account (its trust/IOLTA bank) so
// clients can deposit into it electronically by ACH.
export default function TrustConnectSettings({ lawFirmId, accounts, refreshSignal }: TrustConnectSettingsProps) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("trust.manage");

  const activeAccounts = accounts.filter((a) => a.status === "active");

  return (
    <div className="bg-surface rounded-xl border border-outline-subtle">
      <div className="px-5 py-4 border-b border-outline-subtle">
        <h3 className="text-sm font-semibold text-on-surface">Electronic deposits (trust bank account)</h3>
        <p className="text-xs text-on-surface-muted mt-0.5">
          Connect each trust account to its own bank so clients can fund it by bank transfer (ACH).
          Funds settle directly into that trust account.
        </p>
      </div>

      <div className="px-5 py-4 space-y-3">
        {activeAccounts.length === 0 ? (
          <p className="text-xs text-on-surface-muted">
            No active trust accounts. Create a trust account first, then connect its bank here.
          </p>
        ) : (
          activeAccounts.map((account) => (
            <AccountRow
              key={account.id}
              lawFirmId={lawFirmId}
              account={account}
              canManage={canManage}
              refreshSignal={refreshSignal}
            />
          ))
        )}
      </div>
    </div>
  );
}
