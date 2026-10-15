"use client";

import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Check, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import useIntakeForms from "@/hooks/leadHooks/useIntakeForms";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import StatusBadge from "@/components/ui/StatusBadge";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { publicIntakeUrl } from "@/lib/intakeForms";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import type { IntakeFormTemplate } from "@/types";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";

const inputClass = FULL_INPUT_CLS;

export default function IntakeFormsSettings() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("leads.manage");

  const { navigate } = useNavigation();
  const { templates, loading, error, deleteTemplate, regenerateToken } = useIntakeForms(lawFirmId);

  const [toDelete, setToDelete] = useState<IntakeFormTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...templates].sort((a, b) => a.name.localeCompare(b.name)),
    [templates],
  );

  const editorBase = `/lawfirm/${lawFirmId}/settings/matter-config/intake-forms`;
  const openCreate = () => navigate(`${editorBase}/new`);
  const openEdit = (template: IntakeFormTemplate) =>
    navigate(`${editorBase}/${encodeURIComponent(template.id)}`);

  const handleCopy = async (template: IntakeFormTemplate) => {
    try {
      await navigator.clipboard.writeText(publicIntakeUrl(template.publicToken));
      setCopiedId(template.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setActionError(new Error("Could not copy the link. Copy it manually instead."));
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteTemplate(toDelete.id);
      setToDelete(null);
    } catch (err) {
      setActionError(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel gap="1">
            Intake Forms
          </SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Build public intake forms. Share the link to capture new leads, or send a form
            to a specific lead from the Leads tab.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={openCreate}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New form
          </Button>
        )}
      </div>

      <ErrorNotification
        error={error ? getErrorMessage(error) : actionError ? getErrorMessage(actionError) : null}
        onClose={() => setActionError(null)}
        className="mb-4"
      />

      {!canManage && (
        <div className="mb-4 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          You need <code>leads.manage</code> permission to create or edit intake forms.
        </div>
      )}

      {loading ? (
        <PanelLoadingSpinner label="Loading intake forms" />
      ) : sorted.length === 0 ? (
        <p className="text-sm text-on-surface-secondary">No intake forms yet.</p>
      ) : (
        <div className="bg-surface rounded-2xl border border-outline-subtle overflow-hidden divide-y divide-outline-subtle">
          {sorted.map((template) => {
            const url = publicIntakeUrl(template.publicToken);
            return (
              <div key={template.id} className="px-5 py-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-on-surface truncate">{template.name}</p>
                      <StatusBadge variant={template.isActive ? "success" : "neutral"}>
                        {template.isActive ? "Active" : "Inactive"}
                      </StatusBadge>
                      {template.hasAccessCode && (
                        <StatusBadge variant="info">Access code</StatusBadge>
                      )}
                    </div>
                    {(template.fields || []).length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {(template.fields || []).map((f) => (
                          <span
                            key={f.key}
                            className="inline-flex items-center gap-0.5 rounded-full bg-surface-alt border border-outline-subtle px-2 py-0.5 text-[11px] text-on-surface-secondary"
                          >
                            {f.label}
                            {f.required && (
                              <span className="text-amber-600 dark:text-amber-400">*</span>
                            )}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-on-surface-muted mt-0.5">No fields</p>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEdit(template)}
                        className="p-2 rounded-lg text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        aria-label="Edit form"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setToDelete(template)}
                        className="p-2 rounded-lg text-on-surface-secondary hover:bg-surface-hover hover:text-red-600 dark:hover:text-red-400 transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        aria-label="Delete form"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={url}
                    className={`${inputClass} text-xs font-mono`}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={() => handleCopy(template)}
                    className="inline-flex items-center gap-1.5 shrink-0 px-3 py-2 rounded-md border border-outline bg-surface text-on-surface text-sm font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                  >
                    {copiedId === template.id ? (
                      <Check size={15} className="text-green-600 dark:text-green-400" />
                    ) : (
                      <Copy size={15} />
                    )}
                    {copiedId === template.id ? "Copied" : "Copy"}
                  </button>
                </div>
                {canManage && (
                  <button
                    type="button"
                    onClick={async () => {
                      setActionError(null);
                      try {
                        await regenerateToken(template.id);
                      } catch (err) {
                        setActionError(err);
                      }
                    }}
                    className="text-xs text-on-surface-muted hover:text-on-surface-secondary hover:underline cursor-pointer"
                  >
                    Regenerate public link
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete intake form"
        message={`Delete the form "${toDelete?.name ?? ""}"? Existing public links will stop working. This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
      />
    </div>
  );
}
