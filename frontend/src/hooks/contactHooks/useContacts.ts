"use client";

import { useQuery } from "@tanstack/react-query";
import contactsService from "@/services/contacts.service";
import type { Contact, ContactCategory, ContactMatterLink } from "@/types";
import type { ServerTableQueryParams } from "@/hooks/useServerTable";

/**
 * One server-paged window of the contact directory, keyed on the exact request
 * params so each page/filter/sort combination is cached independently.
 *
 * The key is rooted at `["contacts", lawFirmId]` so the invalidations the
 * contact mutations issue reach it by prefix match.
 */
export function usePagedContacts(
  lawFirmId: string | undefined,
  params: ServerTableQueryParams,
  enabled: boolean = true,
) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<{ contacts: Contact[]; totalItems: number }>({
    queryKey: ["contacts", lawFirmId, "paged", params],
    queryFn: () => contactsService.listContactsPaged(lawFirmId!, {
      page: params.page,
      limit: params.limit,
      sort: params.sort,
      search: params.search,
      category: params.filters.category as ContactCategory | undefined,
      matterId: params.filters.matterId,
      archived: params.filters.archived as "true" | "false" | "all" | undefined,
      oneTime: params.filters.oneTime as "true" | "false" | "all" | undefined,
      tags: params.filters.tag ? [params.filters.tag] : undefined,
    }),
    enabled: !!lawFirmId && enabled,
    // Keep the previous page's rows and total on screen while the next page
    // loads, so the pagination footer doesn't collapse mid-transition. Guarded
    // on the firm id so switching firms does not carry over the previous
    // firm's contacts.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });

  return {
    contacts: data?.contacts ?? [],
    total: data?.totalItems ?? 0,
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load contacts.") : null,
    refresh: refetch,
  };
}

/**
 * One contact by id, plus the matters it appears on.
 *
 * A server-paged list only holds the current page, so the detail page cannot
 * rely on finding its contact in the rows the list happens to have.
 */
export function useContactById(lawFirmId?: string, contactId?: string | null) {
  const { data, isLoading, error, refetch } = useQuery<{
    contact: Contact;
    matters: ContactMatterLink[];
  }>({
    queryKey: ["contacts", lawFirmId, "detail", contactId ?? null],
    queryFn: () => contactsService.getContact(lawFirmId!, contactId!),
    enabled: !!lawFirmId && !!contactId,
  });

  return {
    contact: data?.contact ?? null,
    matters: data?.matters ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load contact.") : null,
    refresh: refetch,
  };
}

/** The tags in use across the firm's directory, for the filter menu. */
export function useContactTags(lawFirmId?: string) {
  const { data, isLoading } = useQuery<string[]>({
    queryKey: ["contacts", lawFirmId, "tags"],
    queryFn: () => contactsService.listTags(lawFirmId!),
    enabled: !!lawFirmId,
    staleTime: 60_000,
  });

  return { tags: data ?? [], loading: isLoading };
}
