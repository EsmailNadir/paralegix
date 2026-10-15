/**
 * Removing Paralegix items from members' provider calendars.
 *
 * Every Paralegix copy on a member's Google or Outlook calendar is recorded
 * twice: in the item's per-user `calendar_sync` map and in a `calendar_mappings`
 * row written the moment the provider accepted the create. The map travels on
 * the event payload, and a payload is a snapshot taken before the sync that
 * wrote the map, so it is routinely missing (a task payload is the row as the
 * task service read it, with no `calendar_sync` at all). The mapping row is the
 * durable record, and every case here deletes through a payload that does not
 * name the event, so only the mapping can address it.
 *
 * Calls are asserted at the network wall (`support/googleFetch.ts`); each member
 * gets a distinct access token, so the bearer on a call names whose calendar it
 * reached.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  drainEvents,
  tokenFor,
  as,
  type Firm,
} from '../support/setupInProcess';
import { describeNetworkWall } from './support/calendarWorld';

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

describeNetworkWall();

async function connectGoogle(lawFirmId: string, opts: { isOwner?: boolean } = {}) {
  const accessToken = `tok-${randomUUID().slice(0, 8)}`;
  const { uid } = await createFirmMember(lawFirmId, { isOwner: opts.isOwner });
  const res = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', $2, 'refresh-seed', true, true)`,
    [uid, accessToken],
  );
  expect(res.rowCount).toBe(1);
  return { uid, accessToken };
}

async function seedTask(lawFirmId: string, createdBy: string, calendarSync: object = {}) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into tasks (id, law_firm_id, title, due_date, created_by, calendar_sync)
     values ($1, $2, 'File the motion', '2026-09-20', $3, $4::jsonb)`,
    [id, lawFirmId, createdBy, JSON.stringify(calendarSync)],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function seedTaskMapping(lawFirmId: string, userId: string, taskId: string, externalEventId: string, calendarId = 'primary') {
  const res = await testPool.query(
    `insert into calendar_mappings
       (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, item_key)
     values ('google', $1, $2, $3, $4, 'task', $5, 'dueDate')`,
    [externalEventId, calendarId, userId, lawFirmId, taskId],
  );
  expect(res.rowCount).toBe(1);
}

const deletes = () => callsMatching('/events/').filter((c) => c.method === 'DELETE');
const mappingIds = async () => (await testPool.query(
  `select external_event_id from calendar_mappings order by external_event_id`,
)).rows.map((r) => r.external_event_id);

describe('deleting a task', () => {
  test('completing a task removes its mapped calendar copy', async () => {
    const owner = await connectGoogle(firm.id, { isOwner: true });
    const taskId = await seedTask(firm.id, owner.uid);
    await seedTaskMapping(firm.id, owner.uid, taskId, 'g-completed');
    route(/\/events\/g-completed/, { status: 204 }, { method: 'DELETE' });
    const response = await as(tokenFor({ uid: owner.uid })).put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).send({ status: 'completed' });
    expect(response.status).toBe(200);
    await drainEvents();
    expect(deletes().map((call) => call.bearer)).toEqual([owner.accessToken]);
    expect(await mappingIds()).toEqual([]);
  });
  /**
   * Goes red if the delete path addresses only the payload's `calendar_sync`
   * map: the task payload carries none, so nothing is deleted and the event
   * stays on the member's calendar for good.
   */
  test('removes the copy the mapping names when the payload does not carry it', async () => {
    const owner = await connectGoogle(firm.id, { isOwner: true });
    const taskId = await seedTask(firm.id, owner.uid);
    await seedTaskMapping(firm.id, owner.uid, taskId, 'g-task-1');
    route(/\/events\/g-task-1/, { status: 204 }, { method: 'DELETE' });

    const res = await as(tokenFor({ uid: owner.uid })).delete(`/api/lawfirms/${firm.id}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    await drainEvents();

    expect(deletes().map((c) => [c.url.split('/events/')[1].split('?')[0], c.bearer])).toEqual([['g-task-1', owner.accessToken]]);
    expect(await mappingIds()).toEqual([]);
  });
});

describe('clearing a due date', () => {
  /**
   * The stale-key half of the update path: a key the item no longer produces
   * is deleted. Goes red if those keys come only from the payload's map.
   */
  test('removes the copy the mapping names', async () => {
    const owner = await connectGoogle(firm.id, { isOwner: true });
    const taskId = await seedTask(firm.id, owner.uid);
    await seedTaskMapping(firm.id, owner.uid, taskId, 'g-task-2');
    route(/\/events\/g-task-2/, { status: 204 }, { method: 'DELETE' });

    const res = await as(tokenFor({ uid: owner.uid }))
      .put(`/api/lawfirms/${firm.id}/tasks/${taskId}`)
      .send({ dueDate: null });
    expect(res.status).toBe(200);
    await drainEvents();

    expect(deletes().map((c) => c.url.split('/events/')[1].split('?')[0])).toEqual(['g-task-2']);
    expect(await mappingIds()).toEqual([]);
  });
});

describe('a delete racing an in-flight create', () => {
  /**
   * A recurrence group deleted while its creates are still at the provider:
   * the delete's payload was read before the create recorded anything. Goes red
   * if the delete addresses only the payload, since the event the create then
   * records is never removed.
   */
  test('removes the event the in-flight create records', async () => {
    const eventBus = require('../../src/shared/events/eventBus');
    const { MATTER_EVENT_CREATED, MATTER_EVENT_DELETED } = require('../../src/shared/events/eventTypes');
    const owner = await connectGoogle(firm.id, { isOwner: true });
    const matterId = randomUUID();
    await testPool.query(
      `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Bell v. Ward', $3)`,
      [matterId, firm.id, `M-${matterId.slice(0, 8)}`],
    );
    await testPool.query(
      `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at) values ($1, $2, $3, 'member', now())`,
      [matterId, owner.uid, firm.id],
    );
    const eventId = randomUUID();
    await testPool.query(
      `insert into events (id, law_firm_id, matter_id, type, title, date, recurrence_group_id)
       values ($1, $2, $3, 'hearing', 'Weekly status', '2026-09-10T14:00:00Z', $4)`,
      [eventId, firm.id, matterId, randomUUID()],
    );
    const payload = { id: eventId, lawFirmId: firm.id, matterId, title: 'Weekly status', date: '2026-09-10T14:00:00Z' };

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let posted: () => void = () => {};
    const postSeen = new Promise<void>((resolve) => { posted = resolve; });
    route('/calendars/primary/events', async () => {
      posted();
      await held;
      return { status: 200, json: { id: 'g-racing', etag: '"1"', updated: '2026-09-01T00:00:00Z' } };
    }, { method: 'POST' });
    route(/\/events\/g-racing/, { status: 204 }, { method: 'DELETE' });

    eventBus.emit(MATTER_EVENT_CREATED, { lawFirmId: firm.id, matterId, eventData: payload, userId: owner.uid });
    await postSeen;
    eventBus.emit(MATTER_EVENT_DELETED, { lawFirmId: firm.id, matterId, eventData: payload, userId: owner.uid });
    release();
    await drainEvents();

    expect(deletes().map((c) => c.url.split('/events/')[1].split('?')[0])).toEqual(['g-racing']);
    expect(await mappingIds()).toEqual([]);
  });
});

export {};
