"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Plus, Pencil, Trash2 } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import useDocumentRequestTemplates from "@/hooks/documentRequestsHooks/useDocumentRequestTemplates";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { DocumentRequestTemplate } from "@/services/documentRequestTemplates.service";
import DocumentRequestTemplateFormModal from "./DocumentRequestTemplateFormModal";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";

export default function DocumentRequestTemplatesSettings() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("settings.manageFirm");

  const { templates, loading, error, createTemplate, updateTemplate, deleteTemplate } =
    useDocumentRequestTemplates(lawFirmId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DocumentRequestTemplate | null>(null);
  const [toDelete, setToDelete] = useState<DocumentRequestTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (template: DocumentRequestTemplate) => {
    setEditing(template);
    setModalOpen(true);
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
            Document Request Presets
          </SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Reusable presets for document requests. Applying one prefills the title, note, and
            requested items when a team member creates a new request.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={openCreate}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New preset
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
          You need <code>settings.manageFirm</code> permission to create, edit, or delete document request presets.
        </div>
      )}

      {loading ? (
        <PanelLoadingSpinner label="Loading presets" />
      ) : templates.length === 0 ? (
        <p className="text-sm text-on-surface-secondary">No document request presets yet.</p>
      ) : (
        <ul className="rounded-xl border border-outline overflow-hidden divide-y divide-outline-subtle">
          {templates.map((template) => (
            <li key={template.id} className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-on-surface">{template.name}</span>
                  <span className="rounded-full bg-surface-alt border border-outline-subtle px-2 py-0.5 text-[11px] text-on-surface-secondary">
                    {template.items.length} item{template.items.length === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-on-surface-muted truncate">{template.defaultTitle}</p>
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-1">
                  <ActionIconButton label="Edit preset" tooltip="Edit" onClick={() => openEdit(template)}>
                    <Pencil size={15} />
                  </ActionIconButton>
                  <ActionIconButton
                    label="Delete preset"
                    tooltip="Delete"
                    tone="danger"
                    onClick={() => setToDelete(template)}
                  >
                    <Trash2 size={15} />
                  </ActionIconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <DocumentRequestTemplateFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        onCreate={createTemplate}
        onUpdate={updateTemplate}
      />

      <ConfirmModal
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete document request preset"
        message={`Delete the preset "${toDelete?.name ?? ""}"? This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
      />
    </div>
  );
}
