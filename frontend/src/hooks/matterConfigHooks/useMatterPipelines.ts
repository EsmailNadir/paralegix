"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import mattersService from "@/services/matters.service";
import type { MatterStage, MatterStagePipeline } from "@/types";

export interface CreateMatterPipelineInput {
  name: string;
  practiceAreaId: string | null;
  isDefault: boolean;
  stages: Array<{
    clientId: string;
    name: string;
    color: string | null;
    sortOrder: number;
    isClosed: boolean;
    parentClientId: string | null;
  }>;
}

export type UpdateMatterPipelineInput = Partial<
  Pick<MatterStagePipeline, "name" | "practiceAreaId" | "isDefault">
>;

export const matterPipelinesQueryKey = (lawFirmId?: string) => ["matterPipelines", lawFirmId] as const;

/**
 * The firm's pipelines query. Exported so a page can start the read before the
 * component that renders it mounts, under the same key and request.
 */
export function matterPipelinesQueryOptions(lawFirmId: string) {
  return {
    queryKey: matterPipelinesQueryKey(lawFirmId),
    queryFn: (): Promise<MatterStagePipeline[]> => mattersService.listPipelines(lawFirmId),
  };
}

/** One query and cache boundary for pipeline metadata and its nested stages. */
export default function useMatterPipelines(lawFirmId?: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...matterPipelinesQueryOptions(lawFirmId!),
    enabled: !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: matterPipelinesQueryKey(lawFirmId) }),
    [lawFirmId, queryClient],
  );

  const createPipeline = useCallback(async (input: CreateMatterPipelineInput) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const result = await mattersService.createPipeline(lawFirmId, input);
    await invalidate();
    return result.pipeline;
  }, [lawFirmId, invalidate]);

  const updatePipeline = useCallback(async (pipelineId: string, input: UpdateMatterPipelineInput) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const result = await mattersService.updatePipeline(lawFirmId, pipelineId, input);
    await invalidate();
    return result.pipeline;
  }, [lawFirmId, invalidate]);

  const deletePipeline = useCallback(async (pipelineId: string) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const result = await mattersService.deletePipeline(lawFirmId, pipelineId);
    await invalidate();
    return result;
  }, [lawFirmId, invalidate]);

  const createStage = useCallback(async (input: Partial<MatterStage>) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const result = await mattersService.createStage(lawFirmId, input);
    await invalidate();
    return result.stage;
  }, [lawFirmId, invalidate]);

  const updateStage = useCallback(async (stageId: string, input: Partial<MatterStage>) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const result = await mattersService.updateStage(lawFirmId, stageId, input);
    await invalidate();
    return result.stage;
  }, [lawFirmId, invalidate]);

  const deleteStage = useCallback(async (stageId: string) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const result = await mattersService.deleteStage(lawFirmId, stageId);
    await invalidate();
    return result;
  }, [lawFirmId, invalidate]);

  const pipelines = query.data ?? [];
  return {
    pipelines,
    stages: pipelines.flatMap((pipeline) => pipeline.stages ?? []),
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    createPipeline,
    updatePipeline,
    deletePipeline,
    createStage,
    updateStage,
    deleteStage,
  };
}
