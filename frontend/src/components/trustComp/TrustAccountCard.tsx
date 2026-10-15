"use client";

import React from "react";
import { ArrowRight, Landmark, Lock } from "lucide-react";
import { styleOf, trustAccountStatusMeta, STATUS_VARIANTS } from "@/constants/statusMeta";
import { TRUST_ACCOUNT_TYPE_LABELS, type TrustAccount } from "@/types/trust";
import { formatCents } from "@/lib/utils/currency";
import { formatDateOnly } from "@/lib/utils/dateUtils";

interface TrustAccountCardProps {
  account: TrustAccount;
  /** Trailing control (the actions menu on the Accounts tab). Omitted on the read-only overview. */
  actions?: React.ReactNode;
  /** Opens the account's transactions. Makes the tile itself clickable. */
  onOpen?: () => void;
}

/** Chip shape shared by the status and account-type tags - the billing tint chip. */
const CHIP_CLS = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold";

/**
 * One trust bank account as a tile: identity and status on top, book balance as
 * the headline figure below. Shared by the overview strip and the Accounts tab so
 * the two never describe the same account differently.
 *
 * Built to the billing KPI-tile language (tinted icon square, bold figure,
 * tint chips) so trust and billing read as one product rather than two.
 */
export default function TrustAccountCard({ account, actions, onOpen }: TrustAccountCardProps) {
  const statusMeta = trustAccountStatusMeta(account.status);
  const statusStyle = styleOf(statusMeta);
  const typeStyle = STATUS_VARIANTS.indigo;

  return (
    <div
      className={`group bg-surface border border-outline rounded-xl p-4 sm:p-5 flex flex-col transition-colors ${
        onOpen ? "hover:border-accent-control-ring/40 hover:bg-surface-hover" : ""
      }`}
    >
      <div className="flex items-center gap-2.5 mb-3 min-w-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-emphasis dark:bg-accent-soft dark:text-accent-emphasis">
          <Landmark className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-on-surface">
          {account.name}
        </span>
        <span className={`${CHIP_CLS} ${statusStyle.tint} ${statusStyle.text}`}>
          {statusMeta.label}
        </span>
        {actions}
      </div>

      {/* The balance is the tile's headline, so it doubles as the click target
          when the tile opens the account's transactions. */}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="text-left cursor-pointer"
          aria-label={`View transactions for ${account.name}`}
        >
          <p className="text-2xl font-bold text-on-surface tabular-nums">
            {formatCents(account.bookBalance)}
          </p>
          <p className="mt-1 sm:mt-1.5 inline-flex items-center gap-1 text-[11px] sm:text-xs text-on-surface-muted">
            <span className="truncate">
              {account.bankName} &bull; ****{account.accountNumberLast4}
            </span>
            <ArrowRight
              size={12}
              className="shrink-0 opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0"
            />
          </p>
        </button>
      ) : (
        <>
          <p className="text-2xl font-bold text-on-surface tabular-nums">
            {formatCents(account.bookBalance)}
          </p>
          <p className="mt-1 sm:mt-1.5 truncate text-[11px] sm:text-xs text-on-surface-muted">
            {account.bankName} &bull; ****{account.accountNumberLast4}
          </p>
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className={`${CHIP_CLS} ${typeStyle.tint} ${typeStyle.text}`}>
          {TRUST_ACCOUNT_TYPE_LABELS[account.accountType]}
        </span>
        {account.bookCloseDate && (
          <span className={`${CHIP_CLS} gap-1 ${STATUS_VARIANTS.warning.tint} ${STATUS_VARIANTS.warning.text}`}>
            <Lock size={11} />
            Closed through {formatDateOnly(account.bookCloseDate)}
          </span>
        )}
      </div>
    </div>
  );
}
