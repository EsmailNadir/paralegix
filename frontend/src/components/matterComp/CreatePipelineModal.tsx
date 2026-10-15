"use client";

import { X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import usePipelineBuilder from "@/hooks/matterConfigHooks/usePipelineBuilder";
import type { MatterStagePipeline } from "@/types";
import PipelineBuilderFields from "./PipelineBuilderFields";

/**
 * Create a new pipeline in its own modal: name, scope, and its stages built
 * live in the same interactive editor used everywhere else (starting from a
 * single Intake stage, with an example template available on request). Used
 * from the firm settings pipelines page.
 */
export default function CreatePipelineModal({
  open,
  onClose,
  lawFirmId,
  defaultPracticeAreaId = null,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  defaultPracticeAreaId?: string | null;
  onCreated?: (pipeline: MatterStagePipeline) => void;
}) {
  const builder = usePipelineBuilder({ lawFirmId, active: open, defaultPracticeAreaId });

  const handleCreate = async () => {
    const pipeline = await builder.handleCreate();
    if (pipeline) {
      onCreated?.(pipeline);
      onClose();
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="New pipeline"
      closeIcon={<X size={18} />}
      size="4xl"
      height="fill"
      bodyClassName="min-h-0 flex-1 space-y-4 overflow-y-auto styled-scrollbar px-6 py-5"
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={builder.saving}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleCreate}
            loading={builder.saving}
            disabled={builder.saving || !builder.name.trim() || builder.drafts.length === 0}
          >
            {`Create pipeline with ${builder.drafts.length} stage${builder.drafts.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <ErrorNotification error={builder.error ? getErrorMessage(builder.error) : null} onClose={() => builder.setError(null)} />

      <PipelineBuilderFields
        name={builder.name}
        onNameChange={builder.setName}
        duplicateName={builder.duplicateName}
        scope={builder.scope}
        onScopeChange={builder.setScope}
        scopeOptions={builder.scopeOptions}
        isDefault={builder.isDefault}
        onIsDefaultChange={builder.setIsDefault}
        drafts={builder.drafts}
        editorNodes={builder.editorNodes}
        editing={builder.editing}
        onAddNode={builder.addNode}
        onFillExample={builder.fillExampleStages}
        onUpdateDraft={builder.updateDraft}
        onDeleteDraft={builder.deleteDraft}
        onEditDraft={builder.setEditingId}
        onCloseDraftEditor={() => builder.setEditingId(null)}
      />
    </Modal>
  );
}
