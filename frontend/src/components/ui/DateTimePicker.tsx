"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import dayjs from "dayjs";
import { Calendar as CalendarIcon, Clock } from "lucide-react";
import { menuAnim } from "@/components/ui/transitionClasses";
import { DAY_FMT, useCalendarWeeks, useDatePickerPopover } from "@/components/ui/datePickerCore";
import CalendarMonthGrid from "@/components/ui/CalendarMonthGrid";
import SegmentedToggle from "@/components/ui/SegmentedToggle";

interface DateTimePickerProps {
  /** Native `datetime-local` format, 'YYYY-MM-DDTHH:mm', or empty/undefined for no selection. */
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  /**
   * Fires right before the popover opens - mirrors the native input's
   * `onFocus`/`onClick`, which every existing call site used to seed a
   * default (today at noon, or a calendar's selected day) the moment the
   * picker was opened on an empty value. Kept as a caller callback rather
   * than a built-in default so each call site can keep its own contextual
   * default (e.g. `CalendarSidePanel` seeds from the day already selected on
   * the calendar, not always "now").
   */
  onOpen?: () => void;
  /**
   * Time of day only: the popover drops the month grid and the trigger reads
   * "10:00 AM". The value keeps its full 'YYYY-MM-DDTHH:mm' shape, so a date
   * picker beside it can own the day; `day` is the date a first pick lands on
   * while the value is still empty.
   */
  timeOnly?: boolean;
  /** 'YYYY-MM-DD' used for a pick made on an empty value. Defaults to today. */
  day?: string;
}

/**
 * A date + time-of-day calendar picker, replacing the browser's native
 * `<input type="datetime-local">` for the same reason `DatePicker` replaced
 * `type="date"`: the native control can't be restyled for dark mode and its
 * open/close state isn't scriptable. The time-of-day row is plain hour/minute
 * number inputs plus an AM/PM toggle rather than a native scrolling-column
 * picker - simpler to build and keyboard-friendly, at the cost of not
 * mirroring the OS control's exact interaction.
 */
export default function DateTimePicker({
  value,
  onChange,
  placeholder = "Select date & time",
  className = "",
  disabled = false,
  "aria-label": ariaLabel,
  onOpen,
  timeOnly = false,
  day,
}: DateTimePickerProps) {
  const [datePart, timePart] = value ? value.split("T") : [undefined, undefined];
  const { openState, setOpen, menuStyle, cursor, setCursor, btnRef, popoverRef, mounted, exiting } =
    useDatePickerPopover(datePart, 240);
  const weeks = useCalendarWeeks(cursor);
  const today = dayjs().format(DAY_FMT);
  const fallbackDay = day || today;

  const label = value && dayjs(value).isValid()
    ? dayjs(value).format(timeOnly ? "h:mm A" : "MMM D, YYYY, h:mm A")
    : placeholder;
  const TriggerIcon = timeOnly ? Clock : CalendarIcon;

  const hour24 = timePart ? parseInt(timePart.slice(0, 2), 10) : 12;
  const minute = timePart ? timePart.slice(3, 5) : "00";
  const isPM = hour24 >= 12;
  const hour12 = ((hour24 + 11) % 12) + 1;

  const commit = (nextDatePart: string, nextHour24: number, nextMinute: string) => {
    const h = String(Math.min(23, Math.max(0, nextHour24))).padStart(2, "0");
    const m = String(Math.min(59, Math.max(0, parseInt(nextMinute, 10) || 0))).padStart(2, "0");
    const next = `${nextDatePart}T${h}:${m}`;
    // Blurring an unchanged field must retain a repeated hour's saved offset.
    onChange(value && next === value.slice(0, 16) ? value : next);
  };

  const setHour12 = (nextHour12: number) => {
    const clamped = Math.min(12, Math.max(1, nextHour12 || 1));
    const next24 = isPM ? (clamped === 12 ? 12 : clamped + 12) : clamped === 12 ? 0 : clamped;
    commit(datePart || fallbackDay, next24, minute);
  };

  const setMinute = (nextMinute: string) => commit(datePart || fallbackDay, hour24, nextMinute);

  // Local text mirrors the committed hour/minute so the field can sit empty
  // mid-edit (backspacing to clear) instead of snapping back to the clamped
  // value on every keystroke; it only clamps and commits on blur/Enter.
  const [hourText, setHourText] = useState(() => String(hour12));
  const [minuteText, setMinuteText] = useState(() => minute);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resyncs the editable text from the committed value (day click, AM/PM toggle, or the value prop changing) without stomping an in-progress edit, since typing never changes hour12 until blur/Enter commits it
    setHourText(String(hour12));
  }, [hour12]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same as above, for minutes
    setMinuteText(minute);
  }, [minute]);

  const commitHourText = () => {
    const parsed = parseInt(hourText, 10);
    if (Number.isNaN(parsed)) {
      setHourText(String(hour12));
      return;
    }
    setHour12(parsed);
  };

  const commitMinuteText = () => {
    const parsed = parseInt(minuteText, 10);
    if (Number.isNaN(parsed)) {
      setMinuteText(minute);
      return;
    }
    setMinute(String(parsed));
  };

  const setPeriod = (period: "AM" | "PM") => {
    const wantPM = period === "PM";
    if (wantPM === isPM) return;
    const next24 = wantPM ? (hour12 === 12 ? 12 : hour12 + 12) : hour12 === 12 ? 0 : hour12;
    commit(datePart || fallbackDay, next24, minute);
  };

  return (
    <div className={className || "w-full"}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (!openState) onOpen?.();
          setOpen((s) => !s);
        }}
        aria-haspopup="dialog"
        aria-expanded={openState}
        aria-label={ariaLabel}
        className={`flex w-full items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-left text-sm text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
        }`}
      >
        <TriggerIcon size={15} className="shrink-0 text-on-surface-muted" aria-hidden="true" />
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
            aria-label={timeOnly ? "Choose a time" : "Choose a date and time"}
            style={menuStyle}
            className={`z-[9999] overflow-y-auto rounded-lg border border-outline bg-surface p-2 shadow-lg origin-top styled-scrollbar ${menuAnim(exiting)}`}
          >
            {!timeOnly && (
              <CalendarMonthGrid
                size="compact"
                cursor={cursor}
                onCursorChange={setCursor}
                weeks={weeks}
                today={today}
                dayState={(key) => (key === datePart ? "selected" : "idle")}
                onDayClick={(key) => commit(key, hour24, minute)}
              />
            )}

            <div className={timeOnly ? "flex items-center gap-1.5" : "mt-2 flex items-center gap-1.5 border-t border-outline-subtle pt-2"}>
              <input
                type="number"
                min={1}
                max={12}
                value={hourText}
                onChange={(e) => setHourText(e.target.value)}
                onBlur={commitHourText}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitHourText();
                  }
                }}
                aria-label="Hour"
                className="w-10 rounded-md border border-input-border bg-input-bg px-1 py-1 text-center text-xs text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
              <span className="text-on-surface-muted">:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={minuteText}
                onChange={(e) => setMinuteText(e.target.value)}
                onBlur={commitMinuteText}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitMinuteText();
                  }
                }}
                aria-label="Minute"
                className="w-10 rounded-md border border-input-border bg-input-bg px-1 py-1 text-center text-xs text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
              <SegmentedToggle
                options={[
                  { value: "AM", label: "AM" },
                  { value: "PM", label: "PM" },
                ]}
                value={isPM ? "PM" : "AM"}
                onChange={setPeriod}
                ariaLabel="AM or PM"
                size="xs"
                className="ml-auto"
              />
            </div>

            <div className="mt-1.5 flex items-center justify-between border-t border-outline-subtle pt-1.5">
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
