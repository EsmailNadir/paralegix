"use client";

interface CalendarLoadingBarProps {
  /** True while a range change is in flight behind data that is already drawn. */
  active: boolean;
  /** Human-readable name of the range being loaded, for the live region. */
  rangeLabel?: string;
}

/**
 * A thin indeterminate bar under the calendar header, shown while a new date range
 * loads behind the range already on screen.
 *
 * The calendar never blanks on navigation: the previous window stays rendered and
 * this reports that fresh data is on its way. It always occupies its 2px of layout
 * so the grid below does not shift when a load starts or ends.
 *
 * The sweep's width and animation come from the `progress-sweep` class in
 * global.css, not from an inline style, so the reduced-motion media query there can
 * replace the movement with a static bar.
 */
export default function CalendarLoadingBar({ active, rangeLabel }: CalendarLoadingBarProps) {
  const message = rangeLabel ? `Loading ${rangeLabel}` : "Loading calendar";

  return (
    <div className="h-0.5 w-full shrink-0 overflow-hidden bg-transparent">
      {active && (
        <div
          role="progressbar"
          aria-label={message}
          className="h-full w-full bg-blue-500/15"
        >
          <div className="progress-sweep h-full rounded-full bg-blue-500 dark:bg-blue-400" />
        </div>
      )}
      {/*
        The live region stays mounted at all times and only its text changes.
        Mounting the region and its content together is unreliable: several screen
        readers only announce changes made to a region that was already present.
      */}
      <span className="sr-only" aria-live="polite">
        {active ? message : ""}
      </span>
    </div>
  );
}
