"use client";

import { useQuery } from "@tanstack/react-query";
import calendarEventsService from "@/services/calendarEvents.service";
import { getUserTimeZone } from "@/lib/utils/timezone";
import type { CalendarWindow } from "@/lib/utils/calendarWindow";
import type { Event } from "@/types";
import { externalEventsWindowKey, selectExternalEvents } from "./calendarSectionQueries";

// External (Google/Outlook) calendar events synced into Paralegix, for one window.
//
// The key keeps the ["externalEvents", lawFirmId] prefix that the background sync
// invalidates after pulling new events, so every cached window refreshes.
//
// The viewer's timezone is also part of the key: `listExternalEvents` sends the
// same `tz` the day-only `window.from`/`to` bounds are resolved against
// server-side, so identical bounds in a different zone are a different UTC
// range. Without `tz` here, a zone change mid-session would keep serving the
// cache entry built for the old zone until the window itself moved.
//
// `enabled: false` holds the read back while the calendar feed is filling this
// entry (see `useCalendarWindowData`).
export default function useExternalCalendarEvents(lawFirmId?: string, window?: CalendarWindow, { enabled = true } = {}) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<Event[]>({
    queryKey: externalEventsWindowKey(lawFirmId, window, getUserTimeZone()),
    queryFn: async () => selectExternalEvents(await calendarEventsService.listExternalEvents(lawFirmId!, window)),
    enabled: enabled && !!lawFirmId && !!window,
    staleTime: 60_000,
    // Only within the SAME firm. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, and a firm switch that leaves the
    // calendar window unchanged is exactly such a change, so it would render
    // the previous firm's external events as though they belonged to the new
    // firm for as long as the new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined
    ),
  });

  return {
    externalEvents: data ?? [],
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load external events.") : null,
    refresh: refetch,
  };
}
