"use client";

import Dropdown from "@/components/ui/Dropdown";
import type { LeadStage, PracticeArea } from "@/types";
import { FIELD_LABEL_BLOCK_CLS } from "@/components/ui/inputClasses";
import { DEFAULT_STAGE_COLOR } from "@/constants/stageColors";
import StageFormModal from "./StageFormModal";

const ALL_LEADS = "__all__";

interface LeadStageFormModalProps {
  open: boolean;
  onClose: () => void;
  editing: LeadStage | null;
  practiceAreas: PracticeArea[];
  onCreate: (stage: Partial<LeadStage>) => Promise<unknown>;
  onUpdate: (stageId: string, stage: Partial<LeadStage>) => Promise<unknown>;
  presetParentStageId?: string | null; // when adding a child in the tree
  presetPracticeAreaId?: string | null; // force the new node's scope to the parent's
  lockScope?: boolean; // show the scope read-only on create (child must match its parent)
}

export default function LeadStageFormModal({
  open, onClose, editing, practiceAreas, onCreate, onUpdate,
  presetParentStageId = null, presetPracticeAreaId = null, lockScope = false,
}: LeadStageFormModalProps) {
  // An existing stage's pipeline is fixed: its parent and children live in the
  // same one, and the backend refuses a move. Editing shows the scope read-only.
  const scopeLocked = lockScope || !!editing;
  return (
    <StageFormModal
      open={open}
      onClose={onClose}
      editing={!!editing}
      seedKey={[editing?.id ?? "", presetPracticeAreaId ?? ""].join("|")}
      initialValues={{
        name: editing?.name ?? "",
        color: editing ? editing.color ?? null : DEFAULT_STAGE_COLOR,
        isClosed: !!editing?.isClosed,
        scope: editing ? editing.practiceAreaId ?? ALL_LEADS : presetPracticeAreaId ?? ALL_LEADS,
      }}
      onSubmit={({ name, color, isClosed, scope }) => {
        const payload: Partial<LeadStage> = editing
          ? { name, color, isClosed }
          : {
            name, color, isClosed,
            practiceAreaId: scope === ALL_LEADS ? null : scope,
            parentStageId: presetParentStageId ?? null,
          };
        return editing ? onUpdate(editing.id, payload) : onCreate(payload);
      }}
      namePlaceholder="e.g. Qualifying"
      closedDescription="Leads in this stage are treated as closed/won-lost in the pipeline."
      renderScope={(values, onChange) => scopeLocked ? (
        <div>
          <label className={FIELD_LABEL_BLOCK_CLS}>Applies to</label>
          <p className="text-sm text-on-surface-secondary">
            {values.scope === ALL_LEADS
              ? "All leads (default pipeline)"
              : practiceAreas.find((area) => area.id === values.scope)?.name || "Practice area"}
          </p>
        </div>
      ) : (
        <Dropdown
          label="Applies to"
          value={values.scope}
          onChange={(scope) => onChange({ ...values, scope })}
          options={[
            { label: "Default (all leads)", value: ALL_LEADS },
            ...practiceAreas.map((area) => ({ label: area.name, value: area.id })),
          ]}
          portal
        />
      )}
    />
  );
}
