"use client";

import { useState } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import EntityPicker from "@/components/ui/EntityPicker";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import ErrorNotification from "@/components/ErrorNotification";
import { useResetAfterClose } from "@/hooks/useMountTransition";

interface NoteLinkTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (taskId: string) => Promise<void>;
  submitting?: boolean;
  lawFirmId: string;
}

/**
 * Link an existing task to a note.
 *
 * The task typeahead searches the whole firm rather than just this matter (the
 * lookup has no matter scope today); picking a task from a different matter is
 * still refused server-side, which surfaces here as the usual error banner.
 */
export default function NoteLinkTaskModal({ isOpen, onClose, onSubmit, submitting = false, lawFirmId }: NoteLinkTaskModalProps) {
  const [taskId, setTaskId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The dialog is shared by every note in the list, so a pick abandoned on one
  // note must not come back preselected on the next.
  useResetAfterClose(isOpen, () => {
    setTaskId("");
    setError(null);
  });

  const handleSubmit = async () => {
    if (!taskId) {
      setError("Choose a task");
      return;
    }
    setError(null);
    try {
      await onSubmit(taskId);
      setTaskId("");
    } catch (err) {
      setError(getErrorMessage(err, "Failed to link task"));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Link Existing Task"
      lockScroll
      footer={
        <>
          <Button type="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting} disabled={submitting || !taskId}>
            Link Task
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />
      <EntityPicker
        entity="tasks"
        lawFirmId={lawFirmId}
        value={taskId}
        onChange={setTaskId}
        label="Task"
        placeholder="Search tasks…"
        buttonClassName="border-input-border bg-input-bg"
      />
    </Modal>
  );
}
