/**
 * `dateUtils.ts` had zero dedicated coverage before this file, despite being
 * the one place day-only date handling is supposed to be centralized.
 *
 * `todayLocalDate` and `isBeforeToday` are frozen at an instant deliberately
 * chosen so UTC's calendar day and the VIEWER's local calendar day disagree
 * (late evening Pacific, already past midnight UTC). `jest.config.js` pins
 * `TZ=America/Los_Angeles` for every run, so these are deterministic whatever
 * the machine's own zone is.
 */
import { toLocalDate, formatDateOnly, isBeforeToday, isPastInstant, isTaskOverdue, localDayKey, todayLocalDate } from '@/lib/utils/dateUtils';

describe('toLocalDate', () => {
  it('parses a day-only string at LOCAL midnight, not UTC midnight', () => {
    // The bug this guards: `new Date('2026-03-15')` is UTC midnight, which
    // reads back as March 14th in any zone behind UTC (Los Angeles included).
    const d = toLocalDate('2026-03-15');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(15);
  });

  it('returns null for missing or unparseable values', () => {
    expect(toLocalDate(null)).toBeNull();
    expect(toLocalDate(undefined)).toBeNull();
    expect(toLocalDate('')).toBeNull();
    expect(toLocalDate('not a date')).toBeNull();
  });

  it('passes a real Date instance through unchanged', () => {
    const original = new Date('2026-06-01T10:00:00.000Z');
    expect(toLocalDate(original)).toBe(original);
  });
});

describe('formatDateOnly', () => {
  it('formats the literal calendar date regardless of any time-of-day component', () => {
    expect(formatDateOnly('2026-03-15')).toBe('3/15/2026');
  });

  it('returns the fallback for a missing value', () => {
    expect(formatDateOnly(null, undefined, 'N/A')).toBe('N/A');
  });
});

describe('todayLocalDate and isBeforeToday across a UTC/local calendar-day mismatch', () => {
  // 2026-01-15T07:30:00Z is 11:30pm on January 14th in America/Los_Angeles
  // (PST, UTC-8): UTC's calendar has already rolled to the 15th while the
  // viewer's has not.
  const FROZEN_UTC_INSTANT = '2026-01-15T07:30:00.000Z';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FROZEN_UTC_INSTANT));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('names the VIEWER local day, not the UTC day', () => {
    // The bug this guards: `new Date().toISOString().slice(0, 10)` would
    // return '2026-01-15' here - tomorrow, from this viewer's perspective.
    expect(todayLocalDate()).toBe('2026-01-14');
  });

  it('treats a value dated the local today as NOT before today', () => {
    expect(isBeforeToday('2026-01-14')).toBe(false);
  });

  it('treats a value dated the local yesterday as before today', () => {
    expect(isBeforeToday('2026-01-13')).toBe(true);
  });

  it('treats a value dated the UTC-only "today" as still in the future locally', () => {
    // '2026-01-15' is tomorrow from this viewer's local vantage point, even
    // though it is UTC's current date at this exact instant.
    expect(isBeforeToday('2026-01-15')).toBe(false);
  });
});

describe('isTaskOverdue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-15T07:30:00.000Z')); // local Jan 14
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is not overdue once completed, regardless of due date', () => {
    expect(isTaskOverdue({ status: 'completed', dueDate: '2020-01-01' })).toBe(false);
  });

  it('is overdue when the local due day has already passed and the task is open', () => {
    expect(isTaskOverdue({ status: 'open', dueDate: '2026-01-13' })).toBe(true);
  });

  it('is not overdue when due today (local)', () => {
    expect(isTaskOverdue({ status: 'open', dueDate: '2026-01-14' })).toBe(false);
  });
});

describe('isPastInstant', () => {
  it('is true for an instant already gone and false for one still ahead', () => {
    expect(isPastInstant(new Date(Date.now() - 60_000).toISOString())).toBe(true);
    expect(isPastInstant(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it('accepts a Date, a number and an ISO string alike', () => {
    // The three shapes the event feeds actually deliver.
    expect(isPastInstant(new Date(Date.now() - 1000))).toBe(true);
    expect(isPastInstant(Date.now() - 1000)).toBe(true);
    expect(isPastInstant(new Date(Date.now() - 1000).toISOString())).toBe(true);
  });

  it('returns false rather than true for a missing or unparseable value', () => {
    // An event with no date is not "past". Returning true would grey out every
    // row whose date failed to load, which reads as a data problem being hidden.
    expect(isPastInstant(null)).toBe(false);
    expect(isPastInstant(undefined)).toBe(false);
    expect(isPastInstant('')).toBe(false);
    expect(isPastInstant('not a date')).toBe(false);
  });

  it('differs from isBeforeToday on a day-only value, which is why both exist', () => {
    // Today's day-only string is NOT before today, so nothing is overdue. But as
    // an instant it is UTC midnight, which has already passed for any viewer
    // behind UTC and for most of the day for one ahead of it. Passing a day-only
    // value here is the mistake the doc comment warns about; this pins the
    // difference so the two helpers cannot be quietly merged.
    const today = todayLocalDate();
    expect(isBeforeToday(today)).toBe(false);
    expect(isPastInstant(today)).toBe(new Date(today).getTime() < Date.now());
  });
});

describe('localDayKey', () => {
  // Red if a day-only value is round-tripped through UTC midnight (it would
  // come back as the previous day in Los Angeles), or if an instant is read in
  // UTC instead of the viewer's zone.
  it('returns a day-only string unchanged', () => {
    expect(localDayKey('2026-04-10')).toBe('2026-04-10');
  });

  it('reads an instant on the viewer\'s calendar, not UTC\'s', () => {
    // 03:00 UTC on the 10th is 8pm on the 9th in Los Angeles.
    expect(localDayKey('2026-04-10T03:00:00.000Z')).toBe('2026-04-09');
    expect(localDayKey('2026-04-10T20:00:00.000Z')).toBe('2026-04-10');
  });

  it('returns null for a missing or unparseable value', () => {
    expect(localDayKey(null)).toBeNull();
    expect(localDayKey('')).toBeNull();
    expect(localDayKey('not a date')).toBeNull();
  });
});
