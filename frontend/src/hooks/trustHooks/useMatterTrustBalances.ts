"use client";

import { useMemo } from "react";
import useClientBalances from "./useClientBalances";

export interface MatterTrustBalanceClient {
  /** `clients.id`, the UUID the trust ledger keys on, not a portal user's Firebase UID. */
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface MatterTrustBalance {
  clientId: string;
  clientName: string;
  totalBalanceCents: number;
}

/**
 * Trust money held for the clients on one matter, for the billing tab's callout.
 *
 * Reads the firm-wide `GET /trust/balances` report ONCE and filters it to this
 * matter's clients. The obvious alternative, one `GET /trust/clients/:id/balance`
 * per client, is an unbounded fan-out: a matter with eight clients fired eight
 * simultaneous requests on a single tab click, and each one held one of the API
 * instance's twelve Postgres pool connections for its duration. The firm-wide
 * report answers in one round trip whatever the client count, and shares its
 * cache entry with the trust page, which reads the same report.
 *
 * The report carries one row per (client, account), so a client holding money in
 * two accounts appears twice and its rows are summed here. Names come from the
 * MATTER's own client records rather than the ledger's `clientName`, so the
 * callout reads the same as the rest of the matter page.
 */
export default function useMatterTrustBalances(
  lawFirmId: string | undefined,
  clients: MatterTrustBalanceClient[],
  enabled: boolean,
) {
  const { balances: firmBalances } = useClientBalances(lawFirmId, {
    enabled: enabled && clients.length > 0,
  });

  // `clients` is rebuilt on every render by the caller, so memoise on the ids
  // and names rather than on the array identity.
  const clientKey = clients.map((c) => `${c.id}:${c.name ?? ""}:${c.email ?? ""}`).join("|");

  const balances = useMemo<MatterTrustBalance[]>(() => {
    if (clients.length === 0 || firmBalances.length === 0) return [];

    const totalByClientId = new Map<string, number>();
    for (const row of firmBalances) {
      totalByClientId.set(row.clientId, (totalByClientId.get(row.clientId) ?? 0) + row.balanceCents);
    }

    return clients
      .filter((c) => !!c.id)
      .map((c) => ({
        clientId: c.id,
        clientName: c.name || c.email || "Client",
        totalBalanceCents: totalByClientId.get(c.id) ?? 0,
      }))
      // Only money that can actually be applied to an invoice is worth a callout.
      .filter((b) => b.totalBalanceCents > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientKey, firmBalances]);

  return { balances };
}
