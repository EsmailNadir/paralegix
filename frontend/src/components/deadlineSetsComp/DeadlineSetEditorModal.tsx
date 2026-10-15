"use client";

import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useId, useState } from "react";
import { Plus, Trash2, GripVertical } from "lucide-react";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import Checkbox from "@/components/ui/Checkbox";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import ErrorNotification from "@/components/ErrorNotification";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import Modal from "@/components/ui/Modal";
import type { MatterEventType } from "@/types/matterEvent";
import type { DeadlineSet, DeadlineSetItem, CreateDeadlineSetRequest } from "@/types/deadlineSet";
import { MATTER_EVENT_TYPE_OPTIONS } from "@/constants/statusMeta";
import FieldLabel from "@/components/ui/FieldLabel";
import { getErrorMessage } from "@/lib/utils/apiErrors";

// Combines offsetDirection + relativeTo into one dropdown value ("<direction>|<relativeTo>").
const TRIGGER_OFFSET_OPTIONS = [
  { label: "after the trigger date", value: "after|trigger" },
  { label: "before the trigger date", value: "before|trigger" },
];
const PREVIOUS_OFFSET_OPTIONS = [
  { label: "after the previous deadline", value: "after|previous" },
  { label: "before the previous deadline", value: "before|previous" },
];

function offsetValue(it: DeadlineSetItem): string {
  return `${it.offsetDirection}|${it.relativeTo === "previous" ? "previous" : "trigger"}`;
}

// A row carries a key of its own so removing one from the middle does not hand
// the rows below it the inputs (focus, open dropdown) of the row above.
type Row = DeadlineSetItem & { rowKey: number };
let nextRowKey = 0;
const toRow = (item: DeadlineSetItem): Row => ({ ...item, rowKey: ++nextRowKey });

function blankItem(): Row {
  return toRow({ title: "", type: "filing_deadline", offsetDays: 30, offsetDirection: "after", relativeTo: "trigger", clientVisible: false, notes: null });
}

interface Props {
  open: boolean;
  editing: DeadlineSet | null;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: CreateDeadlineSetRequest) => Promise<void> | void;
}

const inputClass = FULL_INPUT_CLS;

export default function DeadlineSetEditorModal({ open, editing, saving, onClose, onSave }: Props) {
  const fieldIds = useId();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [adjustForWeekends, setAdjustForWeekends] = useState(false);
  const [items, setItems] = useState<Row[]>(() => [blankItem()]);
  const [error, setError] = useState<string | null>(null);

  // Reseed the form whenever the modal opens (from a template or blank), during
  // render so the first frame never shows the previous session's set.
  useSeedOnOpen(open, () => {
    setError(null);
    if (editing) {
      setName(editing.name);
      setDescription(editing.description || "");
      setAdjustForWeekends(editing.adjustForWeekends);
      setItems(editing.items.length ? editing.items.map(toRow) : [blankItem()]);
    } else {
      setName("");
      setDescription("");
      setAdjustForWeekends(false);
      setItems([blankItem()]);
    }
  }, editing?.id ?? null);

  // The page clears `editing` in the same handler that closes this, so the
  // heading and the submit label would flip to their "new" wording while the
  // modal is still fading out.
  const isEditing = useLastOpenValue(open, !!editing);

  const updateItem = (idx: number, patch: Partial<DeadlineSetItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  const addItem = () => setItems((prev) => [...prev, blankItem()]);
  const removeItem = (idx: number) =>
    setItems((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, i) => i !== idx);
      // The new first item can't chain off a "previous" deadline anymore.
      if (next[0]?.relativeTo === "previous") next[0] = { ...next[0], relativeTo: "trigger" };
      return next;
    });

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Give the deadline set a name.");
      return;
    }
    const cleaned = items
      .map((it) => ({ ...it, title: it.title.trim() }))
      .filter((it) => it.title.length > 0);
    if (cleaned.length === 0) {
      setError("Add at least one deadline with a title.");
      return;
    }
    for (const it of cleaned) {
      if (!Number.isFinite(it.offsetDays) || it.offsetDays < 0) {
        setError(`"${it.title}" needs a valid number of days (0 or more).`);
        return;
      }
    }
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        adjustForWeekends,
        items: cleaned.map((it, idx) => ({
          title: it.title,
          type: it.type,
          offsetDays: Math.round(it.offsetDays),
          offsetDirection: it.offsetDirection,
          // Blank titles are dropped above, which can shift indexes, so the
          // first-item check has to run post-filter, not on the raw `items`.
          relativeTo: idx === 0 ? "trigger" : it.relativeTo === "previous" ? "previous" : "trigger",
          clientVisible: it.clientVisible === true,
          notes: it.notes?.trim() || null,
        })),
      });
    } catch (err) {
      // The page leaves a refused save to this dialog, which is still open.
      setError(getErrorMessage(err));
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={isEditing ? "Edit deadline set" : "New deadline set"}
      subtitle="A reusable recipe. Applying it to a matter creates every deadline below, each dated from a trigger date you pick or from the deadline above it."
      size="2xl"
      dismissible={!saving}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSave}
            loading={saving}
            disabled={saving || !name.trim()}
          >
            {isEditing ? "Save changes" : "Create deadline set"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />

      <div>
        <FieldLabel htmlFor={`${fieldIds}-name`}>Name *</FieldLabel>
        <input
          id={`${fieldIds}-name`}
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Civil Complaint Filed"
          maxLength={200}
        />
      </div>

      <div>
        <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
        <input
          id={`${fieldIds}-description`}
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When to use this set"
          maxLength={1000}
        />
      </div>

      <label className="flex items-center justify-between gap-4 rounded-md border border-outline-subtle bg-surface-alt px-3 py-2.5">
        <span className="text-sm text-on-surface">
          Move weekend deadlines to Monday
          <span className="block text-xs text-on-surface-muted">
            If a computed date lands on a Saturday or Sunday, roll it to the following Monday.
          </span>
        </span>
        <ToggleSwitch checked={adjustForWeekends} onChange={() => setAdjustForWeekends((v) => !v)} ariaLabel="Move weekend deadlines to Monday" />
      </label>

      {/* Deadlines */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium text-on-surface">Deadlines *</label>
          <span className="text-xs text-on-surface-muted">{items.length} in this set</span>
        </div>

        <div className="space-y-2">
          {items.map((it, idx) => (
            <div key={it.rowKey} className="rounded-lg border border-outline bg-surface-alt p-3">
              <div className="flex items-start gap-2">
                <GripVertical size={15} className="mt-2 text-on-surface-muted shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <input
                    className={inputClass}
                    value={it.title}
                    onChange={(e) => updateItem(idx, { title: e.target.value })}
                    placeholder="Deadline title, e.g. Answer due"
                    maxLength={300}
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Dropdown
                      value={it.type}
                      onChange={(v) => updateItem(idx, { type: v as MatterEventType })}
                      options={MATTER_EVENT_TYPE_OPTIONS}
                      portal
                    />
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        max={3650}
                        className={`w-20 ${inputClass}`}
                        // A cleared field stays empty, matching the save check
                        // that refuses it, rather than showing a 0 it will not save.
                        value={Number.isFinite(it.offsetDays) ? it.offsetDays : ""}
                        onChange={(e) => updateItem(idx, { offsetDays: parseInt(e.target.value, 10) })}
                      />
                      <span className="text-sm text-on-surface-secondary shrink-0">days</span>
                    </div>
                  </div>
                  <Dropdown
                    value={offsetValue(it)}
                    onChange={(v) => {
                      const [direction, relativeTo] = v.split("|");
                      updateItem(idx, {
                        offsetDirection: direction as "before" | "after",
                        relativeTo: relativeTo as "trigger" | "previous",
                      });
                    }}
                    options={idx === 0 ? TRIGGER_OFFSET_OPTIONS : [...TRIGGER_OFFSET_OPTIONS, ...PREVIOUS_OFFSET_OPTIONS]}
                    portal
                  />
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <Checkbox
                      checked={it.clientVisible === true}
                      onChange={(c) => updateItem(idx, { clientVisible: c })}
                      label="Visible to client portal"
                    />
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      disabled={items.length === 1}
                      className="inline-flex items-center gap-1 text-xs text-on-surface-muted hover:text-red-500 disabled:opacity-40 disabled:hover:text-on-surface-muted cursor-pointer"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addItem}
          className="mt-2 inline-flex items-center gap-1.5 text-sm text-accent-emphasis hover:underline cursor-pointer"
        >
          <Plus size={14} /> Add deadline
        </button>
      </div>
    </Modal>
  );
}
