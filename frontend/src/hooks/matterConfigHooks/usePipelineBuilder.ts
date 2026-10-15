"use client";

import { useState } from "react";
import useMatterPipelines from "./useMatterPipelines";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import { DEFAULT_STAGE_COLOR, STAGE_COLORS } from "@/constants/stageColors";
import { STARTER_BRANCHED, type DraftStage } from "@/components/matterComp/DraftStageEditor";
import type { MatterStagePipeline } from "@/types";

export const FIRM_WIDE = "";

/**
 * Shared state and creation logic for building a new matter stage pipeline:
 * name, scope, default flag, and its stages drafted live in the flowchart
 * editor used by the Matter Configuration creation modal.
 *
 * `active` mirrors `useSeedOnOpen`'s `open`: pass whatever condition means
 * "this builder is the thing currently on screen" so the draft state resets
 * each time it comes back into view instead of carrying over stale edits.
 */
export default function usePipelineBuilder({
  lawFirmId,
  active,
  defaultPracticeAreaId = null,
}: {
  lawFirmId: string;
  active: boolean;
  defaultPracticeAreaId?: string | null;
}) {
  const { pipelines, createPipeline } = useMatterPipelines(lawFirmId);
  const { practiceAreas } = usePracticeAreas(lawFirmId);

  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>(FIRM_WIDE);
  const [isDefault, setIsDefault] = useState(false);
  const [drafts, setDrafts] = useState<DraftStage[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [seq] = useState(() => ({ n: 0 }));

  const nextId = () => `d${(seq.n += 1)}`;

  const addNode = (parentId: string | null, stageName = "New stage") => {
    const id = nextId();
    setDrafts((prev) => {
      const siblings = prev.filter((d) => d.parentId === parentId).length;
      return [
        ...prev,
        { localId: id, name: stageName, color: STAGE_COLORS[prev.length % STAGE_COLORS.length], isClosed: false, parentId, sortOrder: siblings },
      ];
    });
    setEditingId(id);
  };

  /** Swap the single starter stage for the branching example pipeline. */
  const fillExampleStages = () => {
    seq.n = 0;
    const ids = STARTER_BRANCHED.map(() => nextId());
    setDrafts(
      STARTER_BRANCHED.map((s, i) => ({
        localId: ids[i],
        name: s.name,
        color: STAGE_COLORS[i % STAGE_COLORS.length],
        isClosed: s.isClosed,
        parentId: s.parent === null ? null : ids[s.parent],
        sortOrder: STARTER_BRANCHED.slice(0, i).filter((previous) => previous.parent === s.parent).length,
      })),
    );
    setEditingId(null);
  };

  const updateDraft = (id: string, patch: Partial<DraftStage>) =>
    setDrafts((prev) => prev.map((d) => (d.localId === id ? { ...d, ...patch } : d)));

  const deleteDraft = (id: string) =>
    setDrafts((prev) => {
      const target = prev.find((d) => d.localId === id);
      if (!target) return prev;
      // Promote children to the deleted node's parent (mirror backend semantics).
      return prev
        .filter((d) => d.localId !== id)
        .map((d) => (d.parentId === id ? { ...d, parentId: target.parentId } : d));
    });

  useSeedOnOpen(active, () => {
    setName("");
    setScope(defaultPracticeAreaId ?? FIRM_WIDE);
    setIsDefault(false);
    setEditingId(null);
    setSaving(false);
    setError(null);
    seq.n = 1;
    setDrafts([{ localId: "d1", name: "Intake", color: DEFAULT_STAGE_COLOR, isClosed: false, parentId: null, sortOrder: 0 }]);
  }, defaultPracticeAreaId ?? null);

  const editorNodes = drafts.map((d) => ({
    id: d.localId,
    name: d.name,
    color: d.color,
    isClosed: d.isClosed,
    parentId: d.parentId,
    sortOrder: d.sortOrder,
  }));

  const editing = drafts.find((d) => d.localId === editingId) || null;
  const duplicateName = pipelines.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase()) || null;

  const scopeOptions = [
    { label: "Firm-wide (no practice area)", value: FIRM_WIDE },
    ...practiceAreas.map((pa) => ({ label: pa.name, value: pa.id })),
  ];

  /**
   * Create the pipeline, then its drafted stages parents-before-children so
   * each child can reference a real parent id. Returns the created pipeline,
   * or null if creation failed or wasn't ready (`error`/nothing is set).
   */
  const handleCreate = async (): Promise<MatterStagePipeline | null> => {
    if (!name.trim() || !drafts.length || saving) return null;
    setSaving(true);
    setError(null);
    try {
      const practiceAreaId = scope || null;
      const pipeline = await createPipeline({
        name: name.trim(),
        practiceAreaId,
        isDefault,
        stages: drafts.map((draft) => ({
          clientId: draft.localId,
          name: draft.name.trim(),
          color: draft.color || null,
          sortOrder: draft.sortOrder,
          isClosed: draft.isClosed,
          parentClientId: draft.parentId,
        })),
      });
      // Only reset `saving` on failure: on success the caller is about to
      // close or switch away from this view, and leaving it true keeps the
      // duplicate-name warning (which now legitimately matches, since the
      // pipeline just got created) from flashing in the last render before
      // that happens.
      return pipeline;
    } catch (e) {
      setError(e);
      setSaving(false);
      return null;
    }
  };

  return {
    name, setName, scope, setScope, isDefault, setIsDefault,
    drafts, editorNodes, editing, editingId, setEditingId,
    addNode, fillExampleStages, updateDraft, deleteDraft,
    duplicateName, scopeOptions, saving, error, setError,
    handleCreate,
  };
}
