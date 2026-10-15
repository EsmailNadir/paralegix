/**
 * Sync runs only on a grant that can still be used.
 *
 * A row whose refresh was refused (`meta.grantState = 'reconnect_required'`),
 * whose calendar scope was withdrawn (`permission_required`), or that never held
 * a refresh token (a popup sign-in's access token) is not a connection. The
 * settings read already reports those as not connected; these cases pin that
 * the sync paths agree: an inbound notification or a manual sync for such a row
 * makes no provider call at all, while the same fixture with a usable grant
 * does, so an empty call log is evidence rather than a broken fixture.
 *
 * Teardown is the exception. Disconnecting still stops the watch channel and
 * revokes the grant with whatever token the row holds, because a channel left
 * running keeps Google pushing notifications for a connection that is gone.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  googleCalls,
} from './support/googleFetch';

installGoogleFetchWall();

import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  ownerOf,
  drainEvents,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const googleService = require('../../src/modules/calendar/google/google.service');
const outlookService = require('../../src/modules/calendar/outlook/outlook.service');

const GOOGLE_CALENDAR = 'https://www.googleapis.com/auth/calendar';
const DELTA = 'syncToken=';
const MS_EVENT = /\/me\/events\/AAMk-gate/;

type Provider = 'google' | 'microsoft';

/** The three row shapes, by what the grant on them can still do. */
const UNUSABLE: Array<[string, { refreshToken: string | null; meta: Record<string, unknown> }]> = [
  ['a refused refresh (reconnect_required)', { refreshToken: 'refresh-seed', meta: { grantState: 'reconnect_required' } }],
  ['a withdrawn calendar scope (permission_required)', { refreshToken: 'refresh-seed', meta: { grantState: 'permission_required' } }],
  ['no refresh token at all', { refreshToken: null, meta: {} }],
];

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm({ name: 'Gating Firm' });
});

afterEach(async () => {
  await drainEvents();
});

afterAll(() => uninstallGoogleFetchWall());

/** A fresh owner (the user-data cache is per user) with a two-way connection. */
async function ownerConnected(
  provider: Provider,
  fields: { refreshToken: string | null; meta: Record<string, unknown> },
): Promise<Actor> {
  const owner = await ownerOf(firm.id);
  const meta = provider === 'microsoft'
    ? { outlookTimezone: 'America/New_York', outlookMailboxTimezoneWritable: true, ...fields.meta }
    : fields.meta;
  const res = await testPool.query(
    `insert into user_oauth_tokens
       (user_id, provider, access_token, refresh_token, scope, meta, is_sync_to_provider, is_sync_from_provider, sync_cursor)
     values ($1, $2, $3, $4, $5, $6::jsonb, true, true, $7)`,
    [owner.uid, provider, `access-${randomUUID().slice(0, 8)}`, fields.refreshToken,
      provider === 'google' ? GOOGLE_CALENDAR : 'Calendars.ReadWrite',
      JSON.stringify(meta), provider === 'google' ? 'token-live' : null],
  );
  expect(res.rowCount).toBe(1);
  await testPool.query(
    `update users set preferences = '{"googleCalendarTarget":"default"}'::jsonb, timezone = 'America/New_York' where id = $1`,
    [owner.uid],
  );
  return owner;
}

const notifyGoogle = (owner: Actor) => googleService.processWatchNotification({ userId: owner.uid, lawFirmId: firm.id });

const notifyOutlook = (owner: Actor) => outlookService.processSubscriptionNotification({
  userId: owner.uid,
  lawFirmId: firm.id,
  changeType: 'updated',
  resource: 'me/events/AAMk-gate',
  resourceData: { id: 'AAMk-gate' },
}).catch(() => undefined);

describe('an inbound notification', () => {
  test('Google: reads the delta for a usable grant (the control)', async () => {
    const owner = await ownerConnected('google', { refreshToken: 'refresh-seed', meta: {} });
    route(DELTA, { json: { items: [], nextSyncToken: 'token-next' } });

    await notifyGoogle(owner);

    expect(callsMatching(DELTA)).toHaveLength(1);
  });

  test.each(UNUSABLE)('Google: makes no provider call for %s', async (_label, fields) => {
    const owner = await ownerConnected('google', fields);
    route(DELTA, { json: { items: [], nextSyncToken: 'token-next' } });

    await notifyGoogle(owner);

    expect(googleCalls()).toEqual([]);
  });

  test('Outlook: fetches the changed event for a usable grant (the control)', async () => {
    const owner = await ownerConnected('microsoft', { refreshToken: 'refresh-seed', meta: {} });
    route(MS_EVENT, { status: 404, json: { error: { code: 'ErrorItemNotFound' } } });

    await notifyOutlook(owner);

    expect(callsMatching(MS_EVENT).length).toBeGreaterThan(0);
  });

  test.each(UNUSABLE)('Outlook: makes no provider call for %s', async (_label, fields) => {
    const owner = await ownerConnected('microsoft', fields);
    route(MS_EVENT, { status: 404, json: { error: { code: 'ErrorItemNotFound' } } });

    await notifyOutlook(owner);

    expect(googleCalls()).toEqual([]);
  });
});

describe('a manual sync', () => {
  test.each(UNUSABLE)('Google: asks for a reconnect and calls nobody for %s', async (_label, fields) => {
    const owner = await ownerConnected('google', fields);
    route(/\/calendars\/primary\/events\?/, { json: { items: [] } });

    const res = await owner.api.post('/api/google-calendar-sync/sync-from-google').send({ lawFirmId: firm.id });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ requiresReAuth: true });
    expect(googleCalls()).toEqual([]);
  });

  test.each(UNUSABLE)('Outlook: asks for a reconnect and calls nobody for %s', async (_label, fields) => {
    const owner = await ownerConnected('microsoft', fields);
    route(/calendarView/, { json: { value: [] } });

    const res = await owner.api.post('/api/outlook-calendar-sync/sync-from-outlook').send({ lawFirmId: firm.id });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'NO_REFRESH_TOKEN', requiresReAuth: true });
    expect(googleCalls()).toEqual([]);
  });
});

describe('disconnecting an unusable grant', () => {
  /**
   * Goes red if the teardown path reads tokens through the same gate as sync:
   * the channel would then be recorded as unstoppable instead of stopped.
   */
  test('Google: still stops the watch channel and revokes with the stored token', async () => {
    const owner = await ownerConnected('google', { refreshToken: 'refresh-seed', meta: { grantState: 'permission_required' } });
    const access = (await testPool.query(
      `select access_token from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    )).rows[0].access_token;
    await testPool.query(
      `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
       values ('google', $1, $2, $3, 'primary', 'res-gate', 'secret', now() + interval '7 days')`,
      [`chan-${randomUUID().slice(0, 8)}`, owner.uid, firm.id],
    );
    route('channels/stop', { status: 204 });
    route('oauth2.googleapis.com/revoke', { status: 200, json: {} });

    const res = await owner.api.post('/api/auth/unlink-google').send({});

    expect(res.status).toBe(200);
    const stops = callsMatching('channels/stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].bearer).toBe(access);
    expect(callsMatching('oauth2.googleapis.com/revoke').map((c) => c.body)).toEqual([{ token: 'refresh-seed' }]);
    expect((await testPool.query(
      `select 1 from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    )).rows).toHaveLength(0);
  });
});
