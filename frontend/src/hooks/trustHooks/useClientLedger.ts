"use client";

import trustService from "@/services/trust.service";
import usePagedTrustLedger, { type TrustLedgerScope, type UsePagedTrustLedgerOptions } from "./usePagedTrustLedger";

const CLIENT_LEDGER: TrustLedgerScope = {
  queryKeyRoot: "clientLedger",
  fetchPage: (lawFirmId, clientId, paging) => trustService.getClientLedgerPaged(lawFirmId, clientId, paging),
  errorFallback: "Failed to load client ledger.",
};

/** A client's trust ledger, paged by the server. See `usePagedTrustLedger`. */
export default function useClientLedger(
  lawFirmId?: string,
  clientId?: string,
  options?: UsePagedTrustLedgerOptions,
) {
  return usePagedTrustLedger(CLIENT_LEDGER, lawFirmId, clientId, options);
}
