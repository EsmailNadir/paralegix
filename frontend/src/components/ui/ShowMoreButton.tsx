"use client";

interface ShowMoreButtonProps {
  /** Whether the list is currently showing every item. */
  expanded: boolean;
  /** How many items the collapsed list is hiding. Renders nothing when 0. */
  hiddenCount: number;
  onToggle: () => void;
  className?: string;
}

/**
 * Full-width toggle sat under a list that only shows its first few items.
 * Renders nothing when there is nothing hidden, so it can be dropped in
 * unconditionally.
 */
export default function ShowMoreButton({ expanded, hiddenCount, onToggle, className = "" }: ShowMoreButtonProps) {
  if (hiddenCount <= 0) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`mt-2 w-full rounded-lg px-3 py-2 text-xs font-medium text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover transition-[background-color,color,transform] duration-100 active:scale-[0.99] motion-reduce:active:scale-100 cursor-pointer ${className}`}
    >
      {expanded ? "Show less" : `Show ${hiddenCount} more`}
    </button>
  );
}
