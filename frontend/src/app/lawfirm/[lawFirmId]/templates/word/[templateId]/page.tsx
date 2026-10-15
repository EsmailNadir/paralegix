"use client";

import { useParams } from "next/navigation";
import RequireFeature from "@/components/ui/RequireFeature";
import RequirePermission from "@/components/ui/RequirePermission";
import WordTemplateDetail from "@/components/wordTemplates/WordTemplateDetail";

export default function WordTemplateDetailPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  const templateId = (Array.isArray(params?.templateId) ? params.templateId[0] : params?.templateId) || "";
  if (!lawFirmId || !templateId) return null;

  return (
    <RequireFeature feature="templates">
      <RequirePermission permission="templates.view">
        <WordTemplateDetail lawFirmId={lawFirmId} templateId={templateId} />
      </RequirePermission>
    </RequireFeature>
  );
}
