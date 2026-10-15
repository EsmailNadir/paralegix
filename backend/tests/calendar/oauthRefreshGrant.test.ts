/**
 * What a token refresh records about the grant behind it.
 *
 * A refresh is the only moment Paralegix learns that a person revoked access or
 * granted less than before, so its outcome is written onto the token row:
 * the refreshed `scope`, and `meta.grantState` when the grant is lost
 * (`invalid_grant`) or no longer carries the calendar scope. Every status reader
 * derives the connection from those two fields, so a dead grant stops reading
 * as connected the first time sync touches it, instead of forever.
 *
 * Driven through the calendar-list routes, which make one provider call and
 * refresh on a 401, so each case is one real refresh path end to end.
 */
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
} from './support/googleFetch';

installGoogleFetchWall();

import {
  testPool,
  createFirm,
  ownerOf,
  request,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const { refreshGrant } = require('../../src/modules/calendar/shared/calendarHelpers');

const GOOGLE_CALENDAR = 'https://www.googleapis.com/auth/calendar';
const GOOGLE_TOKEN = 'oauth2.googleapis.com/token';
const GOOGLE_CAL_LIST = 'users/me/calendarList';
const MS_TOKEN = 'login.microsoftonline.com';
const MS_CALENDARS = /\/me\/calendars$/;

let firm: Firm;

beforeEach(async () => {
  resetGoogleFetch();
  firm = await createFirm({ name: 'Refresh Firm' });
});

afterAll(() => uninstallGoogleFetchWall());

async function connectedOwner(provider: 'google' | 'microsoft'): Promise<Actor> {
  const owner = await ownerOf(firm.id);
  const res = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, scope, meta)
     values ($1, $2, 'stale-access', 'the-refresh', $3, $4::jsonb)`,
    [owner.uid, provider,
      provider === 'google' ? `${GOOGLE_CALENDAR} openid` : 'Calendars.ReadWrite openid',
      JSON.stringify(provider === 'google'
        ? { accountId: 'g-sub' }
        : { accountId: 't:o', outlookTimezone: 'America/New_York', outlookMailboxTimezoneWritable: true })],
  );
  expect(res.rowCount).toBe(1);
  return owner;
}

async function grant(uid: string, provider: 'google' | 'microsoft') {
  const { rows } = await testPool.query(
    'select access_token, scope, meta from user_oauth_tokens where user_id = $1 and provider = $2',
    [uid, provider],
  );
  return rows[0];
}

const stateOf = async (actor: Actor, provider: 'google' | 'microsoft') => {
  const res = await actor.api.get('/api/settings/user');
  return res.body.preferences[provider === 'google' ? 'googleCalendarState' : 'microsoftCalendarState'];
};

const listCalendars = (actor: Actor, provider: 'google' | 'microsoft') =>
  actor.api.get(provider === 'google' ? '/api/google-calendar-sync/calendars' : '/api/outlook-calendar-sync/calendars');

function routeCalendarList(provider: 'google' | 'microsoft', responder: any) {
  if (provider === 'google') route(GOOGLE_CAL_LIST, responder);
  else route(MS_CALENDARS, responder);
}

const tokenUrl = (provider: 'google' | 'microsoft') => (provider === 'google' ? GOOGLE_TOKEN : MS_TOKEN);

describe.each(['google', 'microsoft'] as const)('a %s refresh', (provider) => {
  const emptyList = provider === 'google' ? { items: [] } : { value: [] };

  it('records the refreshed scope, and a scope without calendar access reads as permission_required', async () => {
    const owner = await connectedOwner(provider);
    routeCalendarList(provider, [{ status: 401, json: {} }, { status: 200, json: emptyList }]);
    route(tokenUrl(provider), { status: 200, json: { access_token: 'fresh-access', scope: 'openid' } });

    const res = await listCalendars(owner, provider);

    expect(res.status).toBe(200);
    expect(callsMatching(tokenUrl(provider))).toHaveLength(1);
    const row = await grant(owner.uid, provider);
    expect(row).toMatchObject({ access_token: 'fresh-access', scope: 'openid' });
    expect(row.meta.grantState).toBe('permission_required');
    expect(await stateOf(owner, provider)).toBe('permission_required');
  });

  it('records the account a legacy row belongs to from the refresh ID token, and never replaces a known one', async () => {
    const owner = await connectedOwner(provider);
    await testPool.query(
      `update user_oauth_tokens set meta = meta - 'accountId' where user_id = $1 and provider = $2`,
      [owner.uid, provider],
    );
    const claims = provider === 'google'
      ? { sub: 'legacy-sub', email: 'Legacy@Gmail.com' }
      : { tid: 'legacy-t', oid: 'legacy-o', preferred_username: 'legacy@firm.test' };
    const idToken = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    const scope = provider === 'google' ? `${GOOGLE_CALENDAR} openid` : 'Calendars.ReadWrite openid';
    routeCalendarList(provider, [{ status: 401, json: {} }, { status: 200, json: emptyList }]);
    route(tokenUrl(provider), { status: 200, json: { access_token: 'fresh-access', scope, id_token: idToken } });

    await listCalendars(owner, provider);

    const recorded = (await grant(owner.uid, provider)).meta;
    expect(recorded.accountId).toBe(provider === 'google' ? 'legacy-sub' : 'legacy-t:legacy-o');
    expect(recorded.accountEmail).toBe(provider === 'google' ? 'legacy@gmail.com' : 'legacy@firm.test');

    const other = provider === 'google' ? { sub: 'other-sub' } : { tid: 'other-t', oid: 'other-o' };
    resetGoogleFetch();
    routeCalendarList(provider, [{ status: 401, json: {} }, { status: 200, json: emptyList }]);
    route(tokenUrl(provider), { status: 200, json: {
      access_token: 'fresher-access', scope, id_token: `h.${Buffer.from(JSON.stringify(other)).toString('base64url')}.s`,
    } });

    await listCalendars(owner, provider);

    expect((await grant(owner.uid, provider)).meta.accountId).toBe(recorded.accountId);
  });

  it('clears a recorded problem once a refresh carries the calendar scope again', async () => {
    const owner = await connectedOwner(provider);
    await testPool.query(
      `update user_oauth_tokens set meta = meta || '{"grantState":"permission_required"}'::jsonb
        where user_id = $1 and provider = $2`,
      [owner.uid, provider],
    );
    const scope = provider === 'google' ? `${GOOGLE_CALENDAR} openid` : 'https://graph.microsoft.com/Calendars.ReadWrite';
    route(tokenUrl(provider), { status: 200, json: { access_token: 'fresh-access', scope } });

    // A flagged row no longer drives calendar calls, so the refresh is invoked directly.
    await refreshGrant(provider, owner.uid, 'the-refresh');

    expect((await grant(owner.uid, provider)).meta.grantState).toBeNull();
    expect(await stateOf(owner, provider)).toBe('connected');
  });

  it('marks a refused refresh token as reconnect_required', async () => {
    const owner = await connectedOwner(provider);
    routeCalendarList(provider, { status: 401, json: {} });
    route(tokenUrl(provider), { status: 400, json: { error: 'invalid_grant', error_description: 'revoked' } });

    const res = await listCalendars(owner, provider);

    expect(res.status).toBe(401);
    expect(res.body.requiresReAuth).toBe(true);
    const row = await grant(owner.uid, provider);
    expect(row.meta.grantState).toBe('reconnect_required');
    expect(row.access_token).toBe('stale-access');
    expect(await stateOf(owner, provider)).toBe('reconnect_required');
  });

  it('does not treat a provider outage as a lost grant', async () => {
    const owner = await connectedOwner(provider);
    routeCalendarList(provider, { status: 401, json: {} });
    route(tokenUrl(provider), { status: 503, text: 'unavailable' });

    const res = await listCalendars(owner, provider);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not reachable right now/);
    expect(res.body.requiresReAuth).toBeUndefined();
    expect(callsMatching(tokenUrl(provider))).toHaveLength(1);
    expect((await grant(owner.uid, provider)).meta.grantState).toBeUndefined();
    expect(await stateOf(owner, provider)).toBe('connected');
  });

  /**
   * A refresh that never got an answer says nothing about the grant. Goes red
   * if a failed attempt is reported as a reconnect (401), which sends a person
   * whose access is fine through the OAuth flow over a network blip.
   */
  it('does not treat an unreachable token endpoint as a lost grant', async () => {
    const owner = await connectedOwner(provider);
    routeCalendarList(provider, { status: 401, json: {} });
    route(tokenUrl(provider), () => { throw new Error('ECONNRESET'); });

    const res = await listCalendars(owner, provider);

    expect(callsMatching(tokenUrl(provider))).toHaveLength(1);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not reachable right now/);
    expect(res.body.requiresReAuth).toBeUndefined();
    expect((await grant(owner.uid, provider)).meta.grantState).toBeUndefined();
  });
});

describe('a Google call refused for insufficient scope', () => {
  it('records permission_required without a pointless refresh', async () => {
    const owner = await connectedOwner('google');
    route(GOOGLE_CAL_LIST, {
      status: 403,
      json: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      },
    });

    const res = await listCalendars(owner, 'google');

    expect(res.status).toBe(401);
    expect(res.body.requiresReAuth).toBe(true);
    expect(callsMatching(GOOGLE_TOKEN)).toHaveLength(0);
    expect((await grant(owner.uid, 'google')).meta.grantState).toBe('permission_required');
  });

  /**
   * The person reconnects while a call made with the old token is in flight,
   * and that old call's 403 lands after the new grant is saved. Goes red if the
   * flag is written by user and provider alone: the fresh grant would read as
   * permission_required and calendar sync would stop for it.
   */
  it('does not flag a grant reconnected while the refused call was in flight', async () => {
    const owner = await connectedOwner('google');
    route(GOOGLE_CAL_LIST, async () => {
      const reconnected = await testPool.query(
        `update user_oauth_tokens set access_token = 'new-access', refresh_token = 'reconnected-refresh'
          where user_id = $1 and provider = 'google'`,
        [owner.uid],
      );
      expect(reconnected.rowCount).toBe(1);
      return {
        status: 403,
        json: { error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
      };
    });

    const res = await listCalendars(owner, 'google');

    expect(res.status).toBe(401);
    expect(callsMatching(GOOGLE_CAL_LIST)).toHaveLength(1);
    const row = await grant(owner.uid, 'google');
    expect(row.access_token).toBe('new-access');
    expect(row.meta.grantState).toBeUndefined();
  });
});

describe('POST /api/auth/refresh-microsoft-token', () => {
  it('never hands the Microsoft access token to the browser', async () => {
    const owner = await connectedOwner('microsoft');
    route(MS_TOKEN, { status: 200, json: { access_token: 'ms-secret-access' } });

    const res = await request().post('/api/auth/refresh-microsoft-token').send({ token: tokenFor({ uid: owner.uid }) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refreshed: true });
    expect(JSON.stringify(res.body)).not.toContain('ms-secret-access');
    expect((await grant(owner.uid, 'microsoft')).access_token).toBe('ms-secret-access');
  });

  it('records a refused refresh token as reconnect_required', async () => {
    const owner = await connectedOwner('microsoft');
    route(MS_TOKEN, { status: 400, json: { error: 'invalid_grant' } });

    const res = await request().post('/api/auth/refresh-microsoft-token').send({ token: tokenFor({ uid: owner.uid }) });

    expect(res.status).toBe(500);
    expect((await grant(owner.uid, 'microsoft')).meta.grantState).toBe('reconnect_required');
  });
});

describe.each(['google', 'microsoft'] as const)('a %s refresh of a token the row no longer holds', (provider) => {
  const helpers = require('../../src/modules/calendar/shared/calendarHelpers');
  const redeem = (uid: string, token: string) => (provider === 'google'
    ? helpers.refreshGoogleToken(uid, token)
    : helpers.refreshMicrosoftToken(uid, token));

  /** The row a newer connection wrote after the old refresh had started. */
  async function newerConnection() {
    const owner = await connectedOwner(provider);
    await testPool.query(
      `update user_oauth_tokens set access_token = 'newer-access', refresh_token = 'newer-refresh'
        where user_id = $1 and provider = $2`,
      [owner.uid, provider],
    );
    const { rows } = await testPool.query(
      'select * from user_oauth_tokens where user_id = $1 and provider = $2', [owner.uid, provider],
    );
    return { owner, before: rows[0] };
  }

  const rowOf = async (uid: string) => (await testPool.query(
    'select * from user_oauth_tokens where user_id = $1 and provider = $2', [uid, provider],
  )).rows[0];

  /**
   * Goes red if a refresh's write is keyed on the user and provider alone: the
   * old account's tokens, scope and identity would then overwrite the newer
   * connection, or a deleted row would be recreated.
   */
  it('writes nothing over the newer connection', async () => {
    const { owner, before } = await newerConnection();
    route(tokenUrl(provider), { status: 200, json: {
      access_token: 'stale-account-access', refresh_token: 'stale-rotated', scope: 'openid',
      id_token: `h.${Buffer.from(JSON.stringify({ sub: 'x', tid: 't', oid: 'o' })).toString('base64url')}.s`,
    } });

    await redeem(owner.uid, 'the-refresh');

    expect(callsMatching(tokenUrl(provider))).toHaveLength(1);
    expect(await rowOf(owner.uid)).toEqual(before);
  });

  it('does not flag the newer connection when the old token is refused', async () => {
    const { owner, before } = await newerConnection();
    route(tokenUrl(provider), { status: 400, json: { error: 'invalid_grant' } });

    await redeem(owner.uid, 'the-refresh');

    expect(callsMatching(tokenUrl(provider))).toHaveLength(1);
    expect(await rowOf(owner.uid)).toEqual(before);
  });

  it('does not recreate a row that was deleted', async () => {
    const owner = await connectedOwner(provider);
    await testPool.query('delete from user_oauth_tokens where user_id = $1 and provider = $2', [owner.uid, provider]);
    route(tokenUrl(provider), { status: 200, json: { access_token: 'late-access', refresh_token: 'late-rotated' } });

    await redeem(owner.uid, 'the-refresh');

    expect(callsMatching(tokenUrl(provider))).toHaveLength(1);
    expect(await rowOf(owner.uid)).toBeUndefined();
  });
});

describe.each(['google', 'microsoft'] as const)('a %s refresh whose write fails', (provider) => {
  /**
   * Goes red if the refresh catch logs the error's message, which for a Drizzle
   * error carries the query parameters: the new access and refresh tokens.
   */
  it('logs a fixed line and the code, never the tokens', async () => {
    const util = require('util');
    const helpers = require('../../src/modules/calendar/shared/calendarHelpers');
    const calendarTokens = require('../../src/modules/calendar/shared/calendarTokens');
    const owner = await connectedOwner(provider);
    route(tokenUrl(provider), { status: 200, json: { access_token: 'leaked-access', refresh_token: 'leaked-refresh' } });
    const failure = Object.assign(new Error('Failed query: update user_oauth_tokens\nparams: leaked-access,leaked-refresh'), {
      cause: { code: '57014' },
    });
    const failing = jest.spyOn(calendarTokens, 'recordRefresh').mockRejectedValueOnce(failure);
    const logged: string[] = [];
    const errors = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => util.inspect(a, { depth: 5 })).join(' '));
    });

    let result: unknown;
    try {
      result = await (provider === 'google'
        ? helpers.refreshGoogleToken(owner.uid, 'the-refresh')
        : helpers.refreshMicrosoftToken(owner.uid, 'the-refresh')).catch((err: unknown) => err);
      expect(failing).toHaveBeenCalled();
    } finally {
      failing.mockRestore();
      errors.mockRestore();
    }

    expect(result).toMatchObject({ statusCode: 503, code: 'CALENDAR_REFRESH_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toMatch(/leaked-access|leaked-refresh/);
    expect(logged.join('\n')).toContain('57014');
    expect(logged.join('\n')).not.toMatch(/leaked-access|leaked-refresh/);
  });
});
