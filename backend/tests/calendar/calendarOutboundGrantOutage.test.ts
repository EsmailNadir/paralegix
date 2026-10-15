/**
 * Queued outbound calendar work while the person's grant is unusable.
 *
 * A grant recorded as `reconnect_required` or `permission_required` still has
 * its tokens on the row, but `loadUserData` hands none of them out, so nothing
 * can be written to the calendar until the person reconnects. The queued edit
 * or delete is still owed to that calendar: it has to wait, not be resolved as
 * if it had been done. Only a person who turned outbound sync off has asked for
 * the work to be dropped.
 */
import { installGoogleFetchWall, uninstallGoogleFetchWall, resetGoogleFetch, googleCalls } from './support/googleFetch';
installGoogleFetchWall();
import { createFirm, testPool, type Firm } from '../support/setupInProcess';
import { connectGoogle } from './support/calendarWorld';

const repo = require('../../src/modules/calendar/shared/calendarSync.repository');
const outbound = require('../../src/modules/calendar/shared/calendarOutboundRetry');

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});
afterAll(uninstallGoogleFetchWall);

/** A task the connected owner created, with an event already on their calendar. */
async function syncedTask(uid: string) {
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, uid]);
  const task = (await testPool.query(`insert into tasks (id, law_firm_id, title, status, due_date, due_at, created_by)
    values (gen_random_uuid(), $1, 'Hearing prep', 'open', '2030-11-10', '2030-11-10T14:00:00Z', $2) returning id`,
  [firm.id, uid])).rows[0];
  await repo.saveMapping({
    provider: 'google', externalEventId: 'queued-copy', userId: uid, lawFirmId: firm.id,
    entityType: 'task', entityId: task.id, itemKey: 'dueDate', calendarId: 'primary',
  });
  return task.id as string;
}

const setGrantState = (uid: string, grantState: string) => testPool.query(
  `update user_oauth_tokens set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('grantState', $2::text)
    where user_id = $1 and provider = 'google'`,
  [uid, grantState],
);

const queue = (uid: string, taskId: string, action: string) => repo.recordOutboundWork({
  provider: 'google', userId: uid, entityType: 'task',
  entityData: { id: taskId, lawFirmId: firm.id, title: 'Hearing prep', status: 'open', dueDate: '2030-11-10T14:00:00Z' },
  action,
});

describe.each([
  ['reconnect_required', 'updateEventsFromEntity'],
  ['permission_required', 'deleteEventsFromEntity'],
])('a queued write while the grant is %s (%s)', (grantState, action) => {
  /**
   * Goes red if an unusable grant is read as "nothing to do": the work row
   * would be deleted and the change never reach the calendar after reconnect.
   */
  test('stays queued for a later attempt and calls nothing', async () => {
    const uid = await connectGoogle(firm);
    const taskId = await syncedTask(uid);
    await setGrantState(uid, grantState);
    const work = await queue(uid, taskId, action);
    const before = await repo.getOutboundWork(work.dedupeKey);

    await expect(outbound.dispatchOutboundWork(work.dedupeKey, { refreshEntity: true })).rejects.toThrow(/grant/i);

    const after = await repo.getOutboundWork(work.dedupeKey);
    expect(after).not.toBeNull();
    expect(after.payload.action).toBe(action);
    expect(after.attempts).toBe(before.attempts);
    expect(googleCalls()).toHaveLength(0);
  });
});

/**
 * Goes red if the outage fix also holds work for a person who switched
 * outbound sync off: that work is not owed to anyone and must be dropped.
 */
test('a queued edit is dropped when the person turned outbound sync off', async () => {
  const uid = await connectGoogle(firm);
  const taskId = await syncedTask(uid);
  await setGrantState(uid, 'reconnect_required');
  const off = await testPool.query(
    "update user_oauth_tokens set is_sync_to_provider = false where user_id = $1 and provider = 'google'", [uid],
  );
  expect(off.rowCount).toBe(1);
  const work = await queue(uid, taskId, 'updateEventsFromEntity');
  expect(await repo.getOutboundWork(work.dedupeKey)).not.toBeNull();

  await outbound.dispatchOutboundWork(work.dedupeKey, { refreshEntity: true });

  expect(await repo.getOutboundWork(work.dedupeKey)).toBeNull();
  expect(googleCalls()).toHaveLength(0);
});
