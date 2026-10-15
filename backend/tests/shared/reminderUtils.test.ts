jest.mock('../../src/shared/utils/reminderHelpers', () => ({
  resolveUserInfo: jest.fn(),
}));

import { daysUntil, wasSentRecently } from '../../src/shared/utils/reminderUtils';

describe('reminder time utilities', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-30T15:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('treats a missing reminder timestamp as eligible', () => {
    expect(wasSentRecently(null)).toBe(false);
    expect(wasSentRecently(undefined)).toBe(false);
  });

  it('accepts date-like values', () => {
    expect(wasSentRecently('2026-08-30T10:00:00.000Z')).toBe(true);
    expect(wasSentRecently(new Date('2026-08-29T14:59:59.000Z'))).toBe(false);
  });

  it('uses a strict 24-hour window', () => {
    expect(wasSentRecently('2026-08-29T15:00:00.000Z')).toBe(false);
    expect(wasSentRecently('2026-08-29T15:00:01.000Z')).toBe(true);
  });

  // `daysUntil`'s one real caller (`matterEventReminders.service.ts`) always
  // passes a `events.date` value - a `timestamptz` column, which this
  // repo's Postgres driver always returns as a real UTC instant ('...Z'). A
  // bare, offset-less string is not a shape this function is ever actually
  // called with; these use the real shape rather than a synthetic one.
  it('computes calendar days rather than elapsed hours', () => {
    expect(daysUntil('2026-08-30T23:59:59.000Z')).toBe(0);
    expect(daysUntil('2026-08-31T00:00:00.000Z')).toBe(1);
    expect(daysUntil('2026-08-29T23:59:59.000Z')).toBe(-1);
  });

});

// `daysUntil` used to read the calendar day off `Date`'s LOCAL getters,
// making the result depend on the SERVER PROCESS's OS time zone - an
// ambient dependency none of its siblings (`invoiceReminders.service.ts`'s
// `daysUntilDay`, `taskReminders.service.ts`'s `daysUntilDue`) carry, and
// invisible on screen. It is now UTC-anchored like both of them, which is
// immune to a daylight-saving transition by construction rather than by the
// old version's coincidental "the ±1h error is always well inside the
// ±0.5-day rounding tolerance" argument. These pin day counts spanning the
// two 2026 America/New_York transition dates as a regression guard: a
// future change that reintroduces a local getter here would go on drifting
// silently everywhere else and only show up as a wrong "days until" count on
// exactly these two days a year.
describe('daysUntil stays UTC-anchored across a real DST-transition date', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts exactly 1 day across 2026-03-08 (the US spring-forward date)', () => {
    jest.setSystemTime(new Date('2026-03-08T05:30:00.000Z'));
    expect(daysUntil('2026-03-09T16:00:00.000Z')).toBe(1);
  });

  it('counts exactly 7 days across the same date for a week-out reminder', () => {
    jest.setSystemTime(new Date('2026-03-08T05:30:00.000Z'));
    expect(daysUntil('2026-03-15T16:00:00.000Z')).toBe(7);
  });

  it('counts exactly 1 day across 2026-11-01 (the US fall-back date)', () => {
    jest.setSystemTime(new Date('2026-11-01T05:30:00.000Z'));
    expect(daysUntil('2026-11-02T16:00:00.000Z')).toBe(1);
  });
});
