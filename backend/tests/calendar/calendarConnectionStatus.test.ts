/**
 * Every status reader derives a calendar connection from the stored grant.
 *
 * The settings read used to echo `loggedInWithGoogle`/`loggedInWithMicrosoft`
 * out of the preferences jsonb, which the client itself could write and which
 * social sign-in seeded from Firebase identity, so a person could be shown a
 * connected calendar that Paralegix held no usable token for. These cases pin
 * that the flags now come from the `user_oauth_tokens` row through
 * `connectionState()`, that the client can no longer write them, and that the
 * outbound-sync pre-check refuses a row that cannot refresh.
 */
import {
  testPool,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

const calendarTokens = require('../../src/modules/calendar/shared/calendarTokens');

const GOOGLE_CALENDAR = 'https://www.googleapis.com/auth/calendar';

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  firm = await createFirm({ name: 'Status Firm' });
  owner = await ownerOf(firm.id);
});

async function plantGrant(
  uid: string,
  provider: 'google' | 'microsoft',
  fields: { accessToken?: string | null; refreshToken?: string | null; scope?: string | null; meta?: object; syncTo?: boolean },
) {
  const res = await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, scope, meta, is_sync_to_provider)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [uid, provider, fields.accessToken ?? 'access', fields.refreshToken ?? null, fields.scope ?? null,
      JSON.stringify(fields.meta ?? {}), fields.syncTo ?? false],
  );
  expect(res.rowCount).toBe(1);
}

async function setPreferences(uid: string, prefs: object) {
  await testPool.query('update users set preferences = $2::jsonb where id = $1', [uid, JSON.stringify(prefs)]);
}

const readSettings = async (actor: Actor) => {
  const res = await actor.api.get('/api/settings/user');
  expect(res.status).toBe(200);
  return res.body.preferences;
};

describe('GET /api/settings/user', () => {
  it('reports an access-token-only row as disconnected even when preferences claim a connection', async () => {
    await setPreferences(owner.uid, { loggedInWithGoogle: true, loggedInWithMicrosoft: true });
    await plantGrant(owner.uid, 'google', { accessToken: 'popup-a', refreshToken: null, scope: GOOGLE_CALENDAR });

    const prefs = await readSettings(owner);

    expect(prefs.googleCalendarState).toBe('disconnected');
    expect(prefs.loggedInWithGoogle).toBe(false);
    // No Microsoft row at all, so the stale preferences flag is overridden too.
    expect(prefs.microsoftCalendarState).toBe('disconnected');
    expect(prefs.loggedInWithMicrosoft).toBe(false);
  });

  it('reports a row with a refresh token and the calendar scope as connected', async () => {
    await plantGrant(owner.uid, 'google', { refreshToken: 'r', scope: `${GOOGLE_CALENDAR} openid` });
    await plantGrant(owner.uid, 'microsoft', { refreshToken: 'r', scope: 'Calendars.ReadWrite openid' });

    const prefs = await readSettings(owner);

    expect(prefs).toMatchObject({
      googleCalendarState: 'connected', loggedInWithGoogle: true,
      microsoftCalendarState: 'connected', loggedInWithMicrosoft: true,
    });
  });

  it('reports a legacy row with no recorded scope as unverified, still counted as connected', async () => {
    await plantGrant(owner.uid, 'google', { refreshToken: 'r', scope: null });

    const prefs = await readSettings(owner);

    expect(prefs.googleCalendarState).toBe('unverified');
    expect(prefs.loggedInWithGoogle).toBe(true);
  });

  it.each([
    ['a downgraded scope', { refreshToken: 'r', scope: `${GOOGLE_CALENDAR}.events` }, 'permission_required'],
    ['a refresh Google refused', { refreshToken: 'r', scope: GOOGLE_CALENDAR, meta: { grantState: 'reconnect_required' } }, 'reconnect_required'],
  ])('reports %s as not connected', async (_label, fields, state) => {
    await setPreferences(owner.uid, { loggedInWithGoogle: true });
    await plantGrant(owner.uid, 'google', fields);

    const prefs = await readSettings(owner);

    expect(prefs.googleCalendarState).toBe(state);
    expect(prefs.loggedInWithGoogle).toBe(false);
  });

  it("does not read another person's connection", async () => {
    const other = await ownerOf((await createFirm({ name: 'Neighbour LLP' })).id);
    await plantGrant(other.uid, 'google', { refreshToken: 'r', scope: GOOGLE_CALENDAR });

    expect((await readSettings(other)).googleCalendarState).toBe('connected');
    expect((await readSettings(owner)).googleCalendarState).toBe('disconnected');
  });
});

describe('POST /api/settings/user', () => {
  it.each([
    ['loggedInWithGoogle', true],
    ['loggedInWithMicrosoft', true],
    ['googleConnectedEmail', 'someone@gmail.com'],
    ['googleCalendarState', 'connected'],
    ['microsoftCalendarState', 'connected'],
  ])('refuses a client write of %s and stores nothing', async (key, value) => {
    const res = await owner.api.post('/api/settings/user').send({ preferences: { [key]: value, theme: 'dark' } });

    expect(res.status).toBe(400);
    const { rows } = await testPool.query('select preferences from users where id = $1', [owner.uid]);
    expect(rows[0].preferences?.[key]).toBeUndefined();
    expect(rows[0].preferences?.theme).toBeUndefined();
  });

  it('still accepts an ordinary preferences write', async () => {
    const res = await owner.api.post('/api/settings/user').send({ preferences: { theme: 'dark' } });

    expect(res.status).toBe(200);
    expect((await readSettings(owner)).theme).toBe('dark');
  });
});

describe('the outbound-sync pre-check', () => {
  it('counts a connected row with outbound sync on', async () => {
    await plantGrant(owner.uid, 'google', { refreshToken: 'r', scope: GOOGLE_CALENDAR, syncTo: true });

    expect(await calendarTokens.getOutboundSyncCapabilities(owner.uid)).toEqual({ google: true, microsoft: false });
  });

  it('refuses a row with outbound sync on but no refresh token', async () => {
    await plantGrant(owner.uid, 'google', { accessToken: 'popup-a', refreshToken: null, syncTo: true });

    expect(await calendarTokens.getOutboundSyncCapabilities(owner.uid)).toEqual({ google: false, microsoft: false });
  });

  it('refuses a row whose refresh was refused', async () => {
    await plantGrant(owner.uid, 'microsoft', {
      refreshToken: 'r', scope: 'Calendars.ReadWrite', meta: { grantState: 'reconnect_required' }, syncTo: true,
    });

    expect(await calendarTokens.getOutboundSyncCapabilities(owner.uid)).toEqual({ google: false, microsoft: false });
  });
});
