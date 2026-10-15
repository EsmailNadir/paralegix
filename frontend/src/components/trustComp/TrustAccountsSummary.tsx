"use client";

import { Landmark, Settings2 } from "lucide-react";
import ListEmptyState from "@/components/ui/ListEmptyState";
import TrustAccountCard from "./TrustAccountCard";
import type { TrustAccount } from "@/types/trust";
import Button from "@/components/ui/Button";

interface TrustAccountsSummaryProps {
  accounts: TrustAccount[];
  loading?: boolean;
  /** Sends the user to the Accounts tab, which owns creating and editing. */
  onManageAccounts: () => void;
  /** Opens the Transactions tab filtered to one account. */
  onOpenAccount: (accountId: string) => void;
}

/**
 * The read-only account strip on the Trust overview: one tile per bank account,
 * laid out across the full page width.
 *
 * A firm has a handful of trust accounts and hundreds of client balances, so the
 * two can't share a row - a two-column split stretches the short list to the
 * height of the long one. Tiles sit above the balances instead, and every
 * management action lives on the Accounts tab rather than being duplicated here.
 */
export default function TrustAccountsSummary({
  accounts,
  loading,
  onManageAccounts,
  onOpenAccount,
}: TrustAccountsSummaryProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Trust Accounts</h3>
          <p className="text-xs text-on-surface-muted mt-0.5">
            Book balance held in each of your firm&apos;s trust bank accounts.
          </p>
        </div>
        <button
          onClick={onManageAccounts}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-surface bg-surface border border-outline-subtle hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          <Settings2 size={14} />
          Manage accounts
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-surface rounded-xl border border-outline p-4 sm:p-5">
              <div className="h-9 w-9 rounded-lg bg-surface-alt animate-pulse mb-3" />
              <div className="h-8 w-32 rounded bg-surface-alt animate-pulse" />
              <div className="mt-2 h-3 w-24 rounded bg-surface-alt animate-pulse" />
            </div>
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <ListEmptyState
          compact
          icon={<Landmark size={36} />}
          title="No trust accounts yet"
          message="Add an IOLTA or client trust account to start recording deposits and disbursements."
          action={
            <Button
              size="compact"
              onClick={onManageAccounts}
              icon={<Landmark size={14} />}
            >
              Add an account
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {accounts.map((account) => (
            <TrustAccountCard
              key={account.id}
              account={account}
              onOpen={() => onOpenAccount(account.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
