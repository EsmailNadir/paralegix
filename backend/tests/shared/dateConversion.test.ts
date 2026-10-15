import { rowIso, toDate, toDayKey, toIso } from '../../src/shared/utils/dateConversion';

describe('date conversion helpers', () => {
  it('normalizes dates and strings', () => {
    const instant = new Date('2026-02-03T04:05:06.000Z');
    expect(toIso(instant)).toBe('2026-02-03T04:05:06.000Z');
    expect(toIso('2026-02-03T04:05:06.000Z')).toBe('2026-02-03T04:05:06.000Z');
    expect(toDate('2026-02-03T04:05:06.000Z')).toEqual(instant);
  });

  it('returns null for absent and invalid values', () => {
    expect(toDate(null)).toBeNull();
    expect(toIso('not a date')).toBeNull();
    expect(toDayKey('not a date')).toBeNull();
    expect(toDate(new Date('invalid'))).toBeNull();
  });

  it('creates UTC day keys without changing the calendar date', () => {
    expect(toDayKey('2026-07-28T23:59:59.000Z')).toBe('2026-07-28');
    expect(toDayKey(new Date('2028-02-29T12:00:00.000Z'))).toBe('2028-02-29');
  });

  it('preserves database date strings in rowIso while formatting Date values', () => {
    expect(rowIso('2026-07-28')).toBe('2026-07-28');
    expect(rowIso(new Date('2026-07-28T12:00:00.000Z'))).toBe('2026-07-28T12:00:00.000Z');
    expect(rowIso('')).toBeNull();
    expect(rowIso(null)).toBeNull();
  });
});
