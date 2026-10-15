"use client";

import { useQuery } from "@tanstack/react-query";
import trustService from "@/services/trust.service";
import type { TrustInterestRemittance } from "@/types/trust";

interface RemittancesResult {
  remittances: TrustInterestRemittance[];
  totalItems: number;
  truncated: boolean;
  ceiling: number | null;
}

/**
 * Firm-wide IOLTA interest remittances. Tracks interest earned on trust funds
 * and the corresponding payments remitted to the bar foundation, client, or firm.
 *
 * `truncated` is surfaced rather than swallowed. Remittances are generated per
 * account per period and never pruned, so the server caps an unpaged read; the
 * caller has to be able to say the history is partial, because a firm reconciles
 * these against its bar-foundation statements and a short list that looks
 * complete is a reconciliation that quietly does not balance.
 */
export default function useInterestRemittances(lawFirmId?: string, trustAccountId?: string) {
  const { data, isLoading, error, refetch } = useQuery<RemittancesResult>({
    queryKey: ["trustRemittances", lawFirmId, trustAccountId ?? null],
    queryFn: () => trustService.listRemittances(lawFirmId!, trustAccountId),
    enabled: !!lawFirmId,
  });

  return {
    remittances: data?.remittances ?? [],
    totalItems: data?.totalItems ?? 0,
    truncated: data?.truncated ?? false,
    ceiling: data?.ceiling ?? null,
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load interest remittances.") : null,
    refresh: refetch,
  };
}
