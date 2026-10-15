"use client";

import { useQuery } from "@tanstack/react-query";
import leadsService from "@/services/leads.service";
import type { ServerTableQueryParams } from "@/hooks/useServerTable";
import type { Lead } from "@/types";

export function useLeadById(lawFirmId?: string, leadId?: string | null, enabled: boolean = true) {
  const { data, isLoading, error, refetch } = useQuery<Lead>({
    queryKey: ["leads", lawFirmId, "detail", leadId ?? null],
    queryFn: () => leadsService.getLead(lawFirmId!, leadId!),
    enabled: !!lawFirmId && !!leadId && enabled,
    staleTime: 30_000,
  });

  return {
    lead: data ?? null,
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load lead.") : null,
    refresh: refetch,
  };
}

export function usePagedLeads(
  lawFirmId: string | undefined,
  params: ServerTableQueryParams,
  enabled: boolean = true,
) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<{ leads: Lead[]; totalItems: number }>({
    queryKey: ["leads", lawFirmId, "paged", params],
    queryFn: () => leadsService.listLeadsPaged(lawFirmId!, {
      page: params.page,
      limit: params.limit,
      sort: params.sort,
      search: params.search,
      stageId: params.filters.stageId,
    }),
    enabled: !!lawFirmId && enabled,
    // Keep the previous page's rows and total on screen while the next page
    // loads. Guarded on the previous query's OWN law firm (index 1 of its
    // key, not this render's `lawFirmId`): bare `keepPreviousData` hands over
    // the last successful result on ANY key change, not just a page/filter
    // change within the same firm. Without the guard, switching law firms
    // rendered the old firm's leads as though they were the new firm's, for
    // as long as the new firm's request took to resolve - a cross-tenant leak
    // in the UI, the same class already fixed in `useMatters.ts`/`useTasks.ts`.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined
    ),
  });

  return {
    leads: data?.leads ?? [],
    total: data?.totalItems ?? 0,
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load leads.") : null,
    refresh: refetch,
  };
}
