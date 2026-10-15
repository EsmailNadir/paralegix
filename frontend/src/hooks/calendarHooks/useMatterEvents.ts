"use client";

import { useQuery } from "@tanstack/react-query";
import matterEventsService from "@/services/matterEvents.service";
import { getUserTimeZone } from "@/lib/utils/timezone";
import type { CalendarWindow } from "@/lib/utils/calendarWindow";
import type { MatterEvent } from "@/types/matterEvent";
import { matterEventsWindowKey, selectMatterEvents } from "./calendarSectionQueries";

// Matter events for one calendar window, with cancelled events filtered out (the
// calendar never renders cancelled events). The filtered list is what gets cached,
// so consumers receive ready-to-render data.
//
// The key keeps the ["matterEvents", lawFirmId] prefix so the invalidations issued
// elsewhere in the app still reach every cached window by prefix match.
//
// The viewer's timezone is also part of the key. `window.from`/`to` are day-only
// strings ("2026-09-01") with no zone of their own; the server (`listAllEvents`
// sends `tz`) buckets which side of midnight an event's UTC instant falls on
// using the SAME zone name, so identical day bounds resolve to different UTC
// instants, and therefore a different event set, in different zones. Without `tz`
// in the key, a viewer whose zone changes mid-session (their OS travels zones)
// would keep rendering the cache entry built for the old zone until the window
// itself moved, showing events on the wrong day with no indication anything is
// stale.
//
// `keepPreviousData` is what makes month navigation feel instant: the previous
// window stays on screen while the new one loads, and the caller reports the load
// through `fetching` rather than blanking the grid.
//
// `enabled: false` holds the read back while the calendar feed is filling this
// entry (see `useCalendarWindowData`).
export default function useMatterEvents(lawFirmId?: string, window?: CalendarWindow, { enabled = true } = {}) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<MatterEvent[]>({
    queryKey: matterEventsWindowKey(lawFirmId, window, getUserTimeZone()),
    queryFn: async () => selectMatterEvents(await matterEventsService.listAllEvents(lawFirmId!, window)),
    enabled: enabled && !!lawFirmId && !!window,
    staleTime: 60_000,
    // Only within the SAME firm. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, and a firm switch that leaves the
    // calendar window unchanged is exactly such a change, so it would render
    // the previous firm's matter events as though they belonged to the new
    // firm for as long as the new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined
    ),
  });

  return {
    matterEvents: data ?? [],
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load matter events.") : null,
    refresh: refetch,
  };
}
