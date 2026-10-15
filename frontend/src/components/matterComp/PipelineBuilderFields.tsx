"use client";

import Dropdown from "@/components/ui/Dropdown";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import StagePipelineEditor, { type EditorNode } from "./StagePipelineEditor";
import { DraftNodeEditor, type DraftStage } from "./DraftStageEditor";

/**
 * Pipeline metadata and draft-stage editor used by `CreatePipelineModal`.
 */
export default function PipelineBuilderFields({
  name,
  onNameChange,
  duplicateName,
  scope,
  onScopeChange,
  scopeOptions,
  isDefault,
  onIsDefaultChange,
  drafts,
  editorNodes,
  editing,
  onAddNode,
  onFillExample,
  onUpdateDraft,
  onDeleteDraft,
  onEditDraft,
  onCloseDraftEditor,
}: {
  name: string;
  onNameChange: (v: string) => void;
  duplicateName: { name: string } | null;
  scope: string;
  onScopeChange: (v: string) => void;
  scopeOptions: { label: string; value: string }[];
  isDefault: boolean;
  onIsDefaultChange: (v: boolean) => void;
  drafts: DraftStage[];
  editorNodes: EditorNode[];
  editing: DraftStage | null;
  onAddNode: (parentId: string | null) => void;
  onFillExample: () => void;
  onUpdateDraft: (id: string, patch: Partial<DraftStage>) => void;
  onDeleteDraft: (id: string) => void;
  onEditDraft: (id: string) => void;
  onCloseDraftEditor: () => void;
}) {
  return (
    <>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="block text-sm font-medium text-on-surface" htmlFor="pipeline-builder-name">
            Name
          </label>
          {drafts.length <= 1 && (
            <button
              type="button"
              onClick={onFillExample}
              className="shrink-0 whitespace-nowrap text-xs font-medium text-on-surface-secondary underline hover:no-underline hover:text-on-surface cursor-pointer"
            >
              Fill in example stages
            </button>
          )}
        </div>
        <input
          id="pipeline-builder-name"
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Litigation pipeline"
          className={FULL_INPUT_CLS}
          autoFocus
        />
        {duplicateName && (
          <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
            A pipeline named &quot;{duplicateName.name}&quot; already exists.
          </p>
        )}
      </div>

      <Dropdown label="Scope" value={scope} onChange={onScopeChange} options={scopeOptions} portal />

      <div className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-on-surface">Default for this scope</div>
          <div className="text-xs text-on-surface-secondary">
            New matters in this scope are assigned this pipeline automatically.
          </div>
        </div>
        <ToggleSwitch checked={isDefault} onChange={() => onIsDefaultChange(!isDefault)} ariaLabel="Default for this scope" />
      </div>

      <p className="text-sm text-on-surface-secondary">
        Add steps with the <span className="font-medium">+</span> on a stage, add a
        parallel ending with the branch icon, and lock a stage to mark it as an ending.
      </p>

      <StagePipelineEditor
        nodes={editorNodes}
        onAddRoot={() => onAddNode(null)}
        onAddChild={(parentId) => onAddNode(parentId)}
        onAddSibling={(nodeId) => {
          const node = drafts.find((d) => d.localId === nodeId);
          onAddNode(node ? node.parentId : null);
        }}
        onEdit={onEditDraft}
        onToggleClosed={(id) => {
          const node = drafts.find((d) => d.localId === id);
          if (!node) return;
          const hasKids = drafts.some((d) => d.parentId === id);
          if (!node.isClosed && hasKids) return; // endings must be leaves
          onUpdateDraft(id, { isClosed: !node.isClosed });
        }}
        onDelete={onDeleteDraft}
      />

      {editing && (
        <DraftNodeEditor
          draft={editing}
          onChange={(patch) => onUpdateDraft(editing.localId, patch)}
          onClose={onCloseDraftEditor}
        />
      )}
    </>
  );
}
