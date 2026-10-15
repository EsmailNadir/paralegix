'use client';

import { useQuery } from '@tanstack/react-query';
import { REFRESH_ON_FOCUS } from '@/lib/query/lawFirmQueryClient';
import signaturesService from '@/services/signatures.service';
import type { SigningSessionSummary } from '@/types/signature';

const EMPTY_SUMMARY: SigningSessionSummary = { counts: {}, total: 0, notCompleted: 0 };

/**
 * How many sessions each status filter would match, across the firm's whole
 * signing history.
 *
 * Kept out of `useSigningSessions` because the two answer different questions:
 * that hook returns one page of the *filtered* history and re-fetches on every
 * keystroke and page change, while these counts describe the unfiltered whole and
 * only move when a session's status does. Sharing one query would either re-count
 * the history on every keystroke or leave the counts describing the filter that
 * produced them.
 *
 * Failures resolve to zeroes rather than surfacing: the counts annotate the
 * filters, and a filter row that renders without its numbers is a far better
 * outcome than an error banner over a list that loaded fine.
 *
 * `enabled: false` holds the read back while the page's combined workspace
 * request is filling this entry.
 */
export function useSigningSessionSummary(lawFirmId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { data, isLoading } = useQuery<SigningSessionSummary>({
    queryKey: ['signingSessionSummary', lawFirmId],
    queryFn: () => signaturesService.getSigningSessionSummary(lawFirmId),
    enabled: enabled && !!lawFirmId,
    // External signers and other members move sessions along with nothing
    // pushing that here, so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
  });

  return { summary: data ?? EMPTY_SUMMARY, loading: isLoading };
}

export default useSigningSessionSummary;
