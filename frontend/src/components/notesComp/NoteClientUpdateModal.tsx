"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { FIELD_LABEL_CLS, INPUT_CLS } from "@/components/ui/inputClasses";
import mattersService from "@/services/matters.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";

interface NoteClientUpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (message: string) => Promise<void>;
  submitting?: boolean;
  lawFirmId: string;
  matterId: string;
  defaultMessage?: string;
}

/**
 * Compose a client update drawn from a note.
 *
 * The note is never shared as-is: the author writes the message that goes
 * out, pre-filled from the note so nothing has to be retyped but fully
 * editable, and it posts as an ordinary matter message rather than exposing
 * the whole internal note.
 */
export default function NoteClientUpdateModal({
  isOpen,
  onClose,
  onSubmit,
  submitting = false,
  lawFirmId,
  matterId,
  defaultMessage = "",
}: NoteClientUpdateModalProps) {
  const fieldIds = useId();
  const [message, setMessage] = useState(defaultMessage);
  const [error, setError] = useState<string | null>(null);

  const clientsQuery = useQuery({
    queryKey: ["matterClients", lawFirmId, matterId],
    queryFn: () => mattersService.listClients(lawFirmId, matterId),
    enabled: isOpen && !!lawFirmId && !!matterId,
  });
  const clientNames = (clientsQuery.data || []).map((c) => c.name).filter(Boolean);

  const [openedFor, setOpenedFor] = useState(isOpen);
  if (isOpen && !openedFor) {
    setOpenedFor(true);
    setMessage(defaultMessage);
    setError(null);
  } else if (!isOpen && openedFor) {
    setOpenedFor(false);
  }

  const handleSubmit = async () => {
    if (!message.trim()) {
      setError("An update message is required");
      return;
    }
    setError(null);
    try {
      await onSubmit(message.trim());
    } catch (err) {
      setError(getErrorMessage(err, "Failed to send client update"));
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Send Client Update" size="lg" lockScroll bodyClassName={null}>
      <div className="p-6">
        {error && <div className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</div>}

        <p className="text-xs text-on-surface-muted mb-3">
          Your client sees only the message below, not the note.
        </p>

        <div className="mb-3 text-xs text-on-surface-secondary">
          Recipients: {clientNames.length ? clientNames.join(', ') : 'All clients on this matter'}
        </div>

        <label htmlFor={`${fieldIds}-message`} className={`block mb-1 ${FIELD_LABEL_CLS}`}>Message *</label>
        <textarea
          id={`${fieldIds}-message`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          className={`w-full resize-none ${INPUT_CLS}`}
        />

        <div className="mt-6 flex gap-3 justify-end">
          <Button type="secondary" size="small" onClick={onClose}>
            Cancel
          </Button>
          <Button type="primary" size="small" onClick={handleSubmit} loading={submitting} disabled={!message.trim()}>
            Send Update
          </Button>
        </div>
      </div>
    </Modal>
  );
}
