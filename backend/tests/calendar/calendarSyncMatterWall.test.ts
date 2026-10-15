/**
 * The ethical wall on the batch calendar-sync routes.
 *
 * `googleSyncRoutes.test.ts` / `outlookSyncRoutes.test.ts` cover the per-route
 * gates, and `syncFirmGuard` is proven there to re-check the FIRM of every item
 * in a mixed batch. This file covers the question those gates never asked: is the
 * caller allowed to read the MATTER the item names.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. The body pushed to the provider is not
 * copied from the request. `calendarDescriptionBuilder` enriches it from the
 * database: for any item carrying a `matterId` it resolves that matter's clients
 * out of `matter_clients` and writes their NAMES AND PHONE NUMBERS into the event
 * description. So a firm member holding `calendar.sync` could name a matter they
 * were never staffed on and receive its client roster on their personal calendar.
 * Nothing else in the request has to be genuine: the item's title and date are
 * the caller's own text.
 *
 * Every refusal case below is paired with a permitted caller on the SAME route
 * with the SAME fixtures, and the permitted half asserts the client name really
 * does reach the provider. A refusal that passes because the fixture was empty
 * would prove nothing.
 *
 * The recipient is decided by the wall, not by the network: `support/googleFetch`
 * replaces `globalThis.fetch` with a router that answers only registered urls and
 * THROWS on anything else, so an item that slips past the wall shows up here as a
 * recorded outbound call rather than as a silent success.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  wallIsUp,
} from './support/googleFetch';

// Before `setupInProcess` pulls in the app graph, so nothing can reach the
// network on the way in.
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
import { seedMatterEvent } from './support/calendarWorld';

const GOOGLE_BASE = '/api/google-calendar-sync';
const OUTLOOK_BASE = '/api/outlook-calendar-sync';

const CAL_PATCH = /\/calendars\/primary$/;
const EVENTS_CREATE = /\/calendars\/primary\/events(?:\?sendUpdates=none)?$/;
const GRAPH_EVENTS = /\/v1\.0\/me\/events$/;

let firm: Firm;

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function connectGoogle(uid: string) {
  const accessToken = `g-${randomUUID().slice(0, 8)}`;
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token)
     values ($1, 'google', $2, 'refresh-seed')`,
    [uid, accessToken],
  );
  expect(tokens.rowCount).toBe(1);
  const settings = await testPool.query(
    `with touched as (update users set preferences = $2::jsonb, updated_at = now() where id = $1)
     insert into user_oauth_tokens (user_id, provider, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', true, true)
     on conflict (user_id, provider) do update set is_sync_to_provider = excluded.is_sync_to_provider, is_sync_from_provider = excluded.is_sync_from_provider`,
    [uid, JSON.stringify({ googleCalendarTarget: 'default' })],
  );
  expect(settings.rowCount).toBe(1);
  return accessToken;
}

/** The mailbox timezone is seeded so no case has to route the lookup + PATCH. */
async function connectMicrosoft(uid: string) {
  const accessToken = `ms-${randomUUID().slice(0, 8)}`;
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, meta)
     values ($1, 'microsoft', $2, 'ms-refresh-seed', $3::jsonb)`,
    [uid, accessToken, JSON.stringify({ outlookTimezone: 'America/New_York', outlookMailboxTimezoneWritable: true })],
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
  return accessToken;
}

async function googleOwner(lawFirmId: string): Promise<Actor> {
  const actor = await ownerOf(lawFirmId);
  await connectGoogle(actor.uid);
  return actor;
}

/** A plain member: `calendar.sync` and nothing that widens matter visibility. */
async function googleSyncMember(lawFirmId: string): Promise<Actor> {
  const actor = await memberWith(lawFirmId, ['calendar.sync']);
  await connectGoogle(actor.uid);
  return actor;
}

async function outlookSyncMember(lawFirmId: string): Promise<Actor> {
  const actor = await memberWith(lawFirmId, ['calendar.sync']);
  await connectMicrosoft(actor.uid);
  return actor;
}

async function seedMatter(lawFirmId: string) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id)
     values ($1, $2, 'Bell v. Ward', $3)`,
    [id, lawFirmId, `M-${id.slice(0, 8)}`],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function addMatterMember(lawFirmId: string, matterId: string, userId: string) {
  const res = await testPool.query(
    `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
     values ($1, $2, $3, 'member', now())`,
    [matterId, userId, lawFirmId],
  );
  expect(res.rowCount).toBe(1);
}

/**
 * A client on the matter, with a phone number. This is the confidential payload:
 * `buildMatterEventCalendarDescription` puts "Client: <name> - <phone>" at the
 * top of every event description it builds for the matter.
 */
async function seedMatterClient(lawFirmId: string, matterId: string, name: string, phone: string) {
  const clientId = randomUUID();
  const client = await testPool.query(
    `insert into clients (id, law_firm_id, name, client_type, phone)
     values ($1, $2, $3, 'person', $4)`,
    [clientId, lawFirmId, name, phone],
  );
  expect(client.rowCount).toBe(1);
  const link = await testPool.query(
    `insert into matter_clients (matter_id, client_id, law_firm_id) values ($1, $2, $3)`,
    [matterId, clientId, lawFirmId],
  );
  expect(link.rowCount).toBe(1);
  return clientId;
}

/** `createdBy` is who a "sync existing" press may push the unassigned task to. */
async function seedTask(lawFirmId: string, matterId: string | null, createdBy: string | null = null) {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into tasks (id, law_firm_id, title, due_date, due_at, matter_id, created_by)
     values ($1, $2, 'File the motion', '2026-09-10', '2026-09-10T16:00:00Z', $3, $4)`,
    [id, lawFirmId, matterId, createdBy],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

const eventItem = (lawFirmId: string, matterId: string, eventId: string) => ({
  eventId, matterId, lawFirmId, title: 'Preliminary hearing', date: '2026-09-10T14:00:00Z', type: 'hearing',
});

const taskItem = (lawFirmId: string, taskId: string, matterId: string | null) => ({
  taskId, lawFirmId, matterId, title: 'File the motion', dueDate: '2026-09-10T16:00:00Z',
});

const mappingCount = async () => (await testPool.query(
  `select count(*)::int as n from calendar_mappings`,
)).rows[0].n;

function routeGooglePush(id = 'g-pushed') {
  route(CAL_PATCH, { status: 200, json: { id: 'primary' } }, { method: 'PATCH' });
  route(EVENTS_CREATE, { status: 200, json: { id } }, { method: 'POST' });
}

const googlePushes = () => callsMatching(EVENTS_CREATE).filter((c) => c.method === 'POST');
const graphPushes = () => callsMatching(GRAPH_EVENTS).filter((c) => c.method === 'POST');

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

// ── matter events ───────────────────────────────────────────────────────────

describe('POST /sync-events-to-google', () => {
  /**
   * THE CASE THE WALL EXISTS FOR, and the proof the wall is reachable at all.
   *
   * Both halves are the same request from the same member against the same
   * matter; the only difference is the `matter_members` row. The permitted half
   * shows the client's name and phone reaching Google, which is exactly what the
   * refused half withheld.
   *
   * Goes red if the matter check is dropped from `syncEventsToGoogle`: the first
   * half would push, and the recorded call would carry the client roster.
   */
  test('refuses a matter the caller is not on, and pushes the same matter once they are', async () => {
    const outsider = await googleSyncMember(firm.id);
    const matterId = await seedMatter(firm.id);
    await seedMatterClient(firm.id, matterId, 'Dana Whitfield', '555-0142');
    const eventId = await seedMatterEvent(firm.id, matterId, undefined, undefined, outsider.uid);
    expect(wallIsUp()).toBe(true);
    routeGooglePush();

    const body = { events: [eventItem(firm.id, matterId, eventId)] };

    const refused = await outsider.api.post(`${GOOGLE_BASE}/sync-events-to-google`).send(body);
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ syncedCount: 0 });
    expect(refused.body.results).toEqual([
      { eventId, success: false, error: 'Not a member of this matter' },
    ]);
    // The only call before the item loop is the calendar-timezone PATCH the
    // service makes to resolve the target calendar; no event body went out.
    expect(googlePushes()).toHaveLength(0);
    expect(await mappingCount()).toBe(0);

    // Same caller, same request, now staffed on the matter.
    await addMatterMember(firm.id, matterId, outsider.uid);
    const allowed = await outsider.api.post(`${GOOGLE_BASE}/sync-events-to-google`).send(body);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ syncedCount: 1 });

    const pushed = googlePushes();
    expect(pushed).toHaveLength(1);
    // What the refusal was protecting: the matter's client contact details.
    expect(pushed[0].body.description).toContain('Dana Whitfield');
    expect(pushed[0].body.description).toContain('555-0142');
    expect(await mappingCount()).toBe(1);
  });

  /**
   * Owners and firm admins read every matter in the firm (`isFirmOwnerOrAdmin`,
   * and `visibleMatterIds` in dashboard.service answers ALL_MATTERS for them), so
   * the wall must widen for them rather than refuse a matter they can open in the
   * app.
   *
   * Goes red if the gate is switched to `assertMatterMembership`: the owner would
   * be refused a matter of their own firm.
   */
  test('an owner may push a matter they are not personally staffed on', async () => {
    const owner = await googleOwner(firm.id);
    const matterId = await seedMatter(firm.id);
    const eventId = await seedMatterEvent(firm.id, matterId, undefined, undefined, owner.uid);
    routeGooglePush();

    const res = await owner.api.post(`${GOOGLE_BASE}/sync-events-to-google`)
      .send({ events: [eventItem(firm.id, matterId, eventId)] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ syncedCount: 1 });
    expect(googlePushes()).toHaveLength(1);
  });

  /**
   * Widening WHO may read is not the same as skipping WHETHER the matter exists.
   * A matter id that names nothing in this firm, including one that is real in
   * ANOTHER firm, is refused for an owner too.
   *
   * Goes red if the owner/admin branch stops confirming the matter belongs to the
   * firm, which would let a privileged caller push a fabricated matter id and,
   * with it, whatever `matter_clients` that id resolves to.
   */
  test('refuses a matter id that does not belong to the firm, even for an owner', async () => {
    const neighbour = await createFirm();
    const owner = await googleOwner(firm.id);
    const foreignMatterId = await seedMatter(neighbour.id);
    const eventId = randomUUID();
    routeGooglePush();

    const unknown = await owner.api.post(`${GOOGLE_BASE}/sync-events-to-google`)
      .send({ events: [eventItem(firm.id, randomUUID(), eventId)] });
    expect(unknown.body.results).toEqual([
      { eventId, success: false, error: 'Not a member of this matter' },
    ]);

    const foreign = await owner.api.post(`${GOOGLE_BASE}/sync-events-to-google`)
      .send({ events: [eventItem(firm.id, foreignMatterId, eventId)] });
    expect(foreign.body.results).toEqual([
      { eventId, success: false, error: 'Not a member of this matter' },
    ]);

    expect(googlePushes()).toHaveLength(0);
    expect(await mappingCount()).toBe(0);
  });

  /**
   * A mixed batch: the wall is applied per item, not per request. Goes red if a
   * single readable matter in the array authorizes the rest of it.
   */
  test('pushes only the items whose matter the caller may read', async () => {
    const member = await googleSyncMember(firm.id);
    const mine = await seedMatter(firm.id);
    const theirs = await seedMatter(firm.id);
    await addMatterMember(firm.id, mine, member.uid);
    await seedMatterClient(firm.id, theirs, 'Hidden Client', '555-0199');
    const mineEvent = await seedMatterEvent(firm.id, mine, undefined, undefined, member.uid);
    const theirsEvent = await seedMatterEvent(firm.id, theirs, undefined, undefined, member.uid);
    routeGooglePush();

    const res = await member.api.post(`${GOOGLE_BASE}/sync-events-to-google`).send({
      events: [eventItem(firm.id, mine, mineEvent), eventItem(firm.id, theirs, theirsEvent)],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { eventId: mineEvent, success: true, googleEventId: 'g-pushed' },
      { eventId: theirsEvent, success: false, error: 'Not a member of this matter' },
    ]);
    const pushed = googlePushes();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].body.description).not.toContain('Hidden Client');
  });
});

// ── tasks ───────────────────────────────────────────────────────────────────

describe('POST /sync-tasks-to-google', () => {
  /**
   * A task's description is enriched the same way when it names a matter, and the
   * `matterId` on a task item is entirely the caller's to write, so this path
   * leaks the roster of any matter id the caller cares to type.
   *
   * The standalone task in the same batch is the control: it has no matter, so it
   * is not matter-scoped and still pushes. Without it, "one push" would also be
   * what a gate that refused everything produces.
   *
   * Goes red if the matter check is dropped from `syncTasksToGoogle`.
   */
  test('refuses a task naming a matter the caller is not on, and still pushes a matterless one', async () => {
    const member = await googleSyncMember(firm.id);
    const matterId = await seedMatter(firm.id);
    await seedMatterClient(firm.id, matterId, 'Dana Whitfield', '555-0142');
    const matterTask = await seedTask(firm.id, matterId, member.uid);
    const looseTask = await seedTask(firm.id, null, member.uid);
    routeGooglePush('g-task');

    const res = await member.api.post(`${GOOGLE_BASE}/sync-tasks-to-google`).send({
      lawFirmId: firm.id,
      tasks: [taskItem(firm.id, matterTask, matterId), taskItem(firm.id, looseTask, null)],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { taskId: matterTask, success: false, error: 'Not a member of this matter' },
      { taskId: looseTask, success: true, eventId: 'g-task' },
    ]);

    const pushed = googlePushes();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].body.description).not.toContain('Dana Whitfield');

    // The refused task keeps no provider id, so nothing points at an event that
    // was never created.
    const { rows } = await testPool.query(
      `select google_event_id from tasks where id = $1`, [matterTask],
    );
    expect(rows[0].google_event_id).toBeNull();
  });
});

// ── outlook ─────────────────────────────────────────────────────────────────

describe('POST /sync-events-to-outlook', () => {
  /**
   * The same wall on the other provider. Outlook is not a copy of the Google
   * path: it claims each item with a sentinel before pushing, so it needs its
   * own case rather than an assumption of symmetry.
   *
   * Goes red if the matter check is dropped from `syncEventsToOutlook`.
   */
  test('refuses a matter the caller is not on, and pushes the same matter once they are', async () => {
    const outsider = await outlookSyncMember(firm.id);
    const matterId = await seedMatter(firm.id);
    await seedMatterClient(firm.id, matterId, 'Dana Whitfield', '555-0142');
    const eventId = await seedMatterEvent(firm.id, matterId, undefined, undefined, outsider.uid);
    route(GRAPH_EVENTS, { status: 200, json: { id: 'AAMkA-pushed', changeKey: 'CK-1' } }, { method: 'POST' });

    const body = { events: [eventItem(firm.id, matterId, eventId)] };

    const refused = await outsider.api.post(`${OUTLOOK_BASE}/sync-events-to-outlook`).send(body);
    expect(refused.status).toBe(200);
    expect(refused.body.results).toEqual([
      { eventId, success: false, error: 'Not a member of this matter' },
    ]);
    expect(graphPushes()).toHaveLength(0);
    expect(await mappingCount()).toBe(0);

    await addMatterMember(firm.id, matterId, outsider.uid);
    const allowed = await outsider.api.post(`${OUTLOOK_BASE}/sync-events-to-outlook`).send(body);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ syncedCount: 1 });

    const pushed = graphPushes();
    expect(pushed).toHaveLength(1);
    expect(pushed[0].body.body.content).toContain('Dana Whitfield');
    expect(await mappingCount()).toBe(1);
  });
});
