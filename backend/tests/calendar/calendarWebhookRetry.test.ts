/**
 * The durable webhook retry sweep, through the real `calendar_sync_failures`
 * table.
 *
 * The sweep reads due rows, replays each one through the provider service, and
 * then either removes the row or reschedules it. Both of those writes are keyed
 * in SQL, so a test that mocks the repository can pass while the key it hands
 * over matches nothing: the row then stays due forever and is replayed on every
 * run. These cases seed real rows and read the table back afterwards.
 *
 * The provider services are replaced with spies only at their entry points, so
 * no Google or Microsoft call is made; what is under test is the queue.
 */
import { createFirm, createFirmMember, testPool, type Firm } from '../support/setupInProcess';

const calendarSyncRepo = require('../../src/modules/calendar/shared/calendarSync.repository');
const googleService = require('../../src/modules/calendar/google/google.service');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');
const { retryFailedWebhooks } = require('../../src/modules/calendar/shared/calendarWebhookRetry');

let firm: Firm;
let uid: string;

beforeEach(async () => {
  firm = await createFirm();
  ({ uid } = await createFirmMember(firm.id));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const rowsOf = async (kind = 'webhook') => (await testPool.query(
  `select dedupe_key, attempts, payload from calendar_sync_failures where kind = $1 order by dedupe_key`,
  [kind],
)).rows;

describe('retryFailedWebhooks', () => {
  test('replays the retained Google delta cursor instead of dropping deletions in a full scan', async () => {
    await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId: uid, lawFirmId: firm.id, error: 'old' });
    const incremental = jest.spyOn(googleService, 'processWatchNotification').mockResolvedValue(undefined);
    const full = jest.spyOn(googleService, 'syncFromGoogle').mockResolvedValue({});
    await retryFailedWebhooks();
    expect(incremental).toHaveBeenCalledWith({ userId: uid, lawFirmId: firm.id });
    expect(full).not.toHaveBeenCalled();
    expect(await rowsOf()).toHaveLength(0);
  });
  test('an older failed replay cannot postpone a newer pending notification', async () => {
    await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId: uid, lawFirmId: firm.id, error: 'old' });
    jest.spyOn(googleService, 'processWatchNotification').mockImplementation(async () => {
      await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId: uid, lawFirmId: firm.id, pending: true });
      throw new Error('old replay failed');
    });
    await retryFailedWebhooks();
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(0);
    const due = await testPool.query("select next_attempt_at <= now() as due from calendar_sync_failures where kind = 'webhook'");
    expect(due.rows[0].due).toBe(true);
  });
  test('an older successful replay cannot remove a newer notification queued during it', async () => {
    await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId: uid, lawFirmId: firm.id, error: 'old' });
    jest.spyOn(googleService, 'processWatchNotification').mockImplementation(async () => {
      await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId: uid, lawFirmId: firm.id, error: 'new' });
    });
    const result = await retryFailedWebhooks();
    expect(result.attempted).toBe(1);
    expect(await rowsOf()).toHaveLength(1);
  });
  /**
   * Goes red if the sweep resolves by anything other than the row's dedupe key:
   * the delete matches nothing and the row is replayed on every later run.
   */
  test('removes a row whose replay succeeded', async () => {
    await calendarSyncRepo.recordWebhookFailure({
      provider: 'google', userId: uid, lawFirmId: firm.id, error: new Error('boom'),
    });
    const sync = jest.spyOn(googleService, 'processWatchNotification').mockResolvedValue({ success: true });

    const summary = await retryFailedWebhooks();

    expect(sync).toHaveBeenCalledWith({ userId: uid, lawFirmId: firm.id });
    expect(summary).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await rowsOf()).toEqual([]);
  });

  /**
   * Goes red if the reschedule is keyed wrongly: the attempt count never moves,
   * so a row that keeps failing never backs off and never dead-letters.
   */
  test('reschedules a row whose replay failed', async () => {
    await calendarSyncRepo.recordWebhookFailure({
      provider: 'google', userId: uid, lawFirmId: firm.id, error: new Error('boom'),
    });
    jest.spyOn(googleService, 'processWatchNotification').mockRejectedValue(new Error('still down'));

    const summary = await retryFailedWebhooks();

    expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(2);
    const due = await testPool.query(
      `select next_attempt_at > now() as later from calendar_sync_failures where kind = 'webhook'`,
    );
    expect(due.rows[0].later).toBe(true);
  });

  /**
   * A failed Google delete is replayed by id before the delta replay, which
   * cannot see a deletion.
   */
  test('replays a recorded Google delete before the delta replay', async () => {
    await calendarSyncRepo.recordWebhookFailure({
      provider: 'google', userId: uid, lawFirmId: firm.id, changeType: 'deleted', eventId: 'g-gone', error: 'x',
    });
    const order: string[] = [];
    jest.spyOn(googleService, 'reprocessInboundDelete').mockImplementation(async () => { order.push('delete'); });
    jest.spyOn(googleService, 'processWatchNotification').mockImplementation(async () => { order.push('sync'); });

    await retryFailedWebhooks();

    expect(order).toEqual(['delete', 'sync']);
    expect(await rowsOf()).toEqual([]);
  });
});

describe('Outlook failures', () => {
  /**
   * Graph notifies once per changed event, and the retry re-fetches exactly the
   * event a row names. Goes red if failures for one user coalesce onto one row
   * that keeps only the last event: the first event's change is then never
   * retried.
   */
  test('keeps one retry per failed event and replays each of them', async () => {
    for (const eventId of ['o-first', 'o-second']) {
      await calendarSyncRepo.recordWebhookFailure({
        provider: 'outlook', userId: uid, lawFirmId: firm.id, changeType: 'updated',
        eventId, resource: `me/events/${eventId}`, error: 'x',
      });
    }
    expect(await rowsOf()).toHaveLength(2);
    const replay = jest.spyOn(outlookService, 'processSubscriptionNotification').mockResolvedValue(undefined);

    await retryFailedWebhooks();

    const replayed = replay.mock.calls.map((call: any[]) => call[0].resourceData.id).sort();
    expect(replayed).toEqual(['o-first', 'o-second']);
    expect(await rowsOf()).toEqual([]);
  });
});

describe('the sweep budget', () => {
  test('does not start a retry after the shared deadline', async () => {
    await calendarSyncRepo.recordWebhookFailure({
      provider: 'google', userId: uid, lawFirmId: firm.id, error: 'x',
    });
    const sync = jest.spyOn(googleService, 'processWatchNotification').mockResolvedValue({});

    const result = await retryFailedWebhooks({ deadline: Date.now() - 1 });

    expect(result).toMatchObject({ attempted: 0, truncated: true });
    expect(sync).not.toHaveBeenCalled();
    expect(await rowsOf()).toHaveLength(1);
  });
});

export {};

test('reconnection catch-up work uses a full Google recovery and an Outlook full scan', async () => {
  await calendarSyncRepo.recordWebhookFailure({ provider: 'google', userId: uid, lawFirmId: firm.id, changeType: 'catch_up', eventId: 'reconnect', pending: true });
  await calendarSyncRepo.recordWebhookFailure({ provider: 'outlook', userId: uid, lawFirmId: firm.id, changeType: 'catch_up', eventId: 'reconnect', pending: true });
  const google = jest.spyOn(googleService, 'processWatchNotification').mockResolvedValue(undefined);
  const outlook = jest.spyOn(outlookService, 'syncFromOutlook').mockResolvedValue({});
  await retryFailedWebhooks();
  expect(google).toHaveBeenCalledWith({ userId: uid, lawFirmId: firm.id, forceFull: true });
  expect(outlook).toHaveBeenCalledWith({ userId: uid, lawFirmId: firm.id });
  expect(await rowsOf()).toHaveLength(0);
});
