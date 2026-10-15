"use client";

import { useQuery } from "@tanstack/react-query";
import TasksService from "@/services/tasks.service";
import { getUserTimeZone } from "@/lib/utils/timezone";
import type { CalendarWindow } from "@/lib/utils/calendarWindow";
import type { Task } from "@/types";
import { calendarTasksWindowKey, selectTasks } from "./calendarSectionQueries";

/**
 * The tasks due inside one calendar window, plus overlapping all-day spans.
 *
 * Separate from `useLawfirmTasks` (which the tasks grid owns) because the calendar
 * wants every task in a date range rather than a page of a filtered list. The
 * server treats `dueFrom`/`dueTo` as filters, not as a paging opt-in, so this
 * receives the whole window.
 *
 * Keyed under ["tasks", lawFirmId] so the invalidations task mutations already
 * issue reach it by prefix match.
 *
 * The viewer's timezone is also part of the key: `listLawFirmTasksPaged` sends
 * the same `tz` the day-only `dueFrom`/`dueTo` bounds are resolved against
 * server-side, so identical bounds in a different zone are a different UTC
 * range of due dates. Without `tz` here, a zone change mid-session would keep
 * serving the cache entry built for the old zone until the window itself moved.
 *
 * `enabled: false` holds the read back while the calendar feed is filling this
 * entry (see `useCalendarWindowData`).
 */
export default function useCalendarWindowTasks(lawFirmId?: string, window?: CalendarWindow, { enabled = true } = {}) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<Task[]>({
    queryKey: calendarTasksWindowKey(lawFirmId, window, getUserTimeZone()),
    queryFn: async () => selectTasks(await TasksService.listLawFirmTasksPaged(lawFirmId!, {
      dueFrom: window!.from,
      dueTo: window!.to,
      includeSpanning: true,
    })),
    enabled: enabled && !!lawFirmId && !!window,
    staleTime: 60_000,
    // Only within the SAME firm. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, and a firm switch that leaves the
    // calendar window unchanged is exactly such a change, so it would render
    // the previous firm's tasks as though they belonged to the new firm for as
    // long as the new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined
    ),
  });

  return {
    tasks: data ?? [],
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load tasks.") : null,
    refresh: refetch,
  };
}
