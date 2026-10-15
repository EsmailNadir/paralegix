"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import { getUserTimeZone } from "@/lib/utils/timezone";
import { getCalendarWindow, neighbourWindows, windowsOverlap } from "@/lib/utils/calendarWindow";
import useMatterEvents from "./useMatterEvents";
import useStandaloneClientEvents from "./useStandaloneClientEvents";
import useExternalCalendarEvents from "./useExternalCalendarEvents";
import useCalendarWindowTasks from "./useCalendarWindowTasks";
import usePaymentDates from "@/hooks/billingHooks/usePaymentDates";
import {
  calendarFeedKey,
  calendarTasksWindowKey,
  clientEventsWindowKey,
  externalEventsWindowKey,
  loadCalendarFeed,
  matterEventsWindowKey,
  paymentDatesWindowKey,
} from "./calendarSectionQueries";

interface Options {
  /** False when the viewer has no billing permission, so payment dates are skipped. */
  includePaymentDates?: boolean;
}

/** How long a window's data stays fresh, matching every section hook. */
const WINDOW_STALE_MS = 60_000;

/**
 * Every dataset the calendar draws, bounded to the window around `anchor`.
 *
 * Owning all five reads in one place means the calendar has a single `loading`
 * (nothing on screen yet) and a single `fetching` (a range change is in flight
 * while the previous window is still rendered) rather than five of each.
 *
 * A window is read with ONE `calendar-feed` request, which writes each section
 * into that section's own cache entry (see `loadCalendarFeed`). The section
 * hooks are held back while the feed is in flight and then find their data
 * fresh, so they issue nothing. They still own their endpoints for three cases:
 * a section the member may not see (null in the feed, read exactly as before),
 * a feed request that failed, and an invalidation after a mutation or a
 * calendar sync, which re-reads only the section it names.
 *
 * The neighbouring windows are prefetched once the current one settles, so
 * stepping a month forward or back usually renders from cache. The warm-up is
 * one feed request per neighbour, one neighbour after the other, so it cannot
 * crowd out the requests someone is waiting on (one API instance holds twelve
 * Postgres pool connections).
 *
 * `anchor` is a dayjs object, so a parent that rebuilds it every render would
 * re-run the prefetch effect every render. Callers must hold it in state so the
 * reference is stable between navigations.
 */
export default function useCalendarWindowData(
  lawFirmId: string | undefined,
  anchor: Dayjs,
  { includePaymentDates = true }: Options = {},
) {
  const queryClient = useQueryClient();
  // Named `calendarWindow`, not `window`: a local binding called `window` would
  // shadow the DOM global that the idle-callback feature check below reads.
  const calendarWindow = useMemo(() => getCalendarWindow(anchor), [anchor]);
  const tz = getUserTimeZone();

  // The feed caches only which sections it wrote; the data lives under each
  // section's own key.
  const feed = useQuery({
    queryKey: calendarFeedKey(lawFirmId, calendarWindow, tz),
    queryFn: () => loadCalendarFeed(queryClient, lawFirmId!, calendarWindow, tz),
    enabled: !!lawFirmId,
    staleTime: WINDOW_STALE_MS,
    // Same firm only, as the section hooks do: it keeps `loading` false on a
    // step to another month, and true on a firm switch.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });
  // The sections wait until this window's feed has settled, one way or the
  // other. Until then each shows its previous window as a placeholder.
  const sectionsEnabled = feed.status !== "pending" && !feed.isFetching && !feed.isPlaceholderData;
  const section = { enabled: sectionsEnabled };

  const matter = useMatterEvents(lawFirmId, calendarWindow, section);
  const client = useStandaloneClientEvents(lawFirmId, calendarWindow, section);
  const external = useExternalCalendarEvents(lawFirmId, calendarWindow, section);
  const tasks = useCalendarWindowTasks(lawFirmId, calendarWindow, section);
  const payments = usePaymentDates(includePaymentDates ? lawFirmId : undefined, calendarWindow, section);

  const loading = feed.isLoading || matter.loading || client.loading || external.loading || tasks.loading
    || (includePaymentDates && payments.isLoading);
  const fetching = feed.isFetching || matter.fetching || client.fetching || external.fetching || tasks.fetching
    || (includePaymentDates && payments.isFetching);

  // The window (and firm) the data currently on screen was loaded for.
  // `keepPreviousData` holds the last settled query's results while a new one
  // is in flight, so this only advances once that fetch lands.
  const [renderedWindow, setRenderedWindow] = useState(calendarWindow);
  const [renderedLawFirmId, setRenderedLawFirmId] = useState(lawFirmId);
  useEffect(() => {
    if (fetching) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- records which window/firm the rendered data belongs to, once its fetch settles
    setRenderedWindow(calendarWindow);
    setRenderedLawFirmId(lawFirmId);
  }, [fetching, calendarWindow, lawFirmId]);

  // True while a fetch is in flight for a firm or a range that the data on
  // screen was not loaded for: a switch to a different law firm, or a jump
  // several months out rather than a step into an adjacent one. Nothing
  // already loaded can belong on screen, so the grid is showing content it
  // has no data for yet.
  //
  // The firm check matters on its own: `calendarWindow` is date-only (no
  // `lawFirmId`), so switching firms without moving the anchor date leaves it
  // unchanged and `windowsOverlap` trivially true against itself, even though
  // every dataset's `keepPreviousData` placeholder is still the PREVIOUS
  // firm's last successful read. Without this, a firm switch showed the old
  // firm's events at full opacity, fully interactive, until the new firm's
  // read resolved - a cross-tenant leak in the UI, not just stale rendering.
  const firmChanged = lawFirmId !== renderedLawFirmId;
  const rangeUnloaded = fetching && (firmChanged || !windowsOverlap(renderedWindow, calendarWindow));

  // First error wins. The calendar shows one banner, not a stack of five.
  const error = matter.error || client.error || external.error || tasks.error
    || (payments.error instanceof Error ? payments.error.message : null);

  // Warm the months either side once the current window has settled, so the
  // arrows and the mini calendar usually render from cache. Prefetch only, never
  // a render dependency: if it fails the user just pays for the fetch on arrival.
  //
  // Speculative work yields to real work: one feed request per neighbour, the
  // second only after the first has settled. A neighbour whose sections are all
  // still fresh in cache (the month the user just came from) is skipped.
  useEffect(() => {
    if (!lawFirmId || loading || fetching) return;
    let cancelled = false;
    const zone = getUserTimeZone();

    const isFresh = (key: readonly unknown[]) => {
      const state = queryClient.getQueryState(key);
      return !!state && state.data !== undefined && !state.isInvalidated
        && Date.now() - state.dataUpdatedAt < WINDOW_STALE_MS;
    };

    const warm = async () => {
      for (const neighbour of neighbourWindows(anchor)) {
        if (cancelled) return;
        const sections = [
          matterEventsWindowKey(lawFirmId, neighbour, zone),
          clientEventsWindowKey(lawFirmId, neighbour, zone),
          externalEventsWindowKey(lawFirmId, neighbour, zone),
          calendarTasksWindowKey(lawFirmId, neighbour, zone),
          ...(includePaymentDates ? [paymentDatesWindowKey(lawFirmId, neighbour)] : []),
        ];
        if (sections.every(isFresh)) continue;
        // A failed warm read is not worth reporting: the user simply pays for
        // the fetch when they arrive on that month.
        await queryClient.prefetchQuery({
          queryKey: calendarFeedKey(lawFirmId, neighbour, zone),
          queryFn: () => loadCalendarFeed(queryClient, lawFirmId, neighbour, zone),
          staleTime: WINDOW_STALE_MS,
        }).catch(() => {});
      }
    };

    // requestIdleCallback is not in every browser; the timeout fallback keeps the
    // prefetch off the critical path either way.
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const schedule = typeof idle === "function"
      ? (fn: () => void) => idle.call(globalThis, fn)
      : (fn: () => void) => window.setTimeout(fn, 400);

    schedule(() => { if (!cancelled) void warm(); });

    return () => { cancelled = true; };
  }, [lawFirmId, anchor, loading, fetching, includePaymentDates, queryClient]);

  // While a firm switch is in flight, every dataset's `keepPreviousData`
  // placeholder is still the PREVIOUS firm's last successful read - it must
  // not be handed to the caller as though it were the new firm's content.
  // `rangeUnloaded` above already flags this for the grid's dimmed/inert
  // styling; this is what actually keeps the old firm's items out of the
  // rendered lists during that window.
  const suppressStaleFirmData = fetching && firmChanged;

  return {
    window: calendarWindow,
    matterEvents: suppressStaleFirmData ? [] : matter.matterEvents,
    clientEvents: suppressStaleFirmData ? [] : client.clientEvents,
    externalEvents: suppressStaleFirmData ? [] : external.externalEvents,
    tasks: suppressStaleFirmData ? [] : tasks.tasks,
    paymentDates: suppressStaleFirmData ? [] : (payments.data ?? []),
    /** Nothing has been drawn yet. Show the skeleton. */
    loading,
    /** A range change is in flight behind data that is already on screen. */
    fetching,
    /**
     * A range change is in flight for days none of the loaded data covers, so
     * the grid's emptiness means "not loaded", not "nothing scheduled".
     */
    rangeUnloaded,
    error,
    refreshTasks: tasks.refresh,
    retryLoad: async () => {
      if (!lawFirmId) return;
      await Promise.allSettled([
        matter.refresh(), client.refresh(), external.refresh(), tasks.refresh(),
        ...(includePaymentDates ? [payments.refetch()] : []),
      ]);
    },
  };
}
