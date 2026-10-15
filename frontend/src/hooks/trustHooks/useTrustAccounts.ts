"use client";

import { useQuery } from "@tanstack/react-query";
import { REFRESH_ON_FOCUS } from "@/lib/query/lawFirmQueryClient";
import trustService from "@/services/trust.service";
import type { TrustAccount } from "@/types/trust";

export default function useTrustAccounts(lawFirmId?: string) {
  const { data, isLoading, error, refetch } = useQuery<TrustAccount[]>({
    queryKey: ["trustAccounts", lawFirmId],
    queryFn: () => trustService.listAccounts(lawFirmId!),
    enabled: !!lawFirmId,
    // Other members post and void trust transactions with nothing pushing that
    // here, and a stale balance is a money error, so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
  });

  return {
    accounts: data ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load trust accounts.") : null,
    refresh: refetch,
  };
}
