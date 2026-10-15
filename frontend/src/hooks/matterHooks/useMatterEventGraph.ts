"use client";

import { useQuery } from "@tanstack/react-query";
import matterEventsService from "@/services/matterEvents.service";
import type { EventGraphNode } from "@/types/matterEvent";

// Stable reference for the empty state so consumers feeding these into a
// dependency array don't re-run every render while data is undefined.
const EMPTY_NODES: EventGraphNode[] = [];

/**
 * Every event on the matter, projected to its dependency links.
 *
 * Deliberately unpaged, and deliberately separate from the paged list. The tab
 * resolves `dependsOn` against this rather than against the rows on screen,
 * because a dependency that simply was not loaded gets dropped by the resolver
 * and reads as "no dependency" - which is indistinguishable from "not blocked" on
 * a deadline that is blocked.
 *
 * Keyed UNDER the matter's events rather than beside them, so one
 * `invalidateQueries({ queryKey: ["matterEvents", lawFirmId, matterId] })` after
 * a mutation reaches the graph along with the list and its status sections. A
 * new or resolved dependency link is invisible to blocking until the graph is
 * re-read, so it must never be the one thing a refresh misses.
 */
export default function useMatterEventGraph(lawFirmId?: string, matterId?: string) {
  const { data, isLoading, refetch } = useQuery<{ events: EventGraphNode[] }>({
    queryKey: ["matterEvents", lawFirmId, matterId, "graph"],
    queryFn: () => matterEventsService.getEventGraph(lawFirmId!, matterId!),
    enabled: !!lawFirmId && !!matterId,
    staleTime: 30_000,
  });

  return {
    nodes: data?.events ?? EMPTY_NODES,
    loading: isLoading,
    refetch,
  };
}
