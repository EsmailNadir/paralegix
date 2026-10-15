"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import courtsService, { type CourtUpsertData } from "@/services/courts.service";

/**
 * Firm courts.
 *
 * `enabled` lets a caller whose court picker lives in a closed modal hold the
 * request back until the modal opens. The cache key is unchanged, so a gated
 * caller still shares one cache entry with the ungated ones.
 */
export default function useCourts(lawFirmId?: string, enabled: boolean = true) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['courts', lawFirmId],
    queryFn: () => courtsService.listCourts(lawFirmId!),
    enabled: enabled && !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['courts', lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createCourt = async (data: CourtUpsertData & { name: string }) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const response = await courtsService.createCourt(lawFirmId, data);
    await invalidate();
    return response;
  };

  const updateCourt = async (courtId: string, data: CourtUpsertData) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const response = await courtsService.updateCourt(lawFirmId, courtId, data);
    await invalidate();
    return response;
  };

  return {
    courts: data?.courts ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to load courts") : null,
    createCourt,
    updateCourt,
    refetch,
  };
}
