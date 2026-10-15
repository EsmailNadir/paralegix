'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import signaturesService from '@/services/signatures.service';
import { fetchAndSeed } from '@/lib/query/seedQueries';
import {
  INITIAL_SIGNING_SESSIONS_PARAMS,
  SIGNING_SESSIONS_PAGE_SIZE,
  signingSessionsQueryKey,
} from './useSigningSessions';

/**
 * Opens the signatures page with ONE `signature-links/workspace` request instead
 * of four, writing each part into the cache entry its own hook reads: the first
 * page of sessions, the per-status summary, the member's pending documents and
 * the template list.
 *
 * Returns `ready` once that request has settled, successfully or not. Pass it
 * as `enabled` to the four hooks: they then find their data fresh and issue
 * nothing, and if the request failed they read their own endpoints exactly as
 * before. Every later change (a page, a filter, an invalidation after voiding a
 * session) goes through the section's own query, so it re-reads only itself.
 *
 * Fresh for the same 30 seconds as the sections, so reopening the page soon
 * after serves both from cache.
 */
export function useSigningWorkspace(lawFirmId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['signingWorkspace', lawFirmId],
    queryFn: () => fetchAndSeed(
      queryClient,
      () => signaturesService.getSigningWorkspace(lawFirmId, { page: 1, limit: SIGNING_SESSIONS_PAGE_SIZE }),
      (body) => [
        { name: 'sessions', key: signingSessionsQueryKey(lawFirmId, INITIAL_SIGNING_SESSIONS_PARAMS), data: body.sessions },
        { name: 'summary', key: ['signingSessionSummary', lawFirmId], data: body.summary },
        { name: 'needsMySignature', key: ['signingNeedsMySignature', lawFirmId], data: body.pendingForUser.needsMySignature ?? [] },
        { name: 'templates', key: ['signingTemplates', lawFirmId], data: body.templates.templates || [] },
      ],
    ),
    enabled: !!lawFirmId,
    staleTime: 30_000,
    retry: false,
  });

  return { ready: query.status !== 'pending' && !query.isFetching };
}
