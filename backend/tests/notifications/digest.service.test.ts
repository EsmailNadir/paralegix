/**
 * The daily digest job contract (B08.1), fully mocked and unit-level.
 *
 * `digest.service.ts` had no dedicated spec before this file: coverage of the
 * actual sweep lived only in `tests/cron/cronEndpoints.test.ts` (through the
 * real HTTP route, one recipient at a time) and `tests/shared/digestBuckets.test.ts`
 * (pure bucketing math with no service around it). Neither exercises the
 * job-contract rows every unattended job is supposed to satisfy: a mid-firm
 * failure that must not take the rest of the firm down with it, a provider
 * rejection that must release its claim, and the provider-throws case where the
 * release ALSO fails.
 *
 * Everything the service reaches (`digest.repository`, `reminderHelpers`,
 * `reminderControl`, `emailPreferences`, `emailService`) is mocked here so each
 * case can force an exact sequence of outcomes across several recipients
 * without seeding real rows. `digestBuckets.ts` (bucketing/capping) and
 * `localTime.ts` (hour/day resolution) are left real and pure: `now` is passed
 * explicitly and the recipient's timezone is always 'UTC', so the local hour
 * and local day are simple, verifiable UTC values.
 *
 * `lawFirmId` is deliberately a non-UUID string ('firm-1'). `canSeeInvoices`
 * guards on `isUuid(lawFirmId)` before it ever touches the database, so this
 * keeps every case here off the real `queryContext` path without having to
 * mock it, and invoices never enter the item count (already covered with real
 * rows in `cronEndpoints.test.ts`).
 */

jest.mock('../../src/modules/notifications/digest/digest.repository', () => ({
  listFirmMemberIds: jest.fn(),
  claimDigestSend: jest.fn(),
  releaseDigestSend: jest.fn(),
  findDigestTasks: jest.fn(),
  findDigestEvents: jest.fn(),
  findDigestStatuteDates: jest.fn(),
  findDigestInvoices: jest.fn(),
}));
jest.mock('../../src/shared/utils/reminderHelpers', () => ({
  forEachFirm: jest.fn(),
  resolveUserInfo: jest.fn(),
}));
jest.mock('../../src/shared/utils/reminderControl', () => ({
  remindersGloballyDisabled: jest.fn(),
  disabledReminderStats: jest.fn(),
}));
jest.mock('../../src/shared/services/emailPreferences', () => ({
  getEmailPrefsForUsers: jest.fn(),
}));
jest.mock('../../src/shared/services/emailService', () => ({
  sendDailyDigestEmail: jest.fn(),
}));

import digestRepo = require('../../src/modules/notifications/digest/digest.repository');
import { forEachFirm, resolveUserInfo } from '../../src/shared/utils/reminderHelpers';
import { remindersGloballyDisabled, disabledReminderStats } from '../../src/shared/utils/reminderControl';
import { getEmailPrefsForUsers } from '../../src/shared/services/emailPreferences';
import { sendDailyDigestEmail } from '../../src/shared/services/emailService';
import { sendDigestForUser, sendDailyDigests } from '../../src/modules/notifications/digest/digest.service';

const repo = digestRepo as any;
const loop = forEachFirm as jest.Mock;
const userInfo = resolveUserInfo as jest.Mock;
const globallyDisabled = remindersGloballyDisabled as jest.Mock;
const disabledStats = disabledReminderStats as jest.Mock;
const prefs = getEmailPrefsForUsers as jest.Mock;
const sendEmail = sendDailyDigestEmail as jest.Mock;

const FIRM = { id: 'firm-1', name: 'Firm One', settings: {} };
// A Tuesday, so the 'weekdays' default schedule is never the reason a case
// skips; every case that needs 'today' also sets days:'daily' explicitly.
const NOW = new Date('2026-08-25T14:00:00.000Z');
const TODAY = '2026-08-25';

function digestPrefs(hour = 14) {
  return { notifications: { digest: { enabled: true, hour, days: 'daily' } } };
}

function dueTodayTask(id = 'task-1') {
  return { kind: 'task', id, title: `Task ${id}`, day: TODAY, priority: 'high', matterId: null, matterName: null };
}

beforeEach(() => {
  jest.clearAllMocks();
  globallyDisabled.mockReturnValue(false);
  loop.mockImplementation(async (_name: string, callback: any, options: any) => {
    const firm = { ...FIRM, id: options?.lawFirmId || FIRM.id };
    await callback(firm);
    return { firmsProcessed: 1, firmsTotal: 1, truncated: false };
  });
  userInfo.mockResolvedValue({ email: 'member-1@example.test', name: 'Member One', timezone: 'UTC' });
  prefs.mockResolvedValue(new Map([['member-1', digestPrefs()]]));
  repo.listFirmMemberIds.mockResolvedValue(['member-1']);
  repo.findDigestTasks.mockResolvedValue([]);
  repo.findDigestEvents.mockResolvedValue([]);
  repo.findDigestStatuteDates.mockResolvedValue([]);
  repo.findDigestInvoices.mockResolvedValue([]);
  repo.claimDigestSend.mockResolvedValue(true);
  repo.releaseDigestSend.mockResolvedValue(undefined);
  sendEmail.mockResolvedValue({ sent: true });
});

describe('sendDigestForUser (J01, J05, J06)', () => {
  it('J01: does nothing observable when nothing is due — no claim, no send', async () => {
    const outcome = await sendDigestForUser({ firm: FIRM, userId: 'member-1', userInfoCache: new Map(), now: NOW });

    expect(outcome).toBe('skipped');
    // The claim is the observable side effect that would prove a "harmless
    // empty pass" is not actually harmless: an empty digest that still claims
    // the day would silently burn the recipient's one legitimate send.
    expect(repo.claimDigestSend).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('J01: positive control — claims the day and sends when there is eligible work', async () => {
    repo.findDigestTasks.mockResolvedValue([dueTodayTask()]);

    const outcome = await sendDigestForUser({ firm: FIRM, userId: 'member-1', userInfoCache: new Map(), now: NOW });

    expect(outcome).toBe('sent');
    expect(repo.claimDigestSend).toHaveBeenCalledWith(FIRM.id, 'member-1', TODAY, 1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('J05: the provider declines to send — the claim is released and the outcome is skipped, not sent', async () => {
    repo.findDigestTasks.mockResolvedValue([dueTodayTask()]);
    sendEmail.mockResolvedValue({ sent: false });

    const outcome = await sendDigestForUser({ firm: FIRM, userId: 'member-1', userInfoCache: new Map(), now: NOW });

    expect(outcome).toBe('skipped');
    expect(repo.releaseDigestSend).toHaveBeenCalledWith(FIRM.id, 'member-1', TODAY);
  });

  it('J06: the provider throws — the claim is released and the outcome is error, not silently sent', async () => {
    repo.findDigestTasks.mockResolvedValue([dueTodayTask()]);
    sendEmail.mockRejectedValue(new Error('smtp unreachable'));

    const outcome = await sendDigestForUser({ firm: FIRM, userId: 'member-1', userInfoCache: new Map(), now: NOW });

    expect(outcome).toBe('error');
    expect(repo.releaseDigestSend).toHaveBeenCalledWith(FIRM.id, 'member-1', TODAY);
  });
});

describe('sendDailyDigests (J04, J08, J10)', () => {
  it('J04: a source-query failure for the middle of three recipients does not stop the others', async () => {
    repo.listFirmMemberIds.mockResolvedValue(['member-1', 'member-2', 'member-3']);
    userInfo.mockImplementation(async (uid: string) => ({ email: `${uid}@example.test`, name: uid, timezone: 'UTC' }));
    prefs.mockResolvedValue(new Map([
      ['member-1', digestPrefs()], ['member-2', digestPrefs()], ['member-3', digestPrefs()],
    ]));
    repo.findDigestTasks
      .mockResolvedValueOnce([dueTodayTask('t1')])
      .mockRejectedValueOnce(new Error('query timeout'))
      .mockResolvedValueOnce([dueTodayTask('t3')]);

    const stats = await sendDailyDigests(FIRM.id, { now: NOW });

    // The count is the assertion: a version that aborted the firm on the first
    // error would report far fewer than three attempts, and a version that
    // miscounted the failure as a send would report sent:3.
    expect(stats).toMatchObject({ sent: 2, errors: 1, skipped: 0, firmsProcessed: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('J06/J04: a release that ALSO fails is swallowed at the recipient level, not the whole firm', async () => {
    repo.listFirmMemberIds.mockResolvedValue(['member-1', 'member-2']);
    userInfo.mockImplementation(async (uid: string) => ({ email: `${uid}@example.test`, name: uid, timezone: 'UTC' }));
    prefs.mockResolvedValue(new Map([['member-1', digestPrefs()], ['member-2', digestPrefs()]]));
    repo.findDigestTasks.mockResolvedValue([dueTodayTask()]);
    // member-1's send fails AND the recovery release also fails (a DB blip
    // while handling the first failure). member-2's send succeeds cleanly.
    sendEmail.mockRejectedValueOnce(new Error('smtp unreachable')).mockResolvedValueOnce({ sent: true });
    repo.releaseDigestSend.mockRejectedValueOnce(new Error('db unreachable'));

    const stats = await sendDailyDigests(FIRM.id, { now: NOW });

    // Without the per-recipient try/catch around each `sendDigestForUser` call,
    // this double failure for member-1 would propagate out of the whole firm's
    // handler (caught only by `forEachFirm`'s per-FIRM catch, which does not
    // touch `stats`), and member-2 would never be attempted: this would read
    // sent:0, errors:0 instead.
    expect(stats).toMatchObject({ sent: 1, errors: 1, skipped: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('J08: a shared deadline that has already elapsed stops the firm before any recipient is touched', async () => {
    repo.listFirmMemberIds.mockResolvedValue(['member-1', 'member-2']);
    repo.findDigestTasks.mockResolvedValue([dueTodayTask()]);
    const pastDeadline = Date.now() - 1000;

    const stats = await sendDailyDigests(FIRM.id, { now: NOW, deadline: pastDeadline });

    // No transport call at all, for either recipient — the budget check runs
    // before the first `sendDigestForUser` call, not after.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(repo.claimDigestSend).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ sent: 0, skipped: 0, errors: 0 });
  });

  it('J10: the global reminder kill switch skips the pass with no firm walk at all', async () => {
    globallyDisabled.mockReturnValue(true);
    disabledStats.mockReturnValue({ sent: 0, skipped: 0, errors: 0, disabled: true });

    const stats = await sendDailyDigests(FIRM.id, { now: NOW });

    expect(stats).toEqual({ sent: 0, skipped: 0, errors: 0, disabled: true });
    expect(loop).not.toHaveBeenCalled();
    expect(repo.listFirmMemberIds).not.toHaveBeenCalled();
  });

  it.each([
    ['dailyDigest.enabled === false', { dailyDigest: { enabled: false } }],
    ['emailNotificationsEnabled === false', { emailNotificationsEnabled: false }],
  ])('J10: a firm opted out via %s is skipped without ever listing its members', async (_label, settings) => {
    loop.mockImplementation(async (_name: string, callback: any, options: any) => {
      const firm = { ...FIRM, id: options?.lawFirmId || FIRM.id, settings };
      await callback(firm);
      return { firmsProcessed: 1, firmsTotal: 1, truncated: false };
    });

    const stats = await sendDailyDigests(FIRM.id, { now: NOW });

    // The firm is counted as skipped, and — the part a status-only assertion
    // would miss — no member lookup or send was ever attempted for it, which
    // is what "no transport call" actually means for a job that walks members.
    expect(stats).toMatchObject({ sent: 0, skipped: 1, errors: 0 });
    expect(repo.listFirmMemberIds).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
