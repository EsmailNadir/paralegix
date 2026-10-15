/**
 * Recipient-local time helpers for scheduled work.
 *
 * The rest of the app resolves a timezone per HTTP request (`req.tz`, see
 * `shared/middleware/timezone.js`). A cron has no request, so anything scheduled
 * has to derive the recipient's local clock itself from the IANA zone stored on
 * `users.timezone`.
 *
 * Everything here is pure and takes an explicit `now` so it can be tested
 * without freezing the clock.
 */

const { normalizeTimeZone, dayAnchor } = require('./time');

/** The recipient's local hour, 0-23. */
export function localHourFor(timezone: unknown, now: Date = new Date()): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timezone),
    hour: '2-digit',
    hour12: false,
  }).format(now);
  // Some ICU builds render midnight as '24' under hour12:false; normalize it.
  return Number(formatted) % 24;
}

/**
 * The recipient's local calendar day as 'YYYY-MM-DD'. en-CA is the locale whose
 * numeric date format is already ISO-ordered, so this needs no reassembly.
 */
export function localDateFor(timezone: unknown, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimeZone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Shift a 'YYYY-MM-DD' day string by whole days. Anchored at noon UTC so a DST
 * transition can never roll the result back onto the previous day.
 */
export function addDays(ymd: string, n: number): string {
  const d = dayAnchor(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whether a 'YYYY-MM-DD' day is Saturday or Sunday. */
export function isWeekend(ymd: string): boolean {
  const day = dayAnchor(ymd).getUTCDay();
  return day === 0 || day === 6;
}
