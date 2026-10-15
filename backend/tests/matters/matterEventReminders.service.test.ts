jest.mock('../../src/shared/services/emailPreferences', () => ({ EMAIL_CATEGORIES: { EVENT_REMINDER: 'eventReminder' }, isUserEmailCategoryEnabled: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/shared/services/emailService', () => ({
  sendMatterEventReminderEmail: jest.fn(),
}));
jest.mock('../../src/shared/utils/reminderControl', () => ({
  remindersGloballyDisabled: jest.fn(),
  disabledReminderStats: jest.fn(),
}));
jest.mock('../../src/shared/utils/reminderHelpers', () => ({
  resolveUserInfo: jest.fn(),
  forEachFirm: jest.fn(),
  listMatters: jest.fn(),
  firmAdminRecipients: jest.fn(),
  isFirmMember: jest.fn(),
}));
jest.mock('../../src/modules/matters/matterEvents.repository', () => ({
  findAllForMatters: jest.fn(),
  claimReminderSend: jest.fn(),
  releaseReminderClaim: jest.fn(),
}));

import { sendMatterEventReminderEmail } from '../../src/shared/services/emailService';
import { remindersGloballyDisabled, disabledReminderStats } from '../../src/shared/utils/reminderControl';
import { resolveUserInfo, forEachFirm, listMatters, firmAdminRecipients, isFirmMember } from '../../src/shared/utils/reminderHelpers';
import matterEventsRepo from '../../src/modules/matters/matterEvents.repository';
import { sendMatterEventReminders } from '../../src/modules/matters/matterEventReminders.service';

const sendEmail = sendMatterEventReminderEmail as jest.Mock;
const disabled = remindersGloballyDisabled as jest.Mock;
const disabledStats = disabledReminderStats as jest.Mock;
const loop = forEachFirm as jest.Mock;
const matters = listMatters as jest.Mock;
const users = resolveUserInfo as jest.Mock;
const admins = firmAdminRecipients as jest.Mock;
const isMember = isFirmMember as jest.Mock;
const events = matterEventsRepo as any;

const firm = { id: 'firm-1', name: 'Firm One', settings: {} };
const recipient = { userId: 'user-1', email: 'lawyer@example.test', name: 'Lawyer', timezone: 'UTC' };
const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-1', matterId: 'matter-1', title: 'Court appearance', type: 'court_date',
  date: '2026-08-31T16:00:00.000Z', status: 'upcoming', assignedTo: ['user-1'],
  createdBy: 'user-2', lastReminderSentAt: null, ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
  jest.clearAllMocks();
  require('../../src/shared/services/emailPreferences').isUserEmailCategoryEnabled.mockResolvedValue(true);
  disabled.mockReturnValue(false);
  disabledStats.mockReturnValue({ disabled: true, sent: 0, skipped: 0, errors: 0 });
  loop.mockImplementation(async (_name, callback, options) => {
    await callback({ ...firm, id: options.lawFirmId || firm.id });
    return { firmsProcessed: 1, firmsTotal: 1, truncated: false };
  });
  matters.mockResolvedValue([{ id: 'matter-1', name: 'Acme Matter' }]);
  events.findAllForMatters.mockResolvedValue([]);
  events.claimReminderSend.mockResolvedValue(true);
  events.releaseReminderClaim.mockResolvedValue(undefined);
  users.mockResolvedValue(recipient);
  admins.mockResolvedValue([]);
  isMember.mockResolvedValue(true);
  sendEmail.mockResolvedValue({ sent: true });
});

afterEach(() => jest.useRealTimers());

describe('sendMatterEventReminders', () => {
  it('returns the global disabled result without reading firms', async () => {
    disabled.mockReturnValue(true);
    await expect(sendMatterEventReminders('firm-1')).resolves.toEqual(disabledStats());
    expect(loop).not.toHaveBeenCalled();
  });

  it('sends an upcoming reminder with the event label and local date', async () => {
    events.findAllForMatters.mockResolvedValue([event()]);

    await expect(sendMatterEventReminders('firm-1')).resolves.toMatchObject({ sent: 1, skipped: 0, errors: 0 });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'Court Date', reminderType: 'upcoming', daysUntil: 1,
      matterName: 'Acme Matter', eventUrl: expect.stringContaining('/matters/matter-1'),
      eventDate: expect.stringContaining('August 31, 2026'),
    }));
  });

  /**
   * Goes red if the event's day and "today" are read in UTC: 10pm Pacific on
   * August 30 is already August 31 in UTC, so an event due tonight for its
   * Pacific creator reads as tomorrow.
   */
  it('decides the event\'s day in its creator\'s zone, not UTC', async () => {
    jest.setSystemTime(new Date('2026-08-30T20:00:00.000Z'));
    users.mockImplementation(async (uid: string) => (uid === 'user-2'
      ? { userId: 'user-2', email: 'creator@example.test', name: 'Creator', timezone: 'America/Los_Angeles' }
      : recipient));
    events.findAllForMatters.mockResolvedValue([event({ date: '2026-08-31T05:00:00.000Z' })]);

    await sendMatterEventReminders('firm-1');

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ reminderType: 'due_today', daysUntil: 0 }));
  });

  /**
   * An all-day event is stored at its day's noon-UTC anchor, which is no time
   * of day. Goes red if the email prints that anchor as a clock time in the
   * recipient's zone ("5:00 AM" in Pacific).
   */
  it('shows an all-day event as its date alone', async () => {
    users.mockResolvedValue({ ...recipient, timezone: 'America/Los_Angeles' });
    events.findAllForMatters.mockResolvedValue([event({ date: '2026-08-31T12:00:00.000Z', allDay: true })]);

    await sendMatterEventReminders('firm-1');

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ eventDate: 'August 31, 2026' }));
  });

  it.each([
    ['cancelled', { status: 'cancelled' }],
    ['completed', { status: 'completed' }],
    ['undated', { date: null }],
    ['outside reminder window', { date: '2026-09-10T16:00:00.000Z' }],
  ])('skips %s events without claiming or sending', async (_label, overrides) => {
    events.findAllForMatters.mockResolvedValue([event(overrides)]);

    const result = await sendMatterEventReminders('firm-1');

    expect(result.sent).toBe(0);
    expect(events.claimReminderSend).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('uses the created-by user and then firm admins when no assignee resolves', async () => {
    events.findAllForMatters.mockResolvedValue([event({ assignedTo: [], createdBy: 'creator-1' })]);
    users.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    admins.mockResolvedValue([recipient]);

    await sendMatterEventReminders('firm-1');

    expect(users).toHaveBeenCalledWith('creator-1', 'firm-1', expect.any(Map));
    expect(admins).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips a created-by user who is no longer a firm member and falls back to firm admins', async () => {
    events.findAllForMatters.mockResolvedValue([event({ assignedTo: [], createdBy: 'ex-member-1' })]);
    isMember.mockResolvedValue(false);
    admins.mockResolvedValue([recipient]);

    await sendMatterEventReminders('firm-1');

    expect(isMember).toHaveBeenCalledWith('firm-1', 'ex-member-1', expect.any(Map));
    // Membership failed, so resolveUserInfo must never even be asked about
    // the former member - proving the gate runs before resolution, not after.
    expect(users).not.toHaveBeenCalledWith('ex-member-1', 'firm-1', expect.any(Map));
    expect(admins).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not resend recently reminded events or when another worker owns the claim', async () => {
    events.findAllForMatters.mockResolvedValueOnce([event({ lastReminderSentAt: '2026-08-30T00:00:00.000Z' })]);
    await sendMatterEventReminders('firm-1');
    expect(events.claimReminderSend).not.toHaveBeenCalled();

    events.findAllForMatters.mockResolvedValueOnce([event()]);
    events.claimReminderSend.mockResolvedValue(false);
    const result = await sendMatterEventReminders('firm-1');
    expect(result.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('releases the claim when every email attempt fails', async () => {
    events.findAllForMatters.mockResolvedValue([event()]);
    sendEmail.mockRejectedValue(new Error('mailer unavailable'));

    const result = await sendMatterEventReminders('firm-1');

    expect(result.errors).toBe(1);
    expect(events.releaseReminderClaim).toHaveBeenCalledWith('firm-1', 'matter-1', 'event-1', null);
  });
});

it('does not email past appointments as daily overdue work', async () => {
  events.findAllForMatters.mockResolvedValue([event({ date: '2026-08-29T16:00:00Z' })]);
  const result = await sendMatterEventReminders('firm-1');
  expect(events.findAllForMatters).toHaveBeenCalled();
  expect(result).toMatchObject({ sent: 0, skipped: 1 });
  expect(sendEmail).not.toHaveBeenCalled();
});

it('honors recipient event-reminder email preferences', async () => {
  events.findAllForMatters.mockResolvedValue([event()]);
  require('../../src/shared/services/emailPreferences').isUserEmailCategoryEnabled.mockResolvedValue(false);
  const result = await sendMatterEventReminders('firm-1');
  expect(result.sent).toBe(0);
  expect(users).toHaveBeenCalled();
  expect(sendEmail).not.toHaveBeenCalled();
});
