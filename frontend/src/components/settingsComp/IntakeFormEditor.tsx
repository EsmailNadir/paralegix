"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useId, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import useIntakeForms from "@/hooks/leadHooks/useIntakeForms";
import ErrorNotification from "@/components/ErrorNotification";
import Button from "@/components/ui/Button";
import BackButton from "@/components/ui/BackButton";
import PageHeader from "@/components/ui/PageHeader";
import Dropdown from "@/components/ui/Dropdown";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import Checkbox from "@/components/ui/Checkbox";
import OptionListEditor from "@/components/ui/OptionListEditor";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import type {
  IntakeFieldType,
  IntakeFormField,
  IntakeFormFieldInput,
  IntakeFormTemplate,
} from "@/types";

const FIELD_TYPE_OPTIONS = [
  { label: "Text", value: "text" },
  { label: "Text area", value: "textarea" },
  { label: "Email", value: "email" },
  { label: "Phone", value: "phone" },
  { label: "Dropdown", value: "select" },
];

const inputClass = FULL_INPUT_CLS;
const labelClass = FIELD_LABEL_BLOCK_CLS;
const SECTION_CLS = "bg-surface rounded-2xl border border-outline-subtle p-6 space-y-4";

type DraftField = IntakeFormField & { _localId: string };

function localId(): string {
  return `f_${Math.random().toString(36).slice(2, 10)}`;
}

function emptyField(): DraftField {
  return { _localId: localId(), key: "", label: "", type: "text", required: false, options: [] };
}

/** Where the editor returns to: the Intake Forms sub-tab of Matter Config. */
export function intakeFormsListHref(lawFirmId: string): string {
  return `/lawfirm/${lawFirmId}/settings/matter-config?tab=intakeForms`;
}

function IntakeFormEditorForm({
  lawFirmId,
  editing,
  onCreate,
  onUpdate,
}: {
  lawFirmId: string;
  editing: IntakeFormTemplate | null;
  onCreate: ReturnType<typeof useIntakeForms>["createTemplate"];
  onUpdate: ReturnType<typeof useIntakeForms>["updateTemplate"];
}) {
  const { navigate } = useNavigation();
  const fieldIds = useId();
  const backHref = intakeFormsListHref(lawFirmId);

  const [name, setName] = useState(editing?.name || "");
  const [fields, setFields] = useState<DraftField[]>(() =>
    editing
      ? (editing.fields || []).map((f) => ({ ...f, _localId: localId(), options: f.options || [] }))
      : [emptyField()],
  );
  const [accessCode, setAccessCode] = useState("");
  const [clearAccessCode, setClearAccessCode] = useState(false);
  const [isActive, setIsActive] = useState(editing ? editing.isActive !== false : true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateField = (id: string, patch: Partial<DraftField>) => {
    setFields((prev) => prev.map((f) => (f._localId === id ? { ...f, ...patch } : f)));
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Form name is required");
      return;
    }
    const cleaned: IntakeFormFieldInput[] = fields
      .filter((f) => f.label.trim())
      .map((f) => ({
        // A field added here has no key yet; leaving it out lets the backend
        // derive one from the label instead of refusing an empty string.
        key: f.key.trim() || undefined,
        label: f.label.trim(),
        type: f.type,
        required: f.required === true,
        options:
          f.type === "select"
            ? (f.options || []).map((o) => o.trim()).filter(Boolean)
            : undefined,
      }));

    setSubmitting(true);
    setError(null);
    try {
      if (editing) {
        const payload: {
          name: string;
          fields: IntakeFormFieldInput[];
          isActive: boolean;
          accessCode?: string | null;
        } = { name: name.trim(), fields: cleaned, isActive };
        if (clearAccessCode) payload.accessCode = null;
        else if (accessCode.trim()) payload.accessCode = accessCode.trim();
        await onUpdate(editing.id, payload);
      } else {
        await onCreate({
          name: name.trim(),
          fields: cleaned,
          accessCode: accessCode.trim() || null,
          isActive,
        });
      }
      navigate(backHref);
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to save intake form");
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={editing ? "Edit intake form" : "New intake form"}
        description="Set the form name, who can open it, and the fields a prospective client fills in."
        actions={
          <div className="flex items-center gap-2">
            <Button type="secondary" onClick={() => navigate(backHref)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="primary"
              onClick={handleSubmit}
              loading={submitting}
              disabled={submitting || !name.trim()}
            >
              {editing ? "Save changes" : "Create form"}
            </Button>
          </div>
        }
      />

      <ErrorNotification error={error} onClose={() => setError(null)} />

      <div className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-on-surface">Details</h2>

        <div>
          <label className={labelClass} htmlFor="intake-form-name">Name *</label>
          <input
            id="intake-form-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Personal injury intake"
            className={inputClass}
            autoFocus
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-outline bg-surface-alt px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-on-surface">Active</div>
            <div className="text-xs text-on-surface-secondary">
              Inactive forms reject new public submissions.
            </div>
          </div>
          <ToggleSwitch
            checked={isActive}
            onChange={() => setIsActive((v) => !v)}
            ariaLabel="Active"
          />
        </div>

        <div>
          <label htmlFor={`${fieldIds}-accesscode`} className={labelClass}>Access code</label>
          <input
            id={`${fieldIds}-accesscode`}
            type="text"
            value={accessCode}
            onChange={(e) => {
              setAccessCode(e.target.value);
              setClearAccessCode(false);
            }}
            placeholder={
              editing?.hasAccessCode
                ? "Leave blank to keep current code"
                : "Leave blank for a fully public link"
            }
            className={inputClass}
          />
          <p className="mt-1 text-xs text-on-surface-secondary">
            At least 8 characters. Anyone holding the form link can open it, so
            the code is the only thing standing in front of it.
          </p>
          {editing?.hasAccessCode && (
            <label className="mt-2 flex items-center gap-2 text-sm text-on-surface-secondary cursor-pointer">
              <Checkbox
                checked={clearAccessCode}
                onChange={(checked) => {
                  setClearAccessCode(checked);
                  if (checked) setAccessCode("");
                }}
              />
              Remove access code
            </label>
          )}
        </div>
      </div>

      <div className={SECTION_CLS}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-on-surface">Fields</h2>
          <button
            type="button"
            onClick={() => setFields((prev) => [...prev, emptyField()])}
            className="inline-flex items-center gap-1 text-xs font-medium text-accent-emphasis hover:underline cursor-pointer"
          >
            <Plus size={13} /> Add field
          </button>
        </div>

        {fields.map((field, index) => (
          <div
            key={field._localId}
            className="rounded-lg border border-outline bg-surface-alt/50 p-3 space-y-2"
          >
            <div className="flex items-start gap-2">
              <GripVertical size={14} className="mt-2.5 text-on-surface-muted shrink-0" />
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
                <div>
                  <label htmlFor={`${fieldIds}-field-label-${field._localId}`} className={labelClass}>
                    Label{field.required === true ? " *" : ""}
                  </label>
                  <input
                    id={`${fieldIds}-field-label-${field._localId}`}
                    type="text"
                    value={field.label}
                    onChange={(e) => updateField(field._localId, { label: e.target.value })}
                    className={inputClass}
                    placeholder={`Field ${index + 1}`}
                  />
                </div>
                <div>
                  <Dropdown
                    label="Type"
                    value={field.type}
                    onChange={(v) => updateField(field._localId, { type: v as IntakeFieldType })}
                    options={FIELD_TYPE_OPTIONS}
                    portal
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setFields((prev) => prev.filter((f) => f._localId !== field._localId))
                }
                className="mt-6 p-1.5 text-on-surface-muted hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                aria-label="Remove field"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-on-surface-secondary cursor-pointer pl-5">
              <Checkbox
                checked={field.required === true}
                onChange={(checked) => updateField(field._localId, { required: checked })}
              />
              Required
            </label>
            {field.type === "select" && (
              <div className="pl-5">
                <OptionListEditor
                  options={field.options || []}
                  onChange={(options) => updateField(field._localId, { options })}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Full-page editor for one intake form template. With no `formId` it creates a
 * new form; with one it edits the matching template from the firm's list.
 */
export default function IntakeFormEditor({ formId }: { formId?: string }) {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId)
    ? params.lawFirmId[0]
    : (params?.lawFirmId as string);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("leads.manage");
  const { templates, loading, error, createTemplate, updateTemplate } = useIntakeForms(lawFirmId);

  const editing = formId ? templates.find((t) => t.id === formId) ?? null : null;

  let body: ReactNode;
  if (!canManage) {
    body = (
      <div className="rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
        You need <code>leads.manage</code> permission to create or edit intake forms.
      </div>
    );
  } else if (formId && loading) {
    body = <PanelLoadingSpinner label="Loading intake form" />;
  } else if (formId && error) {
    body = <ErrorNotification error={getErrorMessage(error)} />;
  } else if (formId && !editing) {
    body = <p className="text-sm text-on-surface-secondary">This intake form no longer exists.</p>;
  } else {
    body = (
      <IntakeFormEditorForm
        key={editing?.id ?? "new"}
        lawFirmId={lawFirmId}
        editing={editing}
        onCreate={createTemplate}
        onUpdate={updateTemplate}
      />
    );
  }

  return (
    <div className="p-4 pl-5 md:p-6 pb-8 md:pb-6 min-w-0 space-y-4">
      <BackButton href={intakeFormsListHref(lawFirmId)} label="Back to intake forms" variant="link" />
      {body}
    </div>
  );
}
