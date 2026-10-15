"use client";

import trustService from "@/services/trust.service";
import usePagedTrustLedger, { type TrustLedgerScope, type UsePagedTrustLedgerOptions } from "./usePagedTrustLedger";

const MATTER_LEDGER: TrustLedgerScope = {
  queryKeyRoot: "matterLedger",
  fetchPage: (lawFirmId, matterId, paging) => trustService.getMatterLedger(lawFirmId, matterId, paging),
  errorFallback: "Failed to load matter ledger.",
};

/** A matter's trust ledger, paged by the server. See `usePagedTrustLedger`. */
export default function useMatterLedger(
  lawFirmId?: string,
  matterId?: string,
  options?: UsePagedTrustLedgerOptions,
) {
  return usePagedTrustLedger(MATTER_LEDGER, lawFirmId, matterId, options);
}
