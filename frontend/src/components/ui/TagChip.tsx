"use client";

import { X } from "lucide-react";

export default function TagChip({
  label,
  onRemove,
  removeLabel,
}: {
  label: string;
  onRemove?: () => void;
  /** Accessible name for the remove button; defaults to "Remove <label> tag". */
  removeLabel?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-outline-subtle bg-surface-alt px-2 py-0.5 text-[11px] font-medium text-on-surface-secondary">
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? `Remove ${label} tag`}
          className="rounded-full text-on-surface-muted transition-colors hover:text-on-surface cursor-pointer"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}
