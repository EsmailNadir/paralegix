"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import PracticeAreaService from "@/services/practiceArea.service";

export type PracticeArea = { id: string; name: string };

/**
 * The firm's practice areas.
 *
 * `enabled` lets a caller whose picker lives in a closed modal hold the request
 * back until the modal opens. The cache key is unchanged, so a gated caller
 * still shares one cache entry with the ungated ones.
 */
export default function usePracticeAreas(lawFirmId?: string, enabled: boolean = true) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['practiceAreas', lawFirmId],
    queryFn: () => PracticeAreaService.listPracticeAreas(lawFirmId!),
    enabled: enabled && !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['practiceAreas', lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createPracticeArea = async (name: string) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const response = await PracticeAreaService.createPracticeArea(lawFirmId, name);
    await invalidate();
    return response;
  };

  return {
    practiceAreas: data?.practiceAreas ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load practice areas") : null,
    createPracticeArea,
    refetch,
  };
}
