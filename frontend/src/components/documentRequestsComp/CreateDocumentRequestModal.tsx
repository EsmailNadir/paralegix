"use client";

import { FIELD_LABEL_BLOCK_CLS, FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import DatePicker from "@/components/ui/DatePicker";
import ErrorNotification from "@/components/ErrorNotification";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import { useNavigation } from "@/contexts/NavigationContext";
import documentRequestsService from "@/services/documentRequests.service";
import useDocumentRequestTemplates from "@/hooks/documentRequestsHooks/useDocumentRequestTemplates";

const INPUT_CLASS = FULL_INPUT_CLS;
const LABEL_CLASS = FIELD_LABEL_BLOCK_CLS;

interface ItemRow {
  id: number;
  label: string;
  description: string;
}

interface CreateDocumentRequestModalProps {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  /**
   * Fixed matter this request is created on (matter Documents tab call site).
   * When set, the client picker offers that matter's clients and no target
   * picker is shown: the original, single-matter form, unchanged.
   */
  matterId?: string;
  /**
   * Fixed client this request is addressed to (client-detail tab call site).
   * When set instead of `matterId`, the client picker is skipped entirely
   * (the recipient is already known from the page) and a target picker
   * appears letting the user choose "General" or one of the client's
   * matters, via `matterOptions`.
   */
  clientId?: string;
  /** The client's matters, offered by the target picker in client-tab mode. */
  matterOptions?: { id: string; name: string }[];
  /** Called after a request is created so the parent can invalidate its query. */
  onCreated: () => void;
}

export default function CreateDocumentRequestModal({
  open,
  onClose,
  lawFirmId,
  matterId,
  clientId: fixedClientId,
  matterOptions,
  onCreated,
}: CreateDocumentRequestModalProps) {
  const { navigate } = useNavigation();
  const { templates } = useDocumentRequestTemplates(lawFirmId, open);

  // No `matterId` means this was opened from the client-detail tab: the
  // client is already known (fixed via `clientId`) and the user instead picks
  // which matter (or "General") the request applies to.
  const clientTabMode = matterId === undefined;

  const nextItemId = useRef(1);
  const makeRow = (label = "", description = ""): ItemRow => ({ id: nextItemId.current++, label, description });

  const [selectedClientId, setSelectedClientId] = useState("");
  // "" selects "General (not tied to a matter)"; only read in client-tab mode.
  const [targetMatterId, setTargetMatterId] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [items, setItems] = useState<ItemRow[]>([makeRow()]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | Error | null>(null);
  useResetAfterClose(open, () => setError(null));

  const effectiveClientId = clientTabMode ? (fixedClientId || "") : selectedClientId;
  const effectiveMatterId = clientTabMode ? (targetMatterId || null) : matterId;

  const reset = () => {
    setSelectedClientId("");
    setTargetMatterId("");
    setTitle("");
    setNote("");
    setDueDate("");
    nextItemId.current = 1;
    setItems([makeRow()]);
    setSelectedTemplateId("");
    setError(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const addItemRow = () => setItems((prev) => [...prev, makeRow()]);

  const removeItemRow = (id: number) =>
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== id)));

  const updateItemRow = (id: number, fields: Partial<Pick<ItemRow, "label" | "description">>) =>
    setItems((prev) => prev.map((row) => (row.id === id ? { ...row, ...fields } : row)));

  const applyTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    setTitle(template.defaultTitle);
    setNote(template.defaultNote || "");
    nextItemId.current = 1;
    setItems(
      template.items.length > 0
        ? template.items.map((item) => makeRow(item.label, item.description || ""))
        : [makeRow()],
    );
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setError(null);

    if (!effectiveClientId) {
      setError("Please choose a client for this request.");
      return;
    }
    if (!title.trim()) {
      setError("Please enter a title for this request.");
      return;
    }

    const cleanItems = items
      .map((row) => ({ label: row.label.trim(), description: row.description.trim() }))
      .filter((row) => row.label.length > 0);

    setSubmitting(true);
    try {
      await documentRequestsService.create(lawFirmId, {
        matterId: effectiveMatterId,
        clientId: effectiveClientId,
        title: title.trim(),
        note: note.trim() || undefined,
        dueDate: dueDate || undefined,
        items: cleanItems.length > 0 ? cleanItems : undefined,
      });
      onCreated();
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err : "Failed to create document request");
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      title="New document request"
      closeIcon={<X size={18} />}
      dismissible={!submitting}
      size="xl"
      footer={
        <>
          <Button type="secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !effectiveClientId || !title.trim()}
          >
            Create request
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} />

            {templates.length > 0 ? (
              <div>
                <label className={LABEL_CLASS}>Start from preset</label>
                <Dropdown
                  value={selectedTemplateId}
                  onChange={applyTemplate}
                  options={templates.map((t) => ({ label: t.name, value: t.id }))}
                  placeholder="Select a preset"
                  portal
                />
              </div>
            ) : (
              <p className="text-xs text-on-surface-secondary">
                Save time next time: create a reusable preset in{" "}
                <button
                  type="button"
                  onClick={() => navigate(`/lawfirm/${lawFirmId}/settings/matter-config?tab=documentTemplates`)}
                  className="font-medium text-accent-emphasis hover:text-accent-emphasis-hover cursor-pointer"
                >
                  Matter Config settings
                </button>
                .
              </p>
            )}

            {clientTabMode ? (
              <div>
                <label className={LABEL_CLASS}>Applies to</label>
                <Dropdown
                  value={targetMatterId}
                  onChange={setTargetMatterId}
                  options={[
                    { label: "General (not tied to a matter)", value: "" },
                    ...(matterOptions ?? []).map((m) => ({ label: m.name, value: m.id })),
                  ]}
                  portal
                />
              </div>
            ) : (
              <div>
                <label className={LABEL_CLASS}>Client *</label>
                <EntityPicker
                  entity="clients"
                  lawFirmId={lawFirmId}
                  matterId={matterId}
                  value={selectedClientId}
                  onChange={setSelectedClientId}
                  emptyOption={{ label: "Select a client...", value: "" }}
                  placeholder="Select a client"
                  portal
                />
              </div>
            )}

            <div>
              <label className={LABEL_CLASS} htmlFor="doc-request-title">Title *</label>
              <input
                id="doc-request-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Onboarding documents"
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label className={LABEL_CLASS} htmlFor="doc-request-note">Note</label>
              <textarea
                id="doc-request-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Add context for the client."
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label className={LABEL_CLASS} htmlFor="doc-request-due">Due date</label>
              <DatePicker
                value={dueDate}
                onChange={setDueDate}
                className="w-full"
                aria-label="Due date"
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
                          className={INPUT_CLASS}
                        />
                        <textarea
                          value={row.description}
                          onChange={(e) => updateItemRow(row.id, { description: e.target.value })}
                          placeholder="Description shown to the client (optional)"
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
