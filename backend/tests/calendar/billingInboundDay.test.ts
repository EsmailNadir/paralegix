/**
 * The day an invoice date takes when its calendar event is moved to a set
 * time in Google or Outlook.
 *
 * Pure: the invoice write, the member's permission read and the member's
 * settings are stubbed, so all this pins is which day is handed to the write.
 */
jest.mock('../../src/modules/billing/invoices/invoices.service', () => ({
  applyBillingCalendarSyncUpdate: jest.fn(),
}));
jest.mock('../../src/modules/lawfirms/members/members.repository', () => ({
  findByUserId: jest.fn(async () => null),
}));
jest.mock('../../src/modules/calendar/shared/calendarTokens', () => ({
  getSettings: jest.fn(),
}));

const invoicesService = require('../../src/modules/billing/invoices/invoices.service');
const calendarTokens = require('../../src/modules/calendar/shared/calendarTokens');

const googleStrategy = require('../../src/modules/calendar/google/googleStrategy');
const outlookStrategy = require('../../src/modules/calendar/outlook/outlookStrategy');

const write = invoicesService.applyBillingCalendarSyncUpdate as jest.Mock;
const settings = calendarTokens.getSettings as jest.Mock;
const mapping = { data: { id: 'inv-1' }, itemKey: 'dueDate' };

beforeEach(() => {
  jest.clearAllMocks();
  settings.mockResolvedValue({ timezone: 'America/Los_Angeles' });
});

const scheduledDay = () => write.mock.calls[0][0].scheduledDate;

describe('an invoice date moved to a set time', () => {
  /** Goes red if the day is the UTC day: 7pm Pacific on the 10th is the 11th in UTC. */
  test('Google: takes the day in the event\'s own zone', async () => {
    await googleStrategy.syncBillingEvent({
      id: 'g-inv', start: { dateTime: '2026-09-10T19:00:00-07:00', timeZone: 'America/Los_Angeles' },
    }, mapping, 'firm-1', 'user-1');
    expect(scheduledDay()).toBe('2026-09-10');
  });

  /**
   * Graph reports times in UTC unless asked otherwise, which says nothing about
   * the member's day. Goes red if that UTC label decides the day.
   */
  test('Outlook: takes the day in the member\'s zone when Graph reports UTC', async () => {
    await outlookStrategy.syncBillingEvent({
      id: 'AAMk-inv', isAllDay: false,
      start: { dateTime: '2026-09-11T02:00:00.0000000', timeZone: 'UTC' },
    }, mapping, 'firm-1', 'user-1');
    expect(scheduledDay()).toBe('2026-09-10');
  });

  test('an all-day event keeps its own day on both', async () => {
    await googleStrategy.syncBillingEvent({ id: 'g-inv', start: { date: '2026-09-12' } }, mapping, 'firm-1', 'user-1');
    await outlookStrategy.syncBillingEvent({
      id: 'AAMk-inv', isAllDay: true, start: { dateTime: '2026-09-12T00:00:00.0000000', timeZone: 'UTC' },
    }, mapping, 'firm-1', 'user-1');
    expect(write.mock.calls.map((c) => c[0].scheduledDate)).toEqual(['2026-09-12', '2026-09-12']);
  });
});

export {};
