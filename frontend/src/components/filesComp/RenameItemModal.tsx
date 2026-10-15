"use client";

import { useEffect } from "react";
import NameInputModal from "@/components/ui/NameInputModal";
import type { FileInfo } from "@/services/files.service";
import useNamePrompt from "@/hooks/useNamePrompt";

/** Rename a file or folder, keeping it where it is. */
export default function RenameItemModal({
  open,
  item,
  onClose,
  onRename,
}: {
  open: boolean;
  /** Kept set through the close animation so the dialog doesn't blank mid-exit. */
  item: FileInfo | null;
  onClose: () => void;
  onRename: (item: FileInfo, newName: string) => Promise<void>;
}) {
  const { name, setName, error, setError, saving, save } = useNamePrompt();

  useEffect(() => {
    if (!open || !item) return;
    setName(item.name);
    setError(null);
  }, [open, item, setName, setError]);

  const submit = async () => {
    // Enter can fire again before the first rename answers.
    if (saving) return;
    if (!item || !name.trim() || name.trim() === item.name) {
      onClose();
      return;
    }
    await save(async () => {
      await onRename(item, name.trim());
      onClose();
    }, "Failed to rename");
  };

  if (!item) return null;

  return (
    <NameInputModal
      open={open}
      onClose={onClose}
      title={`Rename ${item.isFolder ? "Folder" : "File"}`}
      nameField={{
        label: "Name *",
        value: name,
        onChange: setName,
      }}
      error={error}
      onDismissError={() => setError(null)}
      submitting={saving}
      submitLabel="Rename"
      submitDisabled={!name.trim()}
      onSubmit={() => void submit()}
    />
  );
}
