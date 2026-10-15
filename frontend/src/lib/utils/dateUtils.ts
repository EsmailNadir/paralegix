import dayjs from 'dayjs';

export function getMonthDays(year: number, month: number) {
  const start = dayjs().year(year).month(month).startOf('month');
  const end = dayjs().year(year).month(month).endOf('month');

  const days = [];

  // Add empty days before the first day to align weekday
  const startWeekday = start.day();
  for (let i = 0; i < startWeekday; i++) {
    days.push(null);
  }

  // Add actual days of the month
  for (let i = 0; i < end.date(); i++) {
    days.push(start.add(i, 'day'));
  }

  return days;
}

/**
 * Parse a date-ish value into a Date in the viewer's LOCAL timezone, and the
 * single parsing primitive the other date helpers build on. A day-only
 * "YYYY-MM-DD" string is built from its calendar parts so it lands on local
 * midnight of that day, instead of `new Date("YYYY-MM-DD")` which is UTC midnight
 * and reads as the previous day for viewers behind UTC. Dates, numbers and
 * timestamp strings are parsed normally. Returns null when missing/unparseable.
 */
export function toLocalDate(value?: string | number | Date | null): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const dayOnly = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = dayOnly
    ? new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3]))
    : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date-ish value (ISO string or Date) as "Jan 5, 2026". Day-only
 * "YYYY-MM-DD" values are parsed in local time so they don't shift a day for
 * viewers behind UTC. Missing/unparseable values render the fallback.
 */
export function formatDate(date: unknown, fallback = "N/A"): string {
  if (!date) return fallback;
  try {
    const d = toLocalDate(date as string | number | Date);
    if (!d || isNaN(d.getTime())) return fallback;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return fallback;
  }
}

/**
 * Format a day-only value ("YYYY-MM-DD", as returned by the API for `date`
 * columns) without shifting across timezones. Values with a time component are
 * parsed normally, so this is safe on either. Pass `options` to control the
 * output format (e.g. a long date).
 */
export function formatDateOnly(
  value?: string | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = ""
): string {
  const d = toLocalDate(value);
  if (!d) return fallback;
  return options ? d.toLocaleDateString("en-US", options) : d.toLocaleDateString();
}

/**
 * How long ago a moment was, in the coarsest unit that still reads naturally
 * ("3m ago", "5h ago", "2d ago"), falling back to an absolute short date once a
 * week has passed - "3w ago" or "2mo ago" stops being scannable at that range,
 * while "Jan 5" lets the reader place it on a calendar. Shared by the
 * notification feed and the admin console so "how long ago" reads the same
 * everywhere it's asked.
 */
export function formatTimeAgo(value?: string | number | Date | null, fallback = ""): string {
  const d = toLocalDate(value);
  if (!d) return fallback;

  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * True when `value`'s LOCAL calendar day is strictly before today. Works on
 * day-only strings and instants alike (both parsed via toLocalDate). Use for
 * "overdue" checks so the flip happens at the viewer's local midnight rather than
 * at a fixed UTC instant.
 */
export function isBeforeToday(value?: string | number | Date | null): boolean {
  const d = toLocalDate(value);
  if (!d) return false;
  const now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return day.getTime() < today.getTime();
}

/**
 * A task is overdue when it is not completed and its due day has already passed
 * in the viewer's local time. Shared by the task grid and the matter/client
 * task views so the "Overdue" indicator is computed one way everywhere.
 */
export function isTaskOverdue(task: { status?: string | null; dueDate?: string | null }): boolean {
  if (!task || task.status === "completed") return false;
  return isBeforeToday(task.dueDate);
}

/**
 * Today's date, "YYYY-MM-DD", in the VIEWER's local calendar day - not UTC's.
 * `new Date().toISOString().slice(0, 10)` (UTC today) reads as YESTERDAY for
 * part of the day for a viewer ahead of UTC (their calendar flips before
 * UTC's does), and as TOMORROW for part of the day for a viewer behind UTC
 * (their calendar flips after UTC's does). Use this for anything that
 * prefills or compares against "today", such as a form's default date.
 */
export function todayLocalDate(): string {
  return dayjs().format("YYYY-MM-DD");
}

export function getDefaultDateTimeLocalValue(baseDate?: Date | string) {
  const date = baseDate ? dayjs(baseDate) : dayjs();
  const safeDate = date.isValid() ? date : dayjs();

  return safeDate
    .hour(12)
    .minute(0)
    .second(0)
    .millisecond(0)
    .format('YYYY-MM-DDTHH:mm');
}

/**
 * True when an INSTANT has already passed.
 *
 * For a `timestamptz` value (a calendar event's `date`, a `created_at`), which is
 * a real point in time rather than a calendar label. Comparing two instants needs
 * no time zone: both sides are absolute, so `<` is already correct in any zone.
 *
 * Do NOT use this for a day-only `date` column. `new Date('2026-03-15')` is UTC
 * midnight, so for a viewer behind UTC it has already "passed" while it is still
 * the 14th locally, and the value flips a day early. Use `isBeforeToday` for
 * those, which anchors the day in the viewer's own calendar.
 *
 * It exists because the same expression was written inline at three call sites
 * (the matter overview, `MatterEventsTab` and `ClientEventsTab`), which is how a
 * day-only value eventually gets passed to one of them by mistake.
 */
export function isPastInstant(value?: string | number | Date | null): boolean {
  if (!value) return false;
  const instant = value instanceof Date ? value : new Date(value);
  const time = instant.getTime();
  return Number.isNaN(time) ? false : time < Date.now();
}

/**
 * A compact agenda label: "Today · 3:00 PM", "Tomorrow", "Mon, Sep 28 · 9:00 AM".
 *
 * An all-day item is its day alone. Its stored instant is only the day's
 * noon-UTC anchor, so the day is read off the date it carries (never shifted
 * by the viewer's zone) and no time is shown.
 */
export function formatAgendaWhen(value?: string | null, allDay = false): string {
  if (!value) return "";
  const when = allDay ? dayjs(String(value).slice(0, 10)) : dayjs(value);
  if (!when.isValid()) return "";
  const diffDays = when.startOf("day").diff(dayjs().startOf("day"), "day");
  const label = diffDays === 0
    ? "Today"
    : diffDays === 1
      ? "Tomorrow"
      : when.toDate().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (allDay) return label;
  return `${label} · ${when.toDate().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * True once today is strictly past `value`'s day plus `graceDays`: the rule
 * the backend applies before a late fee can be charged. `value` is a due day
 * ('YYYY-MM-DD', or an instant carrying one at its noon-UTC anchor).
 */
export function isPastDueBeyond(value?: string | null, graceDays = 0): boolean {
  if (!value) return false;
  const cutoff = dayjs(String(value).slice(0, 10)).add(Math.max(0, graceDays || 0), "day");
  return cutoff.isValid() ? isBeforeToday(cutoff.format("YYYY-MM-DD")) : false;
}

/**
 * How long ago a moment was, in calendar days in the viewer's zone: "Today",
 * "Yesterday", "3d ago", then a short date past a week. Calendar days, not
 * 24-hour blocks: 11pm yesterday is "Yesterday" at 10am, not "Today".
 */
export function formatRelativeDay(value?: string | null): string {
  if (!value) return "";
  const when = dayjs(value);
  if (!when.isValid()) return "";
  const diffDays = dayjs().startOf("day").diff(when.startOf("day"), "day");
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`;
  return when.toDate().toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The viewer-local calendar day of a value, as "YYYY-MM-DD". For ordering rows
 * that mix day-only fields with instants: a day-only string already IS a
 * calendar day and is returned as is, and an instant is read in the viewer's
 * zone. Returns null when missing or unparseable.
 */
export function localDayKey(value?: string | number | Date | null): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = toLocalDate(value);
  return d ? dayjs(d).format("YYYY-MM-DD") : null;
}
