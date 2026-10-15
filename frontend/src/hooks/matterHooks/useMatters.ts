"use client";

import { useQuery } from "@tanstack/react-query";
import MattersService from "@/services/matters.service";
import type { ServerTableQueryParams } from "@/hooks/useServerTable";
import type { Matter } from "@/types";

/**
 * One matter by id, resolved independently of any list query.
 *
 * A server-paged grid only holds the current page, so a view that opens a matter
 * from a URL (a deep link, a browser Back) cannot rely on finding it in the rows
 * it happens to have. This resolves the record on its own, so the matter's name
 * and number are available whichever page the grid is on.
 *
 * Keyed under `['matters', lawFirmId]` so the invalidations matter mutations
 * already issue reach it by prefix match.
 */
export function useMatterById(lawFirmId?: string, matterId?: string | null) {
  const { data, isLoading, error } = useQuery<Matter>({
    queryKey: ['matters', lawFirmId, 'detail', matterId ?? null],
    queryFn: () => MattersService.getMatterById(matterId!, lawFirmId!),
    enabled: !!lawFirmId && !!matterId,
    staleTime: 60_000,
  });

  return {
    matter: data ?? null,
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load matter.") : null,
  };
}


/**
 * Sentinel the grid's status dropdown uses for "payment ongoing". It rides in
 * the `status` filter slot so it shares one control and one persisted key, but
 * it is NOT a status value: the server takes it as its own `paymentOngoing`
 * param, because a matter of any status can have payment ongoing.
 */
export const PAYMENT_ONGOING_FILTER = 'paymentOngoing';

/**
 * Splits the grid's filter bag into the request params the list endpoint takes,
 * lifting the payment-ongoing sentinel out of the `status` slot.
 */
export function matterListFilterParams(filters: Record<string, string | undefined>) {
  const isPaymentOngoing = filters.status === PAYMENT_ONGOING_FILTER;
  return {
    status: isPaymentOngoing ? undefined : filters.status,
    paymentOngoing: isPaymentOngoing ? true : undefined,
    practiceAreaId: filters.practiceAreaId,
    leadUserId: filters.leadUserId,
    category: filters.category,
  };
}

/**
 * One server-paged window of matters, keyed on the exact request params so each
 * page/filter/sort combination is cached independently.
 *
 * The key is rooted at `['matters', lawFirmId]` so the invalidations the matter
 * mutations already issue (`invalidateQueries({ queryKey: ['matters', lawFirmId] })`)
 * reach it by prefix match alongside the full-list query above.
 */
export function usePagedMatters(
  lawFirmId: string | undefined,
  params: ServerTableQueryParams,
  // Gates the query, so a caller can hold it back until the list is on screen.
  enabled: boolean = true,
) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<{ matters: Matter[]; totalItems: number }>({
    queryKey: ['matters', lawFirmId, 'paged', params],
    queryFn: () => MattersService.getMattersPaged(lawFirmId!, {
      page: params.page,
      limit: params.limit,
      sort: params.sort,
      search: params.search,
      ...matterListFilterParams(params.filters),
    }),
    enabled: !!lawFirmId && enabled,
    // Keep the previous page's rows and total on screen while the next page
    // loads. Without this, each page change drops to undefined data (total -> 0),
    // which collapses the pagination footer back to page 1 mid-transition.
    //
    // Guarded on the previous query's OWN law firm (index 1 of its key, not
    // this render's `lawFirmId`): `placeholderData` hands over the last
    // successful result on ANY key change, not just a page/filter change
    // within the same firm. Without the guard, switching law firms rendered
    // the old firm's rows as though they were the new firm's, for as long as
    // the new firm's request took to resolve - a cross-tenant leak in the UI.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });

  return {
    matters: data?.matters ?? [],
    total: data?.totalItems ?? 0,
    loading: isLoading,
    // Page changes retain the prior rows through placeholderData. Consumers use
    // this separate flag for inline pagination feedback without replacing the
    // whole list with its initial-loading skeleton.
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load matters.") : null,
    refresh: refetch,
  };
}
