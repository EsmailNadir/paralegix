"use client";

import { useQuery } from "@tanstack/react-query";
import clientsService from "@/services/clients.service";
import type { ClientEvent } from "@/types/clientEvent";

// Shared read of a client's events. Keyed on ["clientDetailEvents", ...] - 
// distinct from the calendar-side ["clientEvents"] key - so the ClientDetail
// badge count and the ClientEventsTab list dedupe to a single fetch.
export default function useClientDetailEvents(lawFirmId?: string, clientId?: string) {
  const { data, isLoading, error, refetch } = useQuery<{ events: ClientEvent[]; totalEvents: number }>({
    queryKey: ["clientDetailEvents", lawFirmId, clientId],
    queryFn: () => clientsService.listClientEvents(lawFirmId!, clientId!),
    enabled: !!lawFirmId && !!clientId,
    staleTime: 30_000,
  });
  return {
    data,
    events: data?.events ?? [],
    totalEvents: data?.totalEvents ?? 0,
    loading: isLoading,
    error,
    refresh: refetch,
  };
}
