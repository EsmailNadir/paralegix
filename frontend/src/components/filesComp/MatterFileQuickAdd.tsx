"use client";

import { useState } from "react";
import Toast from "@/components/ui/Toast";
import FileUpload from "./FileUpload";

interface MatterFileQuickAddProps {
  lawFirmId: string;
  matterId: string;
  /** The folder to file into. The matter's root when omitted. */
  folderPath?: string;
  taskId?: string;
  onUploadComplete?: () => void;
  onError?: (message: string | null) => void;
  onViewFiles?: () => void;
}

/**
 * Quick add on a matter's and a task's overview: the file manager's own
 * dropzone under an overview heading.
 *
 * It is `FileUpload` rather than a copy of it, so it uploads the way the file
 * manager does by construction: the same bar and cancel, the same account of
 * the files that failed, and an upload that carries on when the overview is
 * left. It files under its own upload slot, because its completion does
 * different work from the Documents tab's dropzone for the same matter.
 *
 * The overview has no file list to show what landed, so a batch that landed
 * whole is confirmed with a toast. A partial one is not: `FileUpload` names the
 * files that failed and keeps them picked.
 */
export default function MatterFileQuickAdd({
  lawFirmId,
  matterId,
  folderPath,
  taskId,
  onUploadComplete,
  onError,
  onViewFiles,
}: MatterFileQuickAddProps) {
  const [landed, setLanded] = useState<number | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-on-surface-secondary">Quick Add Files</h4>
        {onViewFiles && (
          <button
            type="button"
            onClick={onViewFiles}
            className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
          >
            View all files
          </button>
        )}
      </div>

      <FileUpload
        lawFirmId={lawFirmId}
        matterId={matterId}
        taskId={taskId}
        folderId={folderPath}
        uploadSlot="quick-add"
        onUploadComplete={(files, failures) => {
          if (failures.length === 0) setLanded(files.length);
          onUploadComplete?.();
        }}
        onError={(message) => onError?.(message)}
      />

      {landed !== null && (
        <Toast
          message={`Uploaded ${landed} file${landed === 1 ? "" : "s"}`}
          tone="success"
          duration={3000}
          onDismiss={() => setLanded(null)}
        />
      )}
    </div>
  );
}
