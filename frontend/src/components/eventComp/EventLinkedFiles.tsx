"use client";

import { FileText, Paperclip, X } from "lucide-react";
import FieldLabel from "@/components/ui/FieldLabel";
import ActionIconButton from "@/components/ui/ActionIconButton";
import type { SelectedFile } from "@/components/matterComp/FilePickerModal";

/**
 * The files attached to an event: the current list, each row unlinkable, with a
 * button that opens the file picker.
 *
 * `MatterEventsTab` and `ClientEventsTab` each carried this, identically. The
 * picker modal itself stays with the caller, since each tab scopes it to its
 * own parent.
 */
export default function EventLinkedFiles({
  files,
  onChange,
  onBrowse,
}: {
  files: SelectedFile[];
  onChange: (next: SelectedFile[]) => void;
  onBrowse: () => void;
}) {
  return (
    <div>
      <FieldLabel>Linked Files</FieldLabel>
      <div className="space-y-2">
        {files.length > 0 && (
          <div className="space-y-1">
            {files.map((f, i) => (
              <div key={f.fileId} className="flex items-center gap-2 px-3 py-2 rounded-md bg-surface-alt border border-outline-subtle text-sm">
                <FileText size={14} className="text-on-surface-muted shrink-0" />
                <span className="truncate flex-1 text-on-surface">{f.name}</span>
                <ActionIconButton
                  label="Unlink file"
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                  tone="danger"
                  className="shrink-0"
                >
                  <X size={14} />
                </ActionIconButton>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onBrowse}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-outline text-xs font-medium text-on-surface-secondary hover:bg-surface-alt transition-colors cursor-pointer"
        >
          <Paperclip size={13} /> Browse Files
        </button>
      </div>
    </div>
  );
}
