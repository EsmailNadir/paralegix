"use client";

export interface ListSkeletonProps {
  /** Placeholder rows to draw. Keep it to what a full page of the list shows. */
  rows?: number;
  /**
   * Match the real row height, for a list that reserves a fixed height so the
   * page doesn't resize when the rows arrive.
   */
  rowHeight?: number;
  /** Names what is loading, for screen readers. */
  label?: string;
  /**
   * Draw the surrounding card. Turn it off when the skeleton stands in for rows
   * that already sit inside a bordered container, so the two don't double up.
   */
  bordered?: boolean;
  className?: string;
}

/**
 * Placeholder rows for a list whose first page is still loading.
 *
 * Every list in the app waits the same way: the rows that are coming are
 * outlined in place, at the size and position they will occupy, rather than a
 * spinner floating in the middle of where the list will be. That keeps the
 * page from jumping when the data lands, and makes a slow list read as "these
 * rows are on their way" instead of "something is happening somewhere".
 *
 * Use `LoadingSpinner` instead for a whole page or an empty panel, and
 * `Spinner` for an in-flight control. This is only for lists of rows.
 */
export default function ListSkeleton({
  rows = 6,
  rowHeight,
  label = "Loading",
  bordered = true,
  className = "",
}: ListSkeletonProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={`overflow-hidden divide-y divide-outline-subtle ${
        bordered ? "rounded-xl border border-outline bg-surface" : ""
      } ${className}`}
    >
      {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          className="flex items-center gap-4 px-4 py-3"
          style={rowHeight ? { height: rowHeight } : undefined}
        >
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-48 max-w-[55%] rounded bg-surface-alt animate-pulse" />
            <div className="h-3 w-72 max-w-[75%] rounded bg-surface-alt animate-pulse" />
          </div>
          <div className="h-4 w-16 rounded bg-surface-alt animate-pulse" />
        </div>
      ))}
    </div>
  );
}
