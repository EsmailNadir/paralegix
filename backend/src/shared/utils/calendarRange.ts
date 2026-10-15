/**
 * Resolve a calendar window into the UTC instants that bound it.
 *
 * The calendar asks for the days it is about to draw, as inclusive day-only
 * 'YYYY-MM-DD' strings. Those name days in the VIEWER's timezone, so the instants
 * they bound depend on that zone: 2026-03-01 begins eleven hours earlier in Sydney
 * than in London. `endUtc` is EXCLUSIVE (local midnight starting the day after
 * `to`) so an event at 23:30 on the last day of the window is still inside it.
 *
 * Returns null when either bound is missing, malformed, or inverted. Every caller
 * treats null as "no window requested" and answers unwindowed, so a client that
 * does not send the params keeps its existing full-set behaviour.
 */

const { localInputToUtcDate } = require('./time');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day after `day`, as a 'YYYY-MM-DD' string. */
export function nextDay(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

export function resolveCalendarRange({ from, to, timezone } : { from?: unknown; to?: unknown; timezone?: unknown } = {}) {
  const fromDay = String(from ?? '');
  const toDay = String(to ?? '');
  if (!DAY_PATTERN.test(fromDay) || !DAY_PATTERN.test(toDay)) return null;
  // Lexicographic comparison is correct for zero-padded YYYY-MM-DD.
  if (fromDay > toDay) return null;

  // The 'YYYY-MM-DDTHH:mm' form is what makes `localInputToUtcDate` interpret the
  // wall time in the given zone. Its day-only branch deliberately anchors at UTC
  // noon instead, which is not a day boundary.
  const startUtc = localInputToUtcDate(`${fromDay}T00:00`, timezone);
  const endUtc = localInputToUtcDate(`${nextDay(toDay)}T00:00`, timezone);
  if (!startUtc || !endUtc) return null;

  return { from, to, startUtc, endUtc };
}
