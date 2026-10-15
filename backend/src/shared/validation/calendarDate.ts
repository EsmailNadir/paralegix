// `Date.UTC` (and the JS `Date` string parser) does not validate calendar
// ranges: "2026-02-30" silently rolls forward to March 2 instead of failing.
// A regex only proves a string is shaped like a date, not that it names a day
// that exists. Round-tripping the parts back out through `Date.UTC` and
// comparing catches the difference before an impossible date reaches a query
// or a downstream `shared/utils/time` conversion.

/** True when year/monthIndex0/day round-trip through Date.UTC unchanged. */
export function isValidCalendarDateParts(year: number, monthIndex0: number, day: number): boolean {
  const check = new Date(Date.UTC(year, monthIndex0, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === monthIndex0 &&
    check.getUTCDate() === day
  );
}

/** True when a strict 'YYYY-MM-DD' string names a real calendar day. */
export function isValidCalendarDateString(s: string): boolean {
  const y = +s.slice(0, 4);
  const m = +s.slice(5, 7) - 1;
  const d = +s.slice(8, 10);
  return isValidCalendarDateParts(y, m, d);
}

/**
 * True when `s` either has no leading 'YYYY-MM-DD' component to check (a
 * timestamp, an epoch-looking string, anything else - some other format
 * check is that string's problem, not this one's) or that leading component
 * names a real calendar day. For fields that legitimately accept more than
 * one date shape (a day-only string or a full datetime), where regex-level
 * format policing already happens elsewhere or not at all.
 */
export function hasValidCalendarDatePrefix(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return true;
  return isValidCalendarDateParts(+m[1], +m[2] - 1, +m[3]);
}
