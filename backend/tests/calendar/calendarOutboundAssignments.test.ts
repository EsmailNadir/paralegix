import { installGoogleFetchWall, uninstallGoogleFetchWall, resetGoogleFetch, route, callsMatching } from './support/googleFetch';
installGoogleFetchWall();
import { createFirm, createFirmMember, createPersonClient, testPool } from '../support/setupInProcess';
import { connectGoogle, seedMatterWithEvent } from './support/calendarWorld';

const repo = require('../../src/modules/calendar/shared/calendarSync.repository');
const outbound = require('../../src/modules/calendar/shared/calendarOutboundRetry');
beforeEach(resetGoogleFetch);
afterAll(uninstallGoogleFetchWall);

test.each(['task', 'matterEvent', 'clientEvent'].flatMap((entityType) => [
  { entityType, refreshEntity: false }, { entityType, refreshEntity: true },
]))('a queued $entityType create cannot recreate a removed assignee copy (refresh: $refreshEntity)', async ({ entityType, refreshEntity }) => {
  const firm = await createFirm();
  const removedUid = await connectGoogle(firm);
  await testPool.query('update members set is_owner = true where law_firm_id = $1 and user_id = $2', [firm.id, removedUid]);
  const current = await createFirmMember(firm.id);
  let data: Record<string, unknown>;
  if (entityType === 'task') {
    const row = (await testPool.query(`insert into tasks (id, law_firm_id, title, due_date, created_by)
      values (gen_random_uuid(), $1, 'Assigned task', '2030-11-10', $2) returning id`, [firm.id, current.uid])).rows[0];
    data = { id: row.id, lawFirmId: firm.id, dueDate: '2030-11-10', title: 'Assigned task', createdBy: current.uid, assignedTo: [removedUid] };
    await testPool.query('insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)', [firm.id, row.id, current.uid]);
  } else {
    const { matterId, eventId } = await seedMatterWithEvent(firm, 'Assigned hearing');
    const client = await createPersonClient(firm.id, { name: 'Hearing client' });
    if (entityType === 'clientEvent') {
      await testPool.query('update events set matter_id = null, client_id = $1 where id = $2', [client.id, eventId]);
    }
    await testPool.query('update events set created_by = $1 where id = $2', [current.uid, eventId]);
    await testPool.query('insert into event_assignees (law_firm_id, event_id, user_id) values ($1, $2, $3)', [firm.id, eventId, current.uid]);
    data = { id: eventId, lawFirmId: firm.id, title: 'Assigned hearing', date: '2030-11-10T14:00:00Z', createdBy: current.uid, assignedTo: [removedUid],
      ...(entityType === 'matterEvent' ? { matterId } : { clientId: client.id }) };
  }
  const work = await repo.recordOutboundWork({ provider: 'google', userId: removedUid, entityType, entityData: data, action: 'createEventsFromEntity' });
  route('/calendars/primary/events', { status: 200, json: { id: 'stale-copy' } }, { method: 'POST' });
  await outbound.dispatchOutboundWork(work.dedupeKey, { refreshEntity });
  expect(await repo.getOutboundWork(work.dedupeKey)).toBeNull();
  expect(callsMatching('/events').filter((call) => call.method === 'POST')).toHaveLength(0);
  expect((await testPool.query('select 1 from calendar_mappings where user_id = $1', [removedUid])).rowCount).toBe(0);
});
