"use client";

import DatePicker from "@/components/ui/DatePicker";
import DateTimePicker from "@/components/ui/DateTimePicker";
import FieldError from "@/components/ui/FieldError";
import FieldLabel from "@/components/ui/FieldLabel";
import { defaultEndFor, endFitsStart } from "@/components/calendarComp/calendarTiming";
import { todayLocalDate } from "@/lib/utils/dateUtils";

const DEFAULT_START_TIME = "12:00";

interface DateTimeRangeFieldsProps {
  /** Prefix for the two row labels' ids, which also name the date pickers. */
  idPrefix: string;
  allDay: boolean;
  /** "Start" on an event, "Due" on a task. */
  startLabel: string;
  startRequired?: boolean;
  /**
   * 'YYYY-MM-DDTHH:mm'. An all-day start keeps the 'T00:00' placeholder time
   * every event and task form already uses. Empty means no start yet.
   */
  start: string;
  onStartChange: (value: string) => void;
  /** Seeds a contextual start (the calendar's selected day) when the time picker opens empty. */
  onStartOpen?: () => void;
  /**
   * A timed end as 'YYYY-MM-DDTHH:mm', or an all-day end as the last day it
   * covers ('YYYY-MM-DD'). Empty means no end.
   */
  end: string;
  onEndChange: (value: string) => void;
  /**
   * Marks the end required, like `startRequired`, for an item that cannot be
   * saved without one (a Google or Outlook event): the message the end row
   * shows while the end is empty. The caller keeps its Continue/Save disabled
   * while it is.
   */
  endRequired?: string;
  /**
   * Hides the end row, for a task with no due date for an end to come after.
   * Shown, the row stays disabled until there is a start.
   */
  showEnd?: boolean;
}

/**
 * The start and optional end of an event or task, as two rows: a date and a
 * time each, or just the dates when the item is all-day. The caller keeps its
 * Continue/Save disabled while `endFitsStart` is false; the end row says why.
 */
export default function DateTimeRangeFields({
  idPrefix,
  allDay,
  startLabel,
  startRequired = false,
  start,
  onStartChange,
  onStartOpen,
  end,
  onEndChange,
  endRequired,
  showEnd = true,
}: DateTimeRangeFieldsProps) {
  const startDay = start ? start.slice(0, 10) : "";
  const endDay = end ? end.slice(0, 10) : "";
  const fits = endFitsStart(start, end, allDay);

  const changeStartDay = (day: string) => {
    if (!day) return onStartChange("");
    if (day === startDay) return onStartChange(start);
    onStartChange(allDay ? `${day}T00:00` : `${day}T${start ? start.slice(11, 16) : DEFAULT_START_TIME}`);
  };

  // A first end day picked on a timed item takes the default length after
  // the start; after that, changing the day keeps the time already chosen.
  // When that time on the start day would come before the start (a 23:30 start
  // whose default end is 00:30), the end falls back to the default length. A
  // day before the start day is left as picked, and the row says why.
  const changeEndDay = (day: string) => {
    if (!day) return onEndChange("");
    if (day === endDay) return onEndChange(end);
    if (allDay) return onEndChange(day);
    const defaultEnd = defaultEndFor(start);
    if (!end && day === defaultEnd.slice(0, 10)) return onEndChange(defaultEnd);
    const time = end ? end.slice(11, 16) : (defaultEnd.slice(11, 16) || DEFAULT_START_TIME);
    const next = `${day}T${time}`;
    if (defaultEnd && day === startDay && !endFitsStart(start, next, false)) return onEndChange(defaultEnd);
    onEndChange(next);
  };

  return (
    <>
      <div>
        <FieldLabel id={`${idPrefix}-start-label`}>{startRequired ? `${startLabel} *` : startLabel}</FieldLabel>
        <div className="flex gap-2">
          <DatePicker
            ariaLabelledBy={`${idPrefix}-start-label`}
            className="min-w-0 flex-1"
            value={startDay}
            onChange={changeStartDay}
          />
          {!allDay && (
            <DateTimePicker
              timeOnly
              day={startDay || todayLocalDate()}
              aria-label={`${startLabel} time`}
              placeholder="Time"
              className="w-36 shrink-0"
              value={start}
              onChange={onStartChange}
              onOpen={() => { if (!start) onStartOpen?.(); }}
            />
          )}
        </div>
      </div>

      {showEnd && (
        <div>
          <FieldLabel id={`${idPrefix}-end-label`}>{endRequired ? "End *" : "End"}</FieldLabel>
          <div className="flex gap-2">
            <DatePicker
              ariaLabelledBy={`${idPrefix}-end-label`}
              placeholder={endRequired ? undefined : "No end"}
              disabled={!start}
              className="min-w-0 flex-1"
              openTo={startDay || undefined}
              value={endDay}
              onChange={changeEndDay}
            />
            {!allDay && (
              <DateTimePicker
                timeOnly
                day={endDay || startDay || todayLocalDate()}
                aria-label="End time"
                placeholder="Time"
                disabled={!start}
                className="w-36 shrink-0"
                value={end}
                onChange={onEndChange}
                onOpen={() => { if (!end && start) onEndChange(defaultEndFor(start)); }}
              />
            )}
          </div>
          {!fits && (
            <FieldError message={allDay ? "The last day cannot be before the first day." : "The end must be after the start."} />
          )}
          {endRequired && start && !end && <FieldError message={endRequired} />}
        </div>
      )}
    </>
  );
}
