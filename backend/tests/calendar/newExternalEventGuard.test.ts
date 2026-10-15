/**
 * A provider event with no usable start cannot be placed on the calendar, so
 * the inbound engine skips it (a null from `buildNewExternalEventData`).
 */
const googleStrategy = require('../../src/modules/calendar/google/googleStrategy');
const outlookStrategy = require('../../src/modules/calendar/outlook/outlookStrategy');

describe('a new provider event with no start', () => {
  /** Goes red if the Outlook guard falls back to "now" again, which made it never skip. */
  test('Outlook: is skipped', () => {
    expect(outlookStrategy.buildNewExternalEventData({ id: 'AAMk-1', subject: 'No start' }, 'user-1')).toBeNull();
    expect(outlookStrategy.buildNewExternalEventData({
      id: 'AAMk-2', subject: 'Garbled', start: { dateTime: 'not a time', timeZone: 'UTC' },
    }, 'user-1')).toBeNull();
  });

  test('Google: is skipped', () => {
    expect(googleStrategy.buildNewExternalEventData({ id: 'g-1', summary: 'No start' }, 'user-1')).toBeNull();
  });

  test('an event with a start is kept, on both', () => {
    expect(outlookStrategy.buildNewExternalEventData({
      id: 'AAMk-3', subject: 'Call', start: { dateTime: '2026-09-28T19:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-28T20:00:00.0000000', timeZone: 'UTC' },
    }, 'user-1')).toMatchObject({ outlookId: 'AAMk-3', createdBy: 'user-1' });
    expect(googleStrategy.buildNewExternalEventData({
      id: 'g-2', summary: 'Call', start: { dateTime: '2026-09-28T19:00:00Z' }, end: { dateTime: '2026-09-28T20:00:00Z' },
    }, 'user-1')).toMatchObject({ googleEventId: 'g-2', createdBy: 'user-1' });
  });
});

export {};
