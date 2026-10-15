"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import leadsService from "@/services/leads.service";
import type { IntakeFormFieldInput, IntakeFormTemplate } from "@/types";

export default function useIntakeForms(lawFirmId?: string) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<IntakeFormTemplate[]>({
    queryKey: ["intakeForms", lawFirmId],
    queryFn: () => leadsService.listIntakeForms(lawFirmId!),
    enabled: !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["intakeForms", lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createTemplate = useCallback(
    async (payload: {
      name: string;
      practiceAreaId?: string | null;
      fields?: IntakeFormFieldInput[];
      accessCode?: string | null;
      isActive?: boolean;
    }) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.createIntakeForm(lawFirmId, payload);
      await invalidate();
      return res.template;
    },
    [lawFirmId, invalidate],
  );

  const updateTemplate = useCallback(
    async (
      templateId: string,
      payload: {
        name?: string;
        practiceAreaId?: string | null;
        fields?: IntakeFormFieldInput[];
        accessCode?: string | null;
        isActive?: boolean;
      },
    ) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.updateIntakeForm(lawFirmId, templateId, payload);
      await invalidate();
      return res.template;
    },
    [lawFirmId, invalidate],
  );

  const deleteTemplate = useCallback(
    async (templateId: string) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.deleteIntakeForm(lawFirmId, templateId);
      await invalidate();
      return res;
    },
    [lawFirmId, invalidate],
  );

  const regenerateToken = useCallback(
    async (templateId: string) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await leadsService.regenerateIntakeFormToken(lawFirmId, templateId);
      await invalidate();
      return res.template;
    },
    [lawFirmId, invalidate],
  );

  return {
    templates: data ?? [],
    loading: isLoading,
    error,
    refetch,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    regenerateToken,
  };
}
