"use client";

import { Lock, X } from "lucide-react";
import Checkbox from "@/components/ui/Checkbox";
import ColorSwatchPicker from "@/components/ui/ColorSwatchPicker";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { STAGE_COLORS } from "@/constants/stageColors";

/** A stage not yet saved to the server, held locally while a new pipeline is built. */
export type DraftStage = {
  localId: string;
  name: string;
  color: string;
  isClosed: boolean;
  parentId: string | null;
  sortOrder: number;
};

// Optional example pipeline offered while building a new one: a trunk of
// Intake -> Discovery -> Negotiation, then three parallel endings.
export const STARTER_BRANCHED: { name: string; isClosed: boolean; parent: number | null }[] = [
  { name: "Intake", isClosed: false, parent: null },
  { name: "Discovery", isClosed: false, parent: 0 },
  { name: "Negotiation", isClosed: false, parent: 1 },
  { name: "Won", isClosed: true, parent: 2 },
  { name: "Lost", isClosed: true, parent: 2 },
  { name: "Settled", isClosed: true, parent: 2 },
];

/** Inline editor for a single draft stage (name, color, ending flag), shown beneath the tree while building a new pipeline. */
export function DraftNodeEditor({
  draft,
  onChange,
  onClose,
}: {
  draft: DraftStage;
  onChange: (patch: Partial<DraftStage>) => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-outline bg-surface p-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-on-surface-secondary">Edit stage</span>
        <button
          type="button"
          onClick={onClose}
          className="text-on-surface-muted hover:text-on-surface cursor-pointer"
          aria-label="Done"
        >
          <X size={15} />
        </button>
      </div>
      <input
        type="text"
        value={draft.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="Stage name"
        className={FULL_INPUT_CLS}
        autoFocus
      />
      <ColorSwatchPicker
        colors={STAGE_COLORS}
        value={draft.color}
        onChange={(color) => onChange({ color })}
        size="sm"
        showCheck={false}
      />
      <label className="flex w-fit items-center gap-2 text-sm text-on-surface-secondary cursor-pointer">
        <Checkbox checked={draft.isClosed} onChange={(checked) => onChange({ isClosed: checked })} />
        <span className="inline-flex items-center gap-1">
          <Lock size={12} /> Ending stage (matter is finished here)
        </span>
      </label>
    </div>
  );
}
