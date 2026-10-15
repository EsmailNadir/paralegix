"use client";

import { useParams } from "next/navigation";
import RequireFeature from "@/components/ui/RequireFeature";
import RequirePermission from "@/components/ui/RequirePermission";
import WordTemplateEditor from "@/components/wordTemplates/WordTemplateEditorHost";
import { useNavigation } from "@/contexts/NavigationContext";

/**
 * A new Word-first template: the editor opens on its upload step (a PDF or
 * Word document to rebuild, or a blank page). Saving creates the template and
 * returns to the library.
 */
export default function NewWordTemplatePage() {
  const params = useParams();
  const { navigate } = useNavigation();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  if (!lawFirmId) return null;
  const library = `/lawfirm/${lawFirmId}/templates`;

  return (
    <RequireFeature feature="templates">
      <RequirePermission permission="templates.manage">
        <WordTemplateEditor
          lawFirmId={lawFirmId}
          folderId={null}
          onSaved={() => navigate(library)}
          onBack={() => navigate(library)}
        />
      </RequirePermission>
    </RequireFeature>
  );
}
