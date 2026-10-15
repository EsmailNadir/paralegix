"use client";

import { useId } from "react";
import { createPortal } from "react-dom";
import dayjs from "dayjs";
import { Calendar as CalendarIcon } from "lucide-react";
import { menuAnim } from "@/components/ui/transitionClasses";
import { DAY_FMT, useCalendarWeeks, useDatePickerPopover } from "@/components/ui/datePickerCore";
import CalendarMonthGrid from "@/components/ui/CalendarMonthGrid";

interface DatePickerProps {
  /** 'YYYY-MM-DD', or empty/undefined for no selection. */
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  /**
   * Id of a visible `<label>` element that names this field.
   *
   * The trigger is a button, not a native `<input type="date">`, so a caller's
   * `<label htmlFor>` has nothing to bind to and the control reaches a screen
   * reader with no name at all. Pass the label's id here instead. The trigger
   * names itself as well, so the reader hears the field name AND the date
   * currently selected rather than only the first of the two.
   *
   * `aria-label` still wins when both are given: that is the caller saying the
   * visible text is not the whole name.
   */
  ariaLabelledBy?: string;
  /**
   * Drops the trigger's own border, background, and focus ring, for embedding
   * flush inside a container that already supplies them - e.g. a "fused"
   * multi-field cluster with one shared outer border and `divide-x` between
   * fields (see `FlatFeeEditorRow`). Without this, the trigger's own border
   * nests inside the cluster's border instead of reading as one of its cells.
   * It also marks the trigger `.fused-field-cell`, so the cluster's ring is
   * the only focus indicator (see `.fused-field-group` in `global.css`).
   */
  bare?: boolean;
  /**
   * 'YYYY-MM-DD' whose month the calendar opens on while there is no value,
   * e.g. an end date opening on its start's month rather than today's.
   */
  openTo?: string;
}

/**
 * A single-date calendar picker, replacing the browser's native `<input
 * type="date">`: the native picker can't be restyled for dark mode (it always
 * renders as a light-themed OS control) and its open/close state isn't
 * scriptable. See `DateRangePicker` for the from/to sibling used by filter
 * bars.
 */
export default function DatePicker({
  value,
  onChange,
  placeholder = "Select date",
  className = "",
  disabled = false,
  "aria-label": ariaLabel,
  ariaLabelledBy,
  bare = false,
  openTo,
}: DatePickerProps) {
  const triggerId = useId();
  const { openState, setOpen, menuStyle, cursor, setCursor, btnRef, popoverRef, mounted, exiting } =
    useDatePickerPopover(value || openTo);
  const weeks = useCalendarWeeks(cursor);
  const today = dayjs().format(DAY_FMT);

  const label = value ? dayjs(value).format("MMM D, YYYY") : placeholder;

  return (
    <div className={className || "w-full"}>
      <button
        ref={btnRef}
        id={triggerId}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((s) => !s)}
        aria-haspopup="dialog"
        aria-expanded={openState}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy && !ariaLabel ? `${ariaLabelledBy} ${triggerId}` : undefined}
        className={`flex w-full items-center gap-2 text-left text-sm text-on-surface focus:outline-none ${
          bare
            ? "fused-field-cell px-4 py-3 bg-transparent"
            : "rounded-md border border-input-border bg-input-bg px-3 py-2 focus-visible:ring-2 focus-visible:ring-focus-ring"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      >
        <CalendarIcon size={15} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
        <span className={`min-w-0 flex-1 truncate ${value ? "text-on-surface" : "text-on-surface-muted"}`}>
          {label}
        </span>
      </button>

      {mounted &&
        menuStyle &&
        !disabled &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Choose a date"
            style={menuStyle}
            className={`z-[9999] overflow-y-auto rounded-lg border border-outline bg-surface p-3 shadow-lg origin-top styled-scrollbar ${menuAnim(exiting)}`}
          >
            <CalendarMonthGrid
              cursor={cursor}
              onCursorChange={setCursor}
              weeks={weeks}
              today={today}
              dayState={(key) => (key === value ? "selected" : "idle")}
              onDayClick={(key) => {
                onChange(key);
                setOpen(false);
              }}
            />

            <div className="mt-2 flex items-center justify-between border-t border-outline-subtle pt-2">
              <button
                type="button"
                onClick={() => onChange("")}
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
