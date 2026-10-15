"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useState } from "react";
import { X } from "lucide-react";
import Modal from "@/components/ui/Modal";
import OptionListEditor from "@/components/ui/OptionListEditor";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { MatterFieldDef, MatterFieldType, PracticeArea } from "@/types";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";

const FIELD_TYPE_OPTIONS: { label: string; value: MatterFieldType }[] = [
  { label: "Text", value: "text" },
  { label: "Text area", value: "textarea" },
  { label: "Number", value: "number" },
  { label: "Currency", value: "currency" },
  { label: "Date", value: "date" },
  { label: "Dropdown (single select)", value: "select" },
  { label: "Multi-select", value: "multiselect" },
  { label: "Checkbox", value: "checkbox" },
  { label: "URL", value: "url" },
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
];

const ALL_MATTERS = "__all__";

const inputClass = FULL_INPUT_CLS;
const labelClass = FIELD_LABEL_BLOCK_CLS;

interface MatterFieldFormModalProps {
  open: boolean;
  onClose: () => void;
  editing: MatterFieldDef | null;
  practiceAreas: PracticeArea[];
  onCreate: (def: Partial<MatterFieldDef>) => Promise<unknown>;
  onUpdate: (defId: string, def: Partial<MatterFieldDef>) => Promise<unknown>;
}

export default function MatterFieldFormModal({
  open,
  onClose,
  editing,
  practiceAreas,
  onCreate,
  onUpdate,
}: MatterFieldFormModalProps) {
  const [label, setLabel] = useState("");
  const [fieldType, setFieldType] = useState<MatterFieldType>("text");
  const [scope, setScope] = useState<string>(ALL_MATTERS);
  const [helpText, setHelpText] = useState("");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState<string[]>([""]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Seed the form from the edited def (or reset for a create) whenever the
  // modal is opened, or the parent swaps which def is being edited.
  useSeedOnOpen(open, () => {
    setError(null);
    setSubmitting(false);
    if (editing) {
      setLabel(editing.label ?? "");
      setFieldType(editing.fieldType ?? "text");
      setScope(editing.practiceAreaId ?? ALL_MATTERS);
      setHelpText(editing.helpText ?? "");
      setRequired(!!editing.required);
      setOptions(
        editing.options?.length ? editing.options.map((o) => o.label ?? o.value ?? "") : [""],
      );
    } else {
      setLabel("");
      setFieldType("text");
      setScope(ALL_MATTERS);
      setHelpText("");
      setRequired(false);
      setOptions([""]);
    }
  }, editing?.id ?? null);

  const needsOptions = fieldType === "select" || fieldType === "multiselect";


  const handleSubmit = async () => {
    if (!label.trim() || submitting) return;

    const cleanedOptions = options.map((o) => o.trim()).filter(Boolean);
    if (needsOptions && cleanedOptions.length === 0) {
      setError("Add at least one option for a select field.");
      return;
    }

    const payload: Partial<MatterFieldDef> = {
      label: label.trim(),
      fieldType,
      practiceAreaId: scope === ALL_MATTERS ? null : scope,
      helpText: helpText.trim() || null,
      required,
      // Backend normalizes plain strings into { label, value } pairs.
      options: needsOptions ? (cleanedOptions as unknown as MatterFieldDef["options"]) : [],
    };

    setSubmitting(true);
    setError(null);
    try {
      if (editing) {
        await onUpdate(editing.id, payload);
      } else {
        await onCreate(payload);
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const scopeOptions = [
    { label: "All matters", value: ALL_MATTERS },
    ...practiceAreas.map((pa) => ({ label: pa.name, value: pa.id })),
  ];

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={editing ? "Edit custom field" : "New custom field"}
      size="xl"
      closeIcon={<X size={18} />}
      dismissible={!submitting}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !label.trim()}
          >
            {editing ? "Save changes" : "Create field"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error ? getErrorMessage(error) : null} onClose={() => setError(null)} />

      <div>
        <label className={labelClass} htmlFor="field-label">Label *</label>
        <input
          id="field-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Opposing Counsel"
          className={inputClass}
          autoFocus
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Dropdown
          label="Field type"
          value={fieldType}
          onChange={(v) => setFieldType(v as MatterFieldType)}
          options={FIELD_TYPE_OPTIONS}
          portal
        />
        <Dropdown
          label="Applies to"
          value={scope}
          onChange={setScope}
          options={scopeOptions}
          portal
        />
      </div>

      {needsOptions && (
        <OptionListEditor options={options} onChange={setOptions} label="Options *" />
      )}

      <div>
        <label className={labelClass} htmlFor="field-help">Help text</label>
        <input
          id="field-help"
          type="text"
          value={helpText}
          onChange={(e) => setHelpText(e.target.value)}
          placeholder="Hint shown under the field"
          className={inputClass}
        />
      </div>

      <div className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-on-surface">Required</div>
          <div className="text-xs text-on-surface-secondary">
            Users must fill this field when creating or editing a matter.
          </div>
        </div>
        <ToggleSwitch
          checked={required}
          onChange={() => setRequired((v) => !v)}
          ariaLabel="Required field"
        />
      </div>
    </Modal>
  );
}
