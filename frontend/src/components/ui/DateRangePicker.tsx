"use client";

import { createPortal } from "react-dom";
import dayjs from "dayjs";
import { Calendar as CalendarIcon } from "lucide-react";
import { menuAnim } from "@/components/ui/transitionClasses";
import { DAY_FMT, useCalendarWeeks, useDatePickerPopover } from "@/components/ui/datePickerCore";
import CalendarMonthGrid from "@/components/ui/CalendarMonthGrid";

interface DateRangePickerProps {
  /** Inclusive range bounds, both 'YYYY-MM-DD'. Either may be set alone. */
  from?: string;
  to?: string;
  onChange: (next: { from?: string; to?: string }) => void;
  placeholder?: string;
  className?: string;
}

/**
 * A calendar range picker, replacing the browser's native `<input
 * type="date">` for filter bars: the native picker can't be restyled for dark
 * mode (it always renders as a light-themed OS control) and its open/close
 * state isn't scriptable, which is exactly what made closing it on a second
 * click impossible to do reliably. This owns its own open state end to end - 
 * a body portal with its own positioning and outside-click close - so there is
 * nothing to fight. See `DatePicker` for the single-date sibling.
 */
export default function DateRangePicker({
  from,
  to,
  onChange,
  placeholder = "Select dates",
  className = "",
}: DateRangePickerProps) {
  const { openState, setOpen, menuStyle, cursor, setCursor, btnRef, popoverRef, mounted, exiting } =
    useDatePickerPopover(from || to);
  const weeks = useCalendarWeeks(cursor);
  const today = dayjs().format(DAY_FMT);

  const selectDay = (key: string) => {
    // A fresh click when a complete range is already selected starts a new
    // one, rather than endlessly extending the old range from one end.
    if (!from || (from && to)) {
      onChange({ from: key, to: undefined });
      return;
    }
    // Second click: order the two ends regardless of click order, so picking
    // an earlier date second still produces a valid from <= to range.
    if (key < from) onChange({ from: key, to: from });
    else onChange({ from, to: key });
  };

  const label = (() => {
    if (!from && !to) return placeholder;
    const fmt = (d: string) => dayjs(d).format("MMM D, YYYY");
    if (from && to) return from === to ? fmt(from) : `${dayjs(from).format("MMM D")} – ${fmt(to)}`;
    return from ? `From ${fmt(from)}` : `Through ${fmt(to!)}`;
  })();

  return (
    <div className={className || "w-full"}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-haspopup="dialog"
        aria-expanded={openState}
        className="flex w-full items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-left text-sm text-on-surface transition-transform duration-100 active:scale-[0.99] motion-reduce:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring cursor-pointer"
      >
        <CalendarIcon size={15} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
        <span className={`min-w-0 flex-1 truncate ${from || to ? "text-on-surface" : "text-on-surface-muted"}`}>
          {label}
        </span>
      </button>

      {mounted &&
        menuStyle &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Choose a date range"
            style={menuStyle}
            className={`z-[9999] overflow-y-auto rounded-lg border border-outline bg-surface p-3 shadow-lg origin-top styled-scrollbar ${menuAnim(exiting)}`}
          >
            <CalendarMonthGrid
              cursor={cursor}
              onCursorChange={setCursor}
              weeks={weeks}
              today={today}
              dayState={(key) => {
                if (key === from || key === to) return "selected";
                if (!!from && !!to && key > from && key < to) return "in-range";
                return "idle";
              }}
              onDayClick={selectDay}
            />

            <div className="mt-2 flex items-center justify-between border-t border-outline-subtle pt-2">
              <button
                type="button"
                onClick={() => onChange({ from: undefined, to: undefined })}
                className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover cursor-pointer"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs font-medium text-accent-emphasis hover:text-accent-emphasis-hover cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
