"use client";

import { useQuery } from "@tanstack/react-query";
import clientPortalService, { type DocumentRequest } from "@/services/client-portal.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/** The React Query key for the document requests a portal client can see. */
export function clientDocumentRequestsKey(lawFirmId?: string, matterId?: string, clientRecordId?: string) {
  return ["client-document-requests", lawFirmId, matterId ?? null, clientRecordId ?? null] as const;
}

/**
 * Document requests visible to a portal CLIENT. The firm-side equivalent is
 * `useDocumentRequests`; this one reads the portal endpoint instead, and its
 * `matterId` is optional - omitting it returns every open request across the
 * client's matters (what the documents page shows).
 *
 * `clientRecordId` (organization-clients plan, Phase 5) is included in the
 * query key so switching the active client record never serves a cached list
 * built for a different one.
 */
export default function useClientDocumentRequests(lawFirmId?: string, matterId?: string, clientRecordId?: string) {
  const { data, isLoading, error, refetch } = useQuery<DocumentRequest[]>({
    queryKey: clientDocumentRequestsKey(lawFirmId, matterId, clientRecordId),
    queryFn: async () => {
      try {
        return await clientPortalService.getDocumentRequests(lawFirmId!, matterId, clientRecordId);
      } catch (err) {
        // A client with no association to this firm has no requests to show;
        // surfacing that as an error would be alarming and useless to them.
        const message = err instanceof Error ? err.message : "";
        if (message.toLowerCase().includes("not associated")) return [];
        throw err;
      }
    },
    enabled: !!lawFirmId,
    staleTime: 30_000,
    // One attempt: a failure here is shown inline, and retrying would leave the
    // panel hidden (it renders nothing while loading) for several more seconds.
    retry: false,
  });

  return {
    requests: data ?? [],
    loading: isLoading,
    error: error ? getErrorMessage(error, "Failed to load document requests") : null,
    refresh: refetch,
  };
}
