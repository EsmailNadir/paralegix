"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import matterEventsService from "@/services/matterEvents.service";
import type { MatterEvent, MatterEventStatus } from "@/types/matterEvent";

const DEFAULT_PAGE_SIZE = 10;

// Stable reference for the empty state so consumers feeding rows into a
// dependency array don't re-run every render while data is undefined.
const EMPTY_EVENTS: MatterEvent[] = [];

/**
 * One status section of a matter's events, paged by the server.
 *
 * Each section pages independently, matching how the tab already presents them.
 * This serves the LIST only - dependency blocking reads `useMatterEventGraph`,
 * which is unpaged on purpose, because resolving a link against a page reports
 * "not blocked" for a blocker that simply was not loaded.
 */
export default function useMatterEventsPage(
  lawFirmId: string | undefined,
  matterId: string | undefined,
  status: MatterEventStatus,
  enabled = true,
) {
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPageState] = useState(DEFAULT_PAGE_SIZE);

  // A different page size re-cuts the section, so the current page number no
  // longer points at the same events. Rewind to the top.
  const setRowsPerPage = useCallback((next: number) => {
    setRowsPerPageState(next);
    setPage(1);
  }, []);

  const query = useQuery<{ events: MatterEvent[]; totalEvents: number }>({
    // Rooted at "matterEvents" (not a separate "matterEventsPage" entity) so the
    // invalidations event mutations already issue
    // (`invalidateQueries({ queryKey: ['matterEvents', lawFirmId] })`, see Calendar.tsx)
    // reach this paged query by prefix match too.
    queryKey: ["matterEvents", lawFirmId, matterId, "page", status, page, rowsPerPage],
    queryFn: () => matterEventsService.getEventsPage(lawFirmId!, matterId!, {
      status,
      page,
      limit: rowsPerPage,
    }),
    enabled: enabled && !!lawFirmId && !!matterId,
    // Keeps the current page rendered while the next one loads, so the pager can
    // show its own pending state instead of the section collapsing - but only
    // within the SAME matter. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, not just a same-matter page change,
    // so switching from one matter's events to another's would render the
    // first matter's events as though they belonged to the second for as long
    // as the new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId && prevQuery?.queryKey?.[2] === matterId ? prev : undefined
    ),
  });

  const total = query.data?.totalEvents ?? 0;

  return {
    rows: query.data?.events ?? EMPTY_EVENTS,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, rowsPerPage))),
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    loading: query.isLoading,
    fetching: query.isFetching,
    refetch: query.refetch,
  };
}
