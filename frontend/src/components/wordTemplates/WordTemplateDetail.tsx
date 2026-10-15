"use client";

// The detail page of one Word-first template, for all three kinds: HTML
// (authored in the visual editor), DOCX (an uploaded Word document) and
// pdf-form (an uploaded fillable PDF).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Edit3, FileText, Tag } from "lucide-react";
import BackButton from "@/components/ui/BackButton";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import ErrorNotification from "@/components/ErrorNotification";
import LoadingSpinner from "@/components/LoadingSpinner";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { fieldLabel } from "@/lib/wordTemplates/vocabulary";
import { extractPlaceholders, extractRepeaters } from "@/lib/wordTemplates/placeholders";
import { wordTemplatesService } from "@/services/wordTemplates.service";
import type { WordTemplateType, WordTemplateWithHtml } from "@/types/wordTemplate";
import ReplaceDocxButton from "./ReplaceDocxButton";
import DeleteTemplateButton from "./DeleteTemplateButton";

// What a template is, in words rather than its stored type.
const TYPE_LABEL: Record<WordTemplateType, string> = {
  docx: "Word template",
  "pdf-form": "PDF form",
  html: "Web template",
};

const CHIP_CLASS =
  "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 bg-surface-alt text-on-surface-secondary text-sm font-medium";

export default function WordTemplateDetail({ lawFirmId, templateId }: { lawFirmId: string; templateId: string }) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const queryClient = useQueryClient();
  const canManage = hasPermission("templates.manage");
  const templatesBase = `/lawfirm/${lawFirmId}/templates`;

  const { data: template, isLoading, error, refetch } = useQuery<WordTemplateWithHtml>({
    queryKey: ["word-template-detail", lawFirmId, templateId],
    queryFn: () => wordTemplatesService.getById(lawFirmId, templateId),
    enabled: !!lawFirmId && !!templateId,
  });

  if (isLoading) return <LoadingSpinner fullPage />;

  if (!template) {
    return (
      <div className="min-h-screen bg-page">
        <div className="max-w-[1100px] mx-auto space-y-6 p-4 pl-5 md:p-6">
          <ErrorNotification error={error ?? "Template not found."} />
        </div>
      </div>
    );
  }

  const type: WordTemplateType = template.type ?? "html";

  // HTML templates carry their fields as chips in the body; Word and PDF-form
  // templates had theirs read from the file when it was stored, with each
  // repeating section's columns as "loop.field" entries.
  let fields: string[];
  let repeaters: Array<{ name: string; fields: string[] }>;
  if (type === "html") {
    fields = extractPlaceholders(template.html ?? "");
    repeaters = extractRepeaters(template.html ?? "");
  } else {
    fields = template.fields.filter((f) => !f.includes("."));
    repeaters = template.repeaters ?? [];
  }

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
    void refetch();
  };

  return (
    <div className="min-h-screen bg-page">
    <div className="max-w-[1100px] mx-auto space-y-6 p-4 pl-5 md:p-6">
      <BackButton href={templatesBase} label="Back to Templates" variant="link" />

      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 border border-accent-border-soft bg-accent-soft text-accent-emphasis">
          <FileText size={22} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-on-surface leading-tight truncate">{template.name}</h1>
          <p className="text-sm text-on-surface-secondary mt-1">
            <span className="mr-2 inline-flex h-5 items-center whitespace-nowrap rounded-md bg-surface-alt px-1.5 text-sm font-medium text-on-surface-secondary">
              {TYPE_LABEL[type]}
            </span>
            {fields.length} field{fields.length === 1 ? "" : "s"}
            {repeaters.length > 0 && (
              <> · {repeaters.length} repeating section{repeaters.length === 1 ? "" : "s"}</>
            )}
            {template.originalFileName && <> · {template.originalFileName}</>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {type === "html" && canManage && (
            <Button
              type="secondary"
              size="compact"
              onClick={() => navigate(`${templatesBase}/word/${template.id}/edit`)}
              data-testid="edit-template-cta"
            >
              <Edit3 size={14} strokeWidth={2} />
              Edit
            </Button>
          )}
          <Button
            size="compact"
            onClick={() => navigate(`${templatesBase}/word/${template.id}/fill`)}
            data-testid="fill-template-cta"
          >
            <Download size={14} strokeWidth={2} />
            Fill &amp; Download
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 bg-surface rounded-2xl border border-outline-subtle p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-on-surface">Placeholders detected</h2>
            <p className="text-xs text-on-surface-muted">
              {type === "html"
                ? "Live-scanned from the editor body."
                : type === "pdf-form"
                  ? "The fillable PDF’s own form fields."
                  : "Scanned from the uploaded .docx."}
            </p>
          </div>

          {fields.length === 0 && repeaters.length === 0 ? (
            <EmptyPlaceholders kind={type} />
          ) : (
            <div className="space-y-5">
              {fields.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted mb-2">Fields</h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {fields.map((f) => (
                      <Tooltip key={f} title={f} enterDelay={300}>
                        <li className={CHIP_CLASS} data-testid={`field-${f}`}>
                          <Tag size={11} className="shrink-0 text-on-surface-muted" />
                          <span>{fieldLabel(f)}</span>
                        </li>
                      </Tooltip>
                    ))}
                  </ul>
                </div>
              )}

              {repeaters.map((r) => (
                <div key={r.name}>
                  <h3 className="mb-2 text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted">
                    Repeating section · <span className="normal-case text-on-surface">{fieldLabel(r.name)}</span>
                  </h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {r.fields.map((f) => (
                      <Tooltip key={f} title={f} enterDelay={300}>
                        <li className={CHIP_CLASS} data-testid={`repeater-${r.name}-field-${f}`}>
                          <Tag size={11} className="shrink-0 text-on-surface-muted" />
                          <span>{fieldLabel(f)}</span>
                        </li>
                      </Tooltip>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface rounded-2xl border border-outline-subtle p-5 space-y-3 h-fit shadow-sm">
          <h2 className="text-base font-semibold text-on-surface mb-2">
            {type === "html" ? "Authoring" : "Source document"}
          </h2>
          <p className="text-xs text-on-surface-muted mb-3">
            {type === "html"
              ? "Edit the body visually. Add fields and repeaters with the toolbar."
              : type === "pdf-form"
                ? "The PDF is stored as-is. Fill sets its own form fields and flattens them, so the court’s layout is preserved exactly."
                : "The .docx is stored as-is. Fill substitutes placeholders inside the original XML: Word formatting is preserved."}
          </p>
          {type === "docx" && canManage && (
            <ReplaceDocxButton lawFirmId={lawFirmId} templateId={template.id} onReplaced={refresh} />
          )}
          {canManage && (
            <DeleteTemplateButton
              lawFirmId={lawFirmId}
              templateId={template.id}
              name={template.name}
              onDeleted={() => {
                queryClient.invalidateQueries({ queryKey: ["templates", lawFirmId] });
                navigate(templatesBase);
              }}
            />
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

function EmptyPlaceholders({ kind }: { kind: WordTemplateType }) {
  return (
    <div className="px-3 py-8 text-center">
      <p className="text-sm text-on-surface-secondary mb-1">No placeholders detected.</p>
      <p className="text-xs text-on-surface-muted">
        {kind === "html"
          ? 'Use the "Insert Field" button in the editor to add placeholders.'
          : kind === "pdf-form"
            ? "This PDF has no fillable form fields to name."
            : "Edit the Word doc to add {placeholders}, then re-upload."}
      </p>
    </div>
  );
}
