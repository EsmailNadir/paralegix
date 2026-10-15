"use client";

import { useState } from "react";
import { readSavedCalendarView, type CalendarViewMode } from "./calendarViewPreference";

/**
 * First-paint placeholder for the calendar.
 *
 * Mirrors the real three-column layout from Calendar.tsx (the 272px sidebar, the
 * center header plus grid, and the 348px side panel) at the same breakpoints, so
 * the page does not reflow when the data lands. The center grid follows the view
 * that is about to be drawn - the time grid for week/day, the month boxes for
 * month - because a week placeholder in front of a month calendar reads as a
 * layout change rather than a load. Used only for the initial load; a later range
 * change keeps the previous range on screen and reports itself through
 * CalendarLoadingBar instead.
 */

const MINI_CAL_DAYS = 35;
const SIDEBAR_ROWS = 3;
const GRID_ROWS = 8;
const WEEK_COLUMNS = 7;
const MONTH_ROWS = 6;
const PANEL_ROWS = 4;

function Block({ className = "" }: { className?: string }) {
  return <div className={`rounded-md bg-surface-hover ${className}`} />;
}

/** Weekday header strip plus the boxed day cells of the month grid. */
function MonthGrid() {
  return (
    <div className="flex-1 overflow-hidden sm:overflow-y-auto flex flex-col sm:block p-0 sm:p-4">
      <div className="grid grid-cols-7 gap-0 sm:gap-1.5 mb-0 sm:mb-2 shrink-0 border-b border-outline-subtle sm:border-0">
        {Array.from({ length: WEEK_COLUMNS }, (_, i) => (
          <div key={`sk-mwd-${i}`} className="flex justify-center py-2 sm:py-1.5">
            <Block className="h-3 w-7" />
          </div>
        ))}
      </div>

      <div className="flex-1 sm:flex-none min-h-0 grid grid-cols-7 gap-0 sm:gap-1.5 [grid-auto-rows:minmax(52px,1fr)] sm:[grid-auto-rows:120px]">
        {Array.from({ length: MONTH_ROWS * WEEK_COLUMNS }, (_, i) => (
          <div
            key={`sk-mcell-${i}`}
            className="h-full border-b border-outline-subtle/20 sm:border sm:border-outline-subtle sm:rounded-xl sm:bg-surface flex flex-col items-center sm:items-stretch pt-1.5 sm:p-2.5 gap-1.5 overflow-hidden"
          >
            <Block className="h-8 w-8 rounded-full sm:h-3.5 sm:w-5 sm:rounded-md" />
            {i % 3 === 0 && <Block className="hidden sm:block h-2.5 w-full" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Day-name headers, the all-day strip, and the hour rows of the time grid. */
function TimeGrid({ columns, tallHeader }: { columns: number; tallHeader: boolean }) {
  return (
    <>
      <div className="flex border-b border-outline shrink-0 bg-surface">
        {!tallHeader && <div className="w-14 shrink-0" />}
        {Array.from({ length: columns }, (_, i) => (
          <div
            key={`sk-head-${i}`}
            className={`flex-1 flex flex-col items-center gap-1 border-outline-subtle ${
              tallHeader ? "py-4 md:py-3" : "border-l py-2.5"
            }`}
          >
            <Block className="h-3 w-12" />
            <Block className={tallHeader ? "h-8 w-8" : "h-7 w-7"} />
          </div>
        ))}
      </div>

      <div className="flex border-b border-outline shrink-0 bg-surface min-h-[32px] md:min-h-[28px]">
        <div className="w-14 shrink-0" />
        {Array.from({ length: columns }, (_, i) => (
          <div key={`sk-allday-${i}`} className="flex-1 border-l border-outline" />
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {Array.from({ length: GRID_ROWS }, (_, row) => (
          <div key={`sk-row-${row}`} className="flex h-[60px] border-t border-outline">
            <div className="w-14 shrink-0 flex justify-end pr-2 -translate-y-[7px]">
              <Block className="h-2.5 w-9" />
            </div>
            {Array.from({ length: columns }, (_, col) => (
              <div key={`sk-cell-${row}-${col}`} className="flex-1 border-l border-outline px-1.5 py-1">
                {(row + col) % 4 === 0 && <Block className="h-full w-full" />}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

export default function CalendarSkeleton({ view }: { view?: CalendarViewMode }) {
  // Rendered as the dynamic-import fallback too, where no calendar exists yet to
  // pass its view down, so fall back to the same stored preference the calendar
  // will initialize itself from.
  const [savedView] = useState<CalendarViewMode>(readSavedCalendarView);
  const resolved = view ?? savedView;

  return (
    <div
      className="flex h-full overflow-hidden bg-page animate-pulse"
      role="status"
      aria-live="polite"
    >
      {/* Left sidebar: mini month, then the category list */}
      <aside className="hidden lg:flex lg:flex-col w-[272px] shrink-0 bg-surface border-r border-outline">
        <div className="p-4 border-b border-outline-subtle">
          <div className="flex items-center justify-between mb-3">
            <Block className="h-5 w-28" />
            <Block className="h-4 w-12" />
          </div>
          <div className="grid grid-cols-7 gap-0">
            {Array.from({ length: WEEK_COLUMNS }, (_, i) => (
              <div key={`sk-mini-h-${i}`} className="flex justify-center py-1">
                <Block className="h-2.5 w-2.5" />
              </div>
            ))}
            {Array.from({ length: MINI_CAL_DAYS }, (_, i) => (
              <div key={`sk-mini-${i}`} className="flex justify-center">
                <Block className="h-8 w-8 rounded-full" />
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 space-y-2.5">
          <Block className="h-3 w-24" />
          {Array.from({ length: SIDEBAR_ROWS }, (_, i) => (
            <div key={`sk-side-${i}`} className="space-y-1">
              <Block className="h-3.5 w-full" />
              <Block className="h-1.5 w-full rounded-full" />
            </div>
          ))}
        </div>
      </aside>

      {/* Center column: header bar, then whichever grid the view calls for */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between px-4 py-3 border-b border-outline bg-surface shrink-0">
          <Block className="h-7 w-48" />
          <div className="flex items-center gap-1.5">
            <Block className="h-8 w-40" />
            <Block className="h-8 w-28" />
          </div>
        </div>

        {/* Holds the space CalendarLoadingBar occupies in the real layout. */}
        <div className="h-0.5 shrink-0" />

        {resolved === "month" ? (
          <MonthGrid />
        ) : (
          <TimeGrid columns={resolved === "day" ? 1 : WEEK_COLUMNS} tallHeader={resolved === "day"} />
        )}
      </div>

      {/* Right side panel, present from xl up just like the real one */}
      <aside className="hidden xl:flex xl:flex-col w-[348px] shrink-0 bg-surface border-l border-outline p-4 gap-4">
        <Block className="h-6 w-40" />
        <Block className="h-8 w-full" />
        {Array.from({ length: PANEL_ROWS }, (_, i) => (
          <Block key={`sk-panel-${i}`} className="h-16 w-full rounded-xl" />
        ))}
      </aside>

      <span className="sr-only">Loading calendar</span>
    </div>
  );
}
