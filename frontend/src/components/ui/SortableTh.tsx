"use client";

import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";

export type SortDirection = "asc" | "desc";

export interface SortState {
  field: string;
  direction: SortDirection;
}

interface SortableThProps {
  /** Server-side sort field name. Must be one the endpoint whitelists. */
  field: string;
  label: string;
  sort: SortState;
  onSortChange: (next: SortState) => void;
  /**
   * Direction applied when this column is picked up from another one. Text reads
   * naturally A→Z, but dates and counts are almost always wanted largest-first,
   * so the useful first click differs by column.
   */
  defaultDirection?: SortDirection;
  align?: "left" | "right";
  className?: string;
}

/**
 * A sortable column header for the plain `<table>` lists in the admin console.
 *
 * Clicking the active column flips its direction; clicking any other column
 * takes over the sort at `defaultDirection`. The state is the server's sort
 * model, not a client-side reorder - these tables hold one page of a much larger
 * set, so sorting the rows in the browser would only reorder the current window.
 *
 * `aria-sort` is set on the `<th>` so the direction is announced rather than
 * being carried by the chevron alone.
 */
export default function SortableTh({
  field,
  label,
  sort,
  onSortChange,
  defaultDirection = "asc",
  align = "left",
  className = "",
}: SortableThProps) {
  const active = sort.field === field;
  const direction = active ? sort.direction : defaultDirection;

  const handleClick = () => {
    onSortChange({
      field,
      direction: active ? (sort.direction === "asc" ? "desc" : "asc") : defaultDirection,
    });
  };

  const Icon = active ? (direction === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={`px-4 py-3 font-semibold ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      <button
        type="button"
        onClick={handleClick}
        className={`inline-flex items-center gap-1 cursor-pointer transition-colors hover:text-on-surface ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-on-surface" : ""}`}
      >
        {label}
        <Icon
          size={13}
          strokeWidth={2.2}
          className={active ? "text-accent-emphasis" : "text-on-surface-muted"}
        />
      </button>
    </th>
  );
}
