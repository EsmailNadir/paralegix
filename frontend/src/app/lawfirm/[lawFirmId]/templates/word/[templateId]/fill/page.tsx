"use client";

import { useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { TemplateEditorSkeleton } from "@/components/wordTemplates/editor-skeleton";
import { useNavigation } from "@/contexts/NavigationContext";

/**
 * Filling is a form owned by the Word-first library. This route keeps fill
 * links working: it opens the library with the fill form open on this
 * template, and the matter preselected when the link names one.
 */
export default function FillWordTemplatePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { navigate } = useNavigation();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  const templateId = (Array.isArray(params?.templateId) ? params.templateId[0] : params?.templateId) || "";
  const matterId = searchParams.get("matterId");

  useEffect(() => {
    if (!lawFirmId || !templateId) return;
    const query = new URLSearchParams({ fill: templateId });
    if (matterId) query.set("matterId", matterId);
    navigate(`/lawfirm/${lawFirmId}/templates?${query.toString()}`);
  }, [lawFirmId, templateId, matterId, navigate]);

  return <TemplateEditorSkeleton />;
}
