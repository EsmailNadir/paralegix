"use client";

import type { Dayjs } from "dayjs";
import { DAY_FMT, WEEKDAY_LABELS } from "./datePickerCore";

/**
 * How a day should be painted. `in-range` is the middle of a selected span and
 * only `DateRangePicker` ever returns it.
 */
export type CalendarDayState = "selected" | "in-range" | "idle";

/**
 * The month header and the seven-column day grid, shared by `DatePicker`,
 * `DateRangePicker` and `DateTimePicker`.
 *
 * `datePickerCore` already shared the hooks behind the three pickers, but each
 * one drew this. The header and the weekday row were byte-identical between
 * them; what actually differed was which days count as selected, which is now
 * the `dayState` function, and the metrics, which are `size`.
 *
 * The pickers keep their own trigger, popover and footer, since those are what
 * makes a date picker different from a range picker.
 */
export default function CalendarMonthGrid({
  cursor,
  onCursorChange,
  weeks,
  today,
  dayState,
  onDayClick,
  size = "default",
}: {
  cursor: Dayjs;
  onCursorChange: (next: (current: Dayjs) => Dayjs) => void;
  weeks: Dayjs[][];
  /** Today as `YYYY-MM-DD`, so the grid does not re-derive it per cell. */
  today: string;
  dayState: (key: string) => CalendarDayState;
  onDayClick: (key: string) => void;
  /**
   * "compact" is `DateTimePicker`, whose popover is 240px rather than 288px
   * because the time row sits under the grid.
   */
  size?: "default" | "compact";
}) {
  const compact = size === "compact";

  return (
    <>
      <div className={`${compact ? "mb-1.5" : "mb-2"} flex items-center justify-between`}>
        <button
          type="button"
          onClick={() => onCursorChange((c) => c.subtract(1, "month"))}
          aria-label="Previous month"
          className="rounded-md p-1 text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-transform active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          ‹
        </button>
        <span className={`${compact ? "text-xs" : "text-sm"} font-semibold text-on-surface`}>
          {cursor.format("MMMM YYYY")}
        </span>
        <button
          type="button"
          onClick={() => onCursorChange((c) => c.add(1, "month"))}
          aria-label="Next month"
          className="rounded-md p-1 text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-transform active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        >
          ›
        </button>
      </div>

      <div className={`grid grid-cols-7 ${compact ? "gap-y-0.5" : "gap-y-1"}`}>
        {WEEKDAY_LABELS.map((d, i) => (
          <span
            key={i}
            className={`text-center ${compact ? "text-[10px]" : "text-[11px]"} font-medium text-on-surface-muted`}
          >
            {d}
          </span>
        ))}
        {weeks.map((week) =>
          week.map((day) => {
            const key = day.format(DAY_FMT);
            const inMonth = day.month() === cursor.month();
            const state = dayState(key);
            const isToday = key === today;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onDayClick(key)}
                className={`${compact ? "m-[1px] h-6 w-6 text-[11px]" : "m-0.5 h-7 w-7 text-xs"} flex items-center justify-center rounded-md transition-colors cursor-pointer ${
                  state === "selected"
                    ? "bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover"
                    : state === "in-range"
                      ? "bg-accent-range text-on-surface"
                      : "hover:bg-surface-hover text-on-surface"
                } ${!inMonth ? "text-on-surface-muted/50" : ""} ${
                  isToday && state !== "selected" ? "ring-1 ring-inset ring-accent-indicator" : ""
                }`}
              >
                {day.date()}
              </button>
            );
          }),
        )}
      </div>
    </>
  );
}
