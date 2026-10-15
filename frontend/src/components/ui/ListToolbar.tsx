import React from "react";

/**
 * The surface that holds a list's search box and the filter or action controls
 * that drive it, sat directly above the list itself.
 *
 * Grouping the controls on one panel keeps them reading as part of the list
 * rather than as loose fields floating between the page header and the rows,
 * and gives every list the same border/radius language as the cards around it.
 * Children are laid out by the call site - a single row, a stacked search +
 * filter pair, whatever the list needs.
 */
export default function ListToolbar({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-outline bg-surface p-3 sm:p-4 ${className}`}>
      {children}
    </div>
  );
}
