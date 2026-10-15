"use client";

import { useQuery } from "@tanstack/react-query";
import clientsService from "@/services/clients.service";
import type { ServerTableQueryParams } from "@/hooks/useServerTable";
import type { Client, ClientCompanyRelationship, ClientType } from "@/types";
import type { LookupItem } from "@/services/clients.service";

/**
 * Every client in the firm, in one unpaged request.
 *
 * NOT for populating a picker. A firm with thousands of clients pays the whole
 * list on mount, and the control only ever shows a slice of it. Use
 * `EntityPicker` / `EntityMultiPicker` (`@/components/ui/EntityPicker`), which
 * are backed by the `/lookup` server typeahead and resolve an already-selected
 * id's label on their own.
 *
 * Reach for this only when a view genuinely needs the whole set in memory.
 * Anything that renders a table should use `usePagedClients` below instead.
 */
export function useAllClients(lawFirmId?: string) {
  const { data, isLoading, error, refetch } = useQuery<Client[]>({
    queryKey: ["clients", lawFirmId],
    queryFn: () => clientsService.listClients(lawFirmId!),
    enabled: !!lawFirmId,
    staleTime: 60_000,
  });

  return {
    clients: data ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load clients.") : null,
    refresh: refetch,
  };
}

/**
 * One client by id, resolved independently of any list query.
 *
 * A server-paged list only holds the current page, so a view that opens a client
 * from a URL (a deep link, a browser Back) cannot rely on finding it in the rows
 * it happens to have. This resolves the record on its own, so the client's name
 * and email are available whichever page the list is on.
 *
 * Keyed under `["clients", lawFirmId]` so the invalidations client mutations
 * already issue reach it by prefix match.
 */
export function useClientById(lawFirmId?: string, clientId?: string | null) {
  const { data, isLoading, error } = useQuery<Client>({
    queryKey: ["clients", lawFirmId, "detail", clientId ?? null],
    queryFn: () => clientsService.getClient(lawFirmId!, clientId!),
    enabled: !!lawFirmId && !!clientId,
    staleTime: 60_000,
  });

  return {
    client: data ?? null,
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load client.") : null,
  };
}

/**
 * Other clients at the same firm sharing a client's `organization` value
 * (case-insensitive, excludes the client itself), for the "colleagues at this
 * organization" link on the client detail page.
 *
 * Keyed under `["clients", lawFirmId]` so it stays reachable by the same
 * prefix invalidations as the rest of the module.
 */
export function useClientsAtOrganization(
  lawFirmId: string | undefined,
  clientId: string | undefined,
  organization: string | null | undefined,
) {
  const org = (organization ?? "").trim();
  const { data, isLoading } = useQuery<LookupItem[]>({
    queryKey: ["clients", lawFirmId, "organization", org || null, clientId ?? null],
    queryFn: async () => {
      const result = await clientsService.lookupClients(lawFirmId!, {
        exactOrganization: org,
        excludeId: clientId,
        limit: 50,
      });
      return result.items;
    },
    enabled: !!lawFirmId && org.length > 0,
    staleTime: 60_000,
  });

  return { colleagues: data ?? [], loading: isLoading };
}

/**
 * The firm's own company client whose name exactly matches a person client's
 * `organization` text (case-insensitive), for a "linked company client" link
 * on the client detail page. `organization` is free text, not a foreign key,
 * so this is a computed match rather than a stored relationship: typing (or
 * autocompleting via `ClientOrganizationAutocomplete`) the exact name of an
 * existing company client is what makes the two resolve as linked.
 */
export function useLinkedCompanyClient(
  lawFirmId: string | undefined,
  organization: string | null | undefined,
) {
  const org = (organization ?? "").trim();
  const { data, isLoading } = useQuery<LookupItem | null>({
    queryKey: ["clients", lawFirmId, "linkedCompany", org || null],
    queryFn: async () => {
      const result = await clientsService.lookupClients(lawFirmId!, {
        exactName: org,
        clientType: "company",
        limit: 1,
      });
      return result.items[0] ?? null;
    },
    enabled: !!lawFirmId && org.length > 0,
    staleTime: 60_000,
  });

  return { company: data ?? null, loading: isLoading };
}

/**
 * The actual company links for a Person client. Unlike the `organization`
 * display field, these records own primary, email-delivery, and billing-access
 * settings.
 */
export function useClientCompanyRelationships(
  lawFirmId: string | undefined,
  clientId: string | undefined,
  enabled = true,
) {
  const { data, isLoading, refetch } = useQuery<ClientCompanyRelationship[]>({
    queryKey: ["clients", lawFirmId, "companyRelationships", clientId ?? null],
    queryFn: () => clientsService.listClientCompanyRelationships(lawFirmId!, clientId!),
    enabled: enabled && !!lawFirmId && !!clientId,
    staleTime: 60_000,
  });

  return { relationships: data ?? [], loading: isLoading, refresh: refetch };
}

/**
 * Which linked company (if any) a row's client id(s) resolve to, for the "why
 * is this here" badge on an item pulled in from a company the viewed person is
 * linked to (`client_company_links`) rather than from their own record.
 * `companyNames` maps a company client id to its name (build one with
 * `new Map(relationships.map(r => [r.companyClientId, r.companyName]))`); a
 * candidate that is neither present nor a company id (e.g. the viewed
 * person's own id) yields no badge. Candidates are checked in order, and an
 * array candidate (a multi-client field like `matterClientIds`) is searched
 * for the first match.
 */
export function findLinkedCompanyName(
  companyNames: Map<string, string>,
  ...candidates: Array<string | null | undefined | Array<string | null | undefined>>
): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ids = Array.isArray(candidate) ? candidate : [candidate];
    for (const id of ids) {
      if (id && companyNames.has(id)) return companyNames.get(id);
    }
  }
  return undefined;
}

/**
 * One server-paged window of clients, keyed on the exact request params so each
 * page/filter/sort combination is cached independently.
 *
 * The key is rooted at `["clients", lawFirmId]` so the invalidations the client
 * mutations already issue (`invalidateQueries({ queryKey: ["clients", lawFirmId] })`)
 * reach it by prefix match alongside the full-list query above.
 */
export function usePagedClients(
  lawFirmId: string | undefined,
  params: ServerTableQueryParams,
  enabled: boolean = true,
) {
  const { data, isLoading, isFetching, error, refetch } = useQuery<{ clients: Client[]; totalItems: number }>({
    queryKey: ["clients", lawFirmId, "paged", params],
    queryFn: () => clientsService.listClientsPaged(lawFirmId!, {
      page: params.page,
      limit: params.limit,
      sort: params.sort,
      search: params.search,
      portalOnly: params.filters.portalOnly === "true",
      matterId: params.filters.matterId,
      status: params.filters.status,
      clientType: params.filters.clientType as ClientType | undefined,
    }),
    enabled: !!lawFirmId && enabled,
    // Keep the previous page's rows and total on screen while the next page
    // loads, so the pagination footer doesn't collapse mid-transition.
    //
    // Guarded on the previous query's OWN law firm (index 1 of its key, not
    // this render's `lawFirmId`): a bare `(prev) => prev` hands over the last
    // successful result on ANY key change, not just a page/filter change
    // within the same firm. Without the guard, switching law firms rendered
    // the old firm's rows as though they were the new firm's, for as long as
    // the new firm's request took to resolve - a cross-tenant leak in the UI.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === lawFirmId ? prev : undefined),
  });

  return {
    clients: data?.clients ?? [],
    total: data?.totalItems ?? 0,
    loading: isLoading,
    fetching: isFetching,
    error: error ? (error instanceof Error ? error.message : "Failed to load clients.") : null,
    refresh: refetch,
  };
}
