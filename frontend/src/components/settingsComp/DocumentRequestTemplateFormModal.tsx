"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ErrorNotification from "@/components/ErrorNotification";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import type {
  DocumentRequestTemplate,
  CreateDocumentRequestTemplatePayload,
  UpdateDocumentRequestTemplatePayload,
} from "@/services/documentRequestTemplates.service";

const INPUT_CLASS = FULL_INPUT_CLS;
const LABEL_CLASS = FIELD_LABEL_BLOCK_CLS;

interface ItemRow {
  id: number;
  label: string;
  description: string;
}

interface DocumentRequestTemplateFormModalProps {
  open: boolean;
  onClose: () => void;
  editing: DocumentRequestTemplate | null;
  onCreate: (payload: CreateDocumentRequestTemplatePayload) => Promise<unknown>;
  onUpdate: (templateId: string, payload: UpdateDocumentRequestTemplatePayload) => Promise<unknown>;
}

export default function DocumentRequestTemplateFormModal({
  open,
  onClose,
  editing,
  onCreate,
  onUpdate,
}: DocumentRequestTemplateFormModalProps) {
  const nextItemId = useRef(1);
  const makeRow = (label = "", description = ""): ItemRow => ({ id: nextItemId.current++, label, description });

  const [name, setName] = useState("");
  const [defaultTitle, setDefaultTitle] = useState("");
  const [defaultNote, setDefaultNote] = useState("");
  const [items, setItems] = useState<ItemRow[]>([makeRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useSeedOnOpen(open, () => {
    setError(null);
    setSubmitting(false);
    nextItemId.current = 1;
    if (editing) {
      setName(editing.name);
      setDefaultTitle(editing.defaultTitle);
      setDefaultNote(editing.defaultNote ?? "");
      setItems(editing.items.length ? editing.items.map((item) => makeRow(item.label, item.description || "")) : [makeRow()]);
    } else {
      setName("");
      setDefaultTitle("");
      setDefaultNote("");
      setItems([makeRow()]);
    }
  }, editing?.id ?? null);

  const addItemRow = () => setItems((prev) => [...prev, makeRow()]);
  const removeItemRow = (id: number) =>
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== id)));
  const updateItemRow = (id: number, fields: Partial<Pick<ItemRow, "label" | "description">>) =>
    setItems((prev) => prev.map((row) => (row.id === id ? { ...row, ...fields } : row)));

  const handleSubmit = async () => {
    if (submitting) return;
    setError(null);

    if (!name.trim()) {
      setError("Please enter a name for this preset.");
      return;
    }
    if (!defaultTitle.trim()) {
      setError("Please enter a default title for this preset.");
      return;
    }

    const cleanItems = items
      .map((row) => ({ label: row.label.trim(), description: row.description.trim() }))
      .filter((row) => row.label.length > 0);

    const payload = {
      name: name.trim(),
      defaultTitle: defaultTitle.trim(),
      defaultNote: defaultNote.trim() || null,
      items: cleanItems,
    };

    setSubmitting(true);
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

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={editing ? "Edit document request preset" : "New document request preset"}
      closeIcon={<X size={18} />}
      size="xl"
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
            disabled={submitting || !name.trim() || !defaultTitle.trim()}
          >
            {editing ? "Save changes" : "Create preset"}
          </Button>
        </>
      }
    >
      <ErrorNotification error={error ? getErrorMessage(error) : null} onClose={() => setError(null)} />

      <div>
        <label className={LABEL_CLASS} htmlFor="template-name">Preset name *</label>
        <input
          id="template-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Standard onboarding docs"
          className={INPUT_CLASS}
          autoFocus
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="template-title">Default title *</label>
        <input
          id="template-title"
          type="text"
          value={defaultTitle}
          onChange={(e) => setDefaultTitle(e.target.value)}
          placeholder="e.g. Onboarding documents"
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label className={LABEL_CLASS} htmlFor="template-note">Default note</label>
        <textarea
          id="template-note"
          value={defaultNote}
          onChange={(e) => setDefaultNote(e.target.value)}
          rows={3}
          placeholder="Add context for the client."
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Requested items</label>
        <div className="space-y-2">
          {items.map((row, index) => (
            <div key={row.id} className="rounded-lg border border-outline bg-surface-alt p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0 space-y-2">
                  <input
                    type="text"
                    value={row.label}
                    onChange={(e) => updateItemRow(row.id, { label: e.target.value })}
                    placeholder={`Item ${index + 1}`}
                    aria-label={`Item ${index + 1} name`}
                    className={INPUT_CLASS}
                  />
                  <textarea
                    value={row.description}
                    onChange={(e) => updateItemRow(row.id, { description: e.target.value })}
                    placeholder="Description shown to the client (optional)"
                    aria-label={`Item ${index + 1} description`}
                    rows={2}
                    className={INPUT_CLASS}
                  />
                </div>
                <ActionIconButton
                  label="Remove item"
                  onClick={() => removeItemRow(row.id)}
                  disabled={items.length <= 1}
                  tone="danger"
                  className="shrink-0"
                >
                  <Trash2 size={16} />
                </ActionIconButton>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addItemRow}
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-accent-emphasis hover:text-accent-emphasis-hover cursor-pointer"
        >
          <Plus size={14} strokeWidth={2.2} /> Add item
        </button>
      </div>
    </Modal>
  );
}
