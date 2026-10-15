"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import useMatterPipelines, { type UpdateMatterPipelineInput } from "@/hooks/matterConfigHooks/useMatterPipelines";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown from "@/components/ui/Dropdown";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { MatterStage, MatterStagePipeline } from "@/types";
import StagePipelineEditor, { type EditorNode } from "@/components/matterComp/StagePipelineEditor";
import CreatePipelineModal from "@/components/matterComp/CreatePipelineModal";
import CollapsibleSection from "@/components/ui/CollapsibleSection";
import MatterStageFormModal from "./MatterStageFormModal";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
import SectionLabel from "@/components/ui/SectionLabel";

const FIRM_WIDE = "";

export default function MatterStagesSettings() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("settings.manageFirm");

  const {
    pipelines,
    stages,
    loading,
    error,
    createStage,
    updateStage,
    deleteStage,
    updatePipeline,
    deletePipeline,
  } = useMatterPipelines(lawFirmId);
  const { practiceAreas } = usePracticeAreas(lawFirmId);
  const paNameById = useMemo(() => new Map(practiceAreas.map((pa) => [pa.id, pa.name])), [practiceAreas]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MatterStage | null>(null);
  const [toDelete, setToDelete] = useState<MatterStage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  // A refused delete is shown inside its confirm dialog, which stays open; the
  // panel banner would sit behind the backdrop.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Which pipeline + parent a newly added stage belongs to (set when "+ step/branch" is clicked).
  const [addContext, setAddContext] = useState<{ parentStageId: string | null; pipelineId: string } | null>(null);

  const [openPipelineIds, setOpenPipelineIds] = useState<Set<string>>(new Set());
  const togglePipeline = (id: string) => {
    setOpenPipelineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [createPipelineOpen, setCreatePipelineOpen] = useState(false);
  const [pipelineModalOpen, setPipelineModalOpen] = useState(false);
  const [editingPipeline, setEditingPipeline] = useState<MatterStagePipeline | null>(null);
  const [pipelineToDelete, setPipelineToDelete] = useState<MatterStagePipeline | null>(null);
  const [deletingPipeline, setDeletingPipeline] = useState(false);

  // Cleared once the form is gone: dropping it as the modal closes would swap
  // the pipeline context back to a stale one mid-fade.
  useResetAfterClose(modalOpen, () => setAddContext(null));

  // Firm-wide pipelines first, then grouped alphabetically within each scope.
  const orderedPipelines = useMemo(
    () => [...pipelines].sort((a, b) => {
      const aScope = a.practiceAreaId || "";
      const bScope = b.practiceAreaId || "";
      if (aScope !== bScope) {
        if (!aScope) return -1;
        if (!bScope) return 1;
        return (paNameById.get(aScope) || "").localeCompare(paNameById.get(bScope) || "");
      }
      return a.name.localeCompare(b.name);
    }),
    [pipelines, paNameById],
  );

  const stagesByPipeline = useMemo(() => {
    const map = new Map<string, MatterStage[]>();
    for (const stage of stages) {
      const arr = map.get(stage.pipelineId) ?? [];
      arr.push(stage);
      map.set(stage.pipelineId, arr);
    }
    map.forEach((arr) => arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    return map;
  }, [stages]);

  const openEditPipeline = (pipeline: MatterStagePipeline) => {
    setEditingPipeline(pipeline);
    setPipelineModalOpen(true);
  };

  const openEdit = (stage: MatterStage) => {
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

  const confirmDeletePipeline = async () => {
    if (!pipelineToDelete) return;
    setDeletingPipeline(true);
    setDeleteError(null);
    try {
      await deletePipeline(pipelineToDelete.id);
      setPipelineToDelete(null);
    } catch (err) {
      setDeleteError(getErrorMessage(err));
    } finally {
      setDeletingPipeline(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel gap="1">
            Pipelines
          </SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Define the stage pipelines a matter moves through. A pipeline can be shared across all
            matters or scoped to a practice area, and a firm can have more than one.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={() => setCreatePipelineOpen(true)}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New pipeline
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
          You need <code>settings.manageFirm</code> permission to create, edit, or delete pipelines.
        </div>
      )}

      {loading ? (
        <PanelLoadingSpinner label="Loading matter pipelines" />
      ) : orderedPipelines.length === 0 ? (
        <p className="text-sm text-on-surface-secondary">No pipelines yet.</p>
      ) : (
        <div className="space-y-6">
          {orderedPipelines.map((pipeline) => {
            const pipelineStages = stagesByPipeline.get(pipeline.id) ?? [];
            const nodes: EditorNode[] = pipelineStages.map((s) => ({
              id: s.id,
              name: s.name,
              color: s.color,
              isClosed: s.isClosed,
              parentId: s.parentStageId ?? null,
              sortOrder: s.sortOrder,
            }));
            const scopeLabel = pipeline.practiceAreaId
              ? paNameById.get(pipeline.practiceAreaId) || "Practice area"
              : "Firm-wide";
            return (
              <CollapsibleSection
                key={pipeline.id}
                tone="inline"
                title={pipeline.name}
                summary={`${scopeLabel}${pipeline.isDefault ? " · Default" : ""}`}
                open={openPipelineIds.has(pipeline.id)}
                onToggle={() => togglePipeline(pipeline.id)}
                actions={
                  canManage && (
                    <span className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => openEditPipeline(pipeline)}
                        className="rounded p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        aria-label={`Rename ${pipeline.name}`}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteError(null);
                          setPipelineToDelete(pipeline);
                        }}
                        className="rounded p-1 text-on-surface-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-surface-hover cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        aria-label={`Delete ${pipeline.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  )
                }
              >
                <StagePipelineEditor
                  nodes={nodes}
                  readOnly={!canManage}
                  onAddRoot={() => {
                    setEditing(null);
                    setAddContext({ parentStageId: null, pipelineId: pipeline.id });
                    setModalOpen(true);
                  }}
                  onAddChild={(parentId) => {
                    setEditing(null);
                    setAddContext({ parentStageId: parentId, pipelineId: pipeline.id });
                    setModalOpen(true);
                  }}
                  onAddSibling={(nodeId) => {
                    const node = pipelineStages.find((s) => s.id === nodeId);
                    setEditing(null);
                    setAddContext({ parentStageId: node?.parentStageId ?? null, pipelineId: pipeline.id });
                    setModalOpen(true);
                  }}
                  onEdit={(id) => {
                    const s = pipelineStages.find((x) => x.id === id);
                    if (s) openEdit(s);
                  }}
                  onToggleClosed={async (id) => {
                    const s = pipelineStages.find((x) => x.id === id);
                    if (!s) return;
                    setActionError(null);
                    try {
                      await updateStage(id, { isClosed: !s.isClosed });
                    } catch (err) {
                      setActionError(err);
                    }
                  }}
                  onDelete={(id) => {
                    const s = pipelineStages.find((x) => x.id === id);
                    if (!s) return;
                    setDeleteError(null);
                    setToDelete(s);
                  }}
                />
              </CollapsibleSection>
            );
          })}
        </div>
      )}

      <MatterStageFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        pipelineId={addContext?.pipelineId ?? editing?.pipelineId ?? ""}
        onCreate={createStage}
        onUpdate={updateStage}
        presetParentStageId={addContext?.parentStageId ?? null}
      />

      <ConfirmModal
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete stage"
        message={`Delete the stage "${toDelete?.name ?? ""}"? Matters currently in this stage will need to be reassigned. This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
        error={deleteError}
      />

      <CreatePipelineModal
        open={createPipelineOpen}
        onClose={() => setCreatePipelineOpen(false)}
        lawFirmId={lawFirmId}
      />

      <PipelineFormModal
        open={pipelineModalOpen}
        onClose={() => setPipelineModalOpen(false)}
        editing={editingPipeline}
        practiceAreas={practiceAreas}
        onUpdate={updatePipeline}
      />

      <ConfirmModal
        isOpen={!!pipelineToDelete}
        onClose={() => setPipelineToDelete(null)}
        onConfirm={confirmDeletePipeline}
        title="Delete pipeline"
        message={`Delete the "${pipelineToDelete?.name ?? ""}" pipeline and all of its stages? Matters on this pipeline will need to be reassigned to a different one. This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deletingPipeline}
        error={deleteError}
      />
    </div>
  );
}

/** Rename a pipeline, or change its practice-area scope and default flag. Stages are edited inline on the page, not here. */
function PipelineFormModal({
  open,
  onClose,
  editing,
  practiceAreas,
  onUpdate,
}: {
  open: boolean;
  onClose: () => void;
  editing: MatterStagePipeline | null;
  practiceAreas: { id: string; name: string }[];
  onUpdate: (pipelineId: string, pipeline: UpdateMatterPipelineInput) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>(FIRM_WIDE);
  const [isDefault, setIsDefault] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useSeedOnOpen(open, () => {
    setError(null);
    setSubmitting(false);
    setName(editing?.name ?? "");
    setScope(editing?.practiceAreaId ?? FIRM_WIDE);
    setIsDefault(!!editing?.isDefault);
  }, editing?.id ?? "");

  if (!editing) return null;

  const handleSubmit = async () => {
    if (!name.trim() || submitting) return;
    const payload: UpdateMatterPipelineInput = {
      name: name.trim(),
      practiceAreaId: scope || null,
      isDefault,
    };
    setSubmitting(true);
    setError(null);
    try {
      await onUpdate(editing.id, payload);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const scopeOptions = [
    { label: "Firm-wide (no practice area)", value: FIRM_WIDE },
    ...practiceAreas.map((pa) => ({ label: pa.name, value: pa.id })),
  ];

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!submitting}
      title="Rename pipeline"
      closeIcon={<X size={18} />}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !name.trim()}
          >
            Save changes
          </Button>
        </>
      }
    >
      <ErrorNotification error={error ? getErrorMessage(error) : null} onClose={() => setError(null)} />

      <div>
        <FieldLabel htmlFor="pipeline-form-name">
          Name *
        </FieldLabel>
        <TextInput
          id="pipeline-form-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Litigation pipeline"
          autoFocus
        />
      </div>

      <Dropdown
        label="Scope"
        value={scope}
        onChange={setScope}
        options={scopeOptions}
        portal
      />

      <div className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-on-surface">Default for this scope</div>
          <div className="text-xs text-on-surface-secondary">
            New matters in this scope are assigned this pipeline automatically.
          </div>
        </div>
        <ToggleSwitch
          checked={isDefault}
          onChange={() => setIsDefault((v) => !v)}
          ariaLabel="Default for this scope"
        />
      </div>
    </Modal>
  );
}
