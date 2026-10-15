"use client";

import { useEffect, useId, useState } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import FieldLabel from "@/components/ui/FieldLabel";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";

/** The two strings an invoice line prints: a bold title over a line of detail. */
export interface InvoiceLineText {
  name: string;
  description: string;
}

interface Props {
  isOpen: boolean;
  /**
   * The line being edited, null once the dialog has closed. Both strings are
   * optional going in, because a draft line carries whatever the invoice stored
   * and either column may be null; the pair coming back out is always complete.
   */
  line: { name?: string | null; description?: string | null } | null;
  onClose: () => void;
  onDone: (text: InvoiceLineText) => void;
}

/**
 * Edits the title and description of one invoice line.
 *
 * These two are the only fields on a line that hold prose, and the edit table
 * has no room for them: its first column is ~190px, which fits a wrapped
 * sentence but not two input boxes. A dialog gives the description a textarea
 * and leaves the table printing the pair as text, so edit mode still reads like
 * the invoice it is editing.
 *
 * It writes to the caller's DRAFT line, not to the server. The invoice is saved
 * by the editor's own Save button, which is why the action here is "Done".
 */
export default function InvoiceLineTextModal({ isOpen, line, onClose, onDone }: Props) {
  const fieldIds = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!isOpen || !line) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the fields from the line being edited
    setName(line.name ?? "");
    setDescription(line.description ?? "");
  }, [isOpen, line]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Edit line text"
      subtitle="Changes the wording on this invoice. The time entry it was billed from keeps its own."
      size="lg"
      footer={
        <>
          <Button type="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="primary" onClick={() => onDone({ name, description })}>
            Done
          </Button>
        </>
      }
    >
      <div>
        <FieldLabel htmlFor={`${fieldIds}-name`}>Title</FieldLabel>
        {/* Placeholder, not a value: "Service" is what the invoice prints for a
            line with no title, so seeding it here would save it as if it had
            been typed. */}
        <input
          id={`${fieldIds}-name`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Service"
          className={`${FULL_INPUT_CLS} font-medium`}
        />
      </div>

      <div>
        <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
        <textarea
          id={`${fieldIds}-description`}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What work was done?"
          className={FULL_INPUT_CLS}
        />
      </div>
    </Modal>
  );
}
