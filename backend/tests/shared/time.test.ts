/**
 * Local-to-UTC date/time conversion - pure unit tests (no server, no database).
 *
 *   TEST_DB_SLOT=23 npx jest tests/shared/time.test.ts --runInBand
 */

const { localInputToUtcDate, toTimestampOrNull, formatForClient, zonedDayString } = require('../../src/shared/utils/time');

describe('localInputToUtcDate: date-only "YYYY-MM-DD"', () => {
  test('a real calendar date resolves to noon UTC on that day', () => {
    const d = localInputToUtcDate('2026-03-15');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-03-15T12:00:00.000Z');
  });

  // Date.UTC(2026, 1, 30) does not validate ranges: it silently rolls forward
  // to March 2. Each of these must be rejected, not turned into the wrong date.
  test.each([
    ['an impossible day-of-month', '2026-02-30'],
    ['a 31st in a 30-day month', '2026-04-31'],
    ['month 13', '2026-13-01'],
    ['Feb 29 on a non-leap year', '2026-02-29'],
  ])('rejects %s (%s) instead of rolling over', (_label, input) => {
    expect(localInputToUtcDate(input)).toBeNull();
  });

  test('accepts the real last day of a 30-day month', () => {
    expect(localInputToUtcDate('2026-04-30')).not.toBeNull();
  });

  test('accepts Feb 29 on a leap year', () => {
    const d = localInputToUtcDate('2028-02-29');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2028-02-29T12:00:00.000Z');
  });
});

describe('localInputToUtcDate: datetime "YYYY-MM-DDTHH:mm"', () => {
  test('a real calendar date resolves to the correct UTC instant', () => {
    const d = localInputToUtcDate('2026-03-15T09:30', 'UTC');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-03-15T09:30:00.000Z');
  });

  test('rejects an impossible day-of-month instead of rolling over', () => {
    expect(localInputToUtcDate('2026-02-30T09:30', 'UTC')).toBeNull();
  });

  test('rejects a 31st in a 30-day month instead of rolling into the next month', () => {
    expect(localInputToUtcDate('2026-04-31T09:30', 'UTC')).toBeNull();
  });
});

describe('localInputToUtcDate: formats not caught by either named branch (falls through to native Date parsing)', () => {
  test('a Date instance passes through unchanged', () => {
    const input = new Date('2026-03-15T00:00:00Z');
    expect(localInputToUtcDate(input)).toEqual(input);
  });

  test('a numeric epoch millisecond value passes through unchanged', () => {
    const ms = Date.parse('2026-03-15T00:00:00Z');
    expect(localInputToUtcDate(ms)!.getTime()).toBe(ms);
  });

  test('a malformed non-matching string still returns null, not a crash', () => {
    expect(localInputToUtcDate('not-a-date')).toBeNull();
  });

  test('a valid full ISO string with an explicit offset still resolves', () => {
    expect(localInputToUtcDate('2026-03-15T09:30:00Z')!.toISOString()).toBe('2026-03-15T09:30:00.000Z');
  });

  test('rejects a full ISO string with an impossible calendar date, same as the shorter formats', () => {
    // V8's own Date parser is lenient here too: new Date('2026-02-30T00:00:00Z')
    // silently rolls forward to March 2 rather than failing. This is the same
    // defect as the two named branches above, one call deeper.
    expect(localInputToUtcDate('2026-02-30T00:00:00Z')).toBeNull();
  });

  test('rejects a full ISO string with a day past the end of a 30-day month', () => {
    expect(localInputToUtcDate('2026-04-31T00:00:00.000Z')).toBeNull();
  });
});

describe('toTimestampOrNull end to end', () => {
  test('an impossible date-only string is rejected, not silently corrected', () => {
    expect(toTimestampOrNull('2026-02-30')).toBeNull();
  });

  test('a real date-only string still resolves', () => {
    expect(toTimestampOrNull('2026-02-28')).not.toBeNull();
  });

  test('undefined and empty string both stay null, matching existing contract', () => {
    expect(toTimestampOrNull(undefined)).toBeNull();
    expect(toTimestampOrNull('')).toBeNull();
  });
});

describe('zonedDateTimeToUtcDate / localInputToUtcDate: DST fold and gap policy', () => {
  test('America/Los_Angeles spring-forward gap: a non-existent wall-clock time is pushed forward past the gap', () => {
    // 2026-03-08 is the US spring-forward date: LA clocks jump from 2:00 AM
    // PST straight to 3:00 AM PDT, so "2:30 AM" never happens. The documented
    // policy pushes it forward by the gap width, i.e. treats it as 3:30 AM
    // PDT (UTC-7): 3:30 + 7h = 10:30 UTC.
    const d = localInputToUtcDate('2026-03-08T02:30', 'America/Los_Angeles');
    expect(d!.toISOString()).toBe('2026-03-08T10:30:00.000Z');
  });

  test('America/New_York spring-forward gap follows the same push-forward policy', () => {
    // Same US transition date; NY jumps 2:00 AM EST -> 3:00 AM EDT. Pushed
    // forward: 3:30 AM EDT (UTC-4) = 3:30 + 4h = 7:30 UTC.
    const d = localInputToUtcDate('2026-03-08T02:30', 'America/New_York');
    expect(d!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  test('the gap resolution does not collide with the distinct, valid time an hour earlier', () => {
    // Before the fix, the gap's second DST-correction pass didn't converge
    // and fell back to an instant that displayed as "1:30 AM PST" - identical
    // to this genuinely valid, distinct input. A correct gap policy must not
    // alias two different user-entered times onto the same instant.
    const gapTime = localInputToUtcDate('2026-03-08T02:30', 'America/Los_Angeles');
    const validEarlierTime = localInputToUtcDate('2026-03-08T01:30', 'America/Los_Angeles');
    expect(gapTime!.toISOString()).not.toBe(validEarlierTime!.toISOString());
  });

  test('a valid wall-clock time just before the spring-forward gap still resolves correctly (regression guard)', () => {
    // 1:30 AM PST, the last valid minute before the transition: 1:30 + 8h = 9:30 UTC.
    const d = localInputToUtcDate('2026-03-08T01:30', 'America/Los_Angeles');
    expect(d!.toISOString()).toBe('2026-03-08T09:30:00.000Z');
  });

  test('a valid wall-clock time just after the spring-forward gap still resolves correctly (regression guard)', () => {
    // 3:30 AM PDT, the first valid minute after the transition: 3:30 + 7h = 10:30 UTC.
    const d = localInputToUtcDate('2026-03-08T03:30', 'America/Los_Angeles');
    expect(d!.toISOString()).toBe('2026-03-08T10:30:00.000Z');
  });

  test('America/Los_Angeles fall-back fold resolves to the earlier of the two occurrences', () => {
    // 2026-11-01 is the US fall-back date: "1:30 AM" happens once as PDT
    // (UTC-7) and again an hour later as PST (UTC-8). The documented policy
    // picks the earlier occurrence: 1:30 + 7h = 8:30 UTC. Neither occurrence
    // is uniquely "correct" - this pins the deterministic choice rather than
    // whatever the host happens to produce.
    const d = localInputToUtcDate('2026-11-01T01:30', 'America/Los_Angeles');
    expect(d!.toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  test('America/New_York fall-back fold resolves to the earlier occurrence too', () => {
    // Same US transition date; NY's ambiguous "1:30 AM" is EDT (UTC-4) first:
    // 1:30 + 4h = 5:30 UTC.
    const d = localInputToUtcDate('2026-11-01T01:30', 'America/New_York');
    expect(d!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('localInputToUtcDate: positive half-hour and quarter-hour offset zones', () => {
  test('Asia/Kolkata (UTC+5:30) applies a partial-hour offset correctly', () => {
    // No DST in India, so this is a plain subtraction: 9:00 - 5:30 = 3:30 UTC.
    const d = localInputToUtcDate('2026-06-15T09:00', 'Asia/Kolkata');
    expect(d!.toISOString()).toBe('2026-06-15T03:30:00.000Z');
  });

  test('Asia/Kathmandu (UTC+5:45) applies a quarter-hour offset correctly', () => {
    // 9:00 - 5:45 = 3:15 UTC.
    const d = localInputToUtcDate('2026-06-15T09:00', 'Asia/Kathmandu');
    expect(d!.toISOString()).toBe('2026-06-15T03:15:00.000Z');
  });
});

describe('localInputToUtcDate: boundary crossings', () => {
  test('a local time in a zone ahead of UTC crosses the year boundary backward', () => {
    // Jan 1, 2026, 12:30 AM in Kolkata (UTC+5:30) is still Dec 31 in UTC:
    // 00:30 - 5:30 = -5:00, i.e. the previous day at 19:00 UTC.
    const d = localInputToUtcDate('2026-01-01T00:30', 'Asia/Kolkata');
    expect(d!.toISOString()).toBe('2025-12-31T19:00:00.000Z');
  });

  test('a local time crosses the month boundary in a zone behind UTC', () => {
    // 8:00 PM PST (UTC-8) on the last day of February rolls into March in UTC:
    // 20:00 + 8h = 04:00 the next day. Ordinary PST, no DST transition nearby
    // (spring-forward is still a week away), isolating the month-boundary
    // arithmetic from any DST interaction.
    const d = localInputToUtcDate('2026-02-28T20:00', 'America/Los_Angeles');
    expect(d!.toISOString()).toBe('2026-03-01T04:00:00.000Z');
  });

  test('a leap-day local time crosses into the following month', () => {
    // 2028 is a leap year, so Feb 29 exists. 11:30 PM PST on that day rolls
    // into March 1: 23:30 + 8h = 07:30 UTC the next day.
    const d = localInputToUtcDate('2028-02-29T23:30', 'America/Los_Angeles');
    expect(d!.toISOString()).toBe('2028-03-01T07:30:00.000Z');
  });
});

describe('localInputToUtcDate: invalid timezone falls back to UTC rather than throwing', () => {
  test('a bogus IANA zone string is treated as UTC, not rejected', () => {
    const withBogusZone = localInputToUtcDate('2026-06-15T09:00', 'Not/AZone');
    const withExplicitUtc = localInputToUtcDate('2026-06-15T09:00', 'UTC');
    expect(withBogusZone!.toISOString()).toBe(withExplicitUtc!.toISOString());
    expect(withBogusZone!.toISOString()).toBe('2026-06-15T09:00:00.000Z');
  });
});

describe('formatForClient: day-only dates stay on the same calendar date across zones', () => {
  test('a noon-UTC-anchored all-day date displays as the same day in a positive half-hour offset zone', () => {
    const noonUtc = new Date(Date.UTC(2026, 5, 15, 12, 0, 0)); // 2026-06-15 noon UTC
    const { input } = formatForClient(noonUtc, 'Asia/Kolkata', { dateOnly: true });
    expect(input.slice(0, 10)).toBe('2026-06-15');
  });

  test('a noon-UTC-anchored all-day date still displays as the same day at the most extreme ordinary offset (UTC-12)', () => {
    // Noon UTC minus 12 hours lands at exactly midnight the same calendar
    // day, the edge case the anchoring comment promises never crosses.
    const noonUtc = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
    const { input } = formatForClient(noonUtc, 'Etc/GMT+12', { dateOnly: true });
    expect(input.slice(0, 10)).toBe('2026-06-15');
  });
});

describe('formatForClient: an all-day date at UTC+12 and beyond', () => {
  /**
   * Noon UTC is already the next day at UTC+12 and beyond (New Zealand in
   * summer, Fiji, Tonga, Kiribati). Goes red if a noon-anchored all-day date is
   * read in the viewer's zone there: it would show the day after.
   */
  test.each(['Pacific/Auckland', 'Pacific/Tongatapu', 'Pacific/Kiritimati'])(
    'a noon-UTC-anchored all-day date is its own day in %s',
    (zone) => {
      const anchor = new Date(Date.UTC(2026, 11, 15, 12, 0, 0));
      const { display, input } = formatForClient(anchor, zone, { dateOnly: true });
      expect(input.slice(0, 10)).toBe('2026-12-15');
      expect(display).toContain('15');
    },
  );

  /**
   * Some older all-day events were stored at the viewer's local midnight rather
   * than the anchor. Goes red if those move a day: they keep being read in the
   * viewer's zone.
   */
  test('an all-day date stored at local midnight keeps its local day', () => {
    const parisMidnight = new Date('2026-08-31T22:00:00Z');
    expect(formatForClient(parisMidnight, 'Europe/Paris', { dateOnly: true }).input.slice(0, 10)).toBe('2026-09-01');
  });
});

describe('formatForClient / zonedDayString: instant timestamps preserve the instant', () => {
  test('converting a local input to UTC and back through formatForClient recovers the same wall-clock time', () => {
    // Independent of localInputToUtcDate: build the UTC instant by hand
    // (9:00 AM IST = 3:30 AM UTC) and confirm formatForClient's reverse
    // direction reports the original local wall time back.
    const instant = new Date('2026-06-15T03:30:00Z');
    const { input } = formatForClient(instant, 'Asia/Kolkata');
    expect(input).toBe('2026-06-15T09:00');
  });

  test('zonedDayString advances the calendar day when a half-hour-offset zone crosses midnight', () => {
    // 7:00 PM UTC on the 14th is half past midnight on the 15th in Kolkata
    // (UTC+5:30): 19:00 + 5:30 = 00:30 the next day.
    expect(zonedDayString(new Date('2026-06-14T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-06-15');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};

describe('dayAnchor / toInstant: a bare day is its noon-UTC anchor, never midnight UTC', () => {
  const { dayAnchor, toInstant } = require('../../src/shared/utils/time');

  test('a day, the leading day of a longer string, and a Date all anchor at noon UTC', () => {
    expect(dayAnchor('2026-09-28').toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(dayAnchor('2026-09-28T23:59:00-07:00').toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(dayAnchor(new Date('2026-09-28T03:00:00Z')).toISOString()).toBe('2026-09-28T12:00:00.000Z');
  });

  test('toInstant reads a bare day as its anchor, which stays on that day in Los Angeles', () => {
    const at = toInstant('2026-09-28');
    expect(at.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(zonedDayString(at, 'America/Los_Angeles')).toBe('2026-09-28');
  });

  test('toInstant passes a real instant through and returns null for nothing or garbage', () => {
    const d = new Date('2026-09-28T19:00:00Z');
    expect(toInstant(d)).toBe(d);
    expect(toInstant('2026-09-28T19:00:00Z').toISOString()).toBe('2026-09-28T19:00:00.000Z');
    expect(toInstant(null)).toBeNull();
    expect(toInstant('')).toBeNull();
    expect(toInstant('not a date')).toBeNull();
  });
});

describe('zonedWallClock / wallClockToUtc: an instant and a wall clock in a zone round-trip', () => {
  const { zonedWallClock, wallClockToUtc } = require('../../src/shared/utils/time');

  test('noon Pacific is 19:00 UTC in daylight time, and back', () => {
    expect(zonedWallClock(new Date('2026-09-28T19:00:00Z'), 'America/Los_Angeles')).toBe('2026-09-28T12:00:00');
    expect(wallClockToUtc('2026-09-28T12:00:00', 'America/Los_Angeles').toISOString()).toBe('2026-09-28T19:00:00.000Z');
  });

  test('midnight renders as 00, not 24', () => {
    expect(zonedWallClock(new Date('2026-09-28T07:00:00Z'), 'America/Los_Angeles')).toBe('2026-09-28T00:00:00');
  });

  test('Graph\'s seven-digit fractions, a bare day (midnight in the zone), and an absolute string', () => {
    expect(wallClockToUtc('2026-09-28T12:00:00.0000000', 'America/New_York').toISOString()).toBe('2026-09-28T16:00:00.000Z');
    expect(wallClockToUtc('2026-09-28', 'America/New_York').toISOString()).toBe('2026-09-28T04:00:00.000Z');
    expect(wallClockToUtc('2026-09-28T12:00:00Z', 'America/New_York').toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(wallClockToUtc(null, 'UTC')).toBeNull();
  });
});
