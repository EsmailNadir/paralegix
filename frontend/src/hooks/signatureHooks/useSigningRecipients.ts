"use client";

import { useQuery } from "@tanstack/react-query";
import signaturesService from "@/services/signatures.service";
import type { SigningRecipient } from "@/types/signature";

/**
 * Server-backed typeahead over the dedicated signing-recipient endpoint (
 * organization-clients plan Phase 8): person clients and company roster
 * contacts, blended into one list.
 *
 * Mirrors `useEntityLookup`'s shape (the caller owns debouncing the `search`
 * it passes in, and `isPlaceholder` distinguishes stale-but-shown results from
 * a background refetch of already-correct ones) but is its own hook rather
 * than a mode of that one, because this list comes from a different endpoint
 * with a different response shape, not the generic client lookup.
 */
export function useSigningRecipients(
  lawFirmId: string | undefined,
  { search = "", clientId, enabled = true, limit }: {
    search?: string;
    clientId?: string;
    enabled?: boolean;
    limit?: number;
  } = {}
) {
  const trimmed = search.trim();

  const { data, isFetching, isPlaceholderData, error } = useQuery({
    queryKey: ["signingRecipients", lawFirmId ?? null, trimmed, clientId ?? null, limit ?? null],
    queryFn: () => signaturesService.listSigningRecipients(lawFirmId!, { search: trimmed, clientId, limit }),
    enabled: enabled && !!lawFirmId,
    staleTime: 30_000,
    // Hold the previous page of results while the next one loads, so the menu
    // does not blink empty between keystrokes. Guarded on the firm id (`?? null`,
    // matching how the key stores it above) so switching firms does not carry
    // over the previous firm's signing recipients.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === (lawFirmId ?? null) ? prev : undefined
    ),
  });

  return {
    items: data?.items ?? ([] as SigningRecipient[]),
    hasMore: data?.hasMore ?? false,
    loading: isFetching,
    isPlaceholder: isPlaceholderData,
    error,
  };
}
