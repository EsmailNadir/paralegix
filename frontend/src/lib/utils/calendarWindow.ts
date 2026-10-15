import { type Dayjs } from "dayjs";

/**
 * The span of days the calendar has loaded, as inclusive day-only bounds plus the
 * cache key they belong to.
 */
export interface CalendarWindow {
  /** Cache key for this window. Quantized to the anchor's month. */
  key: string;
  /** Inclusive first day, 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive last day, 'YYYY-MM-DD'. */
  to: string;
}

const DAY_FORMAT = "YYYY-MM-DD";

/**
 * The window of days the calendar needs for a given anchor date.
 *
 * The key is quantized to the anchor's MONTH, not to the exact view, so moving
 * day-to-day or week-to-week inside a month reuses the same cache entry and
 * issues no request. Only crossing a month boundary changes the key.
 *
 * The bounds cover the anchor's month padded a month either side and snapped out
 * to week boundaries. The padding does two jobs: it keeps a week that straddles
 * a month edge (and the month grid's leading/trailing days) inside the window,
 * and it means the neighbouring months are already loaded often enough that
 * stepping between them usually renders from cache.
 *
 * Weeks start on Sunday, which is dayjs's default and what the calendar's own
 * grid header assumes.
 */
export function getCalendarWindow(anchor: Dayjs): CalendarWindow {
  const month = anchor.startOf("month");
  return {
    key: month.format("YYYY-MM"),
    from: month.subtract(1, "month").startOf("week").format(DAY_FORMAT),
    to: month.add(1, "month").endOf("month").endOf("week").format(DAY_FORMAT),
  };
}

/**
 * Whether two windows share at least one day.
 *
 * Bounds are 'YYYY-MM-DD', so a lexical comparison is a chronological one. Used
 * to tell a step into an adjacent month (whose days are already loaded, because
 * windows are padded a month either side) from a jump to a range the loaded data
 * says nothing about.
 */
export function windowsOverlap(a: CalendarWindow, b: CalendarWindow): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/**
 * The windows either side of the anchor's, for idle prefetching.
 *
 * Returned as [previous, next] so a caller can warm both directions of the
 * navigation the user is most likely to take next.
 */
export function neighbourWindows(anchor: Dayjs): [CalendarWindow, CalendarWindow] {
  return [
    getCalendarWindow(anchor.subtract(1, "month")),
    getCalendarWindow(anchor.add(1, "month")),
  ];
}
