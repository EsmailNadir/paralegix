"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Plus } from "lucide-react";
import useLeadStages from "@/hooks/leadHooks/useLeadStages";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { LeadStage } from "@/types";
import StagePipelineEditor, { type EditorNode } from "@/components/matterComp/StagePipelineEditor";
import LeadStageFormModal from "./LeadStageFormModal";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";

const ALL_KEY = "__all__";

export default function LeadStagesSettings() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("leads.manageStages");

  const { stages, loading, error, createStage, updateStage, deleteStage } =
    useLeadStages(lawFirmId);
  const { practiceAreas } = usePracticeAreas(lawFirmId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LeadStage | null>(null);
  const [toDelete, setToDelete] = useState<LeadStage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  // A refused delete keeps the confirm dialog open, so its reason shows there.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addContext, setAddContext] = useState<{ parentStageId: string | null; practiceAreaId: string | null } | null>(null);

  useResetAfterClose(modalOpen, () => setAddContext(null));

  const groups = useMemo(() => {
    const byGroup = new Map<string, LeadStage[]>();
    for (const stage of stages) {
      const key = stage.practiceAreaId || ALL_KEY;
      const arr = byGroup.get(key) ?? [];
      arr.push(stage);
      byGroup.set(key, arr);
    }
    const ordered: { key: string; label: string; stages: LeadStage[] }[] = [];
    if (byGroup.has(ALL_KEY)) {
      ordered.push({ key: ALL_KEY, label: "Default (all leads)", stages: byGroup.get(ALL_KEY)! });
    }
    for (const pa of practiceAreas) {
      if (byGroup.has(pa.id)) {
        ordered.push({ key: pa.id, label: pa.name, stages: byGroup.get(pa.id)! });
      }
    }
    for (const [key, list] of byGroup.entries()) {
      if (key === ALL_KEY || practiceAreas.some((pa) => pa.id === key)) continue;
      ordered.push({ key, label: "Other", stages: list });
    }
    ordered.forEach((g) => g.stages.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    return ordered;
  }, [stages, practiceAreas]);

  const openCreate = () => {
    setEditing(null);
    setAddContext(null);
    setModalOpen(true);
  };
  const openEdit = (stage: LeadStage) => {
    setEditing(stage);
    setModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteStage(toDelete.id);
      setToDelete(null);
    } catch (err) {
      setDeleteError(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel gap="1">
            Lead Stages
          </SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Define the pipeline stages a lead moves through before converting to a client.
            Stages can be shared across all leads or scoped to a practice area.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={openCreate}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New stage
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
          You need <code>leads.manageStages</code> permission to create, edit, or delete lead stages.
        </div>
      )}

      {loading ? (
        <PanelLoadingSpinner label="Loading lead stages" />
      ) : groups.length === 0 ? (
        <p className="text-sm text-on-surface-secondary">No lead stages yet.</p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const practiceAreaId = group.key === ALL_KEY ? null : group.key;
            const nodes: EditorNode[] = group.stages.map((s) => ({
              id: s.id,
              name: s.name,
              color: s.color,
              isClosed: s.isClosed,
              parentId: s.parentStageId ?? null,
              sortOrder: s.sortOrder,
            }));
            return (
              <div key={group.key}>
                <h3 className="mb-2 text-xs font-semibold text-on-surface-secondary uppercase tracking-wide">
                  {group.label}
                </h3>
                <StagePipelineEditor
                  nodes={nodes}
                  readOnly={!canManage}
                  onAddChild={(parentId) => {
                    setEditing(null);
                    setAddContext({ parentStageId: parentId, practiceAreaId });
                    setModalOpen(true);
                  }}
                  onAddSibling={(nodeId) => {
                    const node = group.stages.find((s) => s.id === nodeId);
                    setEditing(null);
                    setAddContext({ parentStageId: node?.parentStageId ?? null, practiceAreaId });
                    setModalOpen(true);
                  }}
                  onEdit={(id) => {
                    const s = group.stages.find((x) => x.id === id);
                    if (s) openEdit(s);
                  }}
                  onToggleClosed={async (id) => {
                    const s = group.stages.find((x) => x.id === id);
                    if (!s) return;
                    setActionError(null);
                    try {
                      await updateStage(id, { isClosed: !s.isClosed });
                    } catch (err) {
                      setActionError(err);
                    }
                  }}
                  onDelete={(id) => {
                    const s = group.stages.find((x) => x.id === id);
                    if (s) setToDelete(s);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      <LeadStageFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        practiceAreas={practiceAreas}
        onCreate={async (stage) => createStage(stage)}
        onUpdate={async (stageId, stage) => updateStage(stageId, stage)}
        presetParentStageId={addContext?.parentStageId ?? null}
        presetPracticeAreaId={addContext?.practiceAreaId ?? null}
        lockScope={!!addContext}
      />

      <ConfirmModal
        isOpen={!!toDelete}
        onClose={() => { setToDelete(null); setDeleteError(null); }}
        onConfirm={confirmDelete}
        title="Delete stage"
        message={`Delete the stage "${toDelete?.name ?? ""}"? Leads currently in this stage will need to be reassigned. This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
        error={deleteError}
      />
    </div>
  );
}
