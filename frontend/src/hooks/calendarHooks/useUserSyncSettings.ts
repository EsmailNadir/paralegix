"use client";

import { useQuery } from "@tanstack/react-query";
import settingsService from "@/services/settings.service";
import type { SyncFlags } from "@/types/syncFlags";

// User calendar-sync preferences (loggedInWithGoogle/Microsoft, allow*Sync flags).
// Shared by the calendar UI and the layout-level background sync engine so the
// `GET /settings/user` call is fetched once and cached across navigations
// instead of each consumer issuing its own request on every mount.
export default function useUserSyncSettings(lawFirmId?: string, enabled = true) {
  const query = useQuery<SyncFlags>({
    queryKey: ["userSyncSettings", lawFirmId],
    queryFn: async () => {
      const res = await settingsService.getUserSettings(lawFirmId);
      return (res.preferences || {}) as SyncFlags;
    },
    enabled: !!lawFirmId && enabled,
    staleTime: 60_000,
  });

  return {
    syncFlags: query.data ?? null,
    loading: query.isLoading,
    refetch: query.refetch,
  };
}
