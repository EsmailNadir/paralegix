"use client";

import type { ReactNode } from "react";
import useMountTransition from "@/hooks/useMountTransition";
import { listOverflowAnim } from "./transitionClasses";

/** Keep in sync with the list-overflow animation duration in global.css. */
const REVEAL_MS = 300;

interface CollapsibleListProps<T> {
  /** Every row the list holds, not just the visible ones. */
  items: T[];
  /** How many rows stay on screen while the list is collapsed. */
  previewLimit: number;
  /** Whether the list is showing every row. Pair with `<ShowMoreButton>`. */
  expanded: boolean;
  renderItem: (item: T, index: number) => ReactNode;
  /**
   * Layout classes for the rows, e.g. `space-y-2` or `divide-y`. Applied to the
   * visible rows and again to the revealed ones, so both space themselves the
   * same way and the outer rule joins the two groups.
   */
  className?: string;
  /**
   * Extra classes for the animated block, which is one child of the list. A
   * list laid out as a grid needs `col-span-full` here, so the revealed rows
   * span the columns instead of landing in the next cell.
   */
  overflowClassName?: string;
  /**
   * Rows that stay on screen however much of `items` is collapsed, drawn below
   * the revealed ones by the same `renderItem`. For drafts the user is still
   * filling in: hiding one behind "Show more" loses work in progress.
   */
  pinned?: T[];
  /** Content below every row, such as an empty-state line. */
  trailing?: ReactNode;
}

/**
 * A list that shows its first `previewLimit` rows and reveals the rest by
 * growing in place, rather than making them appear all at once.
 *
 *   <CollapsibleList
 *     items={flatFees}
 *     previewLimit={LIST_PREVIEW_LIMIT}
 *     expanded={showAllFlatFees}
 *     className="space-y-2"
 *     renderItem={(fee) => <div key={fee.id}>…</div>}
 *   />
 *   <ShowMoreButton
 *     expanded={showAllFlatFees}
 *     hiddenCount={flatFees.length - LIST_PREVIEW_LIMIT}
 *     onToggle={() => setShowAllFlatFees((prev) => !prev)}
 *   />
 *
 * The hidden rows leave the DOM entirely once collapsed, which is what keeps
 * this usable inside a `divide-y` or `space-y-*` list: a zero-height element
 * left in the flow would still draw that container's divider and gap under the
 * last visible row.
 *
 * Table rows cannot use this - a `<tbody>` may not hold a `<div>` - so a capped
 * table keeps its plain `<ShowMoreButton>` and reveals its rows at once.
 */
export default function CollapsibleList<T>({
  items,
  previewLimit,
  expanded,
  renderItem,
  className = "",
  overflowClassName = "",
  pinned,
  trailing,
}: CollapsibleListProps<T>) {
  const { mounted, exiting } = useMountTransition(expanded, REVEAL_MS);
  const preview = items.slice(0, previewLimit);
  const overflow = items.slice(previewLimit);

  return (
    <div className={className}>
      {preview.map(renderItem)}
      {mounted && overflow.length > 0 && (
        <div className={`grid ${listOverflowAnim(exiting)} ${overflowClassName}`}>
          <div className="overflow-hidden">
            <div className={className}>
              {overflow.map((item, index) => renderItem(item, previewLimit + index))}
            </div>
          </div>
        </div>
      )}
      {pinned?.map((item, index) => renderItem(item, items.length + index))}
      {trailing}
    </div>
  );
}
