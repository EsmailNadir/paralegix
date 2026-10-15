"use client";

import { useEffect, useState } from "react";
import NameInputModal from "@/components/ui/NameInputModal";
import FolderColorPicker from "./FolderColorPicker";
import { DEFAULT_FOLDER_COLOR } from "./folderColors";
import type { FileInfo } from "@/services/files.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/**
 * Change a folder's colour.
 *
 * The colour lives on the folder's own marker, so it follows the folder
 * everywhere it appears - the matter's file tab, the firm-wide Files page, and
 * the client portal.
 */
export default function FolderColorModal({
  open,
  folder,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Kept set through the close animation so the dialog doesn't blank mid-exit. */
  folder: FileInfo | null;
  onClose: () => void;
  onSave: (folder: FileInfo, folderColor: string) => Promise<void>;
}) {
  const [color, setColor] = useState<string>(DEFAULT_FOLDER_COLOR);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !folder) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the picker from the folder being edited
    setColor(folder.folderColor || DEFAULT_FOLDER_COLOR);
    setError(null);
  }, [open, folder]);

  const submit = async () => {
    if (!folder) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(folder, color);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update folder color"));
    } finally {
      setSaving(false);
    }
  };

  if (!folder) return null;

  return (
    <NameInputModal
      open={open}
      onClose={onClose}
      title="Change Folder Color"
      extra={<FolderColorPicker value={color} onChange={setColor} />}
      error={error}
      onDismissError={() => setError(null)}
      submitting={saving}
      submitLabel="Change Color"
      onSubmit={() => void submit()}
    />
  );
}
