import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { getFirebaseToken } from '@/lib/utils/auth';
import { useLawFirm } from '@/contexts/LawFirmContext';
import { useFirmSettings } from '@/contexts/FirmSettingsContext';
import lawFirmService from '@/services/lawfirm.service';
import { GoogleCalendarSync } from '@/services/googleCalendarSync.service';
import { OutlookCalendarSync } from '@/services/outlookCalendarSync.service';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

// `undefined` = still checking, otherwise the resolved completion state.
export type GetStartedStatus = boolean | undefined;

export interface GetStartedProgress {
  stripeConnected: GetStartedStatus;
  teamInvited: GetStartedStatus;
  calendarConnected: GetStartedStatus;
  logoAdded: boolean;
  doneCount: number;
  totalCount: number;
  complete: boolean;
}

/**
 * Shared completion status for the "get started" checklist (Stripe, team,
 * calendar, logo). Cached per firm via React Query so the settings tab bar
 * and the get-started page itself don't each fire their own network calls.
 */
export function useGetStartedProgress(lawFirmId: string): GetStartedProgress {
  const { lawFirm } = useLawFirm();
  const { features } = useFirmSettings();

  const { data: stripeConnected } = useQuery<boolean>({
    queryKey: ['getStartedProgress', lawFirmId, 'stripe'],
    queryFn: async () => {
      const token = await getFirebaseToken();
      const response = await apiFetch(`${API_URL}/stripe/connect/${lawFirmId}/status`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Failed to fetch Stripe status');
      const data = await response.json() as { connected: boolean; chargesEnabled: boolean };
      return !!(data.connected && data.chargesEnabled);
    },
    enabled: !!lawFirmId,
    staleTime: 60_000,
    retry: false,
  });

  const { data: teamInvited } = useQuery<boolean>({
    queryKey: ['getStartedProgress', lawFirmId, 'team'],
    queryFn: async () => {
      const members = await lawFirmService.getLawFirmMembers(lawFirmId);
      return members.length > 1;
    },
    enabled: !!lawFirmId,
    staleTime: 60_000,
    retry: false,
  });

  const { data: calendarConnected } = useQuery<boolean>({
    queryKey: ['getStartedProgress', lawFirmId, 'calendar'],
    queryFn: async () => {
      const [google, outlook] = await Promise.all([
        GoogleCalendarSync.checkGoogleAuth().catch(() => ({ authenticated: false })),
        OutlookCalendarSync.checkOutlookAuth().catch(() => ({ authenticated: false })),
      ]);
      return !!(google.authenticated || outlook.authenticated);
    },
    enabled: !!lawFirmId && !!features.calendarSync,
    staleTime: 60_000,
    retry: false,
  });

  const logoAdded = !!lawFirm?.logoUrl;

  const statuses: GetStartedStatus[] = [
    stripeConnected,
    teamInvited,
    ...(features.calendarSync ? [calendarConnected] : []),
    logoAdded,
  ];

  const doneCount = statuses.filter((s) => s === true).length;
  const totalCount = statuses.length;
  const complete = totalCount > 0 && doneCount === totalCount;

  return { stripeConnected, teamInvited, calendarConnected, logoAdded, doneCount, totalCount, complete };
}
