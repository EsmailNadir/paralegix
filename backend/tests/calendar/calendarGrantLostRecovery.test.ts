/**
 * Calendar work owed while a member's grant is unusable, and what happens when
 * they reconnect.
 *
 * A grant recorded as `reconnect_required` keeps its tokens on the row, but
 * nothing can be written with them until the member reconnects. An edit or a
 * delete made in Paralegix during that outage is still owed to the copy on
 * their calendar: it has to be queued, wait without spending its retry budget,
 * and run once the reconnect callback stores a working grant. Otherwise the
 * provider event is orphaned for good, still showing the old title, or still
 * showing a task that no longer exists.
 *
 * Every provider request is asserted at the network wall
 * (`support/googleFetch.ts`); the reconnect goes through the real
 * `/api/auth/connect-google` and `/api/auth/google-callback` routes.
 */
import {
  installGoogleFetchWall, uninstallGoogleFetchWall, resetGoogleFetch, route, callsMatching, googleCalls,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import { as, createFirm, createFirmMember, drainEvents, request, testPool, tokenFor, type Firm } from '../support/setupInProcess';
import { describeNetworkWall } from './support/calendarWorld';

const outbound = require('../../src/modules/calendar/shared/calendarOutboundRetry');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_FULL_SCOPE = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email openid';
const ENV_KEYS = ['FRONTEND_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
const savedEnv: Record<string, string | undefined> = {};

let firm: Firm;

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.FRONTEND_URL = 'https://app.paralegix.test';
  process.env.GOOGLE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
  delete process.env.GOOGLE_REDIRECT_URI;
  resetGoogleFetch();
  firm = await createFirm();
});

afterEach(async () => {
  await drainEvents();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(uninstallGoogleFetchWall);

describeNetworkWall();

/**
 * The firm owner, connected to Google with outbound sync on and inbound off
 * (so the reconnect callback does not also arm a watch channel), whose refresh
 * was refused. The account id is recorded so a reconnect to the same account
 * keeps the row.
 */
async function lostGrantOwner() {
  const { uid } = await createFirmMember(firm.id, { isOwner: true });
  const res = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, scope, meta, is_sync_to_provider, is_sync_from_provider)
     values ($1, 'google', 'old-access', 'old-refresh', $2, $3::jsonb, true, false)`,
    [uid, GOOGLE_FULL_SCOPE, JSON.stringify({ accountId: 'g-sub', accountEmail: 'person@gmail.com', grantState: 'reconnect_required' })],
  );
  expect(res.rowCount).toBe(1);
  return uid;
}

/** A task the owner created, already copied to their calendar as `g-lost`. */
async function syncedTask(uid: string) {
  const taskId = randomUUID();
  const task = await testPool.query(
    `insert into tasks (id, law_firm_id, title, status, due_date, created_by)
     values ($1, $2, 'File the motion', 'open', '2030-11-10', $3)`,
    [taskId, firm.id, uid],
  );
  expect(task.rowCount).toBe(1);
  const mapping = await testPool.query(
    `insert into calendar_mappings (provider, external_event_id, calendar_id, user_id, law_firm_id, entity_type, entity_id, item_key)
     values ('google', 'g-lost', 'primary', $1, $2, 'task', $3, 'dueDate')`,
    [uid, firm.id, taskId],
  );
  expect(mapping.rowCount).toBe(1);
  return taskId;
}

const outboundRows = async (uid: string) => (await testPool.query(
  `select dedupe_key, attempts, next_attempt_at, payload from calendar_sync_failures
    where kind = 'outbound' and user_id = $1 order by dedupe_key`,
  [uid],
)).rows;

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** Reconnect the same Google account through the real connect and callback routes. */
async function reconnect(uid: string) {
  const start = await as(tokenFor({ uid })).post('/api/auth/connect-google').send({});
  expect(start.status).toBe(200);
  const state = new URL(start.body.authUrl).searchParams.get('state');
  const cookie = String(([] as string[]).concat(start.header['set-cookie'] || []).find((c) => c.startsWith('plx_oauth_state=')) || '').split(';')[0];
  route(GOOGLE_TOKEN_URL, { json: {
    access_token: 'new-access', refresh_token: 'new-refresh', scope: GOOGLE_FULL_SCOPE,
    id_token: jwt({ sub: 'g-sub', email: 'person@gmail.com' }),
  } });
  const res = await request().get(`/api/auth/google-callback?code=c&state=${state}`).set('Cookie', cookie);
  expect(res.header.location).toMatch(/google_connected=true/);
  const grant = await testPool.query(`select meta->>'grantState' as grant_state from user_oauth_tokens where user_id = $1 and provider = 'google'`, [uid]);
  expect(grant.rows[0].grant_state).toBeNull();
}

/** Wait for a fire-and-forget provider request, bounded so a miss fails rather than hangs. */
async function waitForCall(fragment: string, method: string) {
  const deadline = Date.now() + 10_000;
  const matching = () => callsMatching(fragment).filter((call) => call.method === method);
  while (Date.now() < deadline) {
    if (matching().length) return matching();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no ${method} request matching ${fragment} was made`);
}

describe('an edit or delete made while the grant needs a reconnect', () => {
  /**
   * Goes red if the delete fan-out decides "connected" from the tokens
   * `loadUserData` hands out: those are withheld while the grant is lost, so no
   * work is queued and the copy on the calendar is never removed.
   */
  test('a deleted task is removed from the calendar once the member reconnects', async () => {
    const uid = await lostGrantOwner();
    const taskId = await syncedTask(uid);

    const res = await as(tokenFor({ uid })).delete(`/api/lawfirms/${firm.id}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    await drainEvents();

    const parked = await outboundRows(uid);
    expect(parked.map((row) => [row.payload.action, row.attempts])).toEqual([['deleteEventsFromEntity', 0]]);
    expect(googleCalls()).toHaveLength(0);

    route(/\/events\/g-lost/, { status: 204 }, { method: 'DELETE' });
    await reconnect(uid);

    const deletes = await waitForCall('/events/g-lost', 'DELETE');
    expect(deletes.map((call) => call.bearer)).toEqual(['new-access']);
    await drainEvents();
    expect((await testPool.query('select 1 from calendar_mappings where user_id = $1', [uid])).rowCount).toBe(0);
  });

  /**
   * Goes red if the update fan-out keeps using the pre-check that requires a
   * usable grant: the member is skipped, nothing is queued, and their calendar
   * keeps the old title after they reconnect.
   */
  test('an edited task reaches the calendar once the member reconnects', async () => {
    const uid = await lostGrantOwner();
    const taskId = await syncedTask(uid);

    const res = await as(tokenFor({ uid })).put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).send({ title: 'File the amended motion' });
    expect(res.status).toBe(200);
    await drainEvents();

    expect((await outboundRows(uid)).map((row) => [row.payload.action, row.attempts])).toEqual([['updateEventsFromEntity', 0]]);
    expect(googleCalls()).toHaveLength(0);

    route(/\/events\/g-lost/, { status: 200, json: { id: 'g-lost', etag: '"2"', updated: '2030-11-01T00:00:00Z' } }, { method: 'PATCH' });
    await reconnect(uid);

    const patches = await waitForCall('/events/g-lost', 'PATCH');
    expect(patches[0].bearer).toBe('new-access');
    expect(patches[0].body.summary).toContain('File the amended motion');
  });

  /**
   * Goes red if the fix also queues edits for a member who switched outbound
   * sync off: that work is owed to no one.
   */
  test('an edit is not queued for a member who turned outbound sync off', async () => {
    const uid = await lostGrantOwner();
    const taskId = await syncedTask(uid);
    const off = await testPool.query(`update user_oauth_tokens set is_sync_to_provider = false where user_id = $1`, [uid]);
    expect(off.rowCount).toBe(1);

    const res = await as(tokenFor({ uid })).put(`/api/lawfirms/${firm.id}/tasks/${taskId}`).send({ title: 'Renamed' });
    expect(res.status).toBe(200);
    await drainEvents();

    expect(await outboundRows(uid)).toEqual([]);
  });
});

describe('the outbound retry budget while a grant is lost', () => {
  /**
   * Goes red if a grant-lost dispatch consumes an attempt: twelve sweeps would
   * dead-letter the work long before most people notice the reconnect banner.
   */
  test('repeated sweeps park the work without spending attempts', async () => {
    const uid = await lostGrantOwner();
    const taskId = await syncedTask(uid);
    const del = await as(tokenFor({ uid })).delete(`/api/lawfirms/${firm.id}/tasks/${taskId}`);
    expect(del.status).toBe(200);
    await drainEvents();
    expect(await outboundRows(uid)).toHaveLength(1);

    for (let sweep = 0; sweep < 14; sweep++) {
      await testPool.query(`update calendar_sync_failures set next_attempt_at = now() where kind = 'outbound' and user_id = $1`, [uid]);
      const summary = await outbound.retryFailedOutbound();
      expect(summary).toMatchObject({ attempted: 1, parked: 1, failed: 0 });
    }

    const [row] = await outboundRows(uid);
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    expect(googleCalls()).toHaveLength(0);
  });

  /**
   * Goes red if the reconnect releases only rows still inside their budget: a
   * write that dead-lettered before the fix would stay stranded.
   */
  test('a reconnect revives dead-lettered work for that member and provider', async () => {
    const uid = await lostGrantOwner();
    const taskId = await syncedTask(uid);
    await testPool.query(
      `insert into calendar_sync_failures (kind, dedupe_key, provider, user_id, law_firm_id, payload, attempts, next_attempt_at)
       values ('outbound', $1, 'google', $2, $3, $4::jsonb, 12, now() + interval '1 day')`,
      [`${firm.id}:google:task:${taskId}:${uid}`, uid, firm.id,
        JSON.stringify({ entityType: 'task', entityData: { id: taskId, lawFirmId: firm.id }, action: 'deleteEventsFromEntity' })],
    );
    route(/\/events\/g-lost/, { status: 204 }, { method: 'DELETE' });

    await reconnect(uid);

    await waitForCall('/events/g-lost', 'DELETE');
  });
});

describe('dead-lettered outbound work', () => {
  /**
   * Goes red if the sweep stops reporting outbound rows that spent their budget:
   * they would sit in the table with nothing surfacing them.
   */
  test('is counted and warned about on every sweep', async () => {
    const { uid } = await createFirmMember(firm.id);
    await testPool.query(
      `insert into calendar_sync_failures (kind, dedupe_key, provider, user_id, law_firm_id, payload, attempts, last_error)
       values ('outbound', $1, 'google', $2, $3, '{}'::jsonb, 12, 'gave up')`,
      [`dead-${uid}`, uid, firm.id],
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await outbound.retryFailedOutbound();
      expect(summary.deadLettered).toBe(1);
      expect(warn.mock.calls.some((call) => /1 dead-lettered outbound/.test(String(call[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

export {};
