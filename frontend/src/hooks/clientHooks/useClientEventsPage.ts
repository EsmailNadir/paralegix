"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clientsService from "@/services/clients.service";
import type { ClientEvent } from "@/types/clientEvent";
import type { MatterEventStatus } from "@/types/matterEvent";

const DEFAULT_PAGE_SIZE = 10;

// Stable reference for the empty state so consumers feeding rows into a
// dependency array don't re-run every render while data is undefined.
const EMPTY_EVENTS: ClientEvent[] = [];

/**
 * One status section of a client's events, paged by the server.
 *
 * Unlike the matter tab, this one renders no dependency chips and no blocking,
 * so there is no graph read beside it - the sections are the whole story here.
 *
 * Keyed UNDER `useClientDetailEvents` rather than beside it, so one
 * `invalidateQueries({ queryKey: ["clientDetailEvents", lawFirmId, clientId] })`
 * after a mutation reaches the sections and the shared list that backs
 * ClientDetail's count badge together. Under its own root key, no single prefix
 * could reach both, which is what a fan of `refetch()` calls was standing in for.
 */
export default function useClientEventsPage(
  lawFirmId: string | undefined,
  clientId: string | undefined,
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

  const query = useQuery<{ events: ClientEvent[]; totalEvents: number }>({
    queryKey: ["clientDetailEvents", lawFirmId, clientId, "page", status, page, rowsPerPage],
    queryFn: () => clientsService.getEventsPage(lawFirmId!, clientId!, {
      status,
      page,
      limit: rowsPerPage,
    }),
    enabled: enabled && !!lawFirmId && !!clientId,
    // Only within the SAME client. Bare `keepPreviousData` hands over the last
    // successful result on ANY key change, not just a same-client page change,
    // so switching from one client's events to another's would render the
    // first client's events as though they belonged to the second for as long
    // as the new request is in flight.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId && prevQuery?.queryKey?.[2] === clientId ? prev : undefined
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
