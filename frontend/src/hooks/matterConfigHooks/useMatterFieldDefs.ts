"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import mattersService from "@/services/matters.service";
import type { MatterFieldDef } from "@/types";

/**
 * The cache key for a firm's field definitions. Every reader goes under the
 * ["matterFieldDefs", firm] prefix, which is what the mutations below invalidate.
 */
export const matterFieldDefsQueryKey = (lawFirmId: string | undefined, includeArchived: boolean) =>
  ['matterFieldDefs', lawFirmId, includeArchived] as const;

/**
 * Reads and mutations for firm-level matter custom field definitions.
 * Reads go through React Query (deduped); mutations invalidate the cache.
 * `includeArchived` toggles whether archived defs are returned by the list.
 */
export default function useMatterFieldDefs(lawFirmId?: string, includeArchived = true) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<MatterFieldDef[]>({
    queryKey: matterFieldDefsQueryKey(lawFirmId, includeArchived),
    queryFn: () => mattersService.listFieldDefs(lawFirmId!, includeArchived),
    enabled: !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['matterFieldDefs', lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createFieldDef = useCallback(
    async (def: Partial<MatterFieldDef>) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await mattersService.createFieldDef(lawFirmId, def);
      await invalidate();
      return res.fieldDef;
    },
    [lawFirmId, invalidate],
  );

  const updateFieldDef = useCallback(
    async (defId: string, def: Partial<MatterFieldDef>) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await mattersService.updateFieldDef(lawFirmId, defId, def);
      await invalidate();
      return res.fieldDef;
    },
    [lawFirmId, invalidate],
  );

  const deleteFieldDef = useCallback(
    async (defId: string) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await mattersService.deleteFieldDef(lawFirmId, defId);
      await invalidate();
      return res;
    },
    [lawFirmId, invalidate],
  );

  return {
    fieldDefs: data ?? [],
    loading: isLoading,
    error,
    refetch,
    createFieldDef,
    updateFieldDef,
    deleteFieldDef,
  };
}
