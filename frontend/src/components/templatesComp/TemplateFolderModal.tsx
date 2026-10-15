"use client";

import { useEffect } from "react";
import NameInputModal from "@/components/ui/NameInputModal";
import useNamePrompt from "@/hooks/useNamePrompt";

/** Create or rename a template folder. */
export default function TemplateFolderModal({
  open,
  title,
  initialName,
  submitLabel,
  contextLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initialName: string;
  submitLabel: string;
  contextLabel?: string | null;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { name, setName, error, setError, saving: submitting, save } = useNamePrompt(initialName);

  // Reset the input to the supplied initial name each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setError(null);
  }, [open, initialName, setName, setError]);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    await save(async () => {
      await onSubmit(name.trim());
    }, "Something went wrong.");
  };

  return (
    <NameInputModal
      open={open}
      onClose={onClose}
      title={title}
      contextLabel={contextLabel}
      size="md"
      nameField={{
        label: "Folder name",
        value: name,
        onChange: setName,
        placeholder: "e.g. Contracts, Intake Forms",
      }}
      error={error}
      onDismissError={() => setError(null)}
      submitting={submitting}
      submitLabel={submitLabel}
      submitDisabled={!name.trim()}
      onSubmit={() => void handleSubmit()}
    />
  );
}
