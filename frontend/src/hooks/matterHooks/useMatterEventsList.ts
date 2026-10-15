"use client";

import { useQuery } from "@tanstack/react-query";
import matterEventsService from "@/services/matterEvents.service";
import type { MatterEvent } from "@/types/matterEvent";

// Stable reference for the empty state so consumers that feed `events` into a
// `useEffect` dependency array don't re-run every render while data is undefined.
const EMPTY_EVENTS: MatterEvent[] = [];

// Events for a SINGLE matter (matter-scoped). Keyed distinctly from the calendar's
// firm-wide ["matterEvents", lawFirmId] hook so they don't collide. Shared by the
// matter detail overview panel and the Events tab so the list is fetched once.
export default function useMatterEventsList(lawFirmId?: string, matterId?: string) {
  const { data, isLoading, error, refetch } = useQuery<MatterEvent[]>({
    queryKey: ["matterEvents", lawFirmId, matterId],
    queryFn: async () => {
      const res = await matterEventsService.listEvents(lawFirmId!, matterId!);
      return res.events;
    },
    enabled: !!lawFirmId && !!matterId,
    staleTime: 30_000,
  });

  return {
    events: data ?? EMPTY_EVENTS,
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load events.") : null,
    refresh: refetch,
  };
}
