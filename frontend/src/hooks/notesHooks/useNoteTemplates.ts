"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import noteTemplatesService, { type CreateNoteTemplateInput } from "@/services/noteTemplates.service";

export default function useNoteTemplates(lawFirmId?: string) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['noteTemplates', lawFirmId],
    queryFn: () => noteTemplatesService.listNoteTemplates(lawFirmId!),
    enabled: !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['noteTemplates', lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createNoteTemplate = async (input: CreateNoteTemplateInput) => {
    if (!lawFirmId) throw new Error("Law firm ID is required");
    const response = await noteTemplatesService.createNoteTemplate(lawFirmId, input);
    await invalidate();
    return response;
  };

  return {
    noteTemplates: data?.noteTemplates ?? [],
    loading: isLoading,
    createNoteTemplate,
  };
}
