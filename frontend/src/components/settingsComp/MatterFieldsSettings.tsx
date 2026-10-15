"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Plus, Pencil, Trash2, Archive, ArchiveRestore } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import useMatterFieldDefs from "@/hooks/matterConfigHooks/useMatterFieldDefs";
import usePracticeAreas from "@/hooks/practiceHooks/usePracticeAreas";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { MatterFieldDef, MatterFieldType } from "@/types";
import MatterFieldFormModal from "./MatterFieldFormModal";
import PanelLoadingSpinner from "@/components/ui/PanelLoadingSpinner";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";

const FIELD_TYPE_LABELS: Record<MatterFieldType, string> = {
  text: "Text",
  textarea: "Text area",
  number: "Number",
  currency: "Currency",
  date: "Date",
  select: "Dropdown",
  multiselect: "Multi-select",
  checkbox: "Checkbox",
  url: "URL",
  email: "Email",
  phone: "Phone",
};

const ALL_KEY = "__all__";

export default function MatterFieldsSettings() {
  const params = useParams();
  const lawFirmId = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("settings.manageFirm");

  const { fieldDefs, loading, error, createFieldDef, updateFieldDef, deleteFieldDef } =
    useMatterFieldDefs(lawFirmId);
  const { practiceAreas } = usePracticeAreas(lawFirmId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MatterFieldDef | null>(null);
  const [toDelete, setToDelete] = useState<MatterFieldDef | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const practiceAreaName = useMemo(() => {
    const map = new Map<string, string>();
    practiceAreas.forEach((pa) => map.set(pa.id, pa.name));
    return map;
  }, [practiceAreas]);

  // Group field defs into "All matters" first, then one group per practice area
  // that actually has fields. Each group keeps its defs sorted by sortOrder.
  const groups = useMemo(() => {
    const byGroup = new Map<string, MatterFieldDef[]>();
    for (const def of fieldDefs) {
      const key = def.practiceAreaId || ALL_KEY;
      const arr = byGroup.get(key) ?? [];
      arr.push(def);
      byGroup.set(key, arr);
    }
    const ordered: { key: string; label: string; defs: MatterFieldDef[] }[] = [];
    if (byGroup.has(ALL_KEY)) {
      ordered.push({ key: ALL_KEY, label: "All matters", defs: byGroup.get(ALL_KEY)! });
    }
    for (const pa of practiceAreas) {
      if (byGroup.has(pa.id)) {
        ordered.push({ key: pa.id, label: pa.name, defs: byGroup.get(pa.id)! });
      }
    }
    // Any defs pointing at a practice area we couldn't resolve (e.g. deleted).
    for (const [key, defs] of byGroup.entries()) {
      if (key === ALL_KEY || practiceAreaName.has(key)) continue;
      ordered.push({ key, label: "Other", defs });
    }
    ordered.forEach((g) => g.defs.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    return ordered;
  }, [fieldDefs, practiceAreas, practiceAreaName]);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (def: MatterFieldDef) => {
    setEditing(def);
    setModalOpen(true);
  };

  const toggleArchive = async (def: MatterFieldDef) => {
    setActionError(null);
    try {
      await updateFieldDef(def.id, { archived: !def.archived });
    } catch (err) {
      setActionError(err);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteFieldDef(toDelete.id);
      setToDelete(null);
    } catch (err) {
      setActionError(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel gap="1">
            Custom Fields
          </SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Capture extra information on matters. Fields can apply to every matter or only to a
            specific practice area.
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={openCreate}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            New field
          </Button>
        )}
      </div>

      <ErrorNotification
        error={error ? getErrorMessage(error) : actionError ? getErrorMessage(actionError) : null}
        onClose={() => setActionError(null)}
        className="mb-4"
      />

      {!canManage && (
        <div className="mb-4 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          You need <code>settings.manageFirm</code> permission to create, edit, or delete custom fields.
        </div>
      )}

      {loading ? (
        <PanelLoadingSpinner label="Loading custom fields" />
      ) : groups.length === 0 ? (
        <p className="text-sm text-on-surface-secondary">No custom fields yet.</p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.key}>
              <h3 className="mb-2 text-xs font-semibold text-on-surface-secondary uppercase tracking-wide">
                {group.label}
              </h3>
              <ul className="rounded-xl border border-outline overflow-hidden divide-y divide-outline-subtle">
                {group.defs.map((def) => (
                  <li key={def.id} className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`font-medium text-on-surface ${def.archived ? "line-through opacity-60" : ""}`}>
                          {def.label}
                        </span>
                        <span className="rounded-full bg-surface-alt border border-outline-subtle px-2 py-0.5 text-[11px] text-on-surface-secondary">
                          {FIELD_TYPE_LABELS[def.fieldType] ?? def.fieldType}
                        </span>
                        {def.required && (
                          <span className="rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 px-2 py-0.5 text-[11px] font-medium">
                            Required
                          </span>
                        )}
                        {def.archived && (
                          <span className="rounded-full bg-surface-alt border border-outline-subtle px-2 py-0.5 text-[11px] text-on-surface-muted">
                            Archived
                          </span>
                        )}
                      </div>
                      {def.helpText && (
                        <p className="mt-0.5 text-xs text-on-surface-muted truncate">{def.helpText}</p>
                      )}
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 items-center gap-1">
                        <ActionIconButton label="Edit field" tooltip="Edit" onClick={() => openEdit(def)}>
                          <Pencil size={15} />
                        </ActionIconButton>
                        <ActionIconButton
                          label={def.archived ? "Restore field" : "Archive field"}
                          tooltip={def.archived ? "Restore" : "Archive"}
                          onClick={() => toggleArchive(def)}
                        >
                          {def.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                        </ActionIconButton>
                        <ActionIconButton
                          label="Delete field"
                          tooltip="Delete"
                          tone="danger"
                          onClick={() => setToDelete(def)}
                        >
                          <Trash2 size={15} />
                        </ActionIconButton>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <MatterFieldFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        practiceAreas={practiceAreas}
        onCreate={createFieldDef}
        onUpdate={updateFieldDef}
      />

      <ConfirmModal
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete custom field"
        message={`Delete the field "${toDelete?.label ?? ""}"? Existing matter values for this field will be lost. This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deleting}
      />
    </div>
  );
}
