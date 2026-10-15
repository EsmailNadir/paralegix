"use client";

import { useQuery } from "@tanstack/react-query";
import trustService from "@/services/trust.service";
import type { TrustMinimumBalance } from "@/types/trust";

/**
 * Firm-wide configured retainer minimums (per client + trust account). Used both
 * to manage thresholds and to cross-reference live client balances for
 * low-balance ("below minimum") warnings.
 */
export default function useMinimumBalances(lawFirmId?: string) {
  const { data, isLoading, error, refetch } = useQuery<TrustMinimumBalance[]>({
    queryKey: ["trustMinimumBalances", lawFirmId],
    queryFn: () => trustService.listMinimumBalances(lawFirmId!),
    enabled: !!lawFirmId,
  });

  return {
    minimums: data ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load minimum balances.") : null,
    refresh: refetch,
  };
}
