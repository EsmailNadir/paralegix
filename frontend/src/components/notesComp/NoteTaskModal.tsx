"use client";

import { useId, useState } from "react";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import DatePicker from "@/components/ui/DatePicker";
import FieldLabel from "@/components/ui/FieldLabel";
import TextInput from "@/components/ui/TextInput";
import Textarea from "@/components/ui/Textarea";
import { TASK_PRIORITY_OPTIONS } from "@/constants/statusMeta";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import ErrorNotification from "@/components/ErrorNotification";
import DuplicateNameWarning from "@/components/ui/DuplicateNameWarning";
import { useDuplicateNameCheck } from "@/hooks/useEntityLookup";

export interface NoteTaskFormValue {
  title?: string;
  description?: string;
  dueDate?: string;
  priority?: string;
}

interface NoteTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (value: NoteTaskFormValue) => Promise<void>;
  submitting?: boolean;
  defaultTitle?: string;
  defaultDescription?: string;
  lawFirmId: string;
}

/**
 * Create a follow-up task from a note.
 *
 * Deliberately lighter than the full task-creation form (no court, no client
 * links, no recurrence, no assignee): this is the "something should happen
 * next" action off a note, not the general task workflow, and the resulting
 * task can still be assigned and expanded from the tasks page afterward.
 */
export default function NoteTaskModal({
  isOpen,
  onClose,
  onSubmit,
  submitting = false,
  defaultTitle = "",
  defaultDescription = "",
  lawFirmId,
}: NoteTaskModalProps) {
  const fieldIds = useId();
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [error, setError] = useState<string | null>(null);
  const { duplicate: duplicateTask } = useDuplicateNameCheck("tasks", lawFirmId, title, { enabled: isOpen });

  const [openedFor, setOpenedFor] = useState(isOpen);
  if (isOpen && !openedFor) {
    setOpenedFor(true);
    setTitle(defaultTitle);
    setDescription(defaultDescription);
    setDueDate("");
    setPriority("medium");
    setError(null);
  } else if (!isOpen && openedFor) {
    setOpenedFor(false);
  }

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        dueDate: dueDate || undefined,
        priority,
      });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create task"));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Task from Note"
      lockScroll
      footer={
        <>
          <Button type="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !title.trim()}
          >
            Create Task
          </Button>
        </>
      }
    >
      <ErrorNotification error={error} onClose={() => setError(null)} compact />
      <div>
        <FieldLabel htmlFor={`${fieldIds}-title`}>Title *</FieldLabel>
        <TextInput
          id={`${fieldIds}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Enter task title"
        />
        <DuplicateNameWarning duplicateName={duplicateTask?.label} entityLabel="task" />
      </div>
      <div>
        <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
        <Textarea
          id={`${fieldIds}-description`}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Enter task description"
        />
      </div>
      <div className="flex gap-4">
        <div className="flex-1">
          <FieldLabel id={`${fieldIds}-due-date-label`}>Due date</FieldLabel>
          <DatePicker
            ariaLabelledBy={`${fieldIds}-due-date-label`}
            value={dueDate}
            onChange={setDueDate}
            className="w-full"
          />
        </div>
        <div className="flex-1">
          <Dropdown
            label="Priority"
            value={priority}
            onChange={setPriority}
            options={TASK_PRIORITY_OPTIONS}
            buttonClassName="border-input-border bg-input-bg"
          />
        </div>
      </div>
    </Modal>
  );
}
