"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import leadsService from "@/services/leads.service";
import type { LeadStage } from "@/types";

/**
 * Reads and mutations for firm-level lead stages (the lead pipeline).
 */
export default function useLeadStages(lawFirmId?: string) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<LeadStage[]>({
    queryKey: ["leadStages", lawFirmId],
    queryFn: () => leadsService.listStages(lawFirmId!),
    enabled: !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["leadStages", lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createStage = useCallback(
    async (stage: Partial<LeadStage>) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.createStage(lawFirmId, stage);
      await invalidate();
      return res.stage;
    },
    [lawFirmId, invalidate],
  );

  const updateStage = useCallback(
    async (stageId: string, stage: Partial<LeadStage>) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.updateStage(lawFirmId, stageId, stage);
      await invalidate();
      return res.stage;
    },
    [lawFirmId, invalidate],
  );

  const deleteStage = useCallback(
    async (stageId: string) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.deleteStage(lawFirmId, stageId);
      await invalidate();
      return res;
    },
    [lawFirmId, invalidate],
  );

  const reorderStages = useCallback(
    async (stageIds: string[]) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.reorderStages(lawFirmId, stageIds);
      await invalidate();
      return res.stages;
    },
    [lawFirmId, invalidate],
  );

  return {
    stages: data ?? [],
    loading: isLoading,
    error,
    refetch,
    createStage,
    updateStage,
    deleteStage,
    reorderStages,
  };
}
