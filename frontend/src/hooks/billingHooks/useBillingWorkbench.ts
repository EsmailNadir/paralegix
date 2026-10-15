"use client";

import { useQuery } from "@tanstack/react-query";
import billingService from "@/services/billing.service";
import type { BillingWorkbenchResponse } from "@/types";

interface Options {
  /** 1-based page of the attention list. */
  attentionPage?: number;
  attentionLimit?: number;
}

export default function useBillingWorkbench(lawFirmId?: string, options: Options = {}) {
  const { attentionPage, attentionLimit } = options;

  return useQuery<BillingWorkbenchResponse>({
    queryKey: ["billing", "workbench", lawFirmId, attentionPage, attentionLimit],
    queryFn: () => billingService.getBillingWorkbench(lawFirmId!, { attentionPage, attentionLimit }),
    enabled: !!lawFirmId,
    staleTime: 30_000,
    // Paging the attention list refetches; keeping the previous page on screen
    // stops the whole overview collapsing to its skeleton on every page change
    // - but only within the SAME firm. Bare `keepPreviousData` hands over the
    // last successful result on ANY key change, not just a same-firm page
    // change, so switching firms would render the previous firm's overview as
    // though it belonged to the new firm for as long as the new request is in
    // flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[2] === lawFirmId ? prev : undefined
    ),
  });
}
