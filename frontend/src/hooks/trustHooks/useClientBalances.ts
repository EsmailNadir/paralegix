"use client";

import { useQuery } from "@tanstack/react-query";
import { REFRESH_ON_FOCUS } from "@/lib/query/lawFirmQueryClient";
import trustService from "@/services/trust.service";
import type { ClientTrustBalance } from "@/types/trust";

interface UseClientBalancesOptions {
  /**
   * Hold the report back until the caller needs it. A surface that only shows
   * trust balances behind a tab, or only on a plan with trust accounting, passes
   * `false` until then rather than spending a request and a server pool
   * connection on a report nothing is rendering.
   */
  enabled?: boolean;
}

export default function useClientBalances(lawFirmId?: string, options?: UseClientBalancesOptions) {
  const { data, isLoading, error, refetch } = useQuery<ClientTrustBalance[]>({
    queryKey: ["clientTrustBalances", lawFirmId],
    queryFn: () => trustService.getAllBalances(lawFirmId!),
    enabled: !!lawFirmId && (options?.enabled ?? true),
    // Other members post and void trust transactions with nothing pushing that
    // here, and a stale balance is a money error, so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
  });

  return {
    balances: data ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load client balances.") : null,
    refresh: refetch,
  };
}
