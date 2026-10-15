"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal, Pencil, X, ExternalLink } from "lucide-react";
import mattersService from "@/services/matters.service";
import { matterFieldDefsQueryKey } from "@/hooks/matterConfigHooks/useMatterFieldDefs";
import type { Matter, MatterFieldDef } from "@/types";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import Checkbox from "@/components/ui/Checkbox";
import ToggleSwitch from "@/components/ui/ToggleSwitch";
import ErrorNotification from "@/components/ErrorNotification";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { formatDateOnly } from "@/lib/utils/dateUtils";

const INPUT_CLASS = FULL_INPUT_CLS;
const LABEL_CLASS = FIELD_LABEL_BLOCK_CLS;

/** Human label for a stored option value, falling back to the raw value. */
function optionLabel(def: MatterFieldDef, value: string): string {
  return def.options.find((o) => o.value === value)?.label ?? value;
}

function isFieldValueEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" ||
    (Array.isArray(value) && value.length === 0);
}

/** Renders a stored field value for display mode. Returns null when empty. */
function DisplayValue({ def, value }: { def: MatterFieldDef; value: unknown }) {
  const empty = isFieldValueEmpty(value);

  if (def.fieldType === "checkbox") {
    return <span className="text-on-surface">{value ? "Yes" : "No"}</span>;
  }
  if (empty) {
    return <span className="text-on-surface-muted">-</span>;
  }

  switch (def.fieldType) {
    case "date":
      return <span className="text-on-surface">{formatDateOnly(String(value), { year: "numeric", month: "short", day: "numeric" }) || "-"}</span>;
    case "currency": {
      const num = typeof value === "number" ? value : parseFloat(String(value));
      return <span className="text-on-surface">{Number.isNaN(num) ? String(value) : `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</span>;
    }
    case "multiselect": {
      const arr = Array.isArray(value) ? value : [value];
      return <span className="text-on-surface">{arr.map((v) => optionLabel(def, String(v))).join(", ")}</span>;
    }
    case "select":
      return <span className="text-on-surface">{optionLabel(def, String(value))}</span>;
    case "url":
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-emphasis hover:underline break-all">
          {String(value)} <ExternalLink size={12} className="shrink-0" />
        </a>
      );
    case "email":
      return <a href={`mailto:${value}`} className="text-accent-emphasis hover:underline break-all">{String(value)}</a>;
    default:
      return <span className="text-on-surface break-words whitespace-pre-wrap">{String(value)}</span>;
  }
}

interface FieldEditModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  lawFirmId: string;
  matter: Matter;
  defs: MatterFieldDef[];
}

function FieldEditModal({ open, onClose, onSaved, lawFirmId, matter, defs }: FieldEditModalProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the editable values from the matter's stored custom fields when the modal opens
    setValues({ ...(matter.customFields || {}) });
    setError(null);
  }, [open, matter.customFields]);

  const setValue = (id: string, v: unknown) => setValues((prev) => ({ ...prev, [id]: v }));

  const toggleMulti = (id: string, optionValue: string) => {
    setValues((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      const next = current.includes(optionValue)
        ? current.filter((v) => v !== optionValue)
        : [...current, optionValue];
      return { ...prev, [id]: next };
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await mattersService.updateMatter({
        lawFirmId,
        matterId: matter.id,
        customFields: { ...(matter.customFields || {}), ...values },
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Edit Custom Fields"
      closeIcon={<X size={18} />}
      size="lg"
      dismissible={!submitting}
      footer={
        <>
          <Button type="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={
              submitting ||
              defs.some(
                (def) => def.required && def.fieldType !== "checkbox" && isFieldValueEmpty(values[def.id])
              )
            }
          >
            Save Changes
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} />

            {defs.map((def) => {
              const value = values[def.id];
              return (
                <div key={def.id}>
                  {def.fieldType === "checkbox" ? (
                    <div className="flex items-center justify-between gap-3">
                      <label className="text-sm font-medium text-on-surface">{def.label}</label>
                      <ToggleSwitch checked={!!value} onChange={() => setValue(def.id, !value)} ariaLabel={def.label} />
                    </div>
                  ) : (
                    <>
                      <label className={LABEL_CLASS}>{def.label}{def.required ? " *" : ""}</label>
                      {def.fieldType === "textarea" ? (
                        <textarea
                          value={value == null ? "" : String(value)}
                          onChange={(e) => setValue(def.id, e.target.value)}
                          rows={3}
                          className={INPUT_CLASS}
                        />
                      ) : def.fieldType === "select" ? (
                        <Dropdown
                          value={value == null ? "" : String(value)}
                          onChange={(v) => setValue(def.id, v)}
                          options={def.options}
                          placeholder="Select…"
                          buttonClassName="border-input-border bg-input-bg"
                          portal
                        />
                      ) : def.fieldType === "multiselect" ? (
                        <div className="rounded-md border border-outline styled-scrollbar max-h-40 overflow-y-auto">
                          {def.options.length === 0 ? (
                            <p className="px-3 py-2 text-sm text-on-surface-muted">No options configured</p>
                          ) : (
                            def.options.map((opt) => {
                              const arr = Array.isArray(value) ? (value as string[]) : [];
                              return (
                                <label
                                  key={opt.value}
                                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-hover transition-colors cursor-pointer border-b border-outline-subtle last:border-b-0"
                                >
                                  <Checkbox checked={arr.includes(opt.value)} onChange={() => toggleMulti(def.id, opt.value)} />
                                  <span className="text-sm text-on-surface">{opt.label}</span>
                                </label>
                              );
                            })
                          )}
                        </div>
                      ) : (
                        <input
                          type={
                            def.fieldType === "number" || def.fieldType === "currency"
                              ? "number"
                              : def.fieldType === "date"
                              ? "date"
                              : def.fieldType === "email"
                              ? "email"
                              : def.fieldType === "url"
                              ? "url"
                              : def.fieldType === "phone"
                              ? "tel"
                              : "text"
                          }
                          step={def.fieldType === "currency" ? "0.01" : undefined}
                          value={value == null ? "" : String(value)}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (def.fieldType === "number" || def.fieldType === "currency") {
                              setValue(def.id, raw === "" ? "" : Number(raw));
                            } else {
                              setValue(def.id, raw);
                            }
                          }}
                          className={INPUT_CLASS}
                        />
                      )}
                      {def.helpText && <p className="mt-1 text-xs text-on-surface-muted">{def.helpText}</p>}
                    </>
                  )}
                </div>
              );
            })}
    </Modal>
  );
}

interface MatterCustomFieldsCardProps {
  lawFirmId: string;
  matter: Matter;
  canEdit: boolean;
  onSaved?: () => void;
}

/**
 * The firm's custom field definitions, archived ones excluded. Exported so the
 * matter page can start the read while the matter itself is still loading,
 * under the exact key this card then reads from cache. The key sits under the
 * ["matterFieldDefs", firm] prefix the settings screen invalidates after every
 * change, so an edited definition reaches an open matter.
 */
export function matterFieldDefsQueryOptions(lawFirmId: string) {
  return {
    queryKey: matterFieldDefsQueryKey(lawFirmId, false),
    queryFn: (): Promise<MatterFieldDef[]> => mattersService.listFieldDefs(lawFirmId),
  };
}

export default function MatterCustomFieldsCard({ lawFirmId, matter, canEdit, onSaved }: MatterCustomFieldsCardProps) {
  const { data: allDefs = [] } = useQuery({
    ...matterFieldDefsQueryOptions(lawFirmId),
    enabled: !!lawFirmId,
  });

  const defs = useMemo(
    () =>
      allDefs
        .filter((def) => !def.archived)
        .filter((def) => def.practiceAreaId == null || def.practiceAreaId === matter.practiceAreaId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [allDefs, matter.practiceAreaId],
  );

  const [editOpen, setEditOpen] = useState(false);

  // No applicable field definitions - render nothing so the parent can hide the card.
  if (defs.length === 0) return null;

  return (
    <div className="rounded-lg border border-outline bg-surface p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-on-surface-muted" />
          <h3 className="text-sm font-semibold text-on-surface">Custom Fields</h3>
        </div>
        {canEdit && (
          <button
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-outline-subtle bg-surface text-on-surface text-xs font-medium hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            <Pencil size={13} /> Edit
          </button>
        )}
      </div>

      <dl className="divide-y divide-outline-subtle">
        {defs.map((def) => (
          <div key={def.id} className="py-2.5 grid grid-cols-1 sm:grid-cols-3 gap-1 sm:gap-3">
            <dt className="text-xs font-medium text-on-surface-secondary sm:col-span-1">{def.label}</dt>
            <dd className="text-sm sm:col-span-2 min-w-0">
              <DisplayValue def={def} value={matter.customFields?.[def.id]} />
            </dd>
          </div>
        ))}
      </dl>

      <FieldEditModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={onSaved}
        lawFirmId={lawFirmId}
        matter={matter}
        defs={defs}
      />
    </div>
  );
}
