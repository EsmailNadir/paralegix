"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import mattersService, {
  type FullLookupItem,
  type LookupItem,
  type LookupResult,
} from "@/services/matters.service";
import clientsService from "@/services/clients.service";
import tasksService from "@/services/tasks.service";
import contactsService from "@/services/contacts.service";
import { LOOKUP_MAX_LIMIT, LOOKUP_PAGE_SIZE } from "@/lib/constants/search";

export type LookupEntity = "matters" | "clients" | "tasks" | "contacts";

export type { LookupItem, FullLookupItem, LookupResult };

/**
 * Cache key for a lookup request.
 *
 * The key deliberately starts with `[entity, lawFirmId]` because that is the
 * cache root every mutation already invalidates by
 * (`invalidateQueries({ queryKey: ['matters', lawFirmId] })`), and React Query
 * matches keys by prefix. Rooting these anywhere else (e.g. `['lookup', ...]`)
 * would put lookup results outside the reach of those invalidations, so pickers
 * would keep serving stale options after a create or a rename.
 */
export interface LookupScope {
  /** Restrict the result to specific item IDs. */
  ids?: string[];
  /** Matters lookup: restrict to matters linked to this client. */
  clientId?: string;
  /** Clients lookup: restrict to clients linked to this matter. */
  matterId?: string;
  /**
   * Clients lookup: drop archived clients from the browsable options. Excludes
   * ONLY 'archived' status; 'inactive' clients stay selectable.
   *
   * The server ignores it when resolving `ids`, so an already-saved selection
   * whose client has since been archived still resolves its name instead of
   * rendering blank. That asymmetry is the point: it keeps archived clients out
   * of new work without rewriting history on existing records.
   */
  excludeArchived?: boolean;
  /**
   * Clients lookup: only clients that have a linked portal account, so every
   * returned row carries a non-null `userId`.
   *
   * This is the scope that decides who can be offered as a portal e-signature
   * signer, so it is load-bearing rather than cosmetic: a picker that shared a
   * cache entry with an unscoped clients lookup would start offering clients
   * with no portal identity to sign a legal document.
   */
  portalOnly?: boolean;
  /**
   * Clients lookup: restrict to one client type ('person' or 'company'). Used by
   * the org quick-add picker (organization-clients plan Phase 7), which must
   * never offer a person client where a company `clients.id` is expected.
   */
  clientType?: "person" | "company";
  /**
   * Clients lookup: drop clients already linked to this company client, for
   * the "add an existing client" picker on a company's Related Clients tab,
   * so it cannot offer someone the link endpoint would then reject as a
   * duplicate. Like `excludeArchived`, the server ignores it when resolving
   * `ids`.
   */
  excludeLinkedToClientId?: string;
  /** Matters, clients and contacts lookups: return the complete enriched record on each item. */
  full?: boolean;
  /**
   * Contacts lookup: drop the contacts already linked to this matter from the
   * browsable options, so the "add a contact to this matter" picker cannot offer
   * a duplicate the link endpoint would then reject. Like `excludeArchived`, the
   * server ignores it when resolving `ids`.
   */
  excludeMatterId?: string;
}

type LookupQuery = { search?: string; exactName?: string; ids?: string[]; userIds?: string[] } & LookupScope;

export function lookupQueryKey(
  entity: LookupEntity,
  lawFirmId: string | undefined,
  params: LookupQuery
) {
  return [
    entity,
    lawFirmId ?? null,
    "lookup",
    // An empty ids lookup is disabled, but React Query still lets it observe an
    // existing cache entry with the same key. Keep resolution and browse/search
    // in distinct cache modes so an empty selected-id query cannot subscribe to
    // the unfiltered browse page and leak those stale rows into typed results.
    //
    // `userIds` is its own mode for the same reason, and because it answers a
    // different question: the same string is a client-row id in one mode and a
    // portal Firebase UID in the other, so the two must never share an entry.
    // Exact-name checks also need their own mode even while the name is empty:
    // a disabled duplicate check still observes cached data, and must not read
    // the unfiltered browse results stored by an ordinary empty search.
    params.ids !== undefined
      ? "ids"
      : params.userIds !== undefined
        ? "userIds"
        : params.exactName !== undefined
          ? "exactName"
          : "search",
    (params.search ?? "").trim() || null,
    (params.exactName ?? "").trim() || null,
    // Sorted so the same set of ids in a different order shares one cache entry.
    params.ids?.length ? [...params.ids].sort().join(",") : null,
    params.userIds?.length ? [...params.userIds].sort().join(",") : null,
    // The scope MUST be part of the key. A scoped picker sharing a cache entry
    // with an unscoped one would hand a trust transaction another client's
    // matters, which is the exact misattribution this scoping prevents.
    params.clientId ?? null,
    params.matterId ?? null,
    params.excludeArchived ? "excludeArchived" : null,
    params.excludeMatterId ?? null,
    params.excludeLinkedToClientId ?? null,
    params.portalOnly ? "portalOnly" : null,
    params.clientType ?? null,
    params.full ? "full" : null,
  ] as const;
}

/**
 * `full` is a runtime request parameter, so the row type cannot be inferred from
 * it. The generic is the caller's declaration of which shape it asked the server
 * for: `LookupItem` (the default) for an ordinary lookup, `FullLookupItem` when
 * it passed `full: true`. Every branch returns the same envelope; only how many
 * fields each row carries differs.
 */
function fetchLookup<T extends LookupItem = LookupItem>(
  entity: LookupEntity,
  lawFirmId: string,
  params: LookupQuery & { limit?: number }
): Promise<LookupResult<T>> {
  // `userIds` is destructured out of `common` because only the clients lookup
  // understands it: no other entity has a portal identity to key on.
  const {
    clientId, matterId, excludeArchived, excludeLinkedToClientId, portalOnly, clientType, full, userIds, excludeMatterId, ...common
  } = params;
  let result: Promise<LookupResult>;
  switch (entity) {
    case "clients":
      result = clientsService.lookupClients(lawFirmId, {
        ...common, userIds, matterId, excludeArchived, excludeLinkedToClientId, portalOnly, clientType, full,
      });
      break;
    case "tasks":
      result = tasksService.lookupTasks(lawFirmId, { ...common, matterId });
      break;
    case "contacts":
      result = contactsService.lookupContacts(lawFirmId, { ...common, excludeMatterId, full });
      break;
    case "matters":
    default:
      result = mattersService.lookupMatters(lawFirmId, { ...common, clientId, full });
      break;
  }
  return result as Promise<LookupResult<T>>;
}

/**
 * Checks whether an accessible record already uses a field's proposed display
 * name. The result is advisory only: callers show a warning but never disable
 * or alter the save action.
 */
export function useDuplicateNameCheck(
  entity: Exclude<LookupEntity, "contacts">,
  lawFirmId: string | undefined,
  name: string,
  { enabled = true, excludeId, matterId }: { enabled?: boolean; excludeId?: string | null; matterId?: string | null } = {},
) {
  const [debouncedName, setDebouncedName] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedName(name.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [name]);

  const exactName = debouncedName.trim();
  // Tasks scope the check to the current matter: task titles are commonly
  // reused across matters (e.g. "Draft the complaint"), so an unscoped,
  // firm-wide match would read as a false alarm on nearly every edit.
  const scope = entity === "tasks" && matterId ? { matterId } : {};
  const { data, isFetching } = useQuery<LookupResult>({
    queryKey: lookupQueryKey(entity, lawFirmId, { exactName, ...scope }),
    queryFn: () => fetchLookup(entity, lawFirmId!, { exactName, limit: 2, ...scope }),
    enabled: enabled && !!lawFirmId && exactName.length > 0,
    staleTime: 30_000,
  });

  // Hide an old result immediately while the next name is still inside the
  // debounce window; a warning for the field's previous value would be wrong.
  const duplicate = exactName.length > 0 && name.trim() === exactName
    ? data?.items.find((item) => item.id !== excludeId) ?? null
    : null;
  return { duplicate, checking: isFetching };
}

/**
 * Server-backed typeahead options for one entity.
 *
 * The caller owns the debounce and passes an already-debounced `search`, so the
 * hook never has to guess how snappy a given field should feel.
 */
export function useEntityLookup<T extends LookupItem = LookupItem>(
  entity: LookupEntity,
  lawFirmId: string | undefined,
  {
    search = "",
    enabled = true,
    ids,
    clientId,
    matterId,
    excludeArchived,
    excludeLinkedToClientId,
    portalOnly,
    clientType,
    full,
    excludeMatterId,
  }: { search?: string; enabled?: boolean } & LookupScope = {}
) {
  const trimmed = search.trim();

  const { data, isFetching, isPlaceholderData, error } = useQuery<LookupResult<T>>({
    queryKey: lookupQueryKey(entity, lawFirmId, {
      search: trimmed,
      ids,
      clientId,
      matterId,
      excludeArchived,
      excludeLinkedToClientId,
      portalOnly,
      clientType,
      full,
      excludeMatterId,
    }),
    queryFn: () =>
      fetchLookup<T>(entity, lawFirmId!, {
        search: trimmed,
        limit: LOOKUP_PAGE_SIZE,
        ids,
        clientId,
        matterId,
        excludeArchived,
        excludeLinkedToClientId,
        portalOnly,
        clientType,
        full,
        excludeMatterId,
      }),
    enabled: enabled && !!lawFirmId,
    staleTime: 30_000,
    // Hold the previous page of results while the next one loads, so the menu
    // does not blink empty between keystrokes. Guarded on the firm id
    // (`?? null`, matching how `lookupQueryKey` stores it) so switching firms
    // does not carry over the previous firm's rows.
    placeholderData: (prev, prevQuery) => (
      prevQuery?.queryKey?.[1] === (lawFirmId ?? null) ? prev : undefined
    ),
  });

  return {
    items: data?.items ?? [],
    hasMore: data?.hasMore ?? false,
    loading: isFetching,
    // The rows on hand belong to an earlier term, held over by `placeholderData`
    // while the current one loads. Callers need this apart from `loading` to
    // tell "these results are for something else" from a background refetch of
    // results that are already correct - only the former is worth blanking a
    // list for.
    isPlaceholder: isPlaceholderData,
    error,
  };
}

/**
 * Resolves display labels for ids a form already holds.
 *
 * Kept separate from the search query because a selected value must stay
 * labelled no matter what the current search returns. Labels change rarely, and
 * a form with several pickers would otherwise refetch them constantly, hence the
 * longer staleTime.
 */
export function useEntityByIds<T extends LookupItem = LookupItem>(
  entity: LookupEntity,
  lawFirmId: string | undefined,
  ids: string[] = [],
  { clientId, matterId, excludeArchived, excludeLinkedToClientId, portalOnly, clientType, full, excludeMatterId }: LookupScope = {}
) {
  const wanted = ids.filter(Boolean);

  const { data, isFetching } = useQuery<LookupResult<T>>({
    queryKey: lookupQueryKey(entity, lawFirmId, {
      ids: wanted,
      clientId,
      matterId,
      excludeArchived,
      excludeLinkedToClientId,
      portalOnly,
      clientType,
      full,
      excludeMatterId,
    }),
    queryFn: () =>
      fetchLookup<T>(entity, lawFirmId!, {
        ids: wanted,
        // The server caps `limit` at LOOKUP_MAX_LIMIT, so ask for at most that
        // many. Callers holding more selections than the cap must chunk.
        limit: Math.min(wanted.length, LOOKUP_MAX_LIMIT),
        clientId,
        matterId,
        // Sent for key/scope symmetry with the search query. The server ignores
        // both in `ids` mode, which is what keeps an already-saved selection
        // labelled rather than blank - even once it has been archived, or linked
        // to the very matter/company the browse list excludes.
        excludeArchived,
        excludeLinkedToClientId,
        portalOnly,
        clientType,
        full,
        excludeMatterId,
      }),
    enabled: !!lawFirmId && wanted.length > 0,
    staleTime: 5 * 60_000,
  });

  return {
    items: data?.items ?? [],
    loading: isFetching,
  };
}

/**
 * Which key the values being resolved are expressed in. `id` is the record's own
 * id; `userId` is a client's linked portal Firebase UID, for pickers whose value
 * identifies a person rather than a client record. `userId` is meaningful for the
 * clients entity only, since nothing else has a portal identity.
 */
export type LookupIdentifyBy = "id" | "userId";

/**
 * Resolves labels for any number of values by splitting them into server-sized
 * chunks. `useEntityByIds` on its own can only resolve LOOKUP_MAX_LIMIT values,
 * which multi-select pickers routinely exceed.
 *
 * `identifyBy: "userId"` sends the same chunks through the lookup's `userIds`
 * key instead of `ids`, so a picker holding portal UIDs can label its selection.
 */
export function useEntityByIdsChunked<T extends LookupItem = LookupItem>(
  entity: LookupEntity,
  lawFirmId: string | undefined,
  ids: string[] = [],
  scope: LookupScope & { identifyBy?: LookupIdentifyBy } = {}
) {
  const wanted = useMemo(() => ids.filter(Boolean), [ids]);

  const chunks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < wanted.length; i += LOOKUP_MAX_LIMIT) {
      out.push(wanted.slice(i, i + LOOKUP_MAX_LIMIT));
    }
    return out;
  }, [wanted]);

  const { clientId, matterId, excludeArchived, portalOnly, clientType, full, identifyBy = "id" } = scope;

  // Exactly one of the two resolution keys is ever set: the server rejects a
  // request carrying both.
  const keyFor = (chunk: string[]) =>
    identifyBy === "userId" ? { userIds: chunk } : { ids: chunk };

  // `combine` flattens the per-chunk results inside React Query, which memoizes
  // the output for us; mapping over the results array in a useMemo would rebuild
  // it on every render instead.
  return useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: lookupQueryKey(entity, lawFirmId, {
        ...keyFor(chunk),
        clientId,
        matterId,
        excludeArchived,
        portalOnly,
        clientType,
        full,
      }),
      queryFn: () =>
        fetchLookup<T>(entity, lawFirmId!, {
          ...keyFor(chunk),
          limit: chunk.length,
          clientId,
          matterId,
          excludeArchived,
          portalOnly,
          clientType,
          full,
        }),
      enabled: !!lawFirmId && chunk.length > 0,
      staleTime: 5 * 60_000,
    })),
    combine: (results) => ({
      items: results.flatMap((r) => (r.data as LookupResult<T> | undefined)?.items ?? []),
      loading: results.some((r) => r.isFetching),
    }),
  });
}
