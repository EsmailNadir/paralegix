/**
 * Setting or changing the time of a synced item must move the SAME event on the
 * user's Google or Outlook calendar, never add a second one, and a time changed
 * on the provider side must come back to the Paralegix item.
 *
 * Three ways that broke, each pinned below:
 *
 *   THE "SYNC EXISTING" BUTTONS recorded their events differently from the
 *   real-time sync. They wrote the event id into the task's scalar
 *   `google_event_id` / `outlook_id` column and saved no `calendar_mappings`
 *   row. The real-time update path reads the per-user `calendar_sync` map and
 *   the mapping row, and only trusts the scalar column for the task's creator.
 *   So when anyone else had pushed a colleague's task with the button, the next
 *   time change found no event for them and POSTed a second one.
 *
 *   GOOGLE PATCH MERGES `start` AND `end`. Giving an all-day event a time sent
 *   `start: { dateTime, timeZone }`, which Google merges into the stored
 *   `start: { date }`, leaving both set. The field being replaced has to be sent
 *   as an explicit null.
 *
 *   A TIME CHANGED IN GOOGLE on a task synced by the real-time path resolved
 *   through `calendar_mappings` (entity type `task`), and the mapped-entity
 *   branch only knew how to write matter and client events, so the change was
 *   logged as unhandled and dropped.
 *
 * `support/googleFetch` replaces `globalThis.fetch` with a router that answers
 * only registered urls and throws on anything else, so an unexpected second
 * create shows up as a recorded (and rejected) call, not a silent success.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  googleCalls,
  wallIsUp,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool, unfreezeClock,
  createFirm,
  ownerOf,
  memberWith,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const googleService = require('../../src/modules/calendar/google/google.service');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');
const { getAdapter } = require('../../src/modules/calendar/shared/calendarAdapters');
const tasksRepo = require('../../src/modules/tasks/tasks.repository');

const GOOGLE_BASE = '/api/google-calendar-sync';
const OUTLOOK_BASE = '/api/outlook-calendar-sync';

const CAL_PATCH = /\/calendars\/primary$/;
const GOOGLE_CREATE = /\/calendars\/primary\/events(?:\?sendUpdates=none)?$/;
const GRAPH_CREATE = /\/v1\.0\/me\/events$/;

/** Newer than any fixture row's `updated_at`, so an inbound edit is not stale. */
const FUTURE = '2030-01-01T00:00:00.000Z';

let firm: Firm;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-08-01T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'] });
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  await drainEvents();
  unfreezeClock();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function connectGoogle(uid: string, opts: { syncToken?: string } = {}) {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, 'refresh-seed')`,
    [uid, `g-${randomUUID().slice(0, 8)}`],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set preferences = $2::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider, sync_cursor)
     values ($1, 'google', true, true, $3)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider, sync_cursor = excluded.sync_cursor`,
    [uid, JSON.stringify({ googleCalendarTarget: 'default' }), opts.syncToken ?? null],
  );
  expect(settings.rowCount).toBe(1);
}

/** The mailbox timezone is seeded so no case has to route the lookup. */
async function connectMicrosoft(uid: string) {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, meta)
     values ($1, 'microsoft', $2, 'ms-refresh-seed', $3::jsonb)`,
    [uid, `ms-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ outlookTimezone: 'America/New_York', outlookMailboxTimezoneWritable: true })],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set timezone = 'America/New_York', updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', true, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid],
  );
  expect(settings.rowCount).toBe(1);
}

/**
 * A standalone task created by `createdBy`. The creator matters: the adapters
 * fall back to the scalar provider-id column only for the creator, which is the
 * gap the bulk-sync cases below fall into. Those cases push as an ASSIGNEE, the
 * one non-creator a task's copy goes to.
 */
async function seedTask(createdBy: string, opts: {
  allDay?: boolean; calendarSync?: object; dueDate?: string; dueAt?: string; endsAt?: string; assignedTo?: string[];
} = {}) {
  const id = randomUUID();
  const dueDate = opts.dueDate ?? '2026-09-10';
  const res = await testPool.query(
    `insert into tasks (id, law_firm_id, title, due_date, due_at, all_day, created_by, calendar_sync, ends_at)
     values ($1, $2, 'File the motion', $7, $3, $4, $5, $6::jsonb, $8)`,
    [id, firm.id, opts.dueAt ?? (opts.allDay ? `${dueDate}T12:00:00Z` : `${dueDate}T16:00:00Z`),
      opts.allDay ?? false, createdBy, JSON.stringify(opts.calendarSync ?? {}), dueDate, opts.endsAt ?? null],
  );
  expect(res.rowCount).toBe(1);
  for (const uid of opts.assignedTo ?? []) {
    const assigned = await testPool.query(
      'insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)', [firm.id, id, uid],
    );
    expect(assigned.rowCount).toBe(1);
  }
  return id;
}

const taskItem = (taskId: string) => ({
  taskId, lawFirmId: firm.id, title: 'File the motion', dueDate: '2026-09-10T16:00:00Z',
});

/** What the TASK_UPDATED listener hands the provider services after a save. */
async function taskAfterSave(taskId: string, changes: Record<string, unknown>) {
  const state = await tasksRepo.getCalendarState(firm.id, taskId);
  expect(state).not.toBeNull();
  return { ...state, ...changes, ...(changes.dueDate !== undefined ? { dueAt: changes.allDay === true ? null : changes.dueDate } : {}) };
}

const mappingsFor = async (entityId: string) => (await testPool.query(
  `select provider, external_event_id, user_id, entity_type, item_key
     from calendar_mappings where entity_id = $1 order by provider, external_event_id`,
  [entityId],
)).rows;

async function googleSyncMember(): Promise<Actor> {
  const actor = await memberWith(firm.id, ['calendar.sync']);
  await connectGoogle(actor.uid);
  return actor;
}

async function outlookSyncMember(): Promise<Actor> {
  const actor = await memberWith(firm.id, ['calendar.sync']);
  await connectMicrosoft(actor.uid);
  return actor;
}

// ── "sync existing" followed by a time change ───────────────────────────────

describe('a task pushed by "sync existing tasks", then given a new time', () => {
  /**
   * Goes red if `syncTasksToGoogle` records its event anywhere other than where
   * the real-time path looks (the per-user map and `calendar_mappings`): the
   * time change below would find no event for this member and POST a second.
   */
  test('Google: the time change patches the pushed event instead of creating a second one', async () => {
    const owner = await ownerOf(firm.id);
    const member = await googleSyncMember();
    const taskId = await seedTask(owner.uid, { assignedTo: [member.uid] });
    expect(wallIsUp()).toBe(true);
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(GOOGLE_CREATE, [
      { status: 200, json: { id: 'g-bulk' } },
      { status: 200, json: { id: 'g-duplicate' } },
    ], { method: 'POST' });
    route('/events/g-bulk', { status: 200, json: { id: 'g-bulk' } }, { method: 'PATCH' });

    const res = await member.api.post(`${GOOGLE_BASE}/sync-tasks-to-google`)
      .send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ taskId, success: true, eventId: 'g-bulk' }]);
    expect(await mappingsFor(taskId)).toEqual([{
      provider: 'google', external_event_id: 'g-bulk', user_id: member.uid,
      entity_type: 'task', item_key: 'dueDate',
    }]);

    const results = await googleService.updateEventsFromEntity(
      getAdapter('task'),
      await taskAfterSave(taskId, { dueDate: new Date('2026-09-10T19:30:00Z') }),
      member.uid,
    );

    expect(results).toEqual([{ key: 'dueDate', action: 'updated', googleEventId: 'g-bulk' }]);
    expect(callsMatching(GOOGLE_CREATE).filter((c) => c.method === 'POST')).toHaveLength(1);
    const patch = callsMatching('/events/g-bulk');
    expect(patch).toHaveLength(1);
    expect(patch[0].body.start.dateTime).toBe('2026-09-10T19:30:00+00:00');
  });

  /**
   * The same contract on Outlook, which additionally claimed the row with a
   * sentinel in the scalar `outlook_id` column while pushing.
   *
   * Goes red if `syncTasksToOutlook` stops writing the mapping and per-user key.
   */
  test('Outlook: the time change patches the pushed event instead of creating a second one', async () => {
    const owner = await ownerOf(firm.id);
    const member = await outlookSyncMember();
    const taskId = await seedTask(owner.uid, { assignedTo: [member.uid] });
    route(GRAPH_CREATE, [
      { status: 200, json: { id: 'AAMk-bulk', changeKey: 'CK-1' } },
      { status: 200, json: { id: 'AAMk-duplicate', changeKey: 'CK-9' } },
    ], { method: 'POST' });
    route('/me/events/AAMk-bulk', { status: 200, json: { id: 'AAMk-bulk', changeKey: 'CK-2' } }, { method: 'PATCH' });

    const res = await member.api.post(`${OUTLOOK_BASE}/sync-tasks-to-outlook`)
      .send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ taskId, success: true, eventId: 'AAMk-bulk' }]);
    expect(await mappingsFor(taskId)).toEqual([{
      provider: 'outlook', external_event_id: 'AAMk-bulk', user_id: member.uid,
      entity_type: 'task', item_key: 'dueDate',
    }]);

    const results = await outlookService.updateEventsFromEntity(
      getAdapter('task'),
      await taskAfterSave(taskId, { dueDate: new Date('2026-09-10T19:30:00Z') }),
      member.uid,
    );

    expect(results).toEqual([{ key: 'dueDate', action: 'updated', outlookId: 'AAMk-bulk' }]);
    expect(callsMatching(GRAPH_CREATE).filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(callsMatching('/me/events/AAMk-bulk').map((c) => c.method)).toEqual(['PATCH']);
  });

  /**
   * Pressing the button twice must not push twice. Goes red if the bulk path's
   * already-synced check stops consulting what the first press recorded.
   */
  test('Google: a second press pushes nothing new', async () => {
    const owner = await ownerOf(firm.id);
    const member = await googleSyncMember();
    const taskId = await seedTask(owner.uid, { assignedTo: [member.uid] });
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(GOOGLE_CREATE, { status: 200, json: { id: 'g-bulk' } }, { method: 'POST' });

    const first = await member.api.post(`${GOOGLE_BASE}/sync-tasks-to-google`)
      .send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });
    expect(first.body).toMatchObject({ syncedCount: 1 });

    const second = await member.api.post(`${GOOGLE_BASE}/sync-tasks-to-google`)
      .send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ syncedCount: 0 });
    expect(callsMatching(GOOGLE_CREATE).filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  /**
   * The bulk push used to build every task as a one-hour timed block, so an
   * all-day task landed at a clock time and every later update tried to turn
   * it back. Goes red if the bulk path stops honouring the task's own all-day
   * flag.
   */
  test('Google: an all-day task is pushed as an all-day event', async () => {
    const owner = await ownerOf(firm.id);
    const member = await googleSyncMember();
    const taskId = await seedTask(owner.uid, { allDay: true, assignedTo: [member.uid] });
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(GOOGLE_CREATE, { status: 200, json: { id: 'g-allday' } }, { method: 'POST' });

    const res = await member.api.post(`${GOOGLE_BASE}/sync-tasks-to-google`)
      .send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });
    expect(res.body).toMatchObject({ syncedCount: 1 });

    const [post] = callsMatching(GOOGLE_CREATE).filter((c) => c.method === 'POST');
    expect(post.body.start).toEqual({ date: '2026-09-10' });
    expect(post.body.end).toEqual({ date: '2026-09-11' });
  });
});

// ── "sync existing" with a task end ─────────────────────────────────────────

describe('a task with an end pushed by "sync existing tasks"', () => {
  /**
   * The bulk push reads the task's schedule from the saved row. Goes red if
   * the end is left out of what it reads: the timed task goes out as the
   * one-hour default block.
   */
  test.each([
    ['Google', googleSyncMember, GOOGLE_BASE, GOOGLE_CREATE, 'sync-tasks-to-google'],
    ['Outlook', outlookSyncMember, OUTLOOK_BASE, GRAPH_CREATE, 'sync-tasks-to-outlook'],
  ] as const)('%s: a timed task is pushed with its saved end', async (_name, member, base, create, path) => {
    const owner = await ownerOf(firm.id);
    const actor = await member();
    const taskId = await seedTask(owner.uid, { endsAt: '2026-09-10T18:30:00Z', assignedTo: [actor.uid] });
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(create, { status: 200, json: { id: 'bulk-span', changeKey: 'ck' } }, { method: 'POST' });

    const res = await actor.api.post(`${base}/${path}`).send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });

    expect(res.body).toMatchObject({ syncedCount: 1 });
    const [post] = callsMatching(create).filter((c) => c.method === 'POST');
    expect(instantOf(post.body.start)).toBe('2026-09-10T16:00:00.000Z');
    expect(instantOf(post.body.end)).toBe('2026-09-10T18:30:00.000Z');
  });

  /**
   * July 30 through August 2, pushed on August 1 (the frozen clock). Goes red
   * if the bulk push judges an all-day task by its first day alone: a span
   * that started two days ago but still has days left is skipped.
   */
  test.each([
    ['Google', googleSyncMember, GOOGLE_BASE, GOOGLE_CREATE, 'sync-tasks-to-google'],
    ['Outlook', outlookSyncMember, OUTLOOK_BASE, GRAPH_CREATE, 'sync-tasks-to-outlook'],
  ] as const)('%s: an all-day span already under way is still pushed, to its last day', async (name, member, base, create, path) => {
    const owner = await ownerOf(firm.id);
    const actor = await member();
    const taskId = await seedTask(owner.uid, { allDay: true, dueDate: '2026-07-30', endsAt: '2026-08-03T12:00:00Z', assignedTo: [actor.uid] });
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(create, { status: 200, json: { id: 'bulk-days', changeKey: 'ck' } }, { method: 'POST' });

    const res = await actor.api.post(`${base}/${path}`).send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });

    expect(res.body).toMatchObject({ syncedCount: 1 });
    const [post] = callsMatching(create).filter((c) => c.method === 'POST');
    if (name === 'Google') {
      expect(post.body.end).toEqual({ date: '2026-08-03' });
    } else {
      expect(post.body.end.dateTime).toBe('2026-08-03T00:00:00');
    }
  });
});

// ── all-day to a set time, and back (Google PATCH) ──────────────────────────

describe('switching a synced Google event between all-day and a set time', () => {
  /**
   * Google merges a PATCHed `start` into the stored one, so the old `date` has
   * to be cleared explicitly. Goes red if the update body stops nulling the
   * field it replaces.
   */
  test('giving an all-day task a time clears the stored date', async () => {
    const user = await ownerOf(firm.id);
    await connectGoogle(user.uid);
    const taskId = await seedTask(user.uid, {
      allDay: true,
      calendarSync: { google: { [user.uid]: { dueDate: { eventId: 'g-task' } } } },
    });
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route('/events/g-task', { status: 200, json: { id: 'g-task' } }, { method: 'PATCH' });

    const results = await googleService.updateEventsFromEntity(
      getAdapter('task'),
      await taskAfterSave(taskId, { allDay: false, dueDate: new Date('2026-09-10T15:00:00Z') }),
      user.uid,
      'UTC',
    );

    expect(results).toEqual([{ key: 'dueDate', action: 'updated', googleEventId: 'g-task' }]);
    const [patch] = callsMatching('/events/g-task');
    expect(patch.body.start).toEqual({ date: null, dateTime: '2026-09-10T15:00:00+00:00', timeZone: 'UTC' });
    expect(patch.body.end).toEqual({ date: null, dateTime: '2026-09-10T16:00:00+00:00', timeZone: 'UTC' });
  });

  /** The reverse direction. Goes red if the all-day body stops nulling `dateTime`. */
  test('making a timed task all-day clears the stored time', async () => {
    const user = await ownerOf(firm.id);
    await connectGoogle(user.uid);
    const taskId = await seedTask(user.uid, {
      calendarSync: { google: { [user.uid]: { dueDate: { eventId: 'g-task' } } } },
    });
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route('/events/g-task', { status: 200, json: { id: 'g-task' } }, { method: 'PATCH' });

    await googleService.updateEventsFromEntity(
      getAdapter('task'),
      await taskAfterSave(taskId, { allDay: true, dueDate: new Date('2026-09-10T12:00:00Z') }),
      user.uid,
      'UTC',
    );

    const [patch] = callsMatching('/events/g-task');
    expect(patch.body.start).toEqual({ date: '2026-09-10', dateTime: null, timeZone: null });
    expect(patch.body.end).toEqual({ date: '2026-09-11', dateTime: null, timeZone: null });
  });
});

// ── a time changed in Google ────────────────────────────────────────────────

describe('a time changed in Google on a task the real-time sync pushed', () => {
  /**
   * The task's event is known only through the per-user map and
   * `calendar_mappings`, which is how every real-time push records it.
   *
   * Goes red if the mapped-entity branch of the inbound engine stops writing
   * tasks: the due time below would stay at 16:00.
   */
  test('moves the task to the new time', async () => {
    const user = await ownerOf(firm.id);
    await connectGoogle(user.uid, { syncToken: 'token-live' });
    const taskId = await seedTask(user.uid, {
      calendarSync: { google: { [user.uid]: { dueDate: { eventId: 'g-task' } } } },
    });
    const mapping = await testPool.query(
      `insert into calendar_mappings
         (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, item_key)
       values ('google', 'g-task', 'primary', $1, $2, 'task', $3, 'dueDate')`,
      [user.uid, firm.id, taskId],
    );
    expect(mapping.rowCount).toBe(1);

    route('syncToken=', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-task',
          summary: 'File the motion',
          status: 'confirmed',
          updated: FUTURE,
          start: { dateTime: '2026-09-10T19:30:00Z', timeZone: 'UTC' },
          end: { dateTime: '2026-09-10T20:30:00Z', timeZone: 'UTC' },
        }],
      },
    });
    // The applied change is cross-synced to Outlook, which this user has not
    // connected; nothing else may be called.
    await googleService.processWatchNotification({ userId: user.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(
      `select due_at, all_day, title from tasks where id = $1`, [taskId],
    );
    expect(rows[0].due_at.toISOString()).toBe('2026-09-10T19:30:00.000Z');
    expect(rows[0].all_day).toBe(false);
    // Nothing was created: the one event is still the only calendar row for it.
    expect((await testPool.query(`select count(*)::int as n from calendar_events where law_firm_id = $1`, [firm.id])).rows[0].n).toBe(0);
    expect(googleCalls().filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

// ── a task made all-day in Google ───────────────────────────────────────────

describe('a synced task made all-day in Google', () => {
  /**
   * An all-day task carries no time: `resolveDue` stores `due_at` null for
   * one, and the task response reads a stored `due_at` as "has a time".
   *
   * Goes red if the inbound write keeps storing the day's noon anchor in
   * `due_at`: the task comes back from the API showing a clock time on a day
   * that has none.
   */
  test('stores no time, and the task reads back as its day only', async () => {
    const user = await ownerOf(firm.id);
    await connectGoogle(user.uid, { syncToken: 'token-live' });
    const taskId = await seedTask(user.uid, {
      calendarSync: { google: { [user.uid]: { dueDate: { eventId: 'g-task' } } } },
    });
    const mapping = await testPool.query(
      `insert into calendar_mappings
         (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, item_key)
       values ('google', 'g-task', 'primary', $1, $2, 'task', $3, 'dueDate')`,
      [user.uid, firm.id, taskId],
    );
    expect(mapping.rowCount).toBe(1);
    route('syncToken=', {
      status: 200,
      json: {
        nextSyncToken: 'token-after',
        items: [{
          id: 'g-task', summary: 'File the motion', status: 'confirmed', updated: FUTURE,
          start: { date: '2026-09-12' }, end: { date: '2026-09-13' },
        }],
      },
    });

    await googleService.processWatchNotification({ userId: user.uid, lawFirmId: firm.id });

    const { rows } = await testPool.query(`select due_date::text, due_at, all_day from tasks where id = $1`, [taskId]);
    expect(rows[0]).toMatchObject({ due_date: '2026-09-12', due_at: null, all_day: true });

    const res = await user.api.get(`/api/lawfirms/${firm.id}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const task = res.body.task || res.body;
    expect(task.dueDateLocalDisplay).toBe('Sep 12, 2026');
  });
});

// ── a timed task saved in Paralegix ─────────────────────────────────────────

describe('a timed task created in Paralegix', () => {
  /**
   * A saved task reaches the calendar listener with `dueDate` as the bare day
   * and the time in `dueAt`. Goes red if the push builds the event from the
   * day alone: a task due at noon Pacific lands at midnight UTC, which is 5pm
   * the day before on the member's calendar.
   */
  test('Google: is pushed at its due time', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(GOOGLE_CREATE, { status: 200, json: { id: 'g-timed' } }, { method: 'POST' });

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .set('x-timezone', 'America/Los_Angeles')
      .send({ title: 'Call opposing counsel', dueDate: '2026-09-28T12:00' });
    expect(res.status).toBe(201);
    await drainEvents();
    await waitForCall(GOOGLE_CREATE);

    const [create] = callsMatching(GOOGLE_CREATE);
    expect(instantOf(create.body.start)).toBe('2026-09-28T19:00:00.000Z');
  });

  /**
   * In the mailbox's own zone (New York, seeded by `connectMicrosoft`), so the
   * push has no mailbox zone to reconcile and only the task's time is tested.
   */
  test('Outlook: is pushed at its due time', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    route(GRAPH_CREATE, { status: 201, json: { id: 'AAMk-timed', changeKey: 'ck' } }, { method: 'POST' });

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .set('x-timezone', 'America/New_York')
      .send({ title: 'Call opposing counsel', dueDate: '2026-09-28T12:00' });
    expect(res.status).toBe(201);
    await drainEvents();
    await waitForCall(GRAPH_CREATE);

    const [create] = callsMatching(GRAPH_CREATE);
    expect(instantOf(create.body.start)).toBe('2026-09-28T16:00:00.000Z');
  });

  /** Goes red if an all-day task stops reaching the calendar as its day. */
  test('Google: an all-day task still lands on its day', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(GOOGLE_CREATE, { status: 200, json: { id: 'g-day' } }, { method: 'POST' });

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .set('x-timezone', 'America/Los_Angeles')
      .send({ title: 'Filing deadline', dueDate: '2026-09-28' });
    expect(res.status).toBe(201);
    await drainEvents();
    await waitForCall(GOOGLE_CREATE);

    const [create] = callsMatching(GOOGLE_CREATE);
    expect(create.body.start).toEqual({ date: '2026-09-28' });
  });
});

// ── a task with an end saved in Paralegix ───────────────────────────────────

describe('a task with an end created in Paralegix', () => {
  /**
   * The task adapter hands the task's own end to the push. Each case goes red
   * if it stops: a timed task falls back to a one-hour block, and an all-day
   * span collapses to its first day.
   */
  test('Google: a timed task is pushed with its own end', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(GOOGLE_CREATE, { status: 200, json: { id: 'g-span' } }, { method: 'POST' });

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .set('x-timezone', 'America/Los_Angeles')
      .send({ title: 'Deposition prep', dueDate: '2026-09-28T12:00', endsAt: '2026-09-28T14:30' });
    expect(res.status).toBe(201);
    await drainEvents();
    await waitForCall(GOOGLE_CREATE);

    const [create] = callsMatching(GOOGLE_CREATE);
    expect(instantOf(create.body.start)).toBe('2026-09-28T19:00:00.000Z');
    expect(instantOf(create.body.end)).toBe('2026-09-28T21:30:00.000Z');
  });

  test('Google: an all-day task over several days is pushed with its exclusive end day', async () => {
    const owner = await ownerOf(firm.id);
    await connectGoogle(owner.uid);
    route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(GOOGLE_CREATE, { status: 200, json: { id: 'g-days' } }, { method: 'POST' });

    // Monday the 28th through Wednesday the 30th.
    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .set('x-timezone', 'America/Los_Angeles')
      .send({ title: 'Trial', dueDate: '2026-09-28', allDay: true, endsAt: '2026-10-01' });
    expect(res.status).toBe(201);
    await drainEvents();
    await waitForCall(GOOGLE_CREATE);

    const [create] = callsMatching(GOOGLE_CREATE);
    expect(create.body.start).toEqual({ date: '2026-09-28' });
    expect(create.body.end).toEqual({ date: '2026-10-01' });
  });

  test('Outlook: a timed task is pushed with its own end', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    route(GRAPH_CREATE, { status: 201, json: { id: 'AAMk-span', changeKey: 'ck' } }, { method: 'POST' });

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .set('x-timezone', 'America/New_York')
      .send({ title: 'Deposition prep', dueDate: '2026-09-28T12:00', endsAt: '2026-09-28T14:30' });
    expect(res.status).toBe(201);
    await drainEvents();
    await waitForCall(GRAPH_CREATE);

    const [create] = callsMatching(GRAPH_CREATE);
    expect(instantOf(create.body.start)).toBe('2026-09-28T16:00:00.000Z');
    expect(instantOf(create.body.end)).toBe('2026-09-28T18:30:00.000Z');
  });

  test('Outlook: an all-day task over several days is pushed with its exclusive end day', async () => {
    const owner = await ownerOf(firm.id);
    await connectMicrosoft(owner.uid);
    route(GRAPH_CREATE, { status: 201, json: { id: 'AAMk-days', changeKey: 'ck' } }, { method: 'POST' });

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`)
      .set('x-timezone', 'America/New_York')
      .send({ title: 'Trial', dueDate: '2026-09-28', allDay: true, endsAt: '2026-10-01' });
    expect(res.status).toBe(201);
    await drainEvents();
    await waitForCall(GRAPH_CREATE);

    const [create] = callsMatching(GRAPH_CREATE);
    expect(create.body.isAllDay).toBe(true);
    expect(create.body.start.dateTime).toBe('2026-09-28T00:00:00');
    expect(create.body.end.dateTime).toBe('2026-10-01T00:00:00');
  });
});

async function waitForCall(pattern: RegExp) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (callsMatching(pattern).some((c) => c.method === 'POST')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for a POST to ${pattern}`);
}

const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Pacific Standard Time': 'America/Los_Angeles',
};

/**
 * The UTC instant a Google or Graph `{ dateTime, timeZone }` pair names. A
 * Google time carries its offset, which settles the instant on its own.
 */
function instantOf(start: { dateTime: string; timeZone?: string }) {
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(start.dateTime)) return new Date(start.dateTime).toISOString();
  const zone = WINDOWS_ZONES[start.timeZone || ''] || start.timeZone || 'UTC';
  const wall = start.dateTime.replace(/\.\d+$/, '');
  const asUtc = new Date(`${wall}Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(asUtc);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const zoned = new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`);
  return new Date(asUtc.getTime() - (zoned.getTime() - asUtc.getTime())).toISOString();
}


describe('explicit task timezone on provider push', () => {
  it.each([
    ['Google', GOOGLE_BASE, GOOGLE_CREATE, 'sync-tasks-to-google'],
    ['Outlook', OUTLOOK_BASE, GRAPH_CREATE, 'sync-tasks-to-outlook'],
  ])('%s retains a newly saved UTC task zone for a non-UTC viewer', async (provider, base, createPattern, action) => {
    const member = provider === 'Google' ? await googleSyncMember() : await outlookSyncMember();
    const taskId = await seedTask(member.uid);
    await testPool.query("update tasks set due_date_timezone = 'UTC', source = 'app' where id = $1", [taskId]);
    if (provider === 'Google') {
      route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    }
    if (provider === 'Outlook') {
      route(/\/me\/mailboxSettings$/, { status: 200, json: {} }, { method: 'PATCH' });
    }
    route(createPattern, { status: 200, json: { id: 'utc-task', changeKey: 'utc-key' } }, { method: 'POST' });

    const res = await member.api.post(`${base}/${action}`)
      .set('x-timezone', 'America/Los_Angeles')
      .send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ taskId, success: true, eventId: 'utc-task' }]);
    const created = callsMatching(createPattern).filter((call) => call.method === 'POST');
    expect(created).toHaveLength(1);
    expect(created[0].body.start.timeZone).toBe('UTC');
    // Google is sent the offset as well as the zone; Graph takes the bare wall clock.
    expect(created[0].body.start.dateTime).toBe(provider === 'Google' ? '2026-09-10T16:00:00+00:00' : '2026-09-10T16:00:00');
  });
});


describe('per-user task provider mappings', () => {
  it.each([
    ['Google', GOOGLE_BASE, GOOGLE_CREATE, 'sync-tasks-to-google', 'google_event_id'],
    ['Outlook', OUTLOOK_BASE, GRAPH_CREATE, 'sync-tasks-to-outlook', 'outlook_id'],
  ])('%s creates a current per-user copy instead of trusting an obsolete scalar id', async (provider, base, createPattern, action, column) => {
    const member = provider === 'Google' ? await googleSyncMember() : await outlookSyncMember();
    const taskId = await seedTask(member.uid);
    await testPool.query(`update tasks set ${column} = 'obsolete-copy' where id = $1`, [taskId]);
    if (provider === 'Google') route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
    route(createPattern, { status: 200, json: { id: 'current-copy', changeKey: 'current-key' } }, { method: 'POST' });

    const res = await member.api.post(`${base}/${action}`)
      .send({ lawFirmId: firm.id, tasks: [taskItem(taskId)] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ taskId, success: true, eventId: 'current-copy' }]);
    expect(callsMatching(createPattern).filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(await mappingsFor(taskId)).toEqual([{
      provider: provider === 'Google' ? 'google' : 'outlook', external_event_id: 'current-copy',
      user_id: member.uid, entity_type: 'task', item_key: 'dueDate',
    }]);
  });
});
