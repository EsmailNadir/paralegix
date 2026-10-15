"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import noteTypesService from "@/services/noteTypes.service";

export default function useNoteTypes(lawFirmId?: string) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['noteTypes', lawFirmId],
    queryFn: () => noteTypesService.listNoteTypes(lawFirmId!),
    enabled: !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['noteTypes', lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createNoteType = async (label: string) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const response = await noteTypesService.createNoteType(lawFirmId, label);
    await invalidate();
    return response;
  };

  /** `value` may be a firm-custom type's slug or a built-in type's slug. */
  const updateNoteTypeColor = async (value: string, color: string) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const response = await noteTypesService.updateNoteTypeColor(lawFirmId, value, color);
    await invalidate();
    return response;
  };

  const noteTypes = data?.noteTypes ?? [];

  return {
    noteTypes,
    // Every row that carries a color, keyed by its slug - a firm-custom type's
    // own color, or a built-in type's override (see backend `note_types`).
    noteTypeColors: Object.fromEntries(
      noteTypes.filter((t) => t.color).map((t) => [t.value, t.color as string]),
    ) as Record<string, string>,
    loading: isLoading,
    createNoteType,
    updateNoteTypeColor,
  };
}
