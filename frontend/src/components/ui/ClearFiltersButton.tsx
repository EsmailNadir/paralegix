"use client";

import { X } from "lucide-react";

interface ClearFiltersButtonProps {
  /** Number of active filters. The button renders nothing when this is 0. */
  count: number;
  onClear: () => void;
  /** Button text before the optional count. Defaults to "Clear filters". */
  label?: string;
  className?: string;
}

/**
 * Compact "clear all filters" control with an active-filter count. Doubles as the
 * active-filter indicator: it only appears while at least one filter is set, and
 * shows the count once more than one is active. Clearing is the caller's job (reset
 * the filter state and its persisted localStorage keys) via `onClear`.
 */
export default function ClearFiltersButton({
  count,
  onClear,
  label = "Clear filters",
  className = "",
}: ClearFiltersButtonProps) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`${label} (${count} active)`}
      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-medium text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover cursor-pointer transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${className}`}
    >
      <X size={13} />
      {label}
      {count > 1 ? ` (${count})` : ""}
    </button>
  );
}
