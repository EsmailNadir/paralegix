jest.mock('../../src/modules/signatures/signatures.repository', () => ({
  listReminderCandidates: jest.fn(),
  updateParticipant: jest.fn(),
  claimReminderSend: jest.fn(),
  releaseReminderClaim: jest.fn(),
}));
jest.mock('../../src/modules/signatures/signingSessions', () => ({
  getActiveParticipant: jest.fn(),
}));
jest.mock('../../src/modules/signatures/signingNotifications', () => ({
  sendParticipantInvitation: jest.fn(),
}));
jest.mock('../../src/shared/utils/reminderControl', () => ({
  remindersGloballyDisabled: jest.fn(),
  disabledReminderStats: jest.fn(),
}));
jest.mock('../../src/shared/utils/personalDay', () => ({
  firmZone: jest.fn(async () => 'UTC'),
}));

import repoModule = require('../../src/modules/signatures/signatures.repository');
import sessionsModule = require('../../src/modules/signatures/signingSessions');
import { sendParticipantInvitation } from '../../src/modules/signatures/signingNotifications';
import { remindersGloballyDisabled, disabledReminderStats } from '../../src/shared/utils/reminderControl';
import { sendSigningReminders } from '../../src/modules/signatures/signingReminders.service';
import { firmZone } from '../../src/shared/utils/personalDay';

const repo = repoModule as any;
const sessions = sessionsModule as any;
const invite = sendParticipantInvitation as jest.Mock;
const disabled = remindersGloballyDisabled as jest.Mock;
const disabledResult = disabledReminderStats as jest.Mock;

const participant = (overrides: Record<string, unknown> = {}) => ({
  participantId: 'participant-1', publicToken: 'public-token', startedAt: '2026-08-29T12:00:00.000Z',
  lastReminderSentAt: null, reminderCount: 2, ...overrides,
});
const session = (overrides: Record<string, unknown> = {}) => ({
  token: 'session-token', lawFirmId: 'firm-1', fileName: 'Engagement.pdf',
  notifyName: 'Firm One', notifyEmail: 'firm@example.test',
  createdAt: '2026-08-29T12:00:00.000Z', expiresAt: '2026-09-01T12:00:00.000Z', ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
  jest.clearAllMocks();
  disabled.mockReturnValue(false);
  disabledResult.mockReturnValue({ disabled: true, sent: 0, skipped: 0, errors: 0 });
  repo.listReminderCandidates.mockResolvedValue([]);
  repo.updateParticipant.mockResolvedValue(undefined);
  repo.claimReminderSend.mockResolvedValue(true);
  repo.releaseReminderClaim.mockResolvedValue(undefined);
  sessions.getActiveParticipant.mockReturnValue(participant());
  invite.mockResolvedValue({ sent: true });
});

afterEach(() => jest.useRealTimers());

describe('signing reminder days', () => {
  /**
   * Days since signing started are counted on the firm's calendar. Goes red if
   * they are counted from the SERVER's midnight: for a firm in Tokyo, a session
   * that started at 1am and is read at 11pm the same day is 0 days in, but a
   * server in UTC or Los Angeles counts 1 and sends the day-1 reminder early.
   */
  it('does not send a day-1 reminder on the day signing started, firm time', async () => {
    (firmZone as jest.Mock).mockResolvedValueOnce('Asia/Tokyo');
    jest.setSystemTime(new Date('2026-09-27T14:00:00.000Z'));
    sessions.getActiveParticipant.mockReturnValue(participant({ startedAt: '2026-09-26T16:00:00.000Z' }));
    repo.listReminderCandidates.mockResolvedValue([session({ expiresAt: '2026-10-20T00:00:00.000Z' })]);

    await sendSigningReminders();

    expect(invite).not.toHaveBeenCalled();
  });
});

describe('sendSigningReminders', () => {
  it('honors the global reminder switch', async () => {
    disabled.mockReturnValue(true);
    await expect(sendSigningReminders()).resolves.toEqual(disabledResult());
    expect(repo.listReminderCandidates).not.toHaveBeenCalled();
  });

  it('sends an expiring reminder, claiming the participant before sending', async () => {
    repo.listReminderCandidates.mockResolvedValue([session()]);

    await expect(sendSigningReminders()).resolves.toEqual({ sent: 1, skipped: 0, errors: 0 });
    expect(repo.claimReminderSend).toHaveBeenCalledWith('session-token', 'participant-1');
    expect(invite).toHaveBeenCalledWith(expect.objectContaining({
      publicToken: 'public-token',
      senderName: 'Firm One', senderEmail: 'firm@example.test',
      message: expect.stringContaining('close to expiring'),
      notificationOverride: expect.objectContaining({ type: 'signing_reminder', title: 'Signature request expiring soon' }),
    }));
    // The claim already stamped last_reminder_sent_at/reminder_count; a
    // successful send needs no further write, and never releases the claim.
    expect(repo.updateParticipant).not.toHaveBeenCalled();
    expect(repo.releaseReminderClaim).not.toHaveBeenCalled();
  });

  it('skips when another worker wins the claim', async () => {
    repo.listReminderCandidates.mockResolvedValue([session()]);
    repo.claimReminderSend.mockResolvedValue(false);

    const result = await sendSigningReminders();

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(invite).not.toHaveBeenCalled();
    expect(repo.releaseReminderClaim).not.toHaveBeenCalled();
  });

  it('releases the claim when the provider send throws, so a future sweep can retry', async () => {
    repo.listReminderCandidates.mockResolvedValue([session()]);
    invite.mockRejectedValue(new Error('email unavailable'));

    const result = await sendSigningReminders();

    expect(result).toMatchObject({ sent: 0, errors: 1 });
    expect(repo.releaseReminderClaim).toHaveBeenCalledWith('session-token', 'participant-1', null);
  });

  it.each([
    ['without an active participant', { active: null }],
    ['on day two', { active: participant({ startedAt: '2026-08-28T12:00:00.000Z' }) }],
    ['recently reminded', { active: participant({ lastReminderSentAt: '2026-08-30T00:00:00.000Z' }) }],
  ] as Array<[string, { active?: any }]> )('skips %s sessions', async (_label, options) => {
    repo.listReminderCandidates.mockResolvedValue([session()]);
    sessions.getActiveParticipant.mockReturnValue(options.active === undefined ? participant() : options.active);

    const result = await sendSigningReminders();

    expect(result.skipped).toBe(1);
    expect(invite).not.toHaveBeenCalled();
    expect(repo.claimReminderSend).not.toHaveBeenCalled();
    expect(repo.updateParticipant).not.toHaveBeenCalled();
  });

  it('releases the claim when the invitation is declined without sending', async () => {
    repo.listReminderCandidates.mockResolvedValue([session()]);
    invite.mockResolvedValue({ sent: false });

    await expect(sendSigningReminders()).resolves.toEqual({ sent: 0, skipped: 1, errors: 0 });
    expect(repo.claimReminderSend).toHaveBeenCalledWith('session-token', 'participant-1');
    expect(repo.releaseReminderClaim).toHaveBeenCalledWith('session-token', 'participant-1', null);
    expect(repo.updateParticipant).not.toHaveBeenCalled();
  });

  it('counts provider failures as errors, releases only the failed claim, and continues', async () => {
    repo.listReminderCandidates.mockResolvedValue([session(), session({ token: 'session-2' })]);
    invite.mockRejectedValueOnce(new Error('email unavailable')).mockResolvedValueOnce({ sent: true });

    await expect(sendSigningReminders()).resolves.toEqual({ sent: 1, skipped: 0, errors: 1 });
    expect(repo.claimReminderSend).toHaveBeenCalledTimes(2);
    expect(repo.releaseReminderClaim).toHaveBeenCalledTimes(1);
    expect(repo.releaseReminderClaim).toHaveBeenCalledWith('session-token', 'participant-1', null);
  });
});
