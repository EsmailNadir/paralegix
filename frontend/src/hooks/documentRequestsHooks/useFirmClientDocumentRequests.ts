"use client";

import { useQuery } from "@tanstack/react-query";
import { REFRESH_ON_FOCUS } from "@/lib/query/lawFirmQueryClient";
import documentRequestsService, { type DocumentRequest } from "@/services/documentRequests.service";

// Stable reference for the empty state so a consumer feeding rows into a
// dependency array doesn't re-run every render while data is undefined.
const EMPTY_REQUESTS: DocumentRequest[] = [];

/**
 * The React Query key for a client's aggregated document requests (every
 * matter the client is on, plus any matter-less "General" requests).
 */
export function firmClientDocumentRequestsKey(lawFirmId?: string, clientId?: string) {
  return ["document-requests", "client", lawFirmId, clientId] as const;
}

/**
 * Every document request addressed to a client, on the FIRM side: the
 * client-detail page's aggregate tab. Not paginated (the backend returns the
 * full, non-cancelled list in one call), unlike the per-matter
 * `useDocumentRequests`.
 *
 * Named distinctly from the portal-side `useClientDocumentRequests` (which
 * reads the client-portal endpoint for a logged-in client's own view) to
 * avoid confusing the two: this one is for firm members looking at a client.
 */
export default function useFirmClientDocumentRequests(lawFirmId?: string, clientId?: string) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<DocumentRequest[]>({
    queryKey: firmClientDocumentRequestsKey(lawFirmId, clientId),
    queryFn: () => documentRequestsService.listForClient(lawFirmId!, clientId!),
    enabled: !!lawFirmId && !!clientId,
    // Clients fulfil requests from the portal with nothing pushing that here,
    // so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
  });

  return {
    requests: data ?? EMPTY_REQUESTS,
    loading: isLoading,
    fetching: isFetching,
    error,
    refresh: refetch,
  };
}
