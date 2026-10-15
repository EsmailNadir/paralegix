"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import RequireFeature from "@/components/ui/RequireFeature";
import RequirePermission from "@/components/ui/RequirePermission";
import { TemplateEditorSkeleton } from "@/components/wordTemplates/editor-skeleton";
import WordTemplateEditor from "@/components/wordTemplates/WordTemplateEditorHost";
import { useNavigation } from "@/contexts/NavigationContext";
import { wordTemplatesService } from "@/services/wordTemplates.service";

/**
 * Edits one Word-first template. A web template opens in the visual editor; a
 * Word template opens on its read-only setup pane (placeholders, rename,
 * Re-upload, preview). A fillable-PDF template has no HTML and no .docx, so the
 * editor would have nothing to open: its content is the stored PDF, and
 * changing it means replacing that file from the detail page.
 */
function EditWordTemplate({ lawFirmId, templateId }: { lawFirmId: string; templateId: string }) {
  const { navigate } = useNavigation();
  const detailPath = `/lawfirm/${lawFirmId}/templates/word/${templateId}`;
  const { data: template } = useQuery({
    queryKey: ["word-template-detail", lawFirmId, templateId],
    queryFn: () => wordTemplatesService.getById(lawFirmId, templateId),
  });
  const isPdfForm = template?.type === "pdf-form";

  useEffect(() => {
    if (isPdfForm) navigate(detailPath);
  }, [isPdfForm, navigate, detailPath]);

  if (!template || isPdfForm) return <TemplateEditorSkeleton />;

  return (
    <WordTemplateEditor
      lawFirmId={lawFirmId}
      templateId={templateId}
      folderId={template.folderId}
      converterEnabled
      onSaved={() => navigate(detailPath)}
      onBack={() => navigate(`/lawfirm/${lawFirmId}/templates`)}
    />
  );
}

export default function EditWordTemplatePage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  const templateId = (Array.isArray(params?.templateId) ? params.templateId[0] : params?.templateId) || "";
  if (!lawFirmId || !templateId) return null;

  return (
    <RequireFeature feature="templates">
      <RequirePermission permission="templates.manage">
        <EditWordTemplate lawFirmId={lawFirmId} templateId={templateId} />
      </RequirePermission>
    </RequireFeature>
  );
}
