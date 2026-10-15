"use client";

import { Check, ChevronRight, FileText, Folder } from "lucide-react";
import type { FileInfo } from "@/services/files.service";

/**
 * Selectable file row shared by the "browse files and select" modals
 * (`FilePickerModal`, `MessageFilePicker`). A row is either toggleable or
 * `disabled` - a disabled row can never be `selected`, so the two states
 * never compete for the same visual treatment.
 */
export function FilePickerFileRow({
  file,
  selected,
  disabled,
  /** Trailing label shown on a disabled row, e.g. "Already linked". Omit for
   *  a disabled row with no reason to state (e.g. the selection cap). */
  disabledNote,
  onToggle,
  /** Byte-count formatter; callers format sizes slightly differently. */
  formatSize,
}: {
  file: FileInfo;
  selected: boolean;
  disabled: boolean;
  disabledNote?: string;
  onToggle: (file: FileInfo) => void;
  formatSize: (bytes: number) => string;
}) {
  return (
    <button
      onClick={() => !disabled && onToggle(file)}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md border transition-colors text-left ${
        disabled
          ? "border-transparent opacity-40 cursor-not-allowed"
          : selected
          ? "bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-accent-control-ring/30"
          : "border-transparent hover:bg-surface-hover cursor-pointer"
      }`}
    >
      <span
        className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
          selected ? "bg-accent-solid border-accent-control-ring" : "border-input-border"
        }`}
      >
        {selected && <Check size={12} className="text-white" />}
      </span>
      <FileText size={16} className="text-on-surface-muted shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-on-surface truncate">{file.name}</p>
        <p className="text-xs text-on-surface-muted">{formatSize(file.size)}</p>
      </div>
      {disabledNote && <span className="text-xs text-on-surface-muted shrink-0">{disabledNote}</span>}
    </button>
  );
}

/**
 * Folder row for the same pickers. `alignWithCheckbox` reserves the leading
 * checkbox width that `FilePickerFileRow` occupies, so folder and file names
 * line up in scopes that show both in one list (`MessageFilePicker`); scopes
 * that don't render selection checkboxes at all next to folders omit it
 * (`FilePickerModal`). `fileCount`, when given, renders a trailing "N files".
 */
export function FilePickerFolderRow({
  folder,
  onOpen,
  fileCount,
  alignWithCheckbox = false,
  trailingAuto = false,
}: {
  folder: FileInfo;
  onOpen: (folder: FileInfo) => void;
  fileCount?: number | null;
  alignWithCheckbox?: boolean;
  trailingAuto?: boolean;
}) {
  return (
    <button
      onClick={() => onOpen(folder)}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md ${
        alignWithCheckbox ? "border border-transparent " : ""
      }hover:bg-surface-hover transition-colors text-left cursor-pointer`}
    >
      {alignWithCheckbox && <span className="w-5 h-5 shrink-0" />}
      <Folder size={16} className="text-amber-500 shrink-0" />
      <span className={`text-sm font-medium text-on-surface truncate ${alignWithCheckbox ? "flex-1" : ""}`}>
        {folder.displayName || folder.name}
      </span>
      {fileCount != null && (
        <span className="text-xs text-on-surface-muted ml-auto shrink-0">
          {fileCount} file{fileCount !== 1 ? "s" : ""}
        </span>
      )}
      <ChevronRight size={14} className={trailingAuto ? "text-on-surface-muted shrink-0 ml-auto" : "text-on-surface-muted shrink-0"} />
    </button>
  );
}
