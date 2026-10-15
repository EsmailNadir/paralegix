"use client";

import type { MatterStage } from "@/types";
import { DEFAULT_STAGE_COLOR } from "@/constants/stageColors";
import StageFormModal from "./StageFormModal";

interface MatterStageFormModalProps {
  open: boolean;
  onClose: () => void;
  editing: MatterStage | null;
  pipelineId: string; // the pipeline every stage created from this modal belongs to
  onCreate: (stage: Partial<MatterStage>) => Promise<unknown>;
  onUpdate: (stageId: string, stage: Partial<MatterStage>) => Promise<unknown>;
  presetParentStageId?: string | null; // when adding a child in the tree
  /** Render above another open dialog instead of beside it. */
  stacked?: boolean;
}

export default function MatterStageFormModal({
  open, onClose, editing, pipelineId, onCreate, onUpdate, presetParentStageId = null, stacked,
}: MatterStageFormModalProps) {
  return (
    <StageFormModal
      open={open}
      onClose={onClose}
      editing={!!editing}
      seedKey={editing?.id ?? ""}
      initialValues={{
        name: editing?.name ?? "",
        color: editing ? editing.color ?? null : DEFAULT_STAGE_COLOR,
        isClosed: !!editing?.isClosed,
      }}
      onSubmit={(values) => {
        const payload: Partial<MatterStage> = {
          ...values,
          ...(editing ? {} : { pipelineId, parentStageId: presetParentStageId ?? null }),
        };
        return editing ? onUpdate(editing.id, payload) : onCreate(payload);
      }}
      namePlaceholder="e.g. Discovery"
      closedDescription="Matters in this stage are treated as closed/won-lost in the pipeline."
      stacked={stacked}
      bodyClassName="min-h-0 flex-1 space-y-4 overflow-y-auto styled-scrollbar px-6 py-5"
    />
  );
}
