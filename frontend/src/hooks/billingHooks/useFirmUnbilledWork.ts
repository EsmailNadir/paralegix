"use client";

import { useQuery } from "@tanstack/react-query";
import billingService from "@/services/billing.service";
import type { UnbilledWorkResponse } from "@/types";

interface Options {
  /** 1-based page. Omit both to fetch the whole backlog. */
  page?: number;
  limit?: number;
}

export default function useFirmUnbilledWork(lawFirmId?: string, options: Options = {}) {
  const { page, limit } = options;

  return useQuery<UnbilledWorkResponse>({
    queryKey: ["billing", "unbilledWork", lawFirmId, page, limit],
    queryFn: () => billingService.getUnbilledWork(lawFirmId!, { page, limit }),
    enabled: !!lawFirmId,
    staleTime: 30_000,
    // Guarded on the previous query's OWN firm (index 2 of its key above): bare
    // `keepPreviousData` hands over the last successful result on ANY key
    // change, not just a page change within the same firm. Without the guard,
    // switching firms rendered the first firm's unbilled backlog as though it
    // belonged to the second, for as long as the new firm's request took to
    // resolve - a cross-tenant leak in the UI.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[2] === lawFirmId ? prev : undefined
    ),
  });
}
