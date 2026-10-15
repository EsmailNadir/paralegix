"use client";

import { ArrowLeft } from "lucide-react";

import type { FolderCrumb } from "@/lib/files/filePaths";

/**
 * The folder trail, with a Back button and a clickable path.
 *
 * Renders nothing at the scope root, where there is no trail and no level to go
 * back to, unless the scope sits inside a larger view (`parent`): then Back from
 * the root leaves for that view.
 */
export default function FileBreadcrumbs({
  trail,
  rootLabel = "Root",
  onUp,
  onRoot,
  onSegment,
  parent,
  className = "",
}: {
  /** The folders from the scope root down to the open one. */
  trail: FolderCrumb[];
  rootLabel?: string;
  onUp: () => void;
  onRoot: () => void;
  /** Jump to the folder at `index` in the trail. */
  onSegment: (index: number) => void;
  /** The view this scope was opened from, e.g. a client's files around one of
   *  their matters. Listed ahead of `rootLabel`. */
  parent?: { label: string; onOpen: () => void };
  className?: string;
}) {
  if (trail.length === 0 && !parent) return null;

  const linkCls =
    "text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer";

  return (
    <div className={`flex flex-wrap items-center gap-2 text-sm ${className}`}>
      <button
        type="button"
        onClick={trail.length > 0 ? onUp : parent?.onOpen}
        className="inline-flex items-center gap-1 rounded-md border border-outline bg-surface px-2.5 py-1 font-medium text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
      >
        <ArrowLeft size={15} />
        Back
      </button>
      <span className="text-on-surface-muted">·</span>
      {parent && (
        <>
          <button type="button" onClick={parent.onOpen} className={linkCls}>
            {parent.label}
          </button>
          <span className="text-on-surface-muted">/</span>
        </>
      )}
      <button type="button" onClick={onRoot} className={linkCls}>
        {rootLabel}
      </button>
      {trail.map((crumb, index) => (
        <span key={crumb.id} className="flex items-center gap-2">
          <span className="text-on-surface-muted">/</span>
          <button type="button" onClick={() => onSegment(index)} className={linkCls}>
            {crumb.name}
          </button>
        </span>
      ))}
    </div>
  );
}
