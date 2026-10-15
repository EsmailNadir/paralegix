/**
 * The schedule arithmetic Google and Outlook pushes share.
 */
const { timedEnd, allDaySpan, isExistingItemEligible, DEFAULT_TIMED_BLOCK_MS } = require('../../src/modules/calendar/shared/calendarTime');
const { freezeClockAt, unfreezeClock } = require('../support/clock');

describe('timedEnd', () => {
  const start = new Date('2026-09-28T19:00:00Z');

  test('keeps an end after the start', () => {
    const end = new Date('2026-09-28T21:30:00Z');
    expect(timedEnd(start, end)).toBe(end);
  });

  test('fills in the default block for no end, or one not after the start', () => {
    const block = new Date(start.getTime() + DEFAULT_TIMED_BLOCK_MS).toISOString();
    expect(DEFAULT_TIMED_BLOCK_MS).toBe(60 * 60 * 1000);
    expect(timedEnd(start).toISOString()).toBe(block);
    expect(timedEnd(start, start).toISOString()).toBe(block);
    expect(timedEnd(start, new Date('invalid')).toISOString()).toBe(block);
  });
});

describe('allDaySpan', () => {
  test('a single day ends the next day, exclusively', () => {
    expect(allDaySpan(new Date('2026-09-28T12:00:00Z'))).toEqual({ startDay: '2026-09-28', endDay: '2026-09-29' });
  });

  test('keeps a stored exclusive end, and ignores one not after the start', () => {
    expect(allDaySpan(new Date('2026-09-28T12:00:00Z'), new Date('2026-10-01T12:00:00Z')))
      .toEqual({ startDay: '2026-09-28', endDay: '2026-10-01' });
    expect(allDaySpan(new Date('2026-09-28T12:00:00Z'), new Date('2026-09-28T12:00:00Z')))
      .toEqual({ startDay: '2026-09-28', endDay: '2026-09-29' });
  });

  test('crosses a month and a year', () => {
    expect(allDaySpan(new Date('2026-12-31T12:00:00Z'))).toEqual({ startDay: '2026-12-31', endDay: '2027-01-01' });
  });
});

describe('isExistingItemEligible for an all-day item', () => {
  // Monday the 5th through Thursday the 8th: stored as the first day's noon
  // anchor and the exclusive day after the last day, also at noon.
  const mondayToThursday = {
    key: 'dueDate',
    dateTime: '2026-10-05T12:00:00.000Z',
    end: '2026-10-09T12:00:00.000Z',
    allDay: true,
    timeZone: 'America/New_York',
  };
  const state = { status: 'pending', assignedTo: [] };

  afterEach(() => unfreezeClock());

  test('is pushed while a later day of its span is still today', () => {
    freezeClockAt('2026-10-06T09:00:00-04:00');
    expect(isExistingItemEligible(state, mondayToThursday, 'u1')).toBe(true);
  });

  test('is pushed on its last day', () => {
    freezeClockAt('2026-10-08T23:30:00-04:00');
    expect(isExistingItemEligible(state, mondayToThursday, 'u1')).toBe(true);
  });

  test('is skipped once its last day has passed', () => {
    freezeClockAt('2026-10-09T00:30:00-04:00');
    expect(isExistingItemEligible(state, mondayToThursday, 'u1')).toBe(false);
  });

  test('a single day with no end is skipped the day after', () => {
    freezeClockAt('2026-10-06T09:00:00-04:00');
    const single = { ...mondayToThursday, end: null };
    expect(isExistingItemEligible(state, single, 'u1')).toBe(false);
    expect(isExistingItemEligible(state, { ...single, dateTime: '2026-10-06T12:00:00.000Z' }, 'u1')).toBe(true);
  });
});

export {};
