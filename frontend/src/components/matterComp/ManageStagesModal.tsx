"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch, Pencil, X } from "lucide-react";
import useMatterPipelines from "@/hooks/matterConfigHooks/useMatterPipelines";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import Dropdown from "@/components/ui/Dropdown";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import ErrorNotification from "@/components/ErrorNotification";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import MattersService from "@/services/matters.service";
import StagePipelineEditor, { type EditorNode } from "@/components/matterComp/StagePipelineEditor";
import MatterStageFormModal from "@/components/settingsComp/MatterStageFormModal";
import type { Matter, MatterStage } from "@/types";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";

/** Assigns a matter to an existing pipeline. Pipeline structure is managed in settings. */
export default function ManageStagesModal({
  open,
  onClose,
  lawFirmId,
  matter,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  matter: Matter;
  onChanged?: () => void;
}) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManagePipelines = hasPermission("settings.manageFirm");
  const { pipelines, loading, createPipeline, deletePipeline, createStage, updateStage, deleteStage } = useMatterPipelines(lawFirmId);
  // Mounted closed under every matter's stage bar, so this loads on open.
  const { practiceAreas } = usePracticeAreas(lawFirmId, open);
  const practiceAreaNames = useMemo(
    () => new Map(practiceAreas.map((area) => [area.id, area.name])),
    [practiceAreas],
  );
  const [selectedPipelineId, setSelectedPipelineId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // "none": read-only preview. "choosing": asking whether an edit should apply
  // to every matter on this pipeline or fork a copy for just this one.
  // "naming": picking a name for that copy. "active": the tree preview is
  // editable and writes straight to the API.
  const [stageEditMode, setStageEditMode] = useState<"none" | "choosing" | "naming" | "active">("none");
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  // A pipeline copied for this matter exists on the server from the moment it
  // is created, because its stages are edited live. It is only kept if the
  // matter ends up assigned to it; every other way out deletes it again.
  const [copyId, setCopyId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [stageFormOpen, setStageFormOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<MatterStage | null>(null);
  const [addContext, setAddContext] = useState<{ parentStageId: string | null } | null>(null);
  const [stageToDelete, setStageToDelete] = useState<MatterStage | null>(null);
  const [deletingStage, setDeletingStage] = useState(false);

  const exitEdit = () => {
    setStageEditMode("none");
    setDuplicateName("");
    setStageFormOpen(false);
    setEditingStage(null);
    setAddContext(null);
    setStageToDelete(null);
  };

  useSeedOnOpen(open, () => {
    setSelectedPipelineId(matter.stagePipelineId ?? "");
    setSaving(false);
    setError(null);
    setDuplicating(false);
    setCopyId(null);
    setDiscarding(false);
    exitEdit();
  }, `${matter.id}|${matter.stagePipelineId ?? ""}`);

  const options = pipelines.map((pipeline) => ({
    value: pipeline.id,
    label: pipeline.practiceAreaId
      ? `${practiceAreaNames.get(pipeline.practiceAreaId) || "Practice area"} · ${pipeline.name}`
      : `Firm-wide · ${pipeline.name}`,
  }));

  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === selectedPipelineId) || null;
  const selectedStages = selectedPipeline?.stages ?? [];
  const previewNodes: EditorNode[] = selectedStages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    color: stage.color,
    isClosed: stage.isClosed,
    parentId: stage.parentStageId ?? null,
    sortOrder: stage.sortOrder,
  }));

  const startEdit = () => {
    if (!selectedPipeline) return;
    setStageEditMode(selectedStages.length > 0 ? "choosing" : "active");
  };

  const duplicateForThisMatter = async () => {
    if (!selectedPipeline || duplicating || !duplicateName.trim()) return;
    setDuplicating(true);
    setError(null);
    try {
      const copy = await createPipeline({
        name: duplicateName.trim(),
        practiceAreaId: selectedPipeline.practiceAreaId ?? null,
        isDefault: false,
        stages: selectedStages.map((stage) => ({
          clientId: stage.id,
          name: stage.name,
          color: stage.color ?? null,
          sortOrder: stage.sortOrder,
          isClosed: stage.isClosed,
          parentClientId: stage.parentStageId ?? null,
        })),
      });
      setCopyId(copy.id);
      setSelectedPipelineId(copy.id);
      setStageEditMode("active");
    } catch (err) {
      setError(err);
    } finally {
      setDuplicating(false);
    }
  };

  /** Deletes an unassigned copy. Resolves false, with the reason shown, when it could not. */
  const discardCopy = async (): Promise<boolean> => {
    if (!copyId) return true;
    setDiscarding(true);
    setError(null);
    try {
      await deletePipeline(copyId);
      setCopyId(null);
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setDiscarding(false);
    }
  };

  // Stays open when the copy cannot be removed, so the leftover is not hidden.
  // With no copy there is nothing to clean up, and the close is immediate.
  const leaveThen = (after: () => void) => {
    if (saving || discarding) return;
    if (!copyId) {
      after();
      return;
    }
    void discardCopy().then((removed) => { if (removed) after(); });
  };
  const requestClose = () => leaveThen(onClose);

  const save = async () => {
    if (!selectedPipelineId || selectedPipelineId === matter.stagePipelineId || saving) {
      requestClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await MattersService.updateMatter({
        lawFirmId,
        matterId: matter.id,
        stagePipelineId: selectedPipelineId,
        stageId: null,
      });
      onChanged?.();
    } catch (err) {
      setError(err);
      setSaving(false);
      return;
    }
    setSaving(false);
    // The matter moved, so the save itself stands; a copy it did not take is
    // removed before closing, and a failure to remove it is reported here.
    if (selectedPipelineId === copyId || await discardCopy()) onClose();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
    <Modal
      isOpen={open}
      onClose={requestClose}
      dismissible={!saving && !discarding}
      title="Choose pipeline"
      icon={
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent-emphasis">
          <GitBranch size={16} strokeWidth={2.2} />
        </span>
      }
      closeIcon={<X size={18} />}
      size="xl"
      height="none"
      className="border border-outline"
      bodyClassName="space-y-4 px-6 py-5"
      footer={
        <div className="w-full flex items-center justify-between gap-2">
          {canManagePipelines ? (
            <button
              type="button"
              onClick={() => leaveThen(() => {
                onClose();
                navigate(`/lawfirm/${lawFirmId}/settings/matter-config?tab=stages`);
              })}
              className="text-xs font-medium text-on-surface-secondary hover:text-on-surface cursor-pointer"
            >
              Manage pipelines
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button type="secondary" onClick={requestClose} disabled={saving} loading={discarding}>Cancel</Button>
            <Button
              type="primary"
              onClick={save}
              loading={saving}
              disabled={discarding || loading || pipelines.length === 0 || !selectedPipelineId || selectedPipelineId === matter.stagePipelineId}
            >
              Use pipeline
            </Button>
          </div>
        </div>
      }
    >
            <ErrorNotification error={error ? getErrorMessage(error) : null} onClose={() => setError(null)} />
            {loading ? (
              <ListSkeleton rows={3} label="Loading matter pipelines" />
            ) : pipelines.length > 0 ? (
              <>
                <Dropdown
                  label="Pipeline"
                  value={selectedPipelineId}
                  onChange={(value) => {
                    setSelectedPipelineId(value);
                    exitEdit();
                  }}
                  options={options}
                  busy={loading}
                  portal
                />
                <p className="text-xs text-on-surface-secondary">
                  Changing pipelines clears this matter&apos;s current stage so it can start in the new pipeline.
                </p>
                {selectedPipeline && (
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <p className="text-sm font-medium text-on-surface">Stages</p>
                      {canManagePipelines && stageEditMode === "active" && (
                        <button
                          type="button"
                          onClick={() => setStageEditMode("none")}
                          className="text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
                        >
                          Done
                        </button>
                      )}
                      {canManagePipelines && stageEditMode === "none" && (
                        <button
                          type="button"
                          onClick={startEdit}
                          className="inline-flex items-center gap-1 text-xs font-medium text-on-surface-secondary hover:text-on-surface cursor-pointer"
                        >
                          <Pencil size={12} /> Edit
                        </button>
                      )}
                    </div>
                    {stageEditMode === "choosing" && (
                      <div className="mb-2 space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                        <p className="text-xs text-on-surface-secondary">
                          Editing these stages changes the &quot;{selectedPipeline.name}&quot; pipeline for every
                          matter that uses it. To change stages for only this matter, duplicate it first.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="small" type="secondary" onClick={() => setStageEditMode("active")}>
                            Edit for all matters
                          </Button>
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => {
                              setDuplicateName(`${selectedPipeline.name} (copy)`);
                              setStageEditMode("naming");
                            }}
                          >
                            Duplicate for this matter
                          </Button>
                          <button
                            type="button"
                            onClick={() => setStageEditMode("none")}
                            className="text-xs font-medium text-on-surface-secondary hover:text-on-surface cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {stageEditMode === "naming" && (
                      <div className="mb-2 space-y-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-on-surface" htmlFor="duplicate-pipeline-name">
                            Name the copy
                          </label>
                          <input
                            id="duplicate-pipeline-name"
                            type="text"
                            value={duplicateName}
                            onChange={(e) => setDuplicateName(e.target.value)}
                            className={FULL_INPUT_CLS}
                            disabled={duplicating}
                            autoFocus
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="small"
                            type="primary"
                            onClick={duplicateForThisMatter}
                            loading={duplicating}
                            disabled={!duplicateName.trim()}
                          >
                            Create copy
                          </Button>
                          <button
                            type="button"
                            onClick={() => setStageEditMode("choosing")}
                            disabled={duplicating}
                            className="text-xs font-medium text-on-surface-secondary hover:text-on-surface cursor-pointer disabled:opacity-50"
                          >
                            Back
                          </button>
                        </div>
                      </div>
                    )}
                    <StagePipelineEditor
                      nodes={previewNodes}
                      readOnly={stageEditMode !== "active"}
                      height={240}
                      onAddRoot={() => {
                        setEditingStage(null);
                        setAddContext({ parentStageId: null });
                        setStageFormOpen(true);
                      }}
                      onAddChild={(parentId) => {
                        setEditingStage(null);
                        setAddContext({ parentStageId: parentId });
                        setStageFormOpen(true);
                      }}
                      onAddSibling={(nodeId) => {
                        const node = selectedStages.find((s) => s.id === nodeId);
                        setEditingStage(null);
                        setAddContext({ parentStageId: node?.parentStageId ?? null });
                        setStageFormOpen(true);
                      }}
                      onEdit={(id) => {
                        const s = selectedStages.find((x) => x.id === id);
                        if (s) {
                          setEditingStage(s);
                          setStageFormOpen(true);
                        }
                      }}
                      onToggleClosed={async (id) => {
                        const s = selectedStages.find((x) => x.id === id);
                        if (!s) return;
                        setError(null);
                        try {
                          await updateStage(id, { isClosed: !s.isClosed });
                        } catch (err) {
                          setError(err);
                        }
                      }}
                      onDelete={(id) => {
                        const s = selectedStages.find((x) => x.id === id);
                        if (s) setStageToDelete(s);
                      }}
                    />
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-on-surface-secondary">
                No matter pipelines have been configured yet.
              </p>
            )}
    </Modal>

    <MatterStageFormModal
      open={stageFormOpen}
      onClose={() => setStageFormOpen(false)}
      editing={editingStage}
      pipelineId={selectedPipelineId}
      onCreate={createStage}
      onUpdate={updateStage}
      presetParentStageId={addContext?.parentStageId ?? null}
      stacked
    />

    <ConfirmModal
      isOpen={!!stageToDelete}
      onClose={() => setStageToDelete(null)}
      onConfirm={async () => {
        if (!stageToDelete) return;
        setDeletingStage(true);
        setError(null);
        try {
          await deleteStage(stageToDelete.id);
          setStageToDelete(null);
        } catch (err) {
          setError(err);
        } finally {
          setDeletingStage(false);
        }
      }}
      title="Delete stage"
      message={`Delete the stage "${stageToDelete?.name ?? ""}"? Matters currently in this stage will need to be reassigned. This cannot be undone.`}
      confirmText="Delete"
      confirmType="danger"
      loading={deletingStage}
      stacked
    />
    </>,
    document.body,
  );
}
