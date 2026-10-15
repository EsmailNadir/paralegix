"use client";

import Spinner from "@/components/ui/Spinner";

export interface ListBusyIndicatorProps {
  /**
   * True while a request that changes the rows is in flight. A list paired with
   * `ListPager` should exclude a pending page click (`fetching && !pagerPending`)
   * - the clicked button already carries that wait, and two acknowledgements for
   * one action read as two separate waits.
   */
  busy: boolean;
  /** Overrides the wording when "results" is wrong for the surface. */
  label?: string;
  className?: string;
}

/**
 * The inline "still working" line for a list whose rows stay on screen while the
 * next set loads.
 *
 * A server-paged list keeps the previous rows during a fetch so it doesn't
 * collapse and re-expand (which reads as a full page reload). The cost is that a
 * filter change looks ignored until the response lands - the rows, the count and
 * the totals above them all keep their old values. This line is what fills that
 * gap, so every list acknowledges a filter the same way.
 *
 * Place it on a row that is ALREADY on screen - a count line, a control strip,
 * or a header. Its idle state stays in the layout invisibly, reserving both the
 * height and width needed by the busy state so a refresh cannot move or wrap the
 * grid below it.
 *
 * `ListView` draws this itself; only a list with hand-rolled markup needs to
 * render it directly.
 */
export default function ListBusyIndicator({
  busy,
  label = "Updating results…",
  className = "",
}: ListBusyIndicatorProps) {
  return (
    <div
      role={busy ? "status" : undefined}
      aria-live={busy ? "polite" : undefined}
      aria-hidden={busy ? undefined : true}
      className={`flex h-5 shrink-0 items-center gap-1.5 text-xs font-medium text-accent-emphasis ${busy ? "" : "invisible"} ${className}`}
    >
      <Spinner size={13} />
      {label}
    </div>
  );
}
