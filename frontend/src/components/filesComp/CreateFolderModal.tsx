"use client";

import { useEffect, useState } from "react";
import NameInputModal from "@/components/ui/NameInputModal";
import FolderColorPicker from "./FolderColorPicker";
import { DEFAULT_FOLDER_COLOR } from "./folderColors";
import useNamePrompt from "@/hooks/useNamePrompt";
import FieldLabel from "@/components/ui/FieldLabel";

/**
 * Name a new folder and pick its colour.
 *
 * The colour is offered at creation because it is stored on the folder's marker,
 * so setting it later is a second round-trip the user has no reason to make.
 */
export default function CreateFolderModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (folderName: string, folderColor: string) => Promise<void>;
}) {
  const { name, setName, error, setError, saving, save } = useNamePrompt();
  const [color, setColor] = useState<string>(DEFAULT_FOLDER_COLOR);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a fresh form each time the dialog opens
    setColor(DEFAULT_FOLDER_COLOR);
    setNameError(null);
    setError(null);
  }, [open, setName, setError]);

  const submit = async () => {
    // Enter can fire again before the first create answers; a second request
    // would be refused as a duplicate of the folder the first one made.
    if (saving) return;
    if (!name.trim()) {
      setNameError("Please enter a name for the folder.");
      return;
    }
    await save(async () => {
      await onCreate(name.trim(), color);
      onClose();
    }, "Failed to create folder");
  };

  return (
    <NameInputModal
      open={open}
      onClose={onClose}
      title="Create New Folder"
      scrollableBody
      nameField={{
        label: "Folder name *",
        value: name,
        onChange: (value) => {
          setName(value);
          if (nameError) setNameError(null);
        },
        placeholder: "Folder name",
        error: nameError,
      }}
      extra={
        <div>
          <FieldLabel>
            Folder color
          </FieldLabel>
          <FolderColorPicker value={color} onChange={setColor} />
        </div>
      }
      error={error}
      onDismissError={() => setError(null)}
      submitting={saving}
      submitLabel="Create"
      submitDisabled={!name.trim()}
      onSubmit={() => void submit()}
    />
  );
}
