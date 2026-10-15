/**
 * How many pool connections one calendar backfill or one matter-member fan-out
 * holds at once.
 *
 * Every outbound sync unit (one entity for one user) runs inside
 * `withLock('CALENDAR_SYNC', ...)`, a lease row that borrows a connection only
 * for its acquire and release statements, not across the Google and Outlook HTTP
 * calls. The unit's own token, mapping and writeback queries take a connection
 * as they run, and a 401 inside the unit takes an `OAUTH_REFRESH` lease the same
 * way. The pool is small (12 in production, 10 here), so the number of units in
 * flight is what decides whether a backfill leaves any connections for live
 * requests.
 *
 * Only the provider HTTP calls are faked (the fetch wall in
 * `support/googleFetch.ts`). Each is delayed so the units genuinely overlap while
 * their lock connections are held; without the delay a unit finishes before the
 * next one starts and the peak would say nothing about the width.
 *
 * The peak is read from the app pool's own `acquire`/`release` events, so held
 * lock connections and plain queries are counted alike.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  wallIsUp,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  drainEvents,
  type Firm,
} from '../support/setupInProcess';
import { seedMatterEvent } from './support/calendarWorld';

// Loaded after the harness, which points DATABASE_URL at this worker's test
// database: `db.ts` reads the URL when it is first imported.
const { pool } = require('../../src/shared/database/db');
const eventBus = require('../../src/shared/events/eventBus');
require('../../src/modules/calendar/calendar.events');

const { MATTER_EVENT_CREATED, MATTER_MEMBERS_UPDATED } = require('../../src/shared/events/eventTypes');

/** The ceiling on connections one backfill or one fan-out may hold at once. */
const MAX_CALENDAR_SYNC_CONNECTIONS = 6;

/** Long enough that every in-flight unit is still holding its lock when the next starts. */
const PROVIDER_LATENCY_MS = 200;

const EVENTS_URL = '/calendars/primary/events';
const TOKEN_URL = 'oauth2.googleapis.com/token';

// Wrap the wall rather than replace it: unrouted urls still throw, and every
// call is still recorded. Only the answer arrives later.
const walledFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  await new Promise((resolve) => setTimeout(resolve, PROVIDER_LATENCY_MS));
  return walledFetch(input, init);
}) as typeof globalThis.fetch;

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm();
  await drainEvents();
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => {
  globalThis.fetch = walledFetch;
  uninstallGoogleFetchWall();
});

// ── fixtures (plain SQL) ────────────────────────────────────────────────────

async function connectGoogle(lawFirmId: string, accessToken: string): Promise<string> {
  const { uid } = await createFirmMember(lawFirmId, { permissions: ['calendar.sync', 'matters.view', 'tasks.view'] });
  const tokens = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', $2, $3, true, true)`,
    [uid, accessToken, `refresh-${uid}`],
  );
  expect(tokens.rowCount).toBe(1);
  return uid;
}

async function seedMatter(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id) values ($1, $2, 'Bell v. Ward', $3)`,
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

async function seedMatterTask(lawFirmId: string, matterId: string, title: string): Promise<string> {
  const id = randomUUID();
  const res = await testPool.query(
    `insert into tasks (id, law_firm_id, title, due_date, matter_id, calendar_sync)
     values ($1, $2, $3, '2026-09-20', $4, '{}'::jsonb)`,
    [id, lawFirmId, title, matterId],
  );
  expect(res.rowCount).toBe(1);
  return id;
}

async function matterEventPayload(lawFirmId: string, matterId: string, eventId: string) {
  const { rows } = await testPool.query(
    `select id, title, type, date, calendar_sync from events where id = $1`, [eventId],
  );
  expect(rows).toHaveLength(1);
  return {
    id: rows[0].id,
    lawFirmId,
    matterId,
    title: rows[0].title,
    type: rows[0].type,
    date: rows[0].date,
    calendarSync: rows[0].calendar_sync,
  };
}

const mappingCount = async () => (await testPool.query(
  `select count(*)::int as n from calendar_mappings where law_firm_id = $1`, [firm.id],
)).rows[0].n;

// ── measurement ─────────────────────────────────────────────────────────────

async function peakConnectionsDuring(work: () => Promise<unknown>) {
  let active = 0;
  let peak = 0;
  const onAcquire = () => { active += 1; peak = Math.max(peak, active); };
  const onRelease = () => { active -= 1; };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  try {
    await work();
    return peak;
  } finally {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
  }
}

async function emitAndDrain(eventType: string, payload: Record<string, unknown>) {
  eventBus.emit(eventType, payload);
  await drainEvents();
}

// ── specs ───────────────────────────────────────────────────────────────────

describe('calendar sync connection use', () => {
  /**
   * Nine sync units (three added members, each owed two hearings and a task).
   *
   * Goes red if the backfill width rises back toward the pool size: at a width of
   * 8, eight units hold a lock connection at once while the delayed provider
   * call is outstanding, and their own queries push the peak past the ceiling.
   * Goes red on the other side if the backfill stops creating every item, or if
   * the listener no longer sees the pool (a peak under 2).
   */
  test('a matter-member backfill stays inside the connection ceiling and still creates every item', async () => {
    const matterId = await seedMatter(firm.id);
    const users: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const uid = await connectGoogle(firm.id, `tok-backfill-${i}`); // eslint-disable-line no-await-in-loop
      await addMatterMember(firm.id, matterId, uid); // eslint-disable-line no-await-in-loop
      users.push(uid);
    }
    const events = [await seedMatterEvent(firm.id, matterId, 'Preliminary hearing'), await seedMatterEvent(firm.id, matterId, 'Status conference')];
    const task = await seedMatterTask(firm.id, matterId, 'File the motion');
    for (const uid of users) {
      for (const eventId of events) await testPool.query('insert into event_assignees (law_firm_id,event_id,user_id) values ($1,$2,$3)', [firm.id,eventId,uid]);
      await testPool.query('insert into task_assignees (law_firm_id,task_id,user_id) values ($1,$2,$3)', [firm.id,task,uid]);
    }

    expect(wallIsUp()).toBe(true);
    route(EVENTS_URL, (_call, hit) => ({ status: 200, json: { id: `g-backfill-${hit}` } }), { method: 'POST' });

    const peak = await peakConnectionsDuring(() => emitAndDrain(MATTER_MEMBERS_UPDATED, {
      lawFirmId: firm.id,
      matterId,
      memberUserIds: users,
      addedUserIds: users,
      actorUserId: users[0],
    }));

    const created = callsMatching(EVENTS_URL).filter((c) => c.method === 'POST');
    expect(created).toHaveLength(9);
    expect(new Set(created.map((c) => c.bearer))).toEqual(new Set(users.map((_, i) => `tok-backfill-${i}`)));
    expect(await mappingCount()).toBe(9);

    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(MAX_CALENDAR_SYNC_CONNECTIONS);
  }, 60_000);

  /**
   * Five matter members whose access tokens have expired, so every unit also
   * takes the OAUTH_REFRESH lock while it refreshes: the most connections one
   * unit can hold.
   *
   * Goes red if the fan-out width rises back to 4: four units each holding a
   * CALENDAR_SYNC and an OAUTH_REFRESH connection through the delayed token call
   * is eight. Goes red on the other side if a member's refresh or retried create
   * is lost.
   */
  test('a fan-out to every matter member stays inside the ceiling while refreshing tokens', async () => {
    const matterId = await seedMatter(firm.id);
    const users: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const uid = await connectGoogle(firm.id, `stale-${i}`); // eslint-disable-line no-await-in-loop
      await addMatterMember(firm.id, matterId, uid); // eslint-disable-line no-await-in-loop
      users.push(uid);
    }
    const eventId = await seedMatterEvent(firm.id, matterId, 'Preliminary hearing');
    // A matter event is copied to its assignees, so every member is assigned,
    // in the table and in the payload the service emits.
    for (const uid of users) {
      await testPool.query('insert into event_assignees (law_firm_id,event_id,user_id) values ($1,$2,$3)', [firm.id, eventId, uid]); // eslint-disable-line no-await-in-loop
    }

    route(EVENTS_URL, (call, hit) => (String(call.bearer).startsWith('stale-')
      ? { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } }
      : { status: 200, json: { id: `g-fanout-${hit}` } }), { method: 'POST' });
    route(TOKEN_URL, (_call, hit) => ({ status: 200, json: { access_token: `fresh-${hit}`, expires_in: 3599 } }));

    const peak = await peakConnectionsDuring(async () => emitAndDrain(MATTER_EVENT_CREATED, {
      lawFirmId: firm.id,
      matterId,
      eventId,
      eventData: { ...await matterEventPayload(firm.id, matterId, eventId), assignedTo: users },
      userId: users[0],
    }));

    expect(callsMatching(TOKEN_URL)).toHaveLength(5);
    const retried = callsMatching(EVENTS_URL)
      .filter((c) => c.method === 'POST' && String(c.bearer).startsWith('fresh-'));
    expect(retried).toHaveLength(5);
    expect(await mappingCount()).toBe(5);

    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(MAX_CALENDAR_SYNC_CONNECTIONS);
  }, 60_000);
});
