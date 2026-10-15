"use client";

import { useQuery } from "@tanstack/react-query";
import UserService from "@/services/users.service";
import type { User } from "@/types";

/**
 * Get all users in a specific law firm.
 *
 * `enabled` lets an always-mounted caller hold the request back until the UI that
 * needs the roster is actually on screen. The cache key is unchanged, so a gated
 * caller still shares one cache entry with the ungated ones.
 *
 * There is no `setError`: `error` is React Query state, owned by the query and
 * cleared when it next succeeds, so nothing here could honour a setter. A caller
 * that wants a dismissible banner has to record the dismissal on its own side
 * (see `TasksGrid`/`MattersGrid`), because the underlying error does not go away
 * just because the user closed it.
 */
export function useLawFirmUsers(lawfirmId: string, enabled: boolean = true) {
  const { data, isLoading, error, refetch } = useQuery<User[]>({
    queryKey: ['users', lawfirmId],
    queryFn: () => UserService.getUsersByLawFirm(lawfirmId),
    enabled: enabled && !!lawfirmId,
  });

  return {
    users: data ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load users for this law firm.") : null,
    // Named to match the sibling query hooks (`useLeadById`), so a caller
    // retrying a failed page load calls the same thing on each of them.
    refresh: refetch,
  };
}
