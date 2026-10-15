"use client";

import { ChevronRight } from "lucide-react";

/**
 * Compact folder trail used inside the "browse files and select" modals
 * (`FilePickerModal`, `MessageFilePicker`). Distinct from `FileBreadcrumbs`,
 * which is the full-page file browser's breadcrumb (Back button, blue links) - 
 * this one is muted text sized to sit inside a modal header stack.
 *
 * Renders nothing at the scope root, where there is no trail to show.
 */
export default function FilePickerBreadcrumb({
  segments,
  onNavigate,
}: {
  /** Folder names from the scope root to the open folder. */
  segments: string[];
  /** Called with the index of the clicked segment, or -1 for Root. */
  onNavigate: (index: number) => void;
}) {
  if (segments.length === 0) return null;

  return (
    <div className="flex items-center gap-1 px-6 pt-3 text-xs text-on-surface-muted shrink-0 flex-wrap">
      <button onClick={() => onNavigate(-1)} className="hover:text-on-surface-secondary cursor-pointer">
        Root
      </button>
      {segments.map((segment, i) => (
        <span key={i} className="flex items-center gap-1">
          <ChevronRight size={12} />
          <button onClick={() => onNavigate(i)} className="hover:text-on-surface-secondary cursor-pointer">
            {segment}
          </button>
        </span>
      ))}
    </div>
  );
}
