/**
 * "Sync existing" must push exactly what the real-time sync pushes.
 *
 * The bulk buttons (`sync-tasks-to-*`, `sync-events-to-*`) and the per-change
 * sync (a task or event saved through its own route) both create the provider
 * event. When they built it from different inputs, the copy a bulk press made
 * differed from the one the next edit PATCHed, and the bulk press let through
 * members the per-change sync would never push to, so the next edit deleted
 * the copy again.
 *
 * Each case drives the real routes; `support/googleFetch` stands in for both
 * providers (Graph also goes through the global `fetch`).
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  type GoogleCall,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  memberWith,
  createPersonClient,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { describeNetworkWall } from './support/calendarWorld';

const ZONE = 'America/New_York';
const CAL_PATCH = /\/calendars\/primary$/;
const GOOGLE_CREATE = /\/calendars\/primary\/events(?:\?sendUpdates=none)?$/;
const GRAPH_CREATE = /\/v1\.0\/me\/events$/;

type Provider = {
  name: 'Google' | 'Outlook';
  connect: (uid: string) => Promise<void>;
  create: RegExp;
  tasksPath: string;
  eventsPath: string;
  /** The event id path for an update PATCH. */
  eventUrl: (id: string) => string;
};

const PROVIDERS: Provider[] = [
  {
    name: 'Google',
    connect: connectGoogle,
    create: GOOGLE_CREATE,
    tasksPath: '/api/google-calendar-sync/sync-tasks-to-google',
    eventsPath: '/api/google-calendar-sync/sync-events-to-google',
    eventUrl: (id) => `/calendars/primary/events/${id}`,
  },
  {
    name: 'Outlook',
    connect: connectMicrosoft,
    create: GRAPH_CREATE,
    tasksPath: '/api/outlook-calendar-sync/sync-tasks-to-outlook',
    eventsPath: '/api/outlook-calendar-sync/sync-events-to-outlook',
    eventUrl: (id) => `/v1.0/me/events/${id}`,
  },
];

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
  owner = await ownerOf(firm.id);
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => {
  uninstallGoogleFetchWall();
});

describeNetworkWall();

// ── fixtures ───────────────────────────────────────────────────────────────

async function connectGoogle(uid: string) {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, 'refresh-seed')`,
    [uid, `g-${randomUUID().slice(0, 8)}`],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set preferences = $2::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', true, false)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid, JSON.stringify({ googleCalendarTarget: 'default' })],
  );
  expect(settings.rowCount).toBe(1);
}

async function connectMicrosoft(uid: string) {
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, meta)
     values ($1, 'microsoft', $2, 'ms-refresh-seed', $3::jsonb)`,
    [uid, `ms-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ outlookTimezone: ZONE, outlookMailboxTimezoneWritable: true })],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set timezone = $2, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'microsoft', true, false)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid, ZONE],
  );
  expect(settings.rowCount).toBe(1);
}

/** Answer every provider call a create or an update needs, and nothing else. */
function routeProvider(provider: Provider, createdId = 'ext-1') {
  route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
  route(provider.create, { status: 200, json: { id: createdId, changeKey: 'ck-1', etag: '"1"', updated: '2030-01-01T00:00:00Z' } }, { method: 'POST' });
  route(provider.eventUrl(createdId), { status: 200, json: { id: createdId, changeKey: 'ck-2', etag: '"2"', updated: '2030-01-01T00:00:00Z' } }, { method: 'PATCH' });
}

const creates = (provider: Provider): GoogleCall[] => callsMatching(provider.create).filter((c) => c.method === 'POST');
const patchesOf = (provider: Provider, id = 'ext-1'): GoogleCall[] => callsMatching(provider.eventUrl(id)).filter((c) => c.method === 'PATCH');

/** Forget every copy the per-change sync recorded, so a bulk press creates afresh. */
async function forgetCopies(entityId: string) {
  await testPool.query('delete from calendar_mappings where entity_id = $1', [entityId]);
  await testPool.query(`update tasks set calendar_sync = '{}'::jsonb, google_event_id = null, outlook_id = null where id = $1`, [entityId]);
  await testPool.query(`update events set calendar_sync = '{}'::jsonb where id = $1`, [entityId]);
}

async function createMatterWithClient(name = 'Pat Person') {
  const client = await createPersonClient(firm.id, { name, phone: '555-0100' } as any);
  const matter = await owner.api.post(`/api/lawfirms/${firm.id}/matters`).send({
    name: 'Bell v. Ward', clients: [{ clientId: client.id, name }],
  });
  expect(matter.status).toBe(201);
  return { matterId: matter.body.matterId as string, clientId: client.id as string };
}

/** What the settings screen sends for one task (see `handleSyncExistingToGoogle`). */
const taskPayload = (task: any) => ({
  taskId: task.taskId ?? task.id,
  lawFirmId: firm.id,
  title: task.title,
  description: task.description,
  location: task.location ?? null,
  dueDate: task.dueDate,
  dueDateTimeZone: task.dueDateTimeZone ?? null,
});

/** What the settings screen sends for one event (see `buildExistingEventsPayload`). */
const eventPayload = (event: any, parent: { matterId?: string; clientId?: string }) => ({
  eventId: event.id ?? event.eventId,
  ...parent,
  lawFirmId: firm.id,
  title: event.title,
  notes: event.notes ?? null,
  location: event.location ?? null,
  date: event.date,
  type: event.type,
});

// ── 1. the bulk body equals the per-change body ─────────────────────────────

describe.each(PROVIDERS)('$name: a bulk push builds the same event as the per-change push', (provider) => {
  /**
   * The settings screen sends no task id under `id`, no matter and no client
   * list. Goes red if the bulk push builds the event from the request instead
   * of the saved row: the "Open in Paralegix" link and the Client: section
   * drop out of the description, and the location falls back to the request.
   */
  test.each([
    ['a matter task', true],
    ['a standalone task with clients', false],
  ])('%s', async (_label, onMatter) => {
    await provider.connect(owner.uid);
    routeProvider(provider);
    const { matterId, clientId } = await createMatterWithClient();
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).set('x-timezone', ZONE).send({
      title: 'File the motion',
      description: 'Bring the exhibits.',
      location: 'Room 4',
      dueDate: '2030-09-10T16:00:00Z',
      dueDateTimeZone: 'America/Chicago',
      allDay: false,
      ...(onMatter ? { matterId } : { clientIds: [clientId] }),
    });
    expect(created.status).toBe(201);
    const taskId = created.body.taskId;
    await drainEvents();
    const [perChange] = creates(provider);
    expect(perChange).toBeDefined();
    expect(JSON.stringify(perChange.body)).toContain('Pat Person');
    expect(JSON.stringify(perChange.body)).toContain(`/tasks/${taskId}`);

    await forgetCopies(taskId);
    resetGoogleFetch();
    routeProvider(provider);
    const listed = await owner.api.get(`/api/lawfirms/${firm.id}/tasks/${taskId}`).set('x-timezone', ZONE);
    expect(listed.status).toBe(200);
    const bulk = await owner.api.post(provider.tasksPath).set('x-timezone', ZONE)
      .send({ lawFirmId: firm.id, tasks: [{ ...taskPayload(listed.body.task ?? listed.body), location: null }] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.syncedCount).toBe(1);

    const [bulkCreate] = creates(provider);
    expect(bulkCreate.body).toEqual(perChange.body);
  });

  /**
   * A matter event's `locationName` and its own zone, and a client event's
   * court, are on the row only. Goes red if the bulk push reads them from the
   * request.
   */
  test('a matter event with a named location and its own zone', async () => {
    await provider.connect(owner.uid);
    routeProvider(provider);
    const { matterId } = await createMatterWithClient();
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/events`).set('x-timezone', ZONE).send({
      type: 'hearing', title: 'Motion Hearing', allDay: false,
      date: '2030-09-10T15:00:00Z', locationName: 'Courtroom 5B', timeZone: 'America/Chicago',
      notes: 'Bring the binder.',
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;
    await drainEvents();
    const [perChange] = creates(provider);
    expect(perChange).toBeDefined();
    expect(JSON.stringify(perChange.body)).toContain('Courtroom 5B');

    await forgetCopies(eventId);
    resetGoogleFetch();
    routeProvider(provider);
    const bulk = await owner.api.post(provider.eventsPath).set('x-timezone', ZONE).send({
      lawFirmId: firm.id,
      events: [eventPayload({ ...created.body.event, id: eventId }, { matterId })],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.syncedCount).toBe(1);

    const [bulkCreate] = creates(provider);
    expect(bulkCreate.body).toEqual(perChange.body);
  });

  test('a client event held at a court', async () => {
    await provider.connect(owner.uid);
    routeProvider(provider);
    const client = await createPersonClient(firm.id, { name: 'Pat Person' });
    const courtId = randomUUID();
    const court = await testPool.query('insert into courts (id, law_firm_id, name) values ($1, $2, $3)', [courtId, firm.id, 'Cook County Circuit Court']);
    expect(court.rowCount).toBe(1);
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/clients/${client.id}/events`).set('x-timezone', ZONE).send({
      type: 'meeting', title: 'Intake Call', allDay: false, date: '2030-09-10T15:00:00Z', courtId,
    });
    expect(created.status).toBe(201);
    const eventId = created.body.eventId;
    await drainEvents();
    const [perChange] = creates(provider);
    expect(perChange).toBeDefined();
    expect(JSON.stringify(perChange.body)).toContain('Cook County Circuit Court');

    await forgetCopies(eventId);
    resetGoogleFetch();
    routeProvider(provider);
    const bulk = await owner.api.post(provider.eventsPath).set('x-timezone', ZONE).send({
      lawFirmId: firm.id,
      events: [eventPayload({ ...created.body.event, id: eventId, location: null }, { clientId: client.id })],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.syncedCount).toBe(1);

    const [bulkCreate] = creates(provider);
    expect(bulkCreate.body).toEqual(perChange.body);
  });
});

// ── 2. who a bulk press may push to ─────────────────────────────────────────

describe.each(PROVIDERS)('$name: a bulk press pushes only to someone the per-change sync pushes to', (provider) => {
  async function seedTask(createdBy: string, opts: { matterId?: string; assignees?: string[] } = {}) {
    const id = randomUUID();
    const res = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, due_at, all_day, created_by, matter_id)
       values ($1, $2, 'File the motion', '2030-09-10', '2030-09-10T16:00:00Z', false, $3, $4)`,
      [id, firm.id, createdBy, opts.matterId ?? null],
    );
    expect(res.rowCount).toBe(1);
    for (const uid of opts.assignees ?? []) {
      await testPool.query('insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)', [firm.id, id, uid]);
    }
    return id;
  }

  const bulkTask = (actor: Actor, taskId: string) => actor.api.post(provider.tasksPath).set('x-timezone', ZONE).send({
    lawFirmId: firm.id,
    tasks: [{ taskId, lawFirmId: firm.id, title: 'File the motion', dueDate: '2030-09-10T16:00:00Z' }],
  });

  /**
   * With nobody assigned, the per-change sync pushes a task to its creator
   * only. Goes red if the bulk rule still lets anyone through when the
   * assignee list is empty: the colleague's press creates a copy.
   */
  test('an unassigned task is not pushed for a colleague who did not create it', async () => {
    const colleague = await memberWith(firm.id, ['calendar.sync', 'tasks.view']);
    await provider.connect(colleague.uid);
    routeProvider(provider);
    const unassigned = await seedTask(owner.uid);
    const assigned = await seedTask(owner.uid, { assignees: [colleague.uid] });

    const refused = await bulkTask(colleague, unassigned);
    expect(refused.status).toBe(200);
    expect(refused.body.syncedCount).toBe(0);

    // The same press does push a task the colleague is assigned to, so the
    // refusal above is the rule at work and not a push that never ran.
    const allowed = await bulkTask(colleague, assigned);
    expect(allowed.body.syncedCount).toBe(1);
    expect(creates(provider)).toHaveLength(1);
  });

  /** The event rule: the assignees, or the creator when there are none. */
  test('an unassigned matter event is not pushed for a matter colleague who did not create it', async () => {
    const colleague = await memberWith(firm.id, ['calendar.sync', 'matters.view']);
    await provider.connect(colleague.uid);
    routeProvider(provider);
    const { matterId } = await createMatterWithClient();
    await testPool.query('insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)', [firm.id, matterId, colleague.uid]);
    const eventId = randomUUID();
    const seeded = await testPool.query(
      `insert into events (id, law_firm_id, matter_id, type, title, date, created_by)
       values ($1, $2, $3, 'hearing', 'Motion Hearing', '2030-09-10T14:00:00Z', $4)`,
      [eventId, firm.id, matterId, owner.uid],
    );
    expect(seeded.rowCount).toBe(1);
    const press = () => colleague.api.post(provider.eventsPath).set('x-timezone', ZONE).send({
      lawFirmId: firm.id,
      events: [{ eventId, matterId, lawFirmId: firm.id, title: 'Motion Hearing', notes: null, location: null, date: '2030-09-10T14:00:00Z', type: 'hearing' }],
    });

    const refused = await press();
    expect(refused.status).toBe(200);
    expect(refused.body.syncedCount).toBe(0);

    await testPool.query('insert into event_assignees (law_firm_id, event_id, user_id) values ($1, $2, $3)', [firm.id, eventId, colleague.uid]);
    const allowed = await press();
    expect(allowed.body.syncedCount).toBe(1);
    expect(creates(provider)).toHaveLength(1);
  });

  /**
   * A row with no recorded creator has no stable recipient: the per-change
   * fan-out gives it to whoever saved it, so a copy pushed for anyone else is
   * deleted by the next save. Goes red if the bulk press treats the presser as
   * the missing creator.
   */
  test('an unassigned event with no recorded creator is not pushed for the presser', async () => {
    const colleague = await memberWith(firm.id, ['calendar.sync', 'matters.view']);
    await provider.connect(colleague.uid);
    routeProvider(provider);
    const { matterId } = await createMatterWithClient();
    await testPool.query('insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)', [firm.id, matterId, colleague.uid]);
    const eventId = randomUUID();
    const seeded = await testPool.query(
      `insert into events (id, law_firm_id, matter_id, type, title, date)
       values ($1, $2, $3, 'hearing', 'Motion Hearing', '2030-09-10T14:00:00Z')`,
      [eventId, firm.id, matterId],
    );
    expect(seeded.rowCount).toBe(1);
    const press = () => colleague.api.post(provider.eventsPath).set('x-timezone', ZONE).send({
      lawFirmId: firm.id,
      events: [{ eventId, matterId, lawFirmId: firm.id, title: 'Motion Hearing', notes: null, location: null, date: '2030-09-10T14:00:00Z', type: 'hearing' }],
    });

    const refused = await press();
    expect(refused.status).toBe(200);
    expect(refused.body.syncedCount).toBe(0);

    // Recorded as theirs, the same press goes through.
    await testPool.query('update events set created_by = $1 where id = $2', [colleague.uid, eventId]);
    const allowed = await press();
    expect(allowed.body.syncedCount).toBe(1);
    expect(creates(provider)).toHaveLength(1);
  });

  /**
   * The settings screen sends no `matterId` for a task. Goes red if the
   * ethical wall is checked against the request: a member assigned to a task
   * on a matter they are walled off from receives that matter's client roster.
   */
  test('the matter wall is read from the task row, not the request', async () => {
    const walled = await memberWith(firm.id, ['calendar.sync', 'tasks.view']);
    await provider.connect(walled.uid);
    routeProvider(provider);
    const { matterId } = await createMatterWithClient();
    const taskId = await seedTask(owner.uid, { matterId, assignees: [walled.uid] });

    const res = await bulkTask(walled, taskId);

    expect(res.status).toBe(200);
    expect(res.body.syncedCount).toBe(0);
    expect(res.body.results).toEqual([{ taskId, success: false, error: 'Not a member of this matter' }]);
    expect(creates(provider)).toHaveLength(0);

    // Staffed on the matter, the same press goes through.
    await testPool.query('insert into matter_members (law_firm_id, matter_id, user_id) values ($1, $2, $3)', [firm.id, matterId, walled.uid]);
    const allowed = await bulkTask(walled, taskId);
    expect(allowed.body.syncedCount).toBe(1);
  });
});

// ── 3. a task's location on update ─────────────────────────────────────────

describe.each(PROVIDERS)('$name: a task update leaves a provider-owned location alone', (provider) => {
  const locationOf = (body: any) => (provider.name === 'Google' ? body.location : body.location?.displayName);

  async function createSyncedTask(location?: string) {
    await provider.connect(owner.uid);
    routeProvider(provider);
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).set('x-timezone', ZONE).send({
      title: 'File the motion', dueDate: '2030-09-10T16:00:00Z', allDay: false, ...(location ? { location } : {}),
    });
    expect(created.status).toBe(201);
    await drainEvents();
    expect(creates(provider)).toHaveLength(1);
    return created.body.taskId as string;
  }

  const edit = async (taskId: string, body: Record<string, unknown>) => {
    const res = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).set('x-timezone', ZONE).send(body);
    expect(res.status).toBe(200);
    await drainEvents();
  };

  /**
   * The task has no location in Paralegix; the member added a room in the
   * provider. Goes red if the update sends an empty location anyway, which
   * wipes the room.
   */
  test('an edit to a task with no location sends no location', async () => {
    const taskId = await createSyncedTask();
    await edit(taskId, { title: 'File the amended motion' });

    const [patch] = patchesOf(provider);
    expect(patch).toBeDefined();
    expect(patch.body).toHaveProperty(provider.name === 'Google' ? 'summary' : 'subject', 'File the amended motion');
    expect(patch.body).not.toHaveProperty('location');
  });

  /** Clearing it in Paralegix is a change, and is sent. */
  test('clearing the location in Paralegix clears it in the provider', async () => {
    const taskId = await createSyncedTask('Room 4');
    await edit(taskId, { location: null });

    const [patch] = patchesOf(provider);
    expect(patch).toBeDefined();
    expect(locationOf(patch.body)).toBe('');
  });

  /**
   * Two saves inside the coalescing window: the clear, then a title edit. The
   * second save's payload replaces the first, and carries no clear of its own.
   * Goes red if the clear is dropped with the first payload: the room stays on
   * the provider copy.
   */
  test('a clear followed at once by another edit still clears the location', async () => {
    const taskId = await createSyncedTask('Room 4');
    const cleared = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).set('x-timezone', ZONE).send({ location: null });
    expect(cleared.status).toBe(200);
    const retitled = await owner.api.put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).set('x-timezone', ZONE).send({ title: 'File the amended motion' });
    expect(retitled.status).toBe(200);
    await drainEvents();

    const patches = patchesOf(provider);
    expect(patches.length).toBeGreaterThan(0);
    const last = patches[patches.length - 1];
    expect(last.body).toHaveProperty(provider.name === 'Google' ? 'summary' : 'subject', 'File the amended motion');
    expect(locationOf(last.body)).toBe('');
  });

  test('a location set in Paralegix is sent on every edit', async () => {
    const taskId = await createSyncedTask('Room 4');
    await edit(taskId, { title: 'File the amended motion' });

    const [patch] = patchesOf(provider);
    expect(patch).toBeDefined();
    expect(locationOf(patch.body)).toBe('Room 4');
  });
});

// ── 5. a member added to a matter ──────────────────────────────────────────

describe.each(PROVIDERS)('$name: adding a member to a matter backfills what the per-change sync would push them', (provider) => {
  /**
   * The task's creator is joining the matter, and the task has an assignee.
   * The per-change sync pushes a task to its creator AND its assignees. Goes
   * red if the backfill only looks at the assignees when there are any.
   */
  test('a task creator joining the matter gets the task even though it has an assignee', async () => {
    const creator = await memberWith(firm.id, ['calendar.sync', 'tasks.view', 'matters.view']);
    const assignee = await memberWith(firm.id, ['tasks.view']);
    await provider.connect(creator.uid);
    routeProvider(provider);
    const { matterId } = await createMatterWithClient();
    const taskId = randomUUID();
    const seeded = await testPool.query(
      `insert into tasks (id, law_firm_id, title, due_date, due_at, all_day, created_by, matter_id)
       values ($1, $2, 'File the motion', '2030-09-10', '2030-09-10T16:00:00Z', false, $3, $4)`,
      [taskId, firm.id, creator.uid, matterId],
    );
    expect(seeded.rowCount).toBe(1);
    await testPool.query('insert into task_assignees (law_firm_id, task_id, user_id) values ($1, $2, $3)', [firm.id, taskId, assignee.uid]);

    const res = await owner.api.post(`/api/lawfirms/${firm.id}/matters/${matterId}/members`).send({ targetUserIds: [creator.uid] });
    expect(res.status).toBeLessThan(300);
    await drainEvents();

    const [post] = creates(provider);
    expect(post).toBeDefined();
    expect(JSON.stringify(post.body)).toContain(`/tasks/${taskId}`);
    const { rows } = await testPool.query('select user_id from calendar_mappings where entity_id = $1', [taskId]);
    expect(rows).toEqual([{ user_id: creator.uid }]);
  });
});

// ── 4. the repeated hour when clocks go back ────────────────────────────────

describe('Google: a time in the repeated hour', () => {
  /**
   * In Los Angeles on 2026-11-01, 01:30 happens at -07:00 and again at -08:00.
   * Goes red if the push sends a bare wall clock with a zone label, which
   * Google resolves to the FIRST 01:30, an hour early.
   */
  test('is pushed with its offset so Google lands on the second 01:30', async () => {
    await connectGoogle(owner.uid);
    routeProvider(PROVIDERS[0]);
    const created = await owner.api.post(`/api/lawfirms/${firm.id}/tasks`).set('x-timezone', 'America/Los_Angeles').send({
      title: 'Overnight filing', dueDate: '2030-11-03T09:30:00Z', dueDateTimeZone: 'America/Los_Angeles', allDay: false,
    });
    expect(created.status).toBe(201);
    await drainEvents();

    const [post] = creates(PROVIDERS[0]);
    expect(post).toBeDefined();
    // 2030-11-03 is the fall-back night in Los Angeles; 09:30Z is the second 01:30.
    expect(post.body.start).toEqual({ dateTime: '2030-11-03T01:30:00-08:00', timeZone: 'America/Los_Angeles' });
    expect(post.body.end).toEqual({ dateTime: '2030-11-03T02:30:00-08:00', timeZone: 'America/Los_Angeles' });
    expect(new Date(post.body.start.dateTime).toISOString()).toBe('2030-11-03T09:30:00.000Z');
  });
});
