"use client";

import { useQuery } from "@tanstack/react-query";
import clientsService from "@/services/clients.service";
import type { CalendarWindow } from "@/lib/utils/calendarWindow";
import type { ClientEvent } from "@/types/clientEvent";
import { clientEventsWindowKey, selectClientEvents } from "./calendarSectionQueries";
import { getUserTimeZone } from "@/lib/utils/timezone";

// Standalone client events for one calendar window, cancelled events filtered out.
//
// The key keeps the ["clientEvents", lawFirmId] prefix so existing invalidations
// still reach every cached window by prefix match. `enabled: false` holds the
// read back while the calendar feed is filling this entry.
export default function useStandaloneClientEvents(lawFirmId?: string, window?: CalendarWindow, { enabled = true } = {}) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<ClientEvent[]>({
    queryKey: clientEventsWindowKey(lawFirmId, window, getUserTimeZone()),
    queryFn: async () => selectClientEvents(await clientsService.listAllClientEvents(lawFirmId!, window)),
    enabled: enabled && !!lawFirmId && !!window,
    staleTime: 60_000,
    // Only within the SAME firm. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, and a firm switch that leaves the
    // calendar window unchanged is exactly such a change, so it would render
    // the previous firm's client events as though they belonged to the new
    // firm for as long as the new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined
    ),
  });

  return {
    clientEvents: data ?? [],
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load client events.") : null,
    refresh: refetch,
  };
}
