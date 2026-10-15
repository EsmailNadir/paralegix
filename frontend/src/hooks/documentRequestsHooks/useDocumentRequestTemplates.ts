"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import documentRequestTemplatesService, {
  type DocumentRequestTemplate,
  type CreateDocumentRequestTemplatePayload,
  type UpdateDocumentRequestTemplatePayload,
} from "@/services/documentRequestTemplates.service";

const EMPTY_TEMPLATES: DocumentRequestTemplate[] = [];

/**
 * Reads and mutations for firm-level document request templates.
 * `enabled` lets a caller (the New Request modal) defer the fetch until it's
 * actually open, rather than loading templates on every matter page visit.
 */
export default function useDocumentRequestTemplates(lawFirmId?: string, enabled = true) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<DocumentRequestTemplate[]>({
    queryKey: ["documentRequestTemplates", lawFirmId],
    queryFn: () => documentRequestTemplatesService.list(lawFirmId!),
    enabled: !!lawFirmId && enabled,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["documentRequestTemplates", lawFirmId] }),
    [lawFirmId, queryClient],
  );

  const createTemplate = useCallback(
    async (payload: CreateDocumentRequestTemplatePayload) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await documentRequestTemplatesService.create(lawFirmId, payload);
      await invalidate();
      return res.template;
    },
    [lawFirmId, invalidate],
  );

  const updateTemplate = useCallback(
    async (templateId: string, payload: UpdateDocumentRequestTemplatePayload) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await documentRequestTemplatesService.update(lawFirmId, templateId, payload);
      await invalidate();
      return res.template;
    },
    [lawFirmId, invalidate],
  );

  const deleteTemplate = useCallback(
    async (templateId: string) => {
      if (!lawFirmId) throw new Error("Law firm ID is required");
      const res = await documentRequestTemplatesService.remove(lawFirmId, templateId);
      await invalidate();
      return res;
    },
    [lawFirmId, invalidate],
  );

  return {
    templates: data ?? EMPTY_TEMPLATES,
    loading: isLoading,
    error,
    refetch,
    createTemplate,
    updateTemplate,
    deleteTemplate,
  };
}
