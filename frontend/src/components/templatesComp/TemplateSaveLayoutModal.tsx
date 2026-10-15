"use client";

import { useId, useState, useEffect, useRef } from "react";
import Button from "@/components/ui/Button";
import FieldError from "@/components/ui/FieldError";
import Modal from "@/components/ui/Modal";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";

interface TemplateSaveLayoutModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
  initialName: string;
  saving: boolean;
  fieldCount: number;
  repeaterCount: number;
}

/**
 * Confirms (and lets the user change) the template's name before "Save
 * layout" writes the placements, rather than saving silently under whatever
 * name the file happened to upload with.
 */
export default function TemplateSaveLayoutModal({
  open,
  onClose,
  onConfirm,
  initialName,
  saving,
  fieldCount,
  repeaterCount,
}: TemplateSaveLayoutModalProps) {
  const fieldIds = useId();
  // Generated rather than fixed, so two open instances never share a heading id.
  const titleId = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the form to the template's current name each time the modal opens
    setName(initialName);
    setError(null);
    const t = setTimeout(() => inputRef.current?.select(), 50);
    return () => clearTimeout(t);
  }, [open, initialName]);

  // Escape reaches the dialog through useDialog, which calls this directly, so
  // the guard lives here rather than only on the backdrop and the buttons.
  // Closing mid-save would let the editor be changed while the save is in
  // flight, and the save's response then replaces the layout and drops those
  // changes.
  const handleClose = () => {
    if (!saving) onClose();
  };

  const handleConfirm = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name for this template.");
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      dismissible={!saving}
      labelledBy={titleId}
      showClose={false}
      height="none"
      className="rounded-xl border-2 border-outline shadow-2xl relative"
      bodyClassName={null}
    >
      <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-on-surface">Save Layout</h2>
          <p className="text-xs text-on-surface-muted mt-0.5">Saves the fields, repeaters, and styling on this document</p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          disabled={saving}
          aria-label="Close"
          className="text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer disabled:opacity-50"
        >
          &#x2715;
        </button>
      </div>

      <div className="px-6 py-5 space-y-4">
        <div>
          <FieldLabel htmlFor={`${fieldIds}-name`}>
            Template name *
          </FieldLabel>
          <TextInput
            id={`${fieldIds}-name`}
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleConfirm(); }}
            disabled={saving}
            placeholder="e.g. Engagement Letter" className="disabled:opacity-50"
          />
          <FieldError message={error} />
        </div>

        <div className="flex items-center gap-2 rounded-md bg-surface-alt border border-outline px-3 py-2 text-xs text-on-surface-muted">
          <span>
            {fieldCount} field{fieldCount !== 1 ? "s" : ""}
            {repeaterCount > 0 ? `, ${repeaterCount} repeater${repeaterCount !== 1 ? "s" : ""}` : ""} placed on this document.
          </span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg border-t border-outline shrink-0">
        <Button type="secondary" onClick={handleClose} disabled={saving}>Cancel</Button>
        <Button type="primary" onClick={handleConfirm} disabled={!name.trim()} loading={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Modal>
  );
}
