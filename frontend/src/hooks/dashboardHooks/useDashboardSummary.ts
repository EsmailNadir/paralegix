import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import dashboardService, { type DashboardSummaryResponse } from '@/services/dashboard.service';

// Delay before the automatic refetch of a summary that reported section errors.
// Long enough for a transient backend blip (connection pressure after the tab
// sat idle) to clear, short enough that the user rarely reaches the Retry card.
export const DASHBOARD_SECTION_RETRY_DELAY_MS = 1500;

/**
 * Single aggregate dashboard read. Replaces the ~9-11 separate GETs the
 * dashboard page used to fire on cold load. staleTime/gcTime are inherited
 * from the lawfirm layout's QueryClient (two minutes, no refetch on window
 * focus): the summary costs 25-30 database queries, so it deliberately does
 * NOT opt back in to focus refetch. Any write the user makes marks it stale.
 */
export function useDashboardSummary(lawFirmId?: string) {
  const query = useQuery<DashboardSummaryResponse>({
    queryKey: ['dashboardSummary', lawFirmId],
    queryFn: () => dashboardService.getDashboardSummary(lawFirmId!),
    enabled: !!lawFirmId,
  });

  const { data, dataUpdatedAt, refetch } = query;

  // The firm whose current failure episode already spent its automatic retry.
  // Keyed by firm so switching firms starts a fresh episode.
  const autoRetriedFirmRef = useRef<string | null>(null);

  // A section failure arrives inside a 200, so React Query never retries it.
  // Refetch once after a short delay; if that response still has errors, the
  // widgets' manual Retry takes over. A clean response ends the episode.
  // Previous data stays rendered during the refetch, so nothing flashes.
  useEffect(() => {
    if (!lawFirmId || !data) return;

    const hasSectionError = !!data.sectionErrors && Object.values(data.sectionErrors).some(Boolean);
    if (!hasSectionError) {
      autoRetriedFirmRef.current = null;
      return;
    }
    if (autoRetriedFirmRef.current === lawFirmId) return;

    autoRetriedFirmRef.current = lawFirmId;
    const timer = setTimeout(() => {
      void refetch();
    }, DASHBOARD_SECTION_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [lawFirmId, data, dataUpdatedAt, refetch]);

  return query;
}
