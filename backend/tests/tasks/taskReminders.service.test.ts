jest.mock('../../src/shared/utils/reminderHelpers', () => ({
  forEachFirm: jest.fn(),
  resolveUserInfo: jest.fn(),
  firmAdminRecipients: jest.fn(),
}));
jest.mock('../../src/modules/tasks/tasks.repository', () => ({
  findReminderCandidates: jest.fn(),
  claimReminderSend: jest.fn(),
  releaseReminderClaim: jest.fn(),
  completeReminderSend: jest.fn(),
}));
jest.mock('../../src/shared/services/emailService', () => ({
  sendTaskDueReminderEmail: jest.fn(),
}));
jest.mock('../../src/shared/services/emailPreferences', () => ({
  EMAIL_CATEGORIES: { TASK_DUE: 'taskDue' },
  getEmailPrefsForUsers: jest.fn(),
  resolveUserCategory: jest.fn(),
}));
jest.mock('../../src/shared/utils/reminderControl', () => ({
  remindersGloballyDisabled: jest.fn(),
  disabledReminderStats: jest.fn(),
}));

import { forEachFirm, resolveUserInfo, firmAdminRecipients } from '../../src/shared/utils/reminderHelpers';
import tasksRepo from '../../src/modules/tasks/tasks.repository';
import { sendTaskDueReminderEmail } from '../../src/shared/services/emailService';
import { getEmailPrefsForUsers, resolveUserCategory } from '../../src/shared/services/emailPreferences';
import { remindersGloballyDisabled, disabledReminderStats } from '../../src/shared/utils/reminderControl';
import { sendTaskReminders, resolveTaskRecipients } from '../../src/modules/tasks/taskReminders.service';

const loop = forEachFirm as jest.Mock;
const userInfo = resolveUserInfo as jest.Mock;
const admins = firmAdminRecipients as jest.Mock;
const repo = tasksRepo as any;
const sendEmail = sendTaskDueReminderEmail as jest.Mock;
const prefs = getEmailPrefsForUsers as jest.Mock;
const category = resolveUserCategory as jest.Mock;
const globallyDisabled = remindersGloballyDisabled as jest.Mock;
const disabledStats = disabledReminderStats as jest.Mock;

const firm = { id: 'firm-1', name: 'Firm One', settings: {} };
const assignee = { userId: 'member-1', email: 'member@example.test', name: 'Member One', timezone: 'UTC' };

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'File response',
    dueDate: '2026-08-30',
    assignedTo: ['member-1'],
    assignedToName: ['Member One'],
    matterName: 'Acme Matter',
    sendReminderEarly: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-30T15:00:00.000Z'));
  firm.settings = {};
  jest.clearAllMocks();
  prefs.mockReset();
  globallyDisabled.mockReturnValue(false);
  disabledStats.mockReturnValue({ disabled: true, sent: 0, skipped: 0, errors: 0 });
  loop.mockImplementation(async (_name, callback) => {
    await callback(firm);
    return { firmsProcessed: 1, truncated: false };
  });
  repo.findReminderCandidates.mockResolvedValue([]);
  repo.claimReminderSend.mockResolvedValue({ id: 'delivery', token: 'claim-token', sentCount: 0 });
  repo.releaseReminderClaim.mockResolvedValue(undefined);
  repo.completeReminderSend.mockResolvedValue(true);
  userInfo.mockResolvedValue(assignee);
  admins.mockResolvedValue([assignee]);
  prefs.mockResolvedValue(new Map([['member-1', { notifications: { digest: { enabled: false } } }]]));
  category.mockReturnValue(true);
  sendEmail.mockResolvedValue({ sent: true });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('task reminder recipients', () => {
  it('resolves one assignee from a scalar or array assignment', async () => {
    await expect(resolveTaskRecipients(task({ assignedTo: 'member-1' }), firm.id, new Map()))
      .resolves.toEqual([expect.objectContaining({ userId: 'member-1', creatorNotification: false })]);
    await expect(resolveTaskRecipients(task({ assignedTo: ['member-1', 'member-1'] }), firm.id, new Map()))
      .resolves.toHaveLength(1);
  });

  it('falls back to firm admins for an unassigned task', async () => {
    admins.mockResolvedValue([
      { email: 'owner@example.test', name: 'Owner' },
      { email: 'admin@example.test', name: 'Admin' },
    ]);

    await expect(resolveTaskRecipients(task({ assignedTo: [] }), firm.id, new Map()))
      .resolves.toEqual([
        { email: 'owner@example.test', name: 'Owner', creatorNotification: false },
        { email: 'admin@example.test', name: 'Admin', creatorNotification: false },
      ]);
  });

  it('does not add unresolved assignees', async () => {
    userInfo.mockResolvedValue(null);
    await expect(resolveTaskRecipients(task(), firm.id, new Map())).resolves.toEqual([]);
  });
});

describe('task reminder day', () => {
  /**
   * A task's due day is the day in the zone it was entered in. Goes red if
   * "today" is the UTC day: at 8pm Pacific it is already tomorrow in UTC, so
   * a task due today reads as overdue and gets no "due today" reminder.
   */
  it('decides "due today" in the task\'s own zone, not UTC', async () => {
    jest.setSystemTime(new Date('2026-08-31T03:00:00.000Z'));
    repo.findReminderCandidates.mockResolvedValue([task({ dueDateTimeZone: 'America/Los_Angeles' })]);

    await sendTaskReminders(firm.id);

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ reminderType: 'due_today' }));
  });

  /** Goes red if a task with no zone of its own (an all-day import) ignores its creator's zone. */
  it('falls back to the creator\'s zone for a task with none', async () => {
    jest.setSystemTime(new Date('2026-08-31T03:00:00.000Z'));
    userInfo.mockImplementation(async (uid: string) => (uid === 'creator-1'
      ? { email: 'creator@example.test', name: 'Creator', timezone: 'America/Los_Angeles' }
      : assignee));
    repo.findReminderCandidates.mockResolvedValue([task({ dueDateTimeZone: null, createdBy: 'creator-1' })]);

    await sendTaskReminders(firm.id);

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ reminderType: 'due_today' }));
  });
});

describe('task reminder sweep', () => {
  it('returns the disabled result without querying firms', async () => {
    globallyDisabled.mockReturnValue(true);

    await expect(sendTaskReminders(firm.id)).resolves.toEqual(disabledStats());
    expect(loop).not.toHaveBeenCalled();
  });

  it('skips a firm with reminders disabled', async () => {
    firm.settings = { taskReminders: { enabled: false } };

    await expect(sendTaskReminders(firm.id)).resolves.toMatchObject({ skipped: 1, sent: 0 });
    expect(repo.findReminderCandidates).not.toHaveBeenCalled();
  });

  it('sends a due-today reminder with a stable UTC date', async () => {
    repo.findReminderCandidates.mockResolvedValue([task()]);

    const result = await sendTaskReminders(firm.id);

    expect(result).toMatchObject({ sent: 1, skipped: 0, errors: 0 });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: assignee.email,
      dueDate: 'August 30, 2026',
      reminderType: 'due_today',
      taskUrl: expect.stringContaining(`/lawfirm/${firm.id}/tasks`),
    }));
  });

  // `daysUntilDue` (`taskReminders.service.ts`) anchors both sides at noon
  // UTC, unlike `reminderUtils.ts`'s `daysUntil` (used by matter event
  // reminders), which used to read the SERVER PROCESS's local calendar day
  // and could mis-count around a daylight-saving transition - see
  // `tests/shared/reminderUtils.test.ts`. Pinned here as a regression guard
  // that this function's own day count stays correct on the same real 2026
  // transition date, since it takes a different (UTC-anchored) approach.
  it('counts a due date exactly one day out across a DST transition (2026-03-08)', async () => {
    jest.setSystemTime(new Date('2026-03-08T05:30:00.000Z'));
    repo.findReminderCandidates.mockResolvedValue([task({ dueDate: '2026-03-09', sendReminderEarly: true })]);

    const result = await sendTaskReminders(firm.id);

    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ reminderType: 'upcoming' }));
  });

  it('sends an early reminder only when explicitly enabled', async () => {
    repo.findReminderCandidates.mockResolvedValue([task({ dueDate: '2026-08-31', sendReminderEarly: true })]);

    const result = await sendTaskReminders(firm.id);

    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ reminderType: 'upcoming' }));
  });

  it.each([
    ['tomorrow without early flag', { dueDate: '2026-08-31' }],
    ['far in the future', { dueDate: '2026-09-10' }],
    ['missing due date', { dueDate: null }],
  ])('skips %s', async (_label, overrides) => {
    repo.findReminderCandidates.mockResolvedValue([task(overrides)]);

    const result = await sendTaskReminders(firm.id);

    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips when another worker wins the claim', async () => {
    repo.findReminderCandidates.mockResolvedValue([task()]);
    repo.claimReminderSend.mockResolvedValue(false);

    const result = await sendTaskReminders(firm.id);

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('honors task-email opt-out and digest suppression', async () => {
    repo.findReminderCandidates.mockResolvedValue([task(), task({ id: 'task-2' })]);
    prefs
      .mockResolvedValueOnce(new Map([['member-1', { notifications: { taskDue: false } }]]))
      .mockResolvedValueOnce(new Map([['member-1', { notifications: { digest: { enabled: true } } }]]));
    category.mockImplementation((settings: any) => settings.notifications?.taskDue !== false);

    const result = await sendTaskReminders(firm.id);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(2);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(repo.claimReminderSend).not.toHaveBeenCalled();
    expect(repo.releaseReminderClaim).not.toHaveBeenCalled();
  });

  it('uses explicit reminder recipients and deduplicates no recipient path', async () => {
    repo.findReminderCandidates.mockResolvedValue([task({ reminderRecipientIds: ['member-2'] })]);
    userInfo.mockResolvedValue({ userId: 'member-2', email: 'other@example.test', name: 'Other' });
    prefs.mockResolvedValue(new Map([['member-2', { notifications: { digest: { enabled: false } } }]]));

    const result = await sendTaskReminders(firm.id);

    expect(userInfo).toHaveBeenCalledWith('member-2', firm.id, expect.any(Map));
    expect(result).toMatchObject({ sent: 1, skipped: 0 });
    expect(prefs).toHaveBeenCalledWith(['member-2']);
    expect(category).toHaveBeenCalledWith(expect.objectContaining({ notifications: expect.any(Object) }), 'taskDue');
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'other@example.test' }));
  });

  it('does not claim when no recipient can be resolved', async () => {
    repo.findReminderCandidates.mockResolvedValue([task()]);
    userInfo.mockResolvedValue(null);
    admins.mockResolvedValue([]);

    const result = await sendTaskReminders(firm.id);

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(repo.claimReminderSend).not.toHaveBeenCalled();
    expect(repo.releaseReminderClaim).not.toHaveBeenCalled();
  });

  it('counts a false email result as skipped and releases the claim', async () => {
    repo.findReminderCandidates.mockResolvedValue([task()]);
    sendEmail.mockResolvedValue({ sent: false });

    const result = await sendTaskReminders(firm.id);

    expect(result).toMatchObject({ sent: 0, skipped: 1, errors: 0 });
    expect(repo.releaseReminderClaim).toHaveBeenCalled();
  });

  it('records send errors and releases the claim after total failure', async () => {
    repo.findReminderCandidates.mockResolvedValue([task()]);
    sendEmail.mockRejectedValue(new Error('mailer unavailable'));

    const result = await sendTaskReminders(firm.id);

    expect(result).toMatchObject({ sent: 0, skipped: 0, errors: 1 });
    expect(repo.releaseReminderClaim).toHaveBeenCalledWith(firm.id, 'task-1', expect.any(String), 'claim-token');
  });

  // One failed recipient must not abort or repeat successful deliveries.
  it('continues after one recipient fails and releases only their claim', async () => {
    repo.findReminderCandidates.mockResolvedValue([
      task({ reminderRecipientIds: ['member-1', 'member-2'] }),
    ]);
    userInfo.mockImplementation(async (uid: string) => ({
      userId: uid,
      email: `${uid}@example.test`,
      name: uid,
    }));
    prefs.mockResolvedValue(new Map([
      ['member-1', { notifications: { digest: { enabled: false } } }],
      ['member-2', { notifications: { digest: { enabled: false } } }],
    ]));
    sendEmail
      .mockRejectedValueOnce(new Error('first recipient unavailable'))
      .mockResolvedValueOnce({ sent: true });

    const result = await sendTaskReminders(firm.id);

    expect(result).toMatchObject({ sent: 1, skipped: 0, errors: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls.map(([payload]: any[]) => payload.to)).toEqual([
      'member-1@example.test',
      'member-2@example.test',
    ]);
    expect(repo.releaseReminderClaim).toHaveBeenCalledTimes(1);
    expect(repo.completeReminderSend).toHaveBeenCalledTimes(1);
  });

  it('a later pass retries the failed recipient without repeating the successful recipient', async () => {
    repo.findReminderCandidates.mockResolvedValue([
      task({ reminderRecipientIds: ['member-1', 'member-2'] }),
    ]);
    userInfo.mockImplementation(async (uid: string) => ({
      userId: uid,
      email: `${uid}@example.test`,
      name: uid,
    }));
    prefs.mockResolvedValue(new Map([
      ['member-1', { notifications: { digest: { enabled: false } } }],
      ['member-2', { notifications: { digest: { enabled: false } } }],
    ]));
    const delivered = new Set<string>();
    repo.claimReminderSend.mockImplementation(async (_firm: string, _task: string, key: string) =>
      delivered.has(key) ? null : { id: key, token: 'claim-token', sentCount: 0 });
    repo.completeReminderSend.mockImplementation(async (_firm: string, _task: string, key: string) => {
      delivered.add(key);
      return true;
    });
    sendEmail
      .mockRejectedValueOnce(new Error('first recipient unavailable'))
      .mockResolvedValueOnce({ sent: true });

    await sendTaskReminders(firm.id);
    await sendTaskReminders(firm.id);

    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(sendEmail.mock.calls.map(([payload]: any[]) => payload.to)).toEqual([
      'member-1@example.test', 'member-2@example.test', 'member-1@example.test',
    ]);
    expect(repo.claimReminderSend).toHaveBeenCalledTimes(4);
  });

  it('records candidate-query errors and continues the sweep', async () => {
    repo.findReminderCandidates.mockRejectedValue(new Error('database unavailable'));

    const result = await sendTaskReminders(firm.id);

    expect(result).toMatchObject({ sent: 0, skipped: 0, errors: 1, firmsProcessed: 1 });
  });
});
