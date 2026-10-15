/**
 * Shared utilities for reminder services (tasks, matter events, etc.)
 */

// resolveUserInfo now resolves from Postgres (users) + Firebase Auth fallback.
import { resolveUserInfo } from './reminderHelpers';

export { resolveUserInfo };

const { toInstant, zonedDayString, dayAnchor } = require('./time');
const { localDateFor } = require('./localTime');

/**
 * Check if a reminder was sent within the last 24h.
 */
export function wasSentRecently(lastReminderSentAt: any): boolean {
  if (!lastReminderSentAt) return false;
  const lastSent = new Date(lastReminderSentAt);
  const hoursSinceLast = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
  return hoursSinceLast < 24;
}

/**
 * Compute days until a date. Positive = future, 0 = today, negative = past.
 *
 * Both the date's day and "today" are the days in `timeZone`, the zone the
 * reminder is about, so "due today" changes at that zone's midnight rather
 * than UTC's (which is mid-afternoon or evening across the Americas). An
 * all-day date is its day's noon-UTC anchor and takes its UTC day in every
 * zone. With no zone given this is the UTC day count it always was.
 */
export function daysUntil(dateValue: any, timeZone: string = 'UTC', allDay = false): number {
  const target = toInstant(dateValue);
  if (!target) return NaN;
  const day = allDay ? target.toISOString().slice(0, 10) : zonedDayString(target, timeZone);
  const today = localDateFor(timeZone);
  return Math.round((dayAnchor(day).getTime() - dayAnchor(today).getTime()) / (1000 * 60 * 60 * 24));
}
