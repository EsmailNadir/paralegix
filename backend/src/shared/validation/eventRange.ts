const { ValidationError } = require('../errors/AppError');
const { formatForClient, resolveEventDate } = require('../utils/time');
import { z } from 'zod';

/**
 * A day label or an ISO wall clock/instant, with calendar and clock ranges validated.
 *
 * The minutes-only instant ('YYYY-MM-DDTHH:mm-07:00') is what an edit form
 * sends for a time inside a repeated fall-back hour, where the offset is the
 * only thing naming which of the two instants is meant. Zod's default
 * datetime requires seconds whenever an offset is present, so that shape is
 * accepted by its own minute-precision branch.
 */
export const eventEndField = z.union([
  z.iso.date(),
  z.iso.datetime({ local: true, offset: true }),
  z.iso.datetime({ offset: true, precision: -1 }),
]);

/** A flag-only edit keeps the visible day while changing its anchor or default time. */
export function dateOnAllDayToggle(existing: { date: any; allDay?: boolean }, allDay: boolean | undefined, timezone: string): Date | undefined {
  if (allDay === undefined || allDay === (existing.allDay === true) || !existing.date) return undefined;
  const at = new Date(existing.date);
  const input = existing.allDay
    ? `${formatForClient(at, timezone, { dateOnly: true }).input.slice(0, 10)}T12:00`
    : formatForClient(at, timezone).input;
  return resolveEventDate(input, timezone, allDay) || undefined;
}

/**
 * An event's end must come after its start.
 *
 * `events_ends_after_start` enforces this in the database, which is what makes
 * it a guarantee. This exists so the caller gets a 400 naming the problem
 * instead of the 500 a raw constraint violation produces. Matter and client
 * events live in the one `events` table, so both check it here.
 */
export function assertEndAfterStart(startTs: any, endTs: any) {
  if (!startTs || !endTs) return;
  const start = startTs instanceof Date ? startTs : new Date(startTs);
  const end = endTs instanceof Date ? endTs : new Date(endTs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
  if (end.getTime() <= start.getTime()) {
    throw new ValidationError('The event end must be after its start');
  }
}

/**
 * Where an event's end goes when its start moves: by the same amount, so the
 * event keeps its length. Moving only the start past the old end is what
 * `events_ends_after_start` refuses. Null when there is no end to move.
 */
export function shiftedEnd(oldStart: Date | null, oldEnd: Date | null, newStart: Date | null): Date | null {
  if (!oldEnd || !oldStart || !newStart) return null;
  return new Date(oldEnd.getTime() + (newStart.getTime() - oldStart.getTime()));
}

/**
 * The end an edit writes when the caller sent none of its own. Undefined leaves
 * the stored end alone.
 *
 * Flipping all-day drops the end: an all-day end is the exclusive day after the
 * last day and a timed end is an instant, so neither reads correctly as the
 * other. Otherwise a moved start carries the end with it, the same rule
 * postpone and inbound sync follow, so an edit that only moves the event keeps
 * its length instead of failing `assertEndAfterStart` or silently growing.
 */
export function endWithoutCallerEnd(
  existing: { date: any; endsAt: any; allDay: any },
  next: { date?: Date | null; allDay?: boolean },
): Date | null | undefined {
  if (!existing.endsAt) return undefined;
  if (next.allDay !== undefined && next.allDay !== (existing.allDay === true)) return null;
  if (next.date === undefined) return undefined;
  const oldStart = existing.date ? new Date(existing.date) : null;
  return shiftedEnd(oldStart, new Date(existing.endsAt), next.date);
}

/**
 * An event's end as the API returns it beside `dateLocalDisplay` and
 * `dateLocalInput`: a display string and a form value in the caller's zone, or
 * both null when the event has no end. An all-day end is the exclusive day
 * after the last day, so both read as that day; a form showing the last day
 * subtracts one.
 */
export function endsAtLocal(event: { endsAt?: any; allDay?: any }, timezone: any) {
  if (!event.endsAt) return { endsAtLocalDisplay: null, endsAtLocalInput: null };
  const { display, input } = formatForClient(new Date(event.endsAt), timezone, { dateOnly: event.allDay === true });
  return { endsAtLocalDisplay: display, endsAtLocalInput: input };
}
