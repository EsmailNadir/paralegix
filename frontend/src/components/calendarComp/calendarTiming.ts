import dayjs from 'dayjs';
import type { Event, Task } from '@/types';
import { getUserTimeZone } from '@/lib/utils/timezone';

/** Explicit all-day flags take precedence; older tasks without one retain the midnight fallback. */
export function taskMinuteOfDay(task: Task): number | null {
  const value = task.dueDateLocalInput || task.dueDate;
  if (!value || task.allDay === true) return null;
  const date = dayjs(value);
  if (!date.isValid()) return null;
  const minutes = date.hour() * 60 + date.minute();
  return task.allDay === undefined && minutes === 0 ? null : minutes;
}

/** All-day provider timestamps encode calendar labels, not viewer-local instants. */
export function eventStartValue(event: Event): string | undefined {
  return event.allDay ? event.start?.slice(0, 10) : event.start;
}

/** Minutes past midnight an event starts at, or null for an all-day or undated one. */
export function eventMinuteOfDay(event: Event, day?: string): number | null {
  if (event.allDay || !event.start) return null;
  const d = dayjs(event.start);
  if (day && d.format('YYYY-MM-DD') < day) return 0;
  return d.hour() * 60 + d.minute();
}

/**
 * How long an item with no end of its own lasts, matching the block the
 * backend gives it on Google and Outlook (`DEFAULT_TIMED_BLOCK_MS` there).
 */
export const DEFAULT_TIMED_BLOCK_MS = 60 * 60 * 1000;

/** An all-day event form's value for a picked day: that day at local midnight. */
export function allDayInputFor(day: string): string {
  return day ? `${day}T00:00` : '';
}

/**
 * An all-day form value turned back into a timed one. The day's midnight
 * placeholder becomes noon, the default time a new item gets; a real time the
 * user had set is kept.
 */
export function timedInputFromAllDay(value: string): string {
  return value.endsWith('T00:00') ? `${value.slice(0, 10)}T12:00` : value;
}

/** Preserve the offset when a repeated wall clock would resolve to another instant. */
export function timedFormValueFor(instant: string | null | undefined, input: string): string {
  if (!instant || !input) return input;
  const at = dayjs(instant);
  const parsed = dayjs(input);
  if (at.isValid() && parsed.isValid()
    && at.format('YYYY-MM-DDTHH:mm') === input.slice(0, 16)
    && Math.floor(at.valueOf() / 60000) !== Math.floor(parsed.valueOf() / 60000)) {
    return at.format('YYYY-MM-DDTHH:mmZ');
  }
  return input;
}

/**
 * An event form's end value for an event being edited. A timed end is the
 * server's local form value, like the start's. An all-day end is held as the
 * last day the event covers, which is one before the stored end: the API keeps
 * the exclusive day after the last day, the way Google and Outlook take it.
 */
export function endFormValueFor(event: { allDay?: boolean; endsAt?: string | null; endsAtLocalInput?: string | null }): string {
  if (!event.endsAt) return '';
  if (event.allDay) return dayjs(event.endsAt.slice(0, 10)).subtract(1, 'day').format('YYYY-MM-DD');
  return timedFormValueFor(event.endsAt, event.endsAtLocalInput || '');
}

/**
 * The `endsAt` an event form sends: null for no end, the exclusive day after
 * the picked last day for an all-day event, and the wall clock as picked for a
 * timed one, which the server resolves in the caller's zone like the start.
 */
export function endsAtPayloadFor(allDay: boolean, end: string): string | null {
  if (!end) return null;
  return allDay ? dayjs(end.slice(0, 10)).add(1, 'day').format('YYYY-MM-DD') : end;
}

/**
 * The end carried along when the start moves, so the event keeps its length.
 * The server applies the same rule to an edit that sends no end. Clearing the
 * start clears the end too: an end left behind would block the next start
 * picked after it.
 */
export function endFollowingStart(oldStart: string, newStart: string, end: string, allDay: boolean): string {
  if (!newStart) return '';
  if (!end || !oldStart) return end;
  if (allDay) {
    const days = dayjs(newStart.slice(0, 10)).diff(dayjs(oldStart.slice(0, 10)), 'day');
    return dayjs(end.slice(0, 10)).add(days, 'day').format('YYYY-MM-DD');
  }
  const from = dayjs(oldStart);
  const to = dayjs(newStart);
  if (!from.isValid() || !to.isValid()) return end;
  const shifted = dayjs(end).add(to.diff(from), 'millisecond');
  return timedFormValueFor(shifted.toISOString(), shifted.format('YYYY-MM-DDTHH:mm'));
}

/**
 * A form end for an event imported from Google or Outlook, whose update takes
 * provider bounds: the exclusive next day for an all-day event, an instant for
 * a timed one (the form's wall clock is the viewer's own zone).
 */
export function providerEndFromForm(allDay: boolean, end: string): string {
  return allDay ? dayjs(end.slice(0, 10)).add(1, 'day').format('YYYY-MM-DD') : dayjs(end).toISOString();
}

/**
 * An end carried across an All day toggle, keeping the day the user gave it.
 * Into all-day, a timed end becomes its own day as the last day, and keeps its
 * time of day the way an all-day start does: everything that reads an all-day
 * end reads only its day. Out of it, a kept time is used again when it still
 * comes after the new start (`nextStart`, the form's start after the toggle).
 * Otherwise the last day takes the time an hour past the new start, or the
 * hour after the start itself if that would not come after it.
 */
export function endAcrossAllDayToggle(end: string, toAllDay: boolean, nextStart: string): string {
  if (!end) return '';
  if (toAllDay) return end;
  if (end.length > 10 && endFitsStart(nextStart, end, false)) return end;
  const fallback = defaultEndFor(nextStart);
  const candidate = `${end.slice(0, 10)}T${fallback.slice(11, 16) || '13:00'}`;
  return endFitsStart(nextStart, candidate, false) ? candidate : fallback;
}

/** The schedule an event or task form holds: its start, its end, and whether it is all-day. */
export interface ScheduleFields {
  date: string;
  endsAt: string;
  allDay: boolean;
}

/**
 * The schedule fields an edit form should send: only those the user changed
 * from the values the form opened with. One left as it opened is left out, so
 * the server keeps the value it stores. The form may have opened from a cached
 * list older than a provider change polled in since (a Google event resized
 * to two hours), and resending the cached end would undo that change.
 *
 * An end that only followed a moved start (`endFollowingStart`) is left out
 * too: every update route carries its stored end along with a new start when
 * no end is sent, keeping the stored length rather than the cached one. That
 * holds only while the all-day flag stays put; a flip with no end makes the
 * server drop the end, so a followed end is still sent then.
 */
export function scheduleEdits(opened: ScheduleFields, current: ScheduleFields): Partial<ScheduleFields> {
  const edits: Partial<ScheduleFields> = {};
  if (current.date !== opened.date) edits.date = current.date;
  if (current.endsAt !== opened.endsAt) {
    const followedStart = edits.date !== undefined && current.allDay === opened.allDay && !!opened.endsAt
      && current.endsAt === endFollowingStart(opened.date, current.date, opened.endsAt, current.allDay);
    if (!followedStart) edits.endsAt = current.endsAt;
  }
  if (current.allDay !== opened.allDay) edits.allDay = current.allDay;
  return edits;
}

/** The schedule a matter or client event's edit form opens with. */
export function eventScheduleFormValues(event: {
  allDay?: boolean;
  date?: string | null;
  dateLocalInput?: string | null;
  endsAt?: string | null;
  endsAtLocalInput?: string | null;
}): ScheduleFields {
  return {
    date: event.allDay ? event.dateLocalInput || '' : timedFormValueFor(event.date, event.dateLocalInput || ''),
    endsAt: endFormValueFor({ allDay: event.allDay === true, endsAt: event.endsAt, endsAtLocalInput: event.endsAtLocalInput }),
    allDay: event.allDay ?? false,
  };
}

/** The end a timed form offers when its end picker opens empty: the default block after the start. */
export function defaultEndFor(start: string): string {
  if (!start || !dayjs(start).isValid()) return '';
  const end = dayjs(start).add(DEFAULT_TIMED_BLOCK_MS, 'millisecond');
  return timedFormValueFor(end.toISOString(), end.format('YYYY-MM-DDTHH:mm'));
}

/**
 * Whether a form's end is acceptable. No end always is. A timed end has to
 * come after the start; an all-day last day may be the first day itself.
 */
export function endFitsStart(start: string, end: string, allDay: boolean): boolean {
  if (!end || !start) return true;
  if (allDay) return end.slice(0, 10) >= start.slice(0, 10);
  return dayjs(end).isAfter(dayjs(start));
}

const WHEN_DAY = 'ddd, MMM D, YYYY';
const WHEN_TIME = 'h:mm A';

/**
 * The full span of an event for its detail view: "Sat, Sep 5, 2026 · 2:00 PM –
 * 3:30 PM", the end dated too when it falls on another day, or "… · All day".
 *
 * An all-day event is read off the calendar days it carries (its end is
 * exclusive, as Google and Outlook send it), never shifted by the viewer's
 * zone. A timed event uses the server's own formatting when the API sent it.
 */
export function formatEventWhen(event: Event): string {
  const start = eventStartValue(event);
  if (!start) return '';
  if (event.allDay) {
    const first = dayjs(start);
    const last = event.end ? dayjs(event.end.slice(0, 10)).subtract(1, 'day') : first;
    return last.isAfter(first, 'day')
      ? `${first.format(WHEN_DAY)} – ${last.format(WHEN_DAY)} · All day`
      : `${first.format(WHEN_DAY)} · All day`;
  }
  if (event.startLocalDisplay) {
    return event.endLocalDisplay ? `${event.startLocalDisplay} – ${event.endLocalDisplay}` : event.startLocalDisplay;
  }
  const from = dayjs(start);
  const to = event.end ? dayjs(event.end) : null;
  const startLabel = `${from.format(WHEN_DAY)} · ${from.format(WHEN_TIME)}`;
  if (!to || !to.isValid() || !to.isAfter(from)) return startLabel;
  return to.isSame(from, 'day')
    ? `${startLabel} – ${to.format(WHEN_TIME)}`
    : `${startLabel} – ${to.format(WHEN_DAY)} · ${to.format(WHEN_TIME)}`;
}

/**
 * The time line of a matter or client event in its parent's events list. An
 * event with an end shows its span through `formatEventWhen`, the same text
 * the calendar and the portal show; one without keeps the server's start.
 */
export function eventListWhen(event: {
  id: string;
  title: string;
  date: string | null;
  endsAt?: string | null;
  allDay?: boolean;
  dateLocalDisplay?: string | null;
  endsAtLocalDisplay?: string | null;
}): string {
  if (event.date && event.endsAt) {
    return formatEventWhen({
      id: event.id,
      title: event.title,
      start: event.date,
      end: event.endsAt,
      allDay: event.allDay,
      startLocalDisplay: event.dateLocalDisplay,
      endLocalDisplay: event.endsAtLocalDisplay,
    });
  }
  return event.dateLocalDisplay || (event.date ? new Date(event.date).toLocaleString() : 'No date');
}

/**
 * The end of a task, as text to append to whatever start a view already shows
 * for it ("Mar 15, 2026, 1:00 PM" or "Mar 15, 2026"). A timed end on the same
 * day is just its time; one on another day is dated. An all-day end is the
 * last day the task covers, one before the stored exclusive end, and a task
 * that covers a single day adds nothing. Empty for a task with no end.
 *
 * A timed end is read from the server's wall clocks (`endsAtLocalInput`,
 * `dueDateLocalInput`), the zone the start beside it was formatted in, so a
 * browser in another zone cannot put the two halves in different zones. The
 * instants are the fallback when those are absent.
 */
export function taskEndSuffix(task: {
  allDay?: boolean;
  dueDate?: string | null;
  endsAt?: string | null;
  dueDateLocalInput?: string | null;
  endsAtLocalInput?: string | null;
}): string {
  if (!task.endsAt || !task.dueDate) return '';
  if (task.allDay) {
    const last = dayjs(task.endsAt.slice(0, 10)).subtract(1, 'day');
    return last.isAfter(dayjs(task.dueDate.slice(0, 10)), 'day') ? ` – ${last.format('MMM D, YYYY')}` : '';
  }
  const wallClocks = Boolean(task.endsAtLocalInput && task.dueDateLocalInput);
  const end = dayjs(wallClocks ? task.endsAtLocalInput! : task.endsAt);
  const start = dayjs(wallClocks ? task.dueDateLocalInput! : task.dueDate);
  return end.isSame(start, 'day') ? ` – ${end.format('h:mm A')}` : ` – ${end.format('MMM D, YYYY, h:mm A')}`;
}

/** The end of an event as text after its start, in the format `taskEndSuffix` gives a task. */
export function eventEndSuffix(event: Event): string {
  return taskEndSuffix({ allDay: event.allDay === true, dueDate: eventStartValue(event), endsAt: event.end });
}

/**
 * An event's time on one day it is shown on (`day`, 'YYYY-MM-DD'): "All day",
 * or the start time. A timed event that started on an earlier day shows when
 * it ends instead ("until 1:00 AM", dated when the end is on a later day), so
 * the day after an 11:30 PM start does not read "11:30 PM". `withEnd` adds the
 * end after a start, for the day agenda.
 */
export function eventTimeLabel(event: Event, day: string, withEnd = false): string {
  const suffix = withEnd ? eventEndSuffix(event) : '';
  if (eventMinuteOfDay(event) === null) return `All day${suffix}`;
  const from = dayjs(event.start);
  const to = event.end ? dayjs(event.end) : null;
  if (to && to.isValid() && from.format('YYYY-MM-DD') < day) {
    return `until ${to.format('YYYY-MM-DD') === day ? to.format('h:mm A') : to.format('MMM D, YYYY, h:mm A')}`;
  }
  return `${from.format('h:mm A')}${suffix}`;
}

/** One zone's canonical IANA name, so an alias such as `US/Pacific` compares equal to `America/Los_Angeles`. */
function canonicalZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

/** An instant read as a wall clock in one zone: its calendar day, short weekday, and "h:mm AM" time. */
function wallClockIn(instant: Date, zone: string): { day: string; weekday: string; time: string } {
  // Built from parts, since browsers differ on the space before AM/PM.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: part('weekday'),
    time: `${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`,
  };
}

/** A zone's short name at an instant, e.g. "PDT", or "GMT+5:30" where it has none. */
function zoneAbbreviation(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

/** The city of an IANA zone, for a label: `America/New_York` is "New York". */
function zoneCity(zone: string): string {
  return (zone.split('/').pop() || zone).replace(/_/g, ' ');
}

/** What a timed event set in another zone adds to its time, from `eventZoneSuffix`. */
export interface EventZoneSuffix {
  /** The viewer's zone abbreviation, which follows the time shown in the viewer's zone. */
  viewerZoneName: string;
  /** The event's own time in its zone, e.g. "10:00 AM – 11:00 AM", or "Tue 10:00 AM" when that is another day. */
  eventTime: string;
  /** The city of the event's zone, e.g. "Auckland". */
  city: string;
}

/**
 * The time an event has where it was scheduled, for an event set in a zone
 * that is not the viewer's own. The event's time stays in the viewer's zone;
 * this marks that time with the viewer's zone abbreviation and adds the
 * event's local time and city. A weekday is named where the event's zone is
 * on another day. Pass `end` only where the end is shown too.
 *
 * Null for an all-day event, which is a calendar day in every zone, for an
 * event in the viewer's zone, and for one with no zone or no start.
 */
export function eventZoneSuffix(
  event: { start?: string | null; end?: string | null; timeZone?: string | null; allDay?: boolean },
  viewerZone: string = getUserTimeZone(),
): EventZoneSuffix | null {
  const zone = event.timeZone;
  if (!zone || event.allDay || !event.start) return null;
  if (canonicalZone(zone) === canonicalZone(viewerZone)) return null;
  const from = dayjs(event.start);
  if (!from.isValid()) return null;
  const startDate = from.toDate();
  let start: ReturnType<typeof wallClockIn>;
  try {
    start = wallClockIn(startDate, zone);
  } catch {
    // A zone name this browser does not know: say nothing rather than guess.
    return null;
  }
  let eventTime = start.day === wallClockIn(startDate, viewerZone).day ? start.time : `${start.weekday} ${start.time}`;
  const to = event.end ? dayjs(event.end) : null;
  if (to && to.isValid() && to.isAfter(from)) {
    const end = wallClockIn(to.toDate(), zone);
    eventTime += ` – ${end.day === start.day ? end.time : `${end.weekday} ${end.time}`}`;
  }
  return { viewerZoneName: zoneAbbreviation(startDate, viewerZone), eventTime, city: zoneCity(zone) };
}

/** Calendar days touched by an event, bounded to the requested view. Ends are exclusive. */
export function eventDayKeys(event: Event, bounds: { from: string; to: string }): string[] {
  const start = eventStartValue(event);
  if (!start || !dayjs(start).isValid()) return [];
  const first = dayjs(start).format('YYYY-MM-DD');
  const end = event.end && dayjs(event.end).isValid()
    ? (event.allDay ? dayjs(event.end.slice(0, 10)).subtract(1, 'day') : dayjs(event.end).subtract(1, 'millisecond'))
    : dayjs(start);
  const last = end.format('YYYY-MM-DD') < first ? first : end.format('YYYY-MM-DD');
  const from = first < bounds.from ? bounds.from : first;
  const to = last > bounds.to ? bounds.to : last;
  const days: string[] = [];
  for (let day = dayjs(from); day.format('YYYY-MM-DD') <= to; day = day.add(1, 'day')) days.push(day.format('YYYY-MM-DD'));
  return days;
}

/**
 * The days a task is drawn on. A multi-day all-day task spreads across every
 * day it covers, as an all-day event does. Every other task stays on its due
 * day: a timed task's block is placed at its start time on each day it is
 * drawn, so spreading one past midnight would draw a second block at that
 * time on the next day.
 */
export function taskDayKeys(task: Task, bounds: { from: string; to: string }): string[] {
  const start = task.dueDateLocalInput || task.dueDate;
  if (!start || !dayjs(start).isValid()) return [];
  if (task.endsAt && taskMinuteOfDay(task) === null) {
    return eventDayKeys({ id: task.id, title: task.title, start, end: task.endsAt, allDay: true } as Event, bounds);
  }
  return [dayjs(start).format('YYYY-MM-DD')];
}
