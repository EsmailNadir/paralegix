/**
 * The schedule arithmetic every push to Google or Outlook shares.
 *
 * Both providers build a timed event from a start and an end, and an all-day
 * event from a start day and an EXCLUSIVE end day (the day after the last
 * day). Only the body shape each provider wants differs, so the arithmetic
 * lives here once and each service formats the result.
 */

const { addDays } = require('../../../shared/utils/localTime');
const { zonedDayString, normalizeTimeZone } = require('../../../shared/utils/time');

/**
 * How long an item with no end of its own lasts on a provider calendar. Tasks,
 * and matter and client events without an end, carry none; an inbound change
 * reads a span of exactly this length as that fill-in rather than a real end.
 */
export const DEFAULT_TIMED_BLOCK_MS = 60 * 60 * 1000;

/** A timed item's end: its own when that is after the start, else the default block. */
export function timedEnd(start: Date, end?: Date | null): Date {
  const validEnd = end instanceof Date
    && !Number.isNaN(end.getTime())
    && end.getTime() > start.getTime();
  return validEnd ? end : new Date(start.getTime() + DEFAULT_TIMED_BLOCK_MS);
}

/**
 * An all-day item's first day and exclusive end day, as 'YYYY-MM-DD'.
 *
 * Both days are read off the UTC date of the instants given, which is right
 * because a day-only value is stored at its noon-UTC anchor, and a stored
 * exclusive end (calendar_events.ends_at) is anchored the same way. With no
 * end, or one not after the start, the item is the single start day.
 */
export function allDaySpan(start: Date | string, end?: Date | null): { startDay: string; endDay: string } {
  const d = start instanceof Date ? start : new Date(start);
  const startDay = d.toISOString().split('T')[0];
  let endDay: string | null = null;
  if (end instanceof Date && !Number.isNaN(end.getTime())) {
    endDay = end.toISOString().split('T')[0];
    if (endDay <= startDay) endDay = null;
  }
  return { startDay, endDay: endDay || addDays(startDay, 1) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window the full poll reads from either provider: a year back and a year
 * ahead. `removable` is the same window one day in from each edge, the span in
 * which an import missing from a complete listing is taken as deleted (an
 * event on an edge may be listed or not depending on how the provider clips
 * it).
 */
export function fullPollWindow(now: Date = new Date()) {
  const from = new Date(now.getTime() - 365 * DAY_MS);
  const to = new Date(now.getTime() + 365 * DAY_MS);
  return {
    from,
    to,
    removable: { from: new Date(from.getTime() + DAY_MS), to: new Date(to.getTime() - DAY_MS) },
  };
}

/**
 * How much of a repeating event a notification brings in: the recent past and
 * a year ahead. The hourly full poll covers a year back and ahead for every
 * event, so nothing outside this range goes missing; it only waits.
 */
export function seriesWindow(now: number = Date.now()) {
  return { from: new Date(now - 30 * DAY_MS), to: new Date(now + 365 * DAY_MS) };
}

/** Pages of occurrences one series read may take, as a stop against an unbounded loop. */
export const MAX_SERIES_PAGES = 10;

/**
 * The local day a timed provider start falls on, in the first of `zones` that
 * names a real zone other than UTC, else in UTC.
 *
 * A bare UTC label is skipped because it rarely means the event's zone: Graph
 * reports every time in UTC unless asked otherwise. Reading the UTC day moved
 * an evening event in the Americas onto the next day.
 */
export function startDayIn(instant: Date, zones: unknown[]): string | null {
  const zone = zones.map((z) => normalizeTimeZone(z)).find((z) => z !== 'UTC') || 'UTC';
  return zonedDayString(instant, zone);
}

/**
 * Whether a bulk "sync existing" press still has an item to push: it is not
 * cancelled or completed, and it has not ended. Read from the saved status and
 * schedule so stale request data cannot resurrect an event. Who it is pushed to
 * is `isCalendarRecipient` (calendarRecipients.ts), shared with the per-change
 * push.
 */
export function isExistingItemEligible(state: any, item: any, _userId: string, timeZone = 'UTC') {
  if (!item || state.status === 'cancelled' || state.status === 'completed') return false;
  const start = new Date(item.dateTime);
  if (Number.isNaN(start.getTime())) return false;
  // An all-day item is current until its exclusive end day, so a span that
  // started before today but has days left is still pushed.
  if (item.allDay) {
    const { endDay } = allDaySpan(start, item.end ? new Date(item.end) : null);
    return endDay > zonedDayString(new Date(), normalizeTimeZone(item.timeZone || timeZone));
  }
  return timedEnd(start, item.end ? new Date(item.end) : null).getTime() > Date.now();
}
