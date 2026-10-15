"use client";

import { useCallback, useMemo, useState } from "react";
import { BookOpen, Users } from 'lucide-react';
import Tooltip from "@/components/ui/Tooltip";
import ListView, { type ListRow } from "@/components/ui/ListView";
import StatusBadge from "@/components/ui/StatusBadge";
import { highlightText } from "@/components/ui/HighlightText";
import SearchInput from "@/components/ui/SearchInput";
import type { ClientTrustBalance, TrustMinimumBalance } from "@/types/trust";
import { formatCents } from "@/lib/utils/currency";

interface ClientBalancesProps {
  balances: ClientTrustBalance[];
  loading?: boolean;
  onViewLedger?: (clientId: string) => void;
  /** Configured per-(client, account) minimums, used to flag clients below threshold. */
  minimums?: TrustMinimumBalance[];
}

interface ClientAggregate {
  clientId: string;
  clientName: string;
  totalCents: number;
  accounts: number;
}

/**
 * Trust funds held per client, aggregated across every trust account.
 *
 * This is a ledger summary, not a picker: every client with a trust balance
 * belongs here and must be reachable, so the rows are paged rather than capped
 * and a firm past the page size can walk to the rest instead of only being able
 * to search for them by name.
 */
export default function ClientBalances({ balances, loading, onViewLedger, minimums = [] }: ClientBalancesProps) {
  const [search, setSearch] = useState("");

  const allClients = useMemo(() => {
    const aggregates = balances.reduce<Record<string, ClientAggregate>>((acc, b) => {
      if (!acc[b.clientId]) {
        acc[b.clientId] = { clientId: b.clientId, clientName: b.clientName, totalCents: 0, accounts: 0 };
      }
      acc[b.clientId].totalCents += b.balanceCents;
      acc[b.clientId].accounts += 1;
      return acc;
    }, {});
    return Object.values(aggregates);
  }, [balances]);

  const clients = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return allClients;
    return allClients.filter((c) => (c.clientName || "").toLowerCase().includes(term));
  }, [allClients, search]);

  // Total shortfall per client across all breached account-level minimums.
  // Minimums are account-scoped, so each is compared against the matching
  // account balance rather than against the client's total.
  const shortfallByClient = useMemo(() => {
    const balanceKey = (clientId: string, accountId: string) => `${clientId}::${accountId}`;
    const balanceMap = new Map<string, number>();
    balances.forEach((b) => balanceMap.set(balanceKey(b.clientId, b.trustAccountId), b.balanceCents));

    const shortfalls = new Map<string, number>();
    minimums.forEach((min) => {
      const current = balanceMap.get(balanceKey(min.clientId, min.trustAccountId)) ?? 0;
      if (current < min.minimumCents) {
        shortfalls.set(min.clientId, (shortfalls.get(min.clientId) ?? 0) + (min.minimumCents - current));
      }
    });
    return shortfalls;
  }, [balances, minimums]);

  const renderRow = useCallback(
    (client: ClientAggregate): ListRow => {
      const shortfall = shortfallByClient.get(client.clientId);
      return {
        title: highlightText(client.clientName, search),
        badges: shortfall != null && (
          <Tooltip title={`Short by ${formatCents(shortfall)}`} enterDelay={300}>
            <span className="inline-flex">
              <StatusBadge variant="warning">Below minimum</StatusBadge>
            </span>
          </Tooltip>
        ),
        meta: `${client.accounts} account${client.accounts === 1 ? "" : "s"}`,
        right: (
          <p
            className={`text-sm font-semibold tabular-nums ${
              client.totalCents > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : client.totalCents < 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-on-surface-muted"
            }`}
          >
            {formatCents(client.totalCents)}
          </p>
        ),
      };
    },
    [shortfallByClient, search],
  );

  const rowActions = useCallback(
    (client: ClientAggregate) =>
      onViewLedger ? (
        <button
          onClick={() => onViewLedger(client.clientId)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-on-surface bg-surface-alt border border-outline-subtle hover:bg-surface-hover rounded-lg transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          <BookOpen size={12} />
          View Ledger
        </button>
      ) : null,
    [onViewLedger],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Client Trust Balances</h3>
          <p className="text-xs text-on-surface-muted mt-0.5">
            Funds held on behalf of each client across all trust accounts.
          </p>
        </div>
        <SearchInput
          size="sm"
          className="w-full sm:w-72"
          placeholder="Search clients..."
          aria-label="Search client trust balances"
          value={search}
          onChange={(next) => setSearch(next)}
          onClear={() => setSearch("")}
        />
      </div>

      <ListView<ClientAggregate>
        rows={clients}
        loading={loading}
        getRowId={(client) => client.clientId}
        renderRow={renderRow}
        rowActions={onViewLedger ? rowActions : undefined}
        onRowClick={onViewLedger ? (client) => onViewLedger(client.clientId) : undefined}
        leading={
          <p className="text-xs text-on-surface-muted">
            {clients.length} client{clients.length === 1 ? "" : "s"}
            {search && allClients.length !== clients.length ? ` of ${allClients.length}` : ""}
          </p>
        }
        sortColumns={[
          {
            label: "Balance",
            value: "balance",
            defaultDir: "desc",
            compare: (a: ClientAggregate, b: ClientAggregate) => a.totalCents - b.totalCents,
          },
          {
            label: "Client",
            value: "client",
            compare: (a: ClientAggregate, b: ClientAggregate) =>
              (a.clientName || "").localeCompare(b.clientName || ""),
          },
          {
            label: "Accounts",
            value: "accounts",
            defaultDir: "desc",
            compare: (a: ClientAggregate, b: ClientAggregate) => a.accounts - b.accounts,
          },
        ]}
        defaultPageSize={10}
        pageSizeOptions={[10, 25, 50]}
        emptyIcon={<Users size={40} />}
        emptyTitle={allClients.length === 0 ? "No client trust balances" : "No matching clients"}
        emptyMessage={
          allClients.length === 0
            ? "Record a trust deposit and the client's balance will appear here."
            : "No clients match your search."
        }
      />
    </div>
  );
}
