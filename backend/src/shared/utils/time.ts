/**
 * Timezone-aware conversion between UTC instants and a recipient's wall clock.
 *
 * The app stores instants in UTC (`timestamptz`) and renders them per request in
 * the caller's zone (`req.tz`). These helpers are the boundary between the two.
 */

const { isValidCalendarDateParts, isValidCalendarDateString } = require('../validation/calendarDate');

/** Wall-clock components in some zone, before they are resolved to an instant. */
interface ZonedComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Anything the lenient entry points will try to read an instant out of. */
type TimeInput = Date | string | null | undefined;

/**
 * Validate an IANA zone, falling back to UTC. An unknown zone makes
 * `Intl.DateTimeFormat` throw a `RangeError`, which would otherwise take down
 * whatever caller happened to be holding a typo'd or stale zone string.
 *
 * The one normalizer for this repo. Import from here instead of writing a
 * new copy.
 */
export function normalizeTimeZone(timeZone: unknown): string {
  const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export function getTimeZoneOffsetMs(timestampMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = map.hour === '24' ? '00' : map.hour;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(hour),
    Number(map.minute),
    Number(map.second)
  );
  return asUtc - timestampMs;
}

/**
 * DST fold/gap policy (a wall-clock time that is ambiguous or does not exist
 * at all is not a bug to fix, it is a choice to document):
 *
 *  - FOLD (e.g. "1:30 AM" on the day clocks fall back from 2:00 to 1:00,
 *    which happens once before the transition and once after): resolves to
 *    the EARLIER of the two instants, i.e. the offset still in effect just
 *    before the transition. Neither occurrence is more "correct" than the
 *    other; picking one deterministically is what matters.
 *  - GAP (e.g. "2:30 AM" on the day clocks spring forward from 2:00 to
 *    3:00, so no instant maps to it at all): resolves by pushing the time
 *    forward past the gap, using the offset in effect just before the
 *    transition (so "2:30 AM" reads as if it were "3:30 AM" in the new
 *    offset). This is the conventional "spring forward" reading used by most
 *    timezone libraries, and it matters operationally: the alternative
 *    (falling back through a second offset-correction pass) lands on an
 *    instant that displays as an hour EARLIER than what was entered and
 *    collides with a distinct, genuinely valid wall-clock time - two
 *    different user inputs silently resolving to the same instant.
 */
function zonedDateTimeToUtcDate(components: ZonedComponents, timeZone: string): Date {
  const { year, month, day, hour, minute, second } = components;

  // First guess: treat wall time as UTC, then back out the target zone offset.
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getTimeZoneOffsetMs(utcGuess, timeZone);
  const correctedWithOffset1 = utcGuess - offset1;

  // A second pass re-derives the offset from the corrected instant rather
  // than the raw guess, which is what makes an ordinary instant near a
  // transition (and a fold, see above) resolve correctly. If it agrees with
  // the first guess, there is no DST boundary in play at all.
  const offset2 = getTimeZoneOffsetMs(correctedWithOffset1, timeZone);
  if (offset2 === offset1) return new Date(correctedWithOffset1);

  const correctedWithOffset2 = utcGuess - offset2;

  // A genuine DST-adjacent instant (not a gap) converges here: the offset in
  // effect at correctedWithOffset2 matches offset2 itself. A spring-forward
  // GAP never converges - applying offset2 lands back in offset1's regime,
  // and a further pass would just flip back and forth indefinitely - so
  // detecting that non-convergence is how a gap is told apart from an
  // ordinary boundary-adjacent time, and it falls back to the offset1
  // result (the documented push-forward policy above).
  const offset3 = getTimeZoneOffsetMs(correctedWithOffset2, timeZone);
  if (offset3 !== offset2) return new Date(correctedWithOffset1);

  return new Date(correctedWithOffset2);
}

/**
 * Format a Date (UTC) into local display + input strings for a TZ.
 *
 * `dateOnly` drops the clock time from `display` — pass it for an all-day item
 * (no real time-of-day), whose UTC instant is only a noon/midnight anchor and
 * would otherwise print a misleading "12:00 AM"/"5:00 AM" alongside the date.
 */
export function formatForClient(
  dateOrNull: Date | string | number | null | undefined,
  timeZone?: unknown,
  options?: { dateOnly?: boolean },
): { display: string | null; input: string } {
  if (!dateOrNull) return { display: null, input: '' };
  const d = dateOrNull instanceof Date ? dateOrNull : new Date(dateOrNull);
  if (Number.isNaN(d.getTime())) return { display: null, input: '' };
  // A day-only value at its noon-UTC anchor is that UTC day everywhere. Read
  // in the viewer's zone it became the next day at UTC+12 and beyond. A
  // day-only value stored some other way (older all-day events sit at the
  // viewer's local midnight) is still read in the viewer's zone.
  const tz = options?.dateOnly && isDayAnchor(d) ? 'UTC' : normalizeTimeZone(timeZone);

  // For display, use the timezone
  const display = new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    dateStyle: 'medium',
    ...(options?.dateOnly ? {} : { timeStyle: 'short' }),
  }).format(d);

  // For input, the same instant as a wall clock in that zone, to the minute.
  const input = zonedWallClock(d, tz).slice(0, 16);

  return { display, input };
}

/**
 * An instant as the wall clock in a zone: 'YYYY-MM-DDTHH:mm:ss', no offset.
 * This is the form Google and Microsoft Graph take alongside a separate
 * `timeZone` field, and the form a datetime-local input takes (to the minute).
 */
export function zonedWallClock(date: Date | string | number, timeZone: unknown): string {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  // Some ICU builds render midnight as '24' even under h23; normalize it.
  const hh = m.hour === '24' ? '00' : m.hour;
  return `${m.year}-${m.month}-${m.day}T${hh}:${m.minute}:${m.second}`;
}

/**
 * An instant as the wall clock in a zone WITH that zone's offset at the
 * instant: 'YYYY-MM-DDTHH:mm:ss+HH:MM' (RFC 3339).
 *
 * A bare wall clock is ambiguous for the hour that repeats when clocks go
 * back: '01:30' in Los Angeles on a fall-back night happens at -07:00 and again
 * at -08:00. The offset names which one.
 */
export function zonedWallClockWithOffset(date: Date | string | number, timeZone: unknown): string {
  const d = date instanceof Date ? date : new Date(date);
  const zone = normalizeTimeZone(timeZone);
  // Whole seconds on both sides, so a millisecond part cannot skew the offset.
  const seconds = Math.floor(d.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round(getTimeZoneOffsetMs(seconds, zone) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${zonedWallClock(d, zone)}${sign}${hh}:${mm}`;
}

/**
 * A wall clock in a zone, back to the instant it names.
 *
 * Takes 'YYYY-MM-DD', 'YYYY-MM-DDTHH:mm' or 'YYYY-MM-DDTHH:mm:ss' with optional
 * fractional seconds (Graph sends seven digits); a bare day is midnight in
 * that zone. A string that already carries `Z` or an offset is absolute and
 * is read as-is. Any other shape falls back to native parsing. A fold or gap
 * resolves by the policy on `zonedDateTimeToUtcDate`.
 */
export function wallClockToUtc(dateTime: unknown, timeZone: unknown): Date | null {
  if (!dateTime || typeof dateTime !== 'string') return null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(dateTime)) {
    const direct = new Date(dateTime);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }
  const m = dateTime.replace(/\.\d+$/, '')
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) {
    const fallback = new Date(dateTime);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  return zonedDateTimeToUtcDate({
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4] || '0'), minute: Number(m[5] || '0'), second: Number(m[6] || '0'),
  }, normalizeTimeZone(timeZone));
}

/**
 * The instant a day-only value is anchored at: noon UTC on that day.
 *
 * Noon, not midnight, because noon UTC falls on the same calendar day in every
 * zone from UTC-12 to UTC+11, so reading the day back in the viewer's zone
 * never rolls it to the day before. Reads the leading 'YYYY-MM-DD' of a
 * string, or the UTC day of a Date. Something with no such day comes back as
 * an invalid Date, which callers test with `isNaN(getTime())`.
 */
export function dayAnchor(day: string | Date): Date {
  const ymd = day instanceof Date ? day.toISOString().slice(0, 10) : String(day).slice(0, 10);
  return new Date(`${ymd}T12:00:00Z`);
}

/** Whether an instant is a `dayAnchor`: exactly noon UTC. */
function isDayAnchor(d: Date): boolean {
  return d.getUTCHours() === 12 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

/**
 * Read an instant out of a stored or incoming value.
 *
 * A Date passes through. A bare 'YYYY-MM-DD' is a day, not a moment, so it
 * takes the day anchor rather than `new Date()`'s midnight UTC, which lands
 * on the day before in every zone behind UTC. Anything else is parsed natively.
 * Returns null for nothing and for anything unparseable.
 */
export function toInstant(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return dayAnchor(value);
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Convert "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" in TZ → UTC Date; pass ISO/Z/numbers straight through */
export function localInputToUtcDate(localStr: unknown, timeZone?: unknown): Date | null {
  const tz = normalizeTimeZone(timeZone);

  if (typeof localStr !== 'string') {
    const d = new Date(localStr as string | number | Date);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Handle date-only format: "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(localStr)) {
    const y = +localStr.slice(0, 4);
    const m = +localStr.slice(5, 7) - 1;
    const dd = +localStr.slice(8, 10);

    if (!isValidCalendarDateParts(y, m, dd)) return null;

    // Create a date at noon UTC to ensure consistent date handling
    const utcDate = new Date(Date.UTC(y, m, dd, 12, 0, 0));

    return utcDate;
  }

  // Handle datetime format: "YYYY-MM-DDTHH:mm"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localStr)) {
    const y = +localStr.slice(0, 4);
    const m = +localStr.slice(5, 7);
    const dd = +localStr.slice(8, 10);
    const hh = +localStr.slice(11, 13);
    const mm = +localStr.slice(14, 16);

    if (!isValidCalendarDateParts(y, m - 1, dd)) return null;

    return zonedDateTimeToUtcDate(
      { year: y, month: m, day: dd, hour: hh, minute: mm, second: 0 },
      tz
    );
  }

  // Handle other formats (ISO strings, etc). V8's own parser is lenient about
  // an out-of-range day for the given month (though not an out-of-range
  // month), so an ISO-shaped prefix still needs the same calendar check
  // before falling through to native parsing.
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(localStr)) {
    const y = +localStr.slice(0, 4);
    const m = +localStr.slice(5, 7) - 1;
    const dd = +localStr.slice(8, 10);
    if (!isValidCalendarDateParts(y, m, dd)) return null;
  }

  const d = new Date(localStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Local calendar day ('YYYY-MM-DD') of a Date in the given IANA zone.
 * en-CA yields ISO-ordered YYYY-MM-DD parts. Falls back to the UTC day when no
 * timezone is supplied (normalizeTimeZone maps falsy/invalid zones to UTC).
 */
export function zonedDayString(
  dateOrNull: Date | string | number | null | undefined,
  timeZone?: unknown,
): string | null {
  if (!dateOrNull) return null;
  // A day-only 'YYYY-MM-DD' string is a timezone-independent calendar date; return
  // it unchanged rather than parsing it as UTC midnight (which would shift it back
  // a day for zones behind UTC). Real instants (Date / ISO timestamps) are
  // projected into the target zone below.
  if (typeof dateOrNull === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrNull)) return dateOrNull;
  const d = dateOrNull instanceof Date ? dateOrNull : new Date(dateOrNull);
  if (Number.isNaN(d.getTime())) return null;
  const tz = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function toTimestampOrNull(val: TimeInput, timeZone?: unknown): Date | null {
  if (val === undefined) return null;
  if (!val) return null;

  let d: Date | null = null;
  if (val instanceof Date) d = val;
  else if (typeof val === 'string') d = localInputToUtcDate(val, timeZone);

  if (!d || Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Resolve a value intended for a day-only Postgres `date` column to a
 * 'YYYY-MM-DD' string, preserving the calendar date exactly as written rather
 * than round-tripping it through a UTC instant.
 *
 * A `date` column has no timezone concept - '2026-03-01' means March 1st, full
 * stop. `toTimestampOrNull`/`localInputToUtcDate` exist for `timestamptz`
 * columns, where resolving a wall-clock-with-offset string to a genuine UTC
 * instant is exactly the point. Applying that same conversion to a date-only
 * field and then re-extracting the calendar day from the resulting instant is
 * wrong whenever the offset pushes the wall time across a UTC midnight: a
 * caller who sends '2026-03-01T23:30:00-08:00' (07:30 UTC the FOLLOWING day)
 * gets that value stored as March 2nd even though every part of the string
 * they sent named March 1st. Postgres's own `'...'::date` cast of the
 * identical string returns the literal leading date - confirming that reading
 * is the one callers expect, not the UTC-instant one.
 *
 * A string keeps its own leading 'YYYY-MM-DD' verbatim, regardless of any
 * trailing time-of-day or offset. A Date instance or a numeric epoch has no
 * such prefix to read, so those fall back to their UTC calendar day, same as
 * before - the only sane reading available for a bare instant.
 */
export function toDateOnlyOrNull(val: TimeInput): string | null {
  if (val === undefined || val === null || val === '') return null;

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) && isValidCalendarDateString(trimmed)) {
      return trimmed.slice(0, 10);
    }
    // Not a recognizable calendar-date-shaped string (free text, an unknown
    // format, garbage) - fall back to instant parsing and read the UTC day off
    // the result, same as the Date/number branch below.
    const parsed = localInputToUtcDate(trimmed);
    return parsed ? parsed.toISOString().slice(0, 10) : null;
  }

  const asDate = toTimestampOrNull(val);
  return asDate ? asDate.toISOString().slice(0, 10) : null;
}

/**
 * Resolve a matter/client EVENT's `date` field to a UTC instant, honoring
 * `allDay`.
 *
 * The all-day toggle on both the matter- and client-event forms sends the
 * picked day as LOCAL MIDNIGHT ('YYYY-MM-DDTHH:mm'), not a bare date string.
 * `toTimestampOrNull`'s own day-only detection only fires on a bare
 * 'YYYY-MM-DD' string, so that shape falls into the full zoned-datetime path
 * instead, which resolves "midnight in the recipient's zone" to a real UTC
 * instant. For any zone AHEAD of UTC that instant lands on the PREVIOUS
 * calendar day: a Paris (UTC+2 in summer) event picked for September 1st
 * stores as 2026-08-31T22:00:00Z, and syncs to Google/Outlook - and reads
 * back to a same-zone viewer - as August 31st.
 *
 * When `allDay` is true, this extracts the literal calendar day first (via
 * `toDateOnlyOrNull`, which keeps a string's own leading date regardless of
 * any trailing time-of-day) and re-anchors it at noon UTC, timezone-invariant
 * the same way a genuinely bare day-only string already is. Matches
 * `tasks.service.ts`'s `resolveDue()`, which applies the identical fix for
 * the identical all-day-toggle input shape on the tasks side.
 */
export function resolveEventDate(date: TimeInput, timeZone: unknown, allDay: boolean): Date | null {
  if (!allDay) return toTimestampOrNull(date, timeZone);
  const dayOnly = toDateOnlyOrNull(date);
  return dayOnly ? toTimestampOrNull(dayOnly, timeZone) : null;
}
