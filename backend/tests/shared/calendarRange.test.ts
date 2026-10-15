/**
 * Calendar range helper - pure unit tests (no server, no database).
 */

const { resolveCalendarRange, nextDay } = require('../../src/shared/utils/calendarRange');

describe('nextDay', () => {
  test('advances a plain day', () => {
    expect(nextDay('2026-03-10')).toBe('2026-03-11');
  });

  test('rolls over a month boundary', () => {
    expect(nextDay('2026-03-31')).toBe('2026-04-01');
  });

  test('handles a leap day', () => {
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});

describe('resolveCalendarRange', () => {
  test('returns null when either bound is missing', () => {
    expect(resolveCalendarRange({ from: '2026-03-01', timezone: 'UTC' })).toBeNull();
    expect(resolveCalendarRange({ to: '2026-03-31', timezone: 'UTC' })).toBeNull();
    expect(resolveCalendarRange({ timezone: 'UTC' })).toBeNull();
  });

  test('returns null for a malformed bound', () => {
    expect(resolveCalendarRange({ from: '03/01/2026', to: '2026-03-31', timezone: 'UTC' })).toBeNull();
  });

  test('returns null when the range is inverted', () => {
    expect(resolveCalendarRange({ from: '2026-03-31', to: '2026-03-01', timezone: 'UTC' })).toBeNull();
  });

  test('bounds a UTC window at local midnight, end exclusive', () => {
    const range = resolveCalendarRange({ from: '2026-03-01', to: '2026-03-31', timezone: 'UTC' });
    expect(range.startUtc.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  test('shifts the bounds for a zone behind UTC', () => {
    // New York is UTC-5 on 2026-03-01, so the local day starts at 05:00Z.
    const range = resolveCalendarRange({ from: '2026-03-01', to: '2026-03-01', timezone: 'America/New_York' });
    expect(range.startUtc.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-03-02T05:00:00.000Z');
  });

  test('shifts the bounds for a zone ahead of UTC', () => {
    // Sydney is UTC+11 on 2026-03-01, so the local day starts the previous day at 13:00Z.
    const range = resolveCalendarRange({ from: '2026-03-01', to: '2026-03-01', timezone: 'Australia/Sydney' });
    expect(range.startUtc.toISOString()).toBe('2026-02-28T13:00:00.000Z');
    expect(range.endUtc.toISOString()).toBe('2026-03-01T13:00:00.000Z');
  });

  test('echoes the day strings back for day-only callers', () => {
    const range = resolveCalendarRange({ from: '2026-03-01', to: '2026-03-31', timezone: 'UTC' });
    expect(range.from).toBe('2026-03-01');
    expect(range.to).toBe('2026-03-31');
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
