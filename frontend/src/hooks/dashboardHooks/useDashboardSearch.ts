"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import mattersService, { type FullLookupItem, type LookupItem } from "@/services/matters.service";
import clientsService from "@/services/clients.service";
import tasksService from "@/services/tasks.service";
import messagesService from "@/services/messages.service";
import { lookupQueryKey } from "@/hooks/useEntityLookup";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants/search";
import type { Conversation } from "@/types/message";

/** Result rows shown per section of the dashboard search dropdown. */
const RESULTS_PER_SECTION = 5;

export interface DashboardSearchMatter {
  id: string;
  name: string;
  status: string;
  matterReferenceId?: string | null;
}

export interface DashboardSearchClient {
  id: string;
  name: string;
  email?: string;
  matterCount: number;
}

export interface DashboardSearchTask {
  id: string;
  title: string;
  matterName?: string | null;
  priority: string;
  dueDate?: string | null;
}

export interface DashboardSearchResults {
  matters: DashboardSearchMatter[];
  clients: DashboardSearchClient[];
  tasks: DashboardSearchTask[];
  conversations: Conversation[];
}

const EMPTY: DashboardSearchResults = { matters: [], clients: [], tasks: [], conversations: [] };

/**
 * Firm-wide search behind the dashboard's search bar.
 *
 * Every section is a server query, so a term reaches every matter, client, task
 * and conversation in the firm. The dashboard summary it sits above only carries
 * a handful of recent rows per section, and filtering those in memory made the
 * bar look firm-wide while quietly only searching what the page had already
 * rendered.
 *
 * The matter/client/task queries reuse `lookupQueryKey`, so they share cache
 * entries (and mutation invalidations) with every other picker searching the
 * same term.
 */
export function useDashboardSearch(lawFirmId: string | undefined, query: string) {
  const trimmed = query.trim();
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [trimmed]);

  const enabled = !!lawFirmId && debounced.length > 0;

  const matters = useQuery({
    queryKey: lookupQueryKey("matters", lawFirmId, { search: debounced }),
    queryFn: () =>
      mattersService.lookupMatters(lawFirmId!, { search: debounced, limit: RESULTS_PER_SECTION }),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === (lawFirmId ?? null) ? prev : undefined
    ),
  });

  const clients = useQuery({
    queryKey: lookupQueryKey("clients", lawFirmId, { search: debounced, full: true }),
    queryFn: () =>
      clientsService.lookupClients(lawFirmId!, {
        search: debounced,
        limit: RESULTS_PER_SECTION,
        full: true,
      }),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === (lawFirmId ?? null) ? prev : undefined
    ),
  });

  const tasks = useQuery({
    queryKey: lookupQueryKey("tasks", lawFirmId, { search: debounced }),
    queryFn: () =>
      tasksService.lookupTasks(lawFirmId!, { search: debounced, limit: RESULTS_PER_SECTION }),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === (lawFirmId ?? null) ? prev : undefined
    ),
  });

  const conversations = useQuery({
    queryKey: ["firmConversations", lawFirmId, "search", debounced],
    queryFn: () =>
      messagesService.getFirmConversationPage(lawFirmId!, {
        search: debounced,
        limit: RESULTS_PER_SECTION,
      }),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });

  if (!enabled) {
    return { results: EMPTY, loading: false, searching: false };
  }

  const results: DashboardSearchResults = {
    matters: (matters.data?.items ?? []).map((item: LookupItem) => ({
      id: item.id,
      name: item.label,
      status: item.status || "active",
      matterReferenceId: item.matterNumber ?? null,
    })),
    clients: (clients.data?.items ?? []).map((item) => {
      const full = item as FullLookupItem;
      const email = typeof full.email === "string" ? full.email : undefined;
      const matterIds = Array.isArray(full.matterIds) ? full.matterIds : [];
      return { id: item.id, name: item.label, email, matterCount: matterIds.length };
    }),
    tasks: (tasks.data?.items ?? []).map((item: LookupItem) => ({
      id: item.id,
      title: item.label,
      matterName: item.sublabel ?? null,
      priority: item.priority || "medium",
      dueDate: item.dueDate ?? null,
    })),
    conversations: conversations.data?.conversations ?? [],
  };

  return {
    results,
    // True on the first load for a term, when there is nothing to show yet.
    loading:
      matters.isLoading || clients.isLoading || tasks.isLoading || conversations.isLoading,
    // True while any section is in flight, including a refetch that still has
    // the previous term's rows on screen.
    searching:
      trimmed !== debounced ||
      matters.isFetching ||
      clients.isFetching ||
      tasks.isFetching ||
      conversations.isFetching,
  };
}

export default useDashboardSearch;
