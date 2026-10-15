/**
 * Recipient-local time helpers - pure unit tests (no server, no database).
 *
 *   __TEST_TOKEN__=offline npx jest tests/shared/localTime.test.js
 */

const { normalizeTimeZone } = require('../../src/shared/utils/time');
const {
  localHourFor,
  localDateFor,
  addDays,
  isWeekend,
} = require('../../src/shared/utils/localTime');

describe('normalizeTimeZone', () => {
  test('passes through a valid IANA zone', () => {
    expect(normalizeTimeZone('America/New_York')).toBe('America/New_York');
  });

  test('falls back to UTC for a bogus zone', () => {
    expect(normalizeTimeZone('Mars/Olympus_Mons')).toBe('UTC');
  });

  test('falls back to UTC for null and empty', () => {
    expect(normalizeTimeZone(null)).toBe('UTC');
    expect(normalizeTimeZone('')).toBe('UTC');
  });
});

describe('localHourFor', () => {
  test('converts a UTC instant into the recipient local hour', () => {
    const at = new Date('2026-07-28T12:00:00Z');
    expect(localHourFor('America/New_York', at)).toBe(8);
    expect(localHourFor('UTC', at)).toBe(12);
  });

  test('midnight is 0, never 24', () => {
    expect(localHourFor('UTC', new Date('2026-07-28T00:00:00Z'))).toBe(0);
  });

  test('an unknown zone is treated as UTC', () => {
    expect(localHourFor('Nowhere/Nothing', new Date('2026-07-28T12:00:00Z'))).toBe(12);
  });
});

describe('localDateFor', () => {
  test('returns the recipient local calendar day as YYYY-MM-DD', () => {
    const at = new Date('2026-07-28T02:00:00Z');
    expect(localDateFor('America/New_York', at)).toBe('2026-07-27');
    expect(localDateFor('UTC', at)).toBe('2026-07-28');
  });

  test('handles a zone ahead of UTC', () => {
    expect(localDateFor('Asia/Tokyo', new Date('2026-07-28T20:00:00Z'))).toBe('2026-07-29');
  });
});

describe('addDays', () => {
  test.each([
    ['advances a plain day', '2026-07-28', 1, '2026-07-29'],
    ['rolls over a month boundary', '2026-07-31', 1, '2026-08-01'],
    ['handles a leap day', '2028-02-28', 1, '2028-02-29'],
    ['goes backwards', '2026-08-01', -1, '2026-07-31'],
    ['advances a week', '2026-07-28', 7, '2026-08-04'],
  ])('%s: %s + %i is %s', (_label, day, n, expected) => {
    expect(addDays(day, n)).toBe(expected);
  });
});

describe('isWeekend', () => {
  test('Saturday and Sunday are weekend', () => {
    expect(isWeekend('2026-08-01')).toBe(true);
    expect(isWeekend('2026-08-02')).toBe(true);
  });

  test('Tuesday is not', () => {
    expect(isWeekend('2026-07-28')).toBe(false);
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
