/**
 * The server-side OAuth code flows that connect a person's Google or Microsoft
 * calendar, plus the Microsoft refresh endpoint.
 *
 * `connect-*` mints a single-use `oauth_states` row, binds it to the starting
 * browser with the `plx_oauth_state` cookie, and hands back the provider URL;
 * the provider sends the browser to `*-callback` with that state and a code,
 * and the callback trades the code for tokens. Everything the person sees
 * afterwards (the "connected" badge, calendar sync, the login hint on the next
 * connect) comes from what the callback stored, and every failure has to land
 * on a real page carrying a fixed error code rather than a JSON error page,
 * because the callback is a browser navigation.
 *
 * Every provider request goes through the global `fetch`, so the calendar
 * specs' fetch wall stands in for Google and Microsoft: an unrouted request
 * throws instead of reaching the network.
 */
import {
  testPool,
  createFirm,
  ownerOf,
  request,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import {
  installGoogleFetchWall,
  uninstallGoogleFetchWall,
  resetGoogleFetch,
  route,
  callsMatching,
  googleCalls,
} from '../calendar/support/googleFetch';
import { gateMethod } from '../support/gate';

installGoogleFetchWall();
afterAll(() => uninstallGoogleFetchWall());

const A = '/api/auth';
const FRONTEND = 'https://app.paralegix.test';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const STATE_COOKIE = 'plx_oauth_state';

const GOOGLE_CALENDAR = 'https://www.googleapis.com/auth/calendar';
const GOOGLE_FULL_SCOPE = `${GOOGLE_CALENDAR} https://www.googleapis.com/auth/userinfo.email openid`;
const MS_FULL_SCOPE = 'https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read openid';

const ENV_KEYS = [
  'FRONTEND_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_REDIRECT_URI', 'WEBHOOK_BASE_URL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let firm: Firm;
let owner: Actor;

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.FRONTEND_URL = FRONTEND;
  process.env.GOOGLE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
  delete process.env.GOOGLE_REDIRECT_URI;
  process.env.MICROSOFT_CLIENT_ID = 'ms-client-id';
  process.env.MICROSOFT_CLIENT_SECRET = 'ms-client-secret';
  delete process.env.MICROSOFT_REDIRECT_URI;
  delete process.env.WEBHOOK_BASE_URL;
  resetGoogleFetch();

  firm = await createFirm({ name: 'OAuth Firm' });
  owner = await ownerOf(firm.id);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** An unsigned ID token carrying `claims`, the shape both providers return. */
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** A Google token response that grants everything a connection needs. */
const googleGrant = (over: Record<string, unknown> = {}) => ({
  access_token: 'g-access',
  refresh_token: 'g-refresh',
  scope: GOOGLE_FULL_SCOPE,
  id_token: jwt({ sub: 'g-sub', email: 'Person@Gmail.com' }),
  ...over,
});

/** A Microsoft token response that grants everything a connection needs. */
const msGrant = (over: Record<string, unknown> = {}) => ({
  access_token: 'ms-access',
  refresh_token: 'ms-refresh',
  scope: MS_FULL_SCOPE,
  id_token: jwt({ tid: 'tenant-1', oid: 'object-1', preferred_username: 'Lawyer@Firm.test' }),
  ...over,
});

async function stateRow(state: string) {
  const { rows } = await testPool.query('select * from oauth_states where state = $1', [state]);
  return rows[0] || null;
}

async function tokenRow(uid: string, provider: 'google' | 'microsoft') {
  const { rows } = await testPool.query(
    'select access_token, refresh_token from user_oauth_tokens where user_id = $1 and provider = $2',
    [uid, provider],
  );
  return rows[0] || null;
}

/** The whole stored grant, for the cases that must prove nothing moved. */
async function grantRow(uid: string, provider: 'google' | 'microsoft') {
  const { rows } = await testPool.query(
    'select * from user_oauth_tokens where user_id = $1 and provider = $2',
    [uid, provider],
  );
  return rows[0] || null;
}

/** What the settings read reports, which derives the flags from the stored grant. */
async function settingsOf(actor: Actor) {
  const res = await actor.api.get('/api/settings/user');
  expect(res.status).toBe(200);
  return res.body.preferences;
}

async function preferences(uid: string) {
  const { rows } = await testPool.query('select preferences from users where id = $1', [uid]);
  return rows[0].preferences || {};
}

async function plantState(fields: {
  state: string; uid: string; provider: 'google' | 'microsoft';
  redirectUri?: string | null; returnUrl?: string | null; ageMinutes?: number;
}) {
  await testPool.query(
    `insert into oauth_states (state, user_id, provider, redirect_uri, return_url, created_at)
     values ($1, $2, $3, $4, $5, now() - ($6::int * interval '1 minute'))`,
    [fields.state, fields.uid, fields.provider, fields.redirectUri ?? null, fields.returnUrl ?? null,
      fields.ageMinutes ?? 0],
  );
}

async function plantProviderToken(
  uid: string,
  provider: 'google' | 'microsoft',
  fields: {
    accessToken: string; refreshToken?: string | null; syncFromProvider?: boolean; syncToProvider?: boolean;
    scope?: string | null; meta?: Record<string, unknown> | null;
    syncCursor?: string | null; calendarId?: string | null; appCalendarId?: string | null;
  },
) {
  await testPool.query(
    `insert into user_oauth_tokens
       (user_id, provider, access_token, refresh_token, token_updated_at, is_sync_from_provider,
        is_sync_to_provider, scope, meta, sync_cursor, calendar_id, app_calendar_id)
     values ($1, $2, $3, $4, now(), $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), $9, $10, $11)`,
    [uid, provider, fields.accessToken, fields.refreshToken ?? null, fields.syncFromProvider ?? false,
      fields.syncToProvider ?? false, fields.scope ?? null, fields.meta ? JSON.stringify(fields.meta) : null,
      fields.syncCursor ?? null, fields.calendarId ?? null, fields.appCalendarId ?? null],
  );
}

/** The single-use state a connect call minted, read back off the provider URL. */
function stateFrom(authUrl: string) {
  return new URL(authUrl).searchParams.get('state') as string;
}

/** The `Cookie` header a browser holding `state` sends back on the callback. */
const cookieFor = (state: string) => `${STATE_COOKIE}=${state}`;

/** Every `Set-Cookie` header a response carried. */
function setCookies(res: { header: Record<string, any> }): string[] {
  const raw = res.header['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** The state cookie a connect response set, as the browser would send it back. */
function cookieFrom(res: { header: Record<string, any> }) {
  const set = setCookies(res);
  const ours = set.find((c) => c.startsWith(`${STATE_COOKIE}=`));
  return ours ? ours.split(';')[0] : '';
}

/** Waits for a fire-and-forget provider request, bounded so a miss fails rather than hangs. */
async function waitForCall(fragment: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (callsMatching(fragment).length) return callsMatching(fragment);
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`no request matching ${fragment} was made`);
}

const location = (res: { header: Record<string, string> }) => decodeURIComponent(res.header.location);

describe('starting the Google connection', () => {
  it('stores a single-use state bound to the caller and returns the consent URL', async () => {
    const res = await owner.api.post(`${A}/connect-google`).send({ returnUrl: '/lawfirm/settings?tab=calendar' });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-client-id');
    expect(url.searchParams.get('access_type')).toBe('offline');
    // Only the scopes the integration uses: `calendar` already covers events.
    expect(url.searchParams.get('scope')).toBe(GOOGLE_FULL_SCOPE);
    // With no configured redirect the callback is derived from the host the
    // request came in on.
    expect(res.body.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/google-callback$/);
    expect(url.searchParams.get('redirect_uri')).toBe(res.body.redirectUri);
    // No Google address has been connected yet, so there is nothing to hint.
    expect(url.searchParams.has('login_hint')).toBe(false);

    const row = await stateRow(url.searchParams.get('state') as string);
    expect(row).toMatchObject({
      user_id: owner.uid,
      provider: 'google',
      redirect_uri: res.body.redirectUri,
      // A relative return path is anchored to the frontend.
      return_url: `${FRONTEND}/lawfirm/settings?tab=calendar`,
    });
  });

  it('binds the state to the starting browser with an httpOnly, same-site cookie', async () => {
    const res = await owner.api.post(`${A}/connect-google`).send({});

    const set = setCookies(res);
    const cookie = set.find((c) => c.startsWith(`${STATE_COOKIE}=`)) || '';
    expect(cookie.split(';')[0]).toBe(cookieFor(stateFrom(res.body.authUrl)));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(/Max-Age=600/);
  });

  it('prefers the configured redirect URI, trailing slash removed', async () => {
    process.env.GOOGLE_REDIRECT_URI = 'https://api.paralegix.test/api/auth/google-callback/';

    const res = await owner.api.post(`${A}/connect-google`).send({});

    expect(res.status).toBe(200);
    expect(res.body.redirectUri).toBe('https://api.paralegix.test/api/auth/google-callback');
    expect((await stateRow(stateFrom(res.body.authUrl))).return_url).toBeNull();
  });

  it.each([
    ['another origin', 'https://evil.example.test/steal', `${FRONTEND}/dashboard`],
    ['an unparseable URL', 'not a url at all', `${FRONTEND}/dashboard`],
    ['the frontend origin itself', `${FRONTEND}/matters?view=board`, `${FRONTEND}/matters?view=board`],
  ])('sanitizes a return URL on %s', async (_label, returnUrl, stored) => {
    const res = await owner.api.post(`${A}/connect-google`).send({ returnUrl });

    // The stored return URL is where the callback sends the browser. An
    // unchecked one is an open redirect off the back of a trusted sign-in.
    expect(res.status).toBe(200);
    expect((await stateRow(stateFrom(res.body.authUrl))).return_url).toBe(stored);
  });

  it('hints the previously connected Google address on the next connect', async () => {
    await testPool.query(
      `update users set preferences = preferences || '{"googleConnectedEmail":"Person@Gmail.com"}'::jsonb
        where id = $1`,
      [owner.uid],
    );

    const res = await owner.api.post(`${A}/connect-google`).send({});

    expect(res.status).toBe(200);
    expect(new URL(res.body.authUrl).searchParams.get('login_hint')).toBe('person@gmail.com');
  });

  it('refuses to start without a Google client id, and stores no state', async () => {
    delete process.env.GOOGLE_CLIENT_ID;

    const res = await owner.api.post(`${A}/connect-google`).send({});

    expect(res.status).toBe(500);
    const { rows } = await testPool.query('select 1 from oauth_states where user_id = $1', [owner.uid]);
    expect(rows).toHaveLength(0);
  });
});

describe('the Google callback', () => {
  async function connect(returnUrl?: string) {
    const res = await owner.api.post(`${A}/connect-google`).send(returnUrl ? { returnUrl } : {});
    expect(res.status).toBe(200);
    return { state: stateFrom(res.body.authUrl), redirectUri: res.body.redirectUri as string, cookie: cookieFrom(res) };
  }

  const callback = (query: string, cookie: string) =>
    request().get(`${A}/google-callback?${query}`).set('Cookie', cookie);

  it('stores the tokens, records the connected address and consumes the state', async () => {
    const { state, redirectUri, cookie } = await connect('/lawfirm/settings?tab=calendar');
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const res = await callback(`code=auth-code&state=${state}`, cookie);

    expect(res.status).toBe(302);
    // The return URL already has a query, so the flag joins it with `&`.
    expect(res.header.location).toBe(`${FRONTEND}/lawfirm/settings?tab=calendar&google_connected=true`);
    expect(await tokenRow(owner.uid, 'google')).toEqual({ access_token: 'g-access', refresh_token: 'g-refresh' });
    const grant = await grantRow(owner.uid, 'google');
    expect(grant.scope).toBe(GOOGLE_FULL_SCOPE);
    expect(grant.meta).toMatchObject({ accountId: 'g-sub', accountEmail: 'person@gmail.com' });
    const prefs = await preferences(owner.uid);
    expect((await settingsOf(owner)).loggedInWithGoogle).toBe(true);
    expect(prefs.googleConnectedEmail).toBe('person@gmail.com');
    expect(await stateRow(state)).toBeNull();

    const [exchange] = callsMatching(GOOGLE_TOKEN_URL);
    expect(exchange.method).toBe('POST');
    expect(exchange.body).toMatchObject({
      code: 'auth-code',
      grant_type: 'authorization_code',
      client_id: 'google-client-id',
      client_secret: 'google-client-secret',
      redirect_uri: redirectUri,
    });
  });

  it('refuses a replayed state after it has been used once', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });
    const first = await callback(`code=one&state=${state}`, cookie);
    expect(first.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);

    const replay = await callback(`code=two&state=${state}`, cookie);

    expect(replay.status).toBe(302);
    expect(location(replay)).toBe(`${FRONTEND}/dashboard?google_error=invalid_state`);
    expect(callsMatching(GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  it('refuses a state older than ten minutes and deletes it', async () => {
    await plantState({ state: 'stale-google-state', uid: owner.uid, provider: 'google', ageMinutes: 11 });

    const res = await callback('code=c&state=stale-google-state', cookieFor('stale-google-state'));

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=expired_state`);
    expect(await stateRow('stale-google-state')).toBeNull();
    expect(googleCalls()).toHaveLength(0);
  });

  it('refuses a Microsoft state on the Google callback and leaves it unused', async () => {
    await plantState({
      state: 'ms-only-state', uid: owner.uid, provider: 'microsoft', returnUrl: `${FRONTEND}/lawfirm/f1/settings/general`,
    });

    const res = await callback('code=c&state=ms-only-state', cookieFor('ms-only-state'));

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=invalid_state`);
    expect(callsMatching(GOOGLE_TOKEN_URL)).toHaveLength(0);
    expect(await stateRow('ms-only-state')).not.toBeNull();
  });

  it('refuses a callback from a browser that did not start the connection', async () => {
    const { state } = await connect('/lawfirm/f1/settings/general');
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const noCookie = await request().get(`${A}/google-callback?code=c&state=${state}`);
    const otherCookie = await callback(`code=c&state=${state}`, cookieFor('a-different-state'));

    expect(location(noCookie)).toBe(`${FRONTEND}/dashboard?google_error=invalid_state`);
    expect(location(otherCookie)).toBe(`${FRONTEND}/dashboard?google_error=invalid_state`);
    expect(callsMatching(GOOGLE_TOKEN_URL)).toHaveLength(0);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
  });

  it('clears the state cookie on the callback', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const res = await callback(`code=c&state=${state}`, cookie);

    const set = setCookies(res);
    const cleared = set.find((c) => c.startsWith(`${STATE_COOKIE}=`)) || '';
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/Path=\/api\/auth/);
  });

  it('returns a denied consent to the page that started it, and spends the state', async () => {
    const { state, cookie } = await connect('/lawfirm/f1/settings/general');

    const res = await callback(`error=access_denied&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/lawfirm/f1/settings/general?google_error=access_denied`);
    expect(await stateRow(state)).toBeNull();
    expect(googleCalls()).toHaveLength(0);
  });

  it('spends a state once under concurrent callbacks', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const results = await Promise.all([
      callback(`code=one&state=${state}`, cookie),
      callback(`code=two&state=${state}`, cookie),
    ]);

    expect(callsMatching(GOOGLE_TOKEN_URL)).toHaveLength(1);
    expect(results.map((r) => location(r)).sort()).toEqual([
      `${FRONTEND}/dashboard?google_connected=true`,
      `${FRONTEND}/dashboard?google_error=invalid_state`,
    ]);
  });

  it('falls back to the configured redirect URI when the state stored none', async () => {
    process.env.GOOGLE_REDIRECT_URI = 'https://api.paralegix.test/api/auth/google-callback';
    await plantState({ state: 'bare-state', uid: owner.uid, provider: 'google', redirectUri: null });
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ id_token: jwt({ sub: 'g-sub' }) }) });

    const res = await callback('code=c&state=bare-state', cookieFor('bare-state'));

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(callsMatching(GOOGLE_TOKEN_URL)[0].body.redirect_uri)
      .toBe('https://api.paralegix.test/api/auth/google-callback');
    // An ID token with no address stores no connected address.
    expect((await preferences(owner.uid)).googleConnectedEmail).toBeUndefined();
  });

  it('uses the last value of a repeated code parameter', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const res = await callback(`code=first&code=second&state=${state}`, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(callsMatching(GOOGLE_TOKEN_URL)[0].body.code).toBe('second');
  });

  it('treats an object-shaped code as missing', async () => {
    const { state, cookie } = await connect();

    const res = await callback(`code[x]=1&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=invalid_state`);
    // The state was never consulted, so it is still there to be used.
    expect(await stateRow(state)).not.toBeNull();
  });

  it('reports a failed code exchange on the settings page and stores no token', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { status: 400, text: 'invalid_grant' });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=exchange_failed`);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
    expect((await settingsOf(owner)).loggedInWithGoogle).toBe(false);
  });

  it('reports an exchange that returned no access token', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: { refresh_token: 'only-refresh' } });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=exchange_failed`);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
  });

  it('takes the connected address from the ID token without calling userinfo', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ id_token: jwt({ sub: 'g-sub', email: 'From.Token@Gmail.com' }) }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(callsMatching('oauth2/v1/userinfo')).toHaveLength(0);
    expect((await preferences(owner.uid)).googleConnectedEmail).toBe('from.token@gmail.com');
  });

  it('refuses a grant with no refresh token when none is on file, and stores nothing', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ refresh_token: undefined }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    // Without a refresh token background sync dies within the hour, so this is
    // not a connection.
    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=missing_refresh_token`);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
    expect((await settingsOf(owner)).loggedInWithGoogle).toBe(false);
  });

  it.each([
    ['only calendar.events', `${GOOGLE_CALENDAR}.events openid`],
    ['only identity scopes', 'https://www.googleapis.com/auth/userinfo.email openid'],
  ])('refuses a grant with %s and stores nothing', async (_label, scope) => {
    process.env.WEBHOOK_BASE_URL = 'https://hooks.paralegix.test';
    const { state, cookie } = await connect('/lawfirm/f1/settings/general');
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ scope }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/lawfirm/f1/settings/general?google_error=permission_required`);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
    expect((await settingsOf(owner)).loggedInWithGoogle).toBe(false);
    expect(callsMatching('/events/watch')).toHaveLength(0);
  });

  it('refuses a grant whose response names no scope at all', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ scope: undefined }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=permission_required`);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
  });

  it('refuses a grant with no ID token, since the account cannot be identified', async () => {
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ id_token: undefined }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=identity_unverified`);
    expect(await tokenRow(owner.uid, 'google')).toBeNull();
  });

  it('leaves a working connection byte-for-byte intact when a reconnect is refused', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'old-a', refreshToken: 'old-r', syncFromProvider: true,
      scope: GOOGLE_FULL_SCOPE, meta: { accountId: 'g-sub', accountEmail: 'person@gmail.com' },
    });
    const before = await grantRow(owner.uid, 'google');
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ scope: `${GOOGLE_CALENDAR}.events openid` }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=permission_required`);
    expect(await grantRow(owner.uid, 'google')).toEqual(before);
  });

  it('keeps the stored refresh token when the same account reconnects without a new one', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'old-a', refreshToken: 'old-r', scope: `${GOOGLE_CALENDAR}.events`,
      meta: { accountId: 'g-sub', accountEmail: 'person@gmail.com' },
    });
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ access_token: 'new-a', refresh_token: undefined }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    const grant = await grantRow(owner.uid, 'google');
    expect(grant).toMatchObject({ access_token: 'new-a', refresh_token: 'old-r', scope: GOOGLE_FULL_SCOPE });
  });

  it('treats a different Google account as a new connection', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'a-access', refreshToken: 'a-refresh', syncFromProvider: true, syncToProvider: true,
      scope: GOOGLE_FULL_SCOPE, meta: { accountId: 'a-sub', accountEmail: 'a@gmail.com' },
      syncCursor: 'cursor-a', calendarId: 'cal-a', appCalendarId: 'app-a',
    });
    await testPool.query(
      `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
       values ('google', 'chan-a', $1, $2, 'primary', 'res-a', 'secret', now() + interval '7 days')`,
      [owner.uid, firm.id],
    );
    const imported = await testPool.query(
      `insert into calendar_events (law_firm_id, title, provider, external_event_id, created_by)
       values ($1, 'Imported from A', 'google', 'ext-a', $2) returning id`,
      [firm.id, owner.uid],
    );
    const { state, cookie } = await connect();
    route('channels/stop', { status: 204 });
    route(GOOGLE_REVOKE_URL, { status: 200, json: {} });
    route(GOOGLE_TOKEN_URL, {
      json: googleGrant({ access_token: 'b-access', refresh_token: 'b-refresh', id_token: jwt({ sub: 'b-sub', email: 'b@gmail.com' }) }),
    });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    // The old account's watch is stopped with the old account's token.
    const stops = callsMatching('channels/stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].bearer).toBe('a-access');
    // The old account's grant is ended at Google, not just forgotten here.
    const revokes = callsMatching(GOOGLE_REVOKE_URL);
    expect(revokes).toHaveLength(1);
    expect(revokes[0].body).toEqual({ token: 'a-refresh' });
    expect((await testPool.query('select 1 from calendar_events where id = $1', [imported.rows[0].id])).rows).toHaveLength(0);
    const grant = await grantRow(owner.uid, 'google');
    expect(grant).toMatchObject({
      access_token: 'b-access', refresh_token: 'b-refresh',
      sync_cursor: null, calendar_id: null, app_calendar_id: null,
      is_sync_to_provider: false, is_sync_from_provider: false,
    });
    expect(grant.meta).toMatchObject({ accountId: 'b-sub', accountEmail: 'b@gmail.com' });
    expect((await preferences(owner.uid)).googleConnectedEmail).toBe('b@gmail.com');
  });

  it('opens a watch channel when Google-to-Paralegix sync was already on', async () => {
    process.env.WEBHOOK_BASE_URL = 'https://hooks.paralegix.test';
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'old-access', refreshToken: 'old-refresh', syncFromProvider: true, meta: { accountId: 'g-sub' },
    });
    const { state, cookie } = await connect();
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });
    route('/events/watch', { json: { id: 'channel', resourceId: 'resource-1', expiration: String(Date.now() + 86_400_000) } });
    route('googleapis.com/calendar', { json: { timeZone: 'America/New_York' } });

    const res = await callback(`code=c&state=${state}`, cookie);
    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);

    const [watch] = await waitForCall('/events/watch');
    // The channel is opened with the token the exchange just returned, not the
    // stale one that was on file.
    expect(watch.bearer).toBe('g-access');
    expect(watch.body.address).toBe('https://hooks.paralegix.test/api/webhooks/google-calendar');
  });
});

describe('starting the Microsoft connection', () => {
  it('stores a single-use state and returns the consent URL', async () => {
    const res = await owner.api.post(`${A}/connect-microsoft`).send({ returnUrl: '/dashboard' });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authUrl);
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe('ms-client-id');
    expect(url.searchParams.get('scope')).toBe(
      'offline_access Calendars.ReadWrite MailboxSettings.ReadWrite User.Read email openid profile',
    );
    const row = await stateRow(url.searchParams.get('state') as string);
    expect(row).toMatchObject({ user_id: owner.uid, provider: 'microsoft', return_url: `${FRONTEND}/dashboard` });
    expect(row.redirect_uri).toMatch(/\/api\/auth\/microsoft-callback$/);
    expect(url.searchParams.get('redirect_uri')).toBe(row.redirect_uri);
    expect(cookieFrom(res)).toBe(cookieFor(url.searchParams.get('state') as string));
  });

  it('refuses to start without a Microsoft client id, and stores no state', async () => {
    delete process.env.MICROSOFT_CLIENT_ID;

    const res = await owner.api.post(`${A}/connect-microsoft`).send({});

    expect(res.status).toBe(500);
    const { rows } = await testPool.query('select 1 from oauth_states where user_id = $1', [owner.uid]);
    expect(rows).toHaveLength(0);
  });
});

describe('the Microsoft callback', () => {
  async function connect(returnUrl?: string) {
    const res = await owner.api.post(`${A}/connect-microsoft`).send(returnUrl ? { returnUrl } : {});
    expect(res.status).toBe(200);
    return { state: stateFrom(res.body.authUrl), cookie: cookieFrom(res) };
  }

  const callback = (query: string, cookie: string) =>
    request().get(`${A}/microsoft-callback?${query}`).set('Cookie', cookie);

  it('stores the tokens, marks the account connected and consumes the state', async () => {
    const { state, cookie } = await connect('/lawfirm/settings?tab=calendar');
    route(MS_TOKEN_URL, { json: msGrant() });

    const res = await callback(`code=ms-code&state=${state}`, cookie);

    expect(res.status).toBe(302);
    expect(res.header.location).toBe(`${FRONTEND}/lawfirm/settings?tab=calendar&microsoft_connected=true`);
    expect(await tokenRow(owner.uid, 'microsoft')).toEqual({ access_token: 'ms-access', refresh_token: 'ms-refresh' });
    const grant = await grantRow(owner.uid, 'microsoft');
    expect(grant.scope).toBe('Calendars.ReadWrite User.Read openid');
    expect(grant.meta).toMatchObject({ accountId: 'tenant-1:object-1', accountEmail: 'lawyer@firm.test', tenantId: 'tenant-1' });
    expect((await settingsOf(owner)).loggedInWithMicrosoft).toBe(true);
    expect(await stateRow(state)).toBeNull();
    const [exchange] = callsMatching(MS_TOKEN_URL);
    expect(exchange.body).toMatchObject({
      code: 'ms-code',
      grant_type: 'authorization_code',
      client_id: 'ms-client-id',
      client_secret: 'ms-client-secret',
    });
    expect(exchange.body.scope).toContain('Calendars.ReadWrite');
  });

  it('refuses a connection that returned no refresh token, on the dashboard when the state carried no return URL', async () => {
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { json: msGrant({ refresh_token: undefined }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=missing_refresh_token`);
    expect(await tokenRow(owner.uid, 'microsoft')).toBeNull();
  });

  it('reports a declined consent as a fixed code, without the provider description', async () => {
    const res = await request().get(
      `${A}/microsoft-callback?error=access_denied&error_description=${encodeURIComponent('The user declined')}`,
    );

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=access_denied`);
  });

  it('reports any other provider error as access_denied too', async () => {
    const res = await request().get(`${A}/microsoft-callback?error=server_error`);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=access_denied`);
  });

  it('maps a tenant that needs admin approval to one code and drops the description', async () => {
    const { state, cookie } = await connect();

    const res = await callback(
      `error=access_denied&error_description=AADSTS65001%3A%20trace%20id%20abc&state=${state}`, cookie,
    );

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=admin_consent_required`);
    expect(res.header.location).not.toContain('AADSTS');
    expect(res.header.location).not.toContain('trace');
    expect(await stateRow(state)).toBeNull();
  });

  it('redirects with an error when the code or state is missing', async () => {
    const res = await request().get(`${A}/microsoft-callback?code=only-code`);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=invalid_state`);
  });

  it('refuses an unknown state without calling Microsoft', async () => {
    const res = await callback('code=c&state=never-minted', cookieFor('never-minted'));

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=invalid_state`);
    expect(googleCalls()).toHaveLength(0);
  });

  it('refuses a state older than ten minutes and deletes it', async () => {
    await plantState({ state: 'stale-ms-state', uid: owner.uid, provider: 'microsoft', ageMinutes: 11 });

    const res = await callback('code=c&state=stale-ms-state', cookieFor('stale-ms-state'));

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=expired_state`);
    expect(await stateRow('stale-ms-state')).toBeNull();
    expect(googleCalls()).toHaveLength(0);
  });

  it('refuses a callback from a browser that did not start the connection', async () => {
    const { state } = await connect();
    route(MS_TOKEN_URL, { json: msGrant() });

    const res = await request().get(`${A}/microsoft-callback?code=c&state=${state}`);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=invalid_state`);
    expect(callsMatching(MS_TOKEN_URL)).toHaveLength(0);
  });

  it('falls back to the configured redirect URI when the state stored none', async () => {
    process.env.MICROSOFT_REDIRECT_URI = 'https://api.paralegix.test/api/auth/microsoft-callback';
    await plantState({ state: 'bare-ms-state', uid: owner.uid, provider: 'microsoft', redirectUri: null });
    route(MS_TOKEN_URL, { json: msGrant() });

    await callback('code=c&state=bare-ms-state', cookieFor('bare-ms-state'));

    expect(callsMatching(MS_TOKEN_URL)[0].body.redirect_uri)
      .toBe('https://api.paralegix.test/api/auth/microsoft-callback');
  });

  it('reports a failed code exchange and stores no token', async () => {
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { status: 400, text: 'invalid_grant' });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=exchange_failed`);
    expect(await tokenRow(owner.uid, 'microsoft')).toBeNull();
    expect((await settingsOf(owner)).loggedInWithMicrosoft).toBe(false);
  });

  it('reports an exchange that returned no access token', async () => {
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { json: {} });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=exchange_failed`);
    expect(await tokenRow(owner.uid, 'microsoft')).toBeNull();
  });

  it('refuses a grant without Calendars.ReadWrite and stores nothing', async () => {
    process.env.WEBHOOK_BASE_URL = 'https://hooks.paralegix.test';
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { json: msGrant({ scope: 'https://graph.microsoft.com/Calendars.Read openid' }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=permission_required`);
    expect(await tokenRow(owner.uid, 'microsoft')).toBeNull();
    expect(callsMatching('graph.microsoft.com/v1.0/subscriptions')).toHaveLength(0);
  });

  it('connects when the response omits scope, recording the requested set', async () => {
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { json: msGrant({ scope: undefined }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?microsoft_connected=true`);
    expect((await grantRow(owner.uid, 'microsoft')).scope).toBe(
      'offline_access Calendars.ReadWrite MailboxSettings.ReadWrite User.Read email openid profile',
    );
  });

  it('refuses a grant with no ID token', async () => {
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { json: msGrant({ id_token: undefined }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=identity_unverified`);
    expect(await tokenRow(owner.uid, 'microsoft')).toBeNull();
  });

  it('leaves a working connection byte-for-byte intact when a reconnect is refused', async () => {
    await plantProviderToken(owner.uid, 'microsoft', {
      accessToken: 'old-a', refreshToken: 'old-r', syncFromProvider: true,
      scope: 'Calendars.ReadWrite openid', meta: { accountId: 'tenant-1:object-1', outlookTimezone: 'America/New_York' },
    });
    const before = await grantRow(owner.uid, 'microsoft');
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { json: msGrant({ scope: 'Calendars.Read openid' }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?microsoft_error=permission_required`);
    expect(await grantRow(owner.uid, 'microsoft')).toEqual(before);
  });

  it('treats a different Microsoft account as a new connection', async () => {
    await plantProviderToken(owner.uid, 'microsoft', {
      accessToken: 'a-access', refreshToken: 'a-refresh', syncFromProvider: true, syncToProvider: true,
      scope: 'Calendars.ReadWrite', meta: { accountId: 'tenant-1:object-a', outlookTimezone: 'America/New_York' },
      calendarId: 'cal-a',
    });
    await testPool.query(
      `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
       values ('outlook', 'sub-a', $1, $2, 'primary', '/me/calendar/events', 'secret', now() + interval '2 days')`,
      [owner.uid, firm.id],
    );
    const imported = await testPool.query(
      `insert into calendar_events (law_firm_id, title, provider, external_event_id, created_by)
       values ($1, 'Imported from A', 'outlook', 'ext-a', $2) returning id`,
      [firm.id, owner.uid],
    );
    const { state, cookie } = await connect();
    route('graph.microsoft.com/v1.0/subscriptions/sub-a', { status: 204 }, { method: 'DELETE' });
    route(MS_TOKEN_URL, { json: msGrant({ access_token: 'b-access', refresh_token: 'b-refresh' }) });

    const res = await callback(`code=c&state=${state}`, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?microsoft_connected=true`);
    const stops = callsMatching('subscriptions/sub-a');
    expect(stops).toHaveLength(1);
    expect(stops[0].bearer).toBe('a-access');
    expect((await testPool.query('select 1 from calendar_events where id = $1', [imported.rows[0].id])).rows).toHaveLength(0);
    const grant = await grantRow(owner.uid, 'microsoft');
    expect(grant).toMatchObject({
      access_token: 'b-access', refresh_token: 'b-refresh', calendar_id: null,
      is_sync_to_provider: false, is_sync_from_provider: false,
    });
    expect(grant.meta).toMatchObject({ accountId: 'tenant-1:object-1' });
    // The old mailbox's time zone belongs to the old account.
    expect(grant.meta.outlookTimezone).toBeUndefined();
  });

  it('opens an Outlook subscription when Outlook-to-Paralegix sync was already on', async () => {
    process.env.WEBHOOK_BASE_URL = 'https://hooks.paralegix.test';
    await plantProviderToken(owner.uid, 'microsoft', {
      accessToken: 'old-ms', refreshToken: 'old-refresh', syncFromProvider: true, meta: { accountId: 'tenant-1:object-1' },
    });
    const { state, cookie } = await connect();
    route(MS_TOKEN_URL, { json: msGrant() });
    route('graph.microsoft.com/v1.0/subscriptions', {
      status: 201,
      json: { id: 'sub-1', expirationDateTime: new Date(Date.now() + 86_400_000).toISOString() },
    });

    const res = await callback(`code=c&state=${state}`, cookie);
    expect(res.header.location).toBe(`${FRONTEND}/dashboard?microsoft_connected=true`);

    const [subscription] = await waitForCall('graph.microsoft.com/v1.0/subscriptions');
    expect(subscription.bearer).toBe('ms-access');
    expect(subscription.body.notificationUrl).toBe('https://hooks.paralegix.test/api/webhooks/outlook-calendar');
    expect(subscription.body.resource).toBe('/me/calendar/events');
  });
});

describe('refreshing the Microsoft access token', () => {
  const refresh = (uid: string) => request().post(`${A}/refresh-microsoft-token`).send({ token: tokenFor({ uid }) });

  it('exchanges the stored refresh token and keeps it when Microsoft sends no new one', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-old', refreshToken: 'ms-refresh' });
    route(MS_TOKEN_URL, { json: { access_token: 'ms-new' } });

    const res = await refresh(owner.uid);

    expect(res.status).toBe(200);
    // The access token stays server-side; the caller only learns it worked.
    expect(res.body).toEqual({ refreshed: true });
    expect(await tokenRow(owner.uid, 'microsoft')).toEqual({ access_token: 'ms-new', refresh_token: 'ms-refresh' });
    expect(callsMatching(MS_TOKEN_URL)[0].body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ms-refresh',
      client_id: 'ms-client-id',
    });
  });

  it('stores a rotated refresh token when Microsoft returns one', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-old', refreshToken: 'ms-refresh' });
    route(MS_TOKEN_URL, { json: { access_token: 'ms-new', refresh_token: 'ms-rotated' } });

    await refresh(owner.uid);

    expect(await tokenRow(owner.uid, 'microsoft')).toEqual({ access_token: 'ms-new', refresh_token: 'ms-rotated' });
  });

  it('refuses when no refresh token is on file, without calling Microsoft', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-old' });

    const res = await refresh(owner.uid);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No Microsoft refresh token available');
    expect(googleCalls()).toHaveLength(0);
  });

  it('answers 404 for a token with no users row behind it', async () => {
    const res = await refresh('nobody-registered');

    expect(res.status).toBe(404);
    expect(googleCalls()).toHaveLength(0);
  });

  it('keeps the old token when Microsoft refuses the refresh', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-old', refreshToken: 'ms-refresh' });
    route(MS_TOKEN_URL, { status: 400, text: 'invalid_grant' });

    const res = await refresh(owner.uid);

    expect(res.status).toBe(500);
    expect(await tokenRow(owner.uid, 'microsoft')).toEqual({ access_token: 'ms-old', refresh_token: 'ms-refresh' });
  });
});

// ── reconnecting over an existing row ──────────────────────────────────────

/** Starts a connection for `provider` and returns what its callback needs. */
async function startConnect(provider: 'google' | 'microsoft') {
  const res = await owner.api.post(`${A}/connect-${provider}`).send({});
  expect(res.status).toBe(200);
  return { state: stateFrom(res.body.authUrl), cookie: cookieFrom(res) };
}

const finishConnect = (provider: 'google' | 'microsoft', state: string, cookie: string) =>
  request().get(`${A}/${provider}-callback?code=c&state=${state}`).set('Cookie', cookie);

describe('overlapping calendar account changes', () => {
  it('waits for a Google disconnect to finish revoking before exchanging a reconnect code', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'a-access', refreshToken: 'a-refresh', scope: GOOGLE_FULL_SCOPE,
      meta: { accountId: 'g-sub', accountEmail: 'person@gmail.com' },
    });
    const reconnect = await startConnect('google');
    const transport = { async revoke() { return { status: 200 }; } };
    const gate = gateMethod(transport, 'revoke');
    route(GOOGLE_REVOKE_URL, () => transport.revoke());
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });
    async function disconnect() { return owner.api.post(`${A}/unlink-google`).send({}); }
    async function connect() { return finishConnect('google', reconnect.state, reconnect.cookie); }
    const unlinking = disconnect();
    let connecting: ReturnType<typeof connect> | undefined;
    try {
      await gate.arrived(1);
      connecting = connect();
      for (let attempt = 0; await stateRow(reconnect.state); attempt++) {
        if (attempt === 100) throw new Error('Reconnect callback did not consume its state');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(gate.waiting()).toBe(1);
      expect(callsMatching(GOOGLE_TOKEN_URL)).toHaveLength(0);
      gate.open();
      expect((await unlinking).status).toBe(200);
      expect((await connecting).header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
      expect(await tokenRow(owner.uid, 'google')).toEqual({ access_token: 'g-access', refresh_token: 'g-refresh' });
    } finally {
      gate.restore();
      await unlinking;
      if (connecting) await connecting;
    }
  });

  it('orders overlapping reconnects to different accounts without combining their tokens', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'a-access', refreshToken: 'a-refresh', scope: GOOGLE_FULL_SCOPE,
      meta: { accountId: 'a-sub', accountEmail: 'a@gmail.com' },
    });
    const first = await startConnect('google');
    const second = await startConnect('google');
    const checkpoint = { async afterRead() {} };
    const gate = gateMethod(checkpoint, 'afterRead');
    const tokens = require('../../src/modules/calendar/shared/calendarTokens');
    const original = tokens.getConnectionRow;
    let paused = false;
    const spy = jest.spyOn(tokens, 'getConnectionRow').mockImplementation(async (...args: any[]) => {
      const row = await original(...args);
      if (!paused && !args[2]) {
        paused = true;
        await checkpoint.afterRead();
      }
      return row;
    });
    route(GOOGLE_TOKEN_URL, (call) => ({ json: call.body?.code === 'first'
      ? googleGrant({ access_token: 'a-new-access', refresh_token: undefined,
        id_token: jwt({ sub: 'a-sub', email: 'a@gmail.com' }) })
      : googleGrant({ access_token: 'b-access', refresh_token: 'b-refresh',
        id_token: jwt({ sub: 'b-sub', email: 'b@gmail.com' }) }) }));
    route(GOOGLE_REVOKE_URL, { status: 200 });
    async function finishFirst() {
      return request().get(`${A}/google-callback?code=first&state=${first.state}`).set('Cookie', first.cookie);
    }
    async function finishSecond() { return finishConnect('google', second.state, second.cookie); }
    const pending = finishFirst();
    let replacing: ReturnType<typeof finishSecond> | undefined;
    try {
      await gate.arrived(1);
      expect(gate.waiting()).toBe(1);
      replacing = finishSecond();
      for (let attempt = 0; await stateRow(second.state); attempt++) {
        if (attempt === 100) throw new Error('Second callback did not consume its state');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(callsMatching(GOOGLE_TOKEN_URL).map((call) => call.body.code)).toEqual(['first']);
      gate.open();
      expect((await pending).header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
      expect((await replacing).header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
      expect(await tokenRow(owner.uid, 'google')).toEqual({ access_token: 'b-access', refresh_token: 'b-refresh' });
      expect((await grantRow(owner.uid, 'google')).meta.accountId).toBe('b-sub');
    } finally {
      gate.restore();
      await pending;
      if (replacing) await replacing;
      spy.mockRestore();
    }
  });
});

async function seedLiveSync(provider: 'google' | 'microsoft') {
  await testPool.query(
    `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
     values ($1, $2, $3, $4, 'primary', 'res-old', 'secret', now() + interval '2 days')`,
    [provider === 'google' ? 'google' : 'outlook', provider === 'google' ? 'chan-old' : 'sub-old', owner.uid, firm.id],
  );
  const imported = await testPool.query(
    `insert into calendar_events (law_firm_id, title, provider, external_event_id, created_by)
     values ($1, 'Imported earlier', $2, 'ext-old', $3) returning id`,
    [firm.id, provider === 'google' ? 'google' : 'outlook', owner.uid],
  );
  return imported.rows[0].id as string;
}

const importKept = async (id: string) => (await testPool.query('select 1 from calendar_events where id = $1', [id])).rows.length === 1;
const subscriptionsOf = async (uid: string) => (await testPool.query(
  'select id from calendar_subscriptions where user_id = $1 order by id', [uid],
)).rows.map((r) => r.id);

/**
 * Token endpoint answers by grant type: the code exchange gets `exchange`, a
 * refresh of the stored token gets `refresh`.
 */
function routeTokenEndpoint(url: string, exchange: object, refresh: { status?: number; json?: object; text?: string }) {
  route(url, (call) => (call.body?.grant_type === 'refresh_token' ? refresh : { json: exchange }));
}

describe('a Google reconnect over a row of unknown identity', () => {
  const legacyRow = () => plantProviderToken(owner.uid, 'google', {
    accessToken: 'old-a', refreshToken: 'old-r', syncFromProvider: true, syncToProvider: true,
    scope: GOOGLE_FULL_SCOPE, meta: {}, syncCursor: 'cursor-old', calendarId: 'cal-old',
  });

  /**
   * Goes red if a legacy row is assumed to be a different account: the
   * reconnect would then stop the channel, delete the imports, turn sync off,
   * and revoke a grant that Google ends for the NEW token as well.
   */
  it('resolves the old grant through one refresh and keeps everything when it is the same account', async () => {
    await legacyRow();
    const imported = await seedLiveSync('google');
    const { state, cookie } = await startConnect('google');
    route('channels/stop', { status: 204 });
    route(GOOGLE_REVOKE_URL, { status: 200, json: {} });
    routeTokenEndpoint(GOOGLE_TOKEN_URL, googleGrant(), {
      json: { access_token: 'old-a2', scope: GOOGLE_FULL_SCOPE, id_token: jwt({ sub: 'g-sub', email: 'person@gmail.com' }) },
    });

    const res = await finishConnect('google', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    const refreshes = callsMatching(GOOGLE_TOKEN_URL).filter((c) => c.body.grant_type === 'refresh_token');
    expect(refreshes.map((c) => c.body.refresh_token)).toEqual(['old-r']);
    expect(callsMatching(GOOGLE_REVOKE_URL)).toHaveLength(0);
    expect(callsMatching('channels/stop')).toHaveLength(0);
    expect(await importKept(imported)).toBe(true);
    expect(await subscriptionsOf(owner.uid)).toEqual(['chan-old']);
    const grant = await grantRow(owner.uid, 'google');
    expect(grant).toMatchObject({
      access_token: 'g-access', refresh_token: 'g-refresh', sync_cursor: 'cursor-old', calendar_id: 'cal-old',
      is_sync_to_provider: true, is_sync_from_provider: true,
    });
    expect(grant.meta).toMatchObject({ accountId: 'g-sub' });
  });

  it('forgets the old connection and revokes it when the refresh names a different account', async () => {
    await legacyRow();
    const imported = await seedLiveSync('google');
    const { state, cookie } = await startConnect('google');
    route('channels/stop', { status: 204 });
    route(GOOGLE_REVOKE_URL, { status: 200, json: {} });
    routeTokenEndpoint(GOOGLE_TOKEN_URL, googleGrant(), {
      json: { access_token: 'old-a2', scope: GOOGLE_FULL_SCOPE, id_token: jwt({ sub: 'someone-else' }) },
    });

    const res = await finishConnect('google', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(callsMatching(GOOGLE_REVOKE_URL).map((c) => c.body)).toEqual([{ token: 'old-r' }]);
    expect(callsMatching('channels/stop')).toHaveLength(1);
    expect(await importKept(imported)).toBe(false);
    expect(await grantRow(owner.uid, 'google')).toMatchObject({
      access_token: 'g-access', refresh_token: 'g-refresh', sync_cursor: null, calendar_id: null,
      is_sync_to_provider: false, is_sync_from_provider: false,
    });
  });

  /**
   * A refused refresh means the old grant is already dead, so it is forgotten,
   * but never revoked: revoking it at Google would gain nothing and could end
   * the grant the person just gave. Goes red if the revoke still goes out.
   */
  it('forgets a dead old grant without revoking anything at Google', async () => {
    await legacyRow();
    const imported = await seedLiveSync('google');
    const { state, cookie } = await startConnect('google');
    route('channels/stop', { status: 204 });
    route(GOOGLE_REVOKE_URL, { status: 200, json: {} });
    routeTokenEndpoint(GOOGLE_TOKEN_URL, googleGrant(), { status: 400, json: { error: 'invalid_grant' } });

    const res = await finishConnect('google', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(callsMatching(GOOGLE_TOKEN_URL).filter((c) => c.body.grant_type === 'refresh_token')).toHaveLength(1);
    expect(callsMatching(GOOGLE_REVOKE_URL)).toHaveLength(0);
    expect(await importKept(imported)).toBe(false);
    const grant = await grantRow(owner.uid, 'google');
    expect(grant).toMatchObject({ access_token: 'g-access', refresh_token: 'g-refresh', is_sync_from_provider: false });
    expect(grant.meta.grantState).toBeNull();
  });

  /** Goes red if a provider outage is read as "a different account" and wipes the row. */
  it('refuses the reconnect and keeps the old row when the identity cannot be resolved', async () => {
    await legacyRow();
    const imported = await seedLiveSync('google');
    const before = await grantRow(owner.uid, 'google');
    const { state, cookie } = await startConnect('google');
    route(GOOGLE_REVOKE_URL, { status: 200, json: {} });
    routeTokenEndpoint(GOOGLE_TOKEN_URL, googleGrant(), { status: 503, text: 'unavailable' });

    const res = await finishConnect('google', state, cookie);

    expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=exchange_failed`);
    expect(callsMatching(GOOGLE_REVOKE_URL)).toHaveLength(0);
    expect(await importKept(imported)).toBe(true);
    expect(await grantRow(owner.uid, 'google')).toEqual(before);
  });

  /**
   * A popup sign-in's row holds an access token and no refresh token, so it
   * cannot be resolved. Its cursor, calendar and sync flags are not inherited
   * by whatever account connects next, and nothing is revoked on a guess.
   */
  it('forgets a popup-only row instead of letting the new account inherit its sync state', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'popup-a', syncFromProvider: true, syncToProvider: true,
      syncCursor: 'cursor-popup', calendarId: 'cal-popup',
    });
    const { state, cookie } = await startConnect('google');
    route(GOOGLE_REVOKE_URL, { status: 200, json: {} });
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const res = await finishConnect('google', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(await grantRow(owner.uid, 'google')).toMatchObject({
      access_token: 'g-access', refresh_token: 'g-refresh', sync_cursor: null, calendar_id: null,
      is_sync_to_provider: false, is_sync_from_provider: false,
    });
    expect(callsMatching(GOOGLE_REVOKE_URL)).toHaveLength(0);
  });

  /**
   * A row with no token at all holds only the sync choices the person made
   * before connecting, which belong to them rather than to any account. Goes
   * red if every existing row is forgotten.
   */
  it('keeps the sync choices on a row that never held a token', async () => {
    await testPool.query(
      `insert into user_oauth_tokens (user_id, provider, is_sync_to_provider) values ($1, 'google', true)`,
      [owner.uid],
    );
    const { state, cookie } = await startConnect('google');
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const res = await finishConnect('google', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(await grantRow(owner.uid, 'google')).toMatchObject({ access_token: 'g-access', is_sync_to_provider: true });
  });
});

describe('a Microsoft reconnect over a row of unknown identity', () => {
  const legacyRow = () => plantProviderToken(owner.uid, 'microsoft', {
    accessToken: 'old-a', refreshToken: 'old-r', syncFromProvider: true, syncToProvider: true,
    scope: 'Calendars.ReadWrite', meta: { outlookTimezone: 'America/New_York' }, calendarId: 'cal-old',
  });

  it('forgets an unproven old account when its refresh omits identity', async () => {
    await legacyRow();
    const imported = await seedLiveSync('microsoft');
    const { state, cookie } = await startConnect('microsoft');
    route('graph.microsoft.com/v1.0/subscriptions/sub-old', { status: 204 }, { method: 'DELETE' });
    routeTokenEndpoint(MS_TOKEN_URL, msGrant(), {
      json: { access_token: 'old-a2', refresh_token: 'old-r2', scope: MS_FULL_SCOPE },
    });

    const res = await finishConnect('microsoft', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?microsoft_connected=true`);
    expect(await importKept(imported)).toBe(false);
    expect(await grantRow(owner.uid, 'microsoft')).toMatchObject({
      access_token: 'ms-access', refresh_token: 'ms-refresh', calendar_id: null,
      is_sync_from_provider: false, is_sync_to_provider: false,
    });
    expect(callsMatching('subscriptions/sub-old')).toHaveLength(1);
  });

  it('resolves the old grant through one refresh and keeps everything when it is the same account', async () => {
    await legacyRow();
    const imported = await seedLiveSync('microsoft');
    const { state, cookie } = await startConnect('microsoft');
    route('graph.microsoft.com/v1.0/subscriptions/sub-old', { status: 204 }, { method: 'DELETE' });
    routeTokenEndpoint(MS_TOKEN_URL, msGrant(), {
      json: {
        access_token: 'old-a2', refresh_token: 'old-r2', scope: MS_FULL_SCOPE,
        id_token: jwt({ tid: 'tenant-1', oid: 'object-1' }),
      },
    });

    const res = await finishConnect('microsoft', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?microsoft_connected=true`);
    const refreshes = callsMatching(MS_TOKEN_URL).filter((c) => c.body.grant_type === 'refresh_token');
    expect(refreshes.map((c) => c.body.refresh_token)).toEqual(['old-r']);
    expect(callsMatching('subscriptions/sub-old')).toHaveLength(0);
    expect(await importKept(imported)).toBe(true);
    expect(await subscriptionsOf(owner.uid)).toEqual(['sub-old']);
    const grant = await grantRow(owner.uid, 'microsoft');
    expect(grant).toMatchObject({
      access_token: 'ms-access', refresh_token: 'ms-refresh', calendar_id: 'cal-old',
      is_sync_to_provider: true, is_sync_from_provider: true,
    });
    expect(grant.meta).toMatchObject({ accountId: 'tenant-1:object-1', outlookTimezone: 'America/New_York' });
  });

  it('forgets the old connection when the refresh names a different account', async () => {
    await legacyRow();
    const imported = await seedLiveSync('microsoft');
    const { state, cookie } = await startConnect('microsoft');
    route('graph.microsoft.com/v1.0/subscriptions/sub-old', { status: 204 }, { method: 'DELETE' });
    routeTokenEndpoint(MS_TOKEN_URL, msGrant(), {
      json: { access_token: 'old-a2', scope: MS_FULL_SCOPE, id_token: jwt({ tid: 'tenant-1', oid: 'object-a' }) },
    });

    const res = await finishConnect('microsoft', state, cookie);

    expect(res.header.location).toBe(`${FRONTEND}/dashboard?microsoft_connected=true`);
    expect(callsMatching('subscriptions/sub-old')).toHaveLength(1);
    expect(await importKept(imported)).toBe(false);
    const grant = await grantRow(owner.uid, 'microsoft');
    expect(grant).toMatchObject({ access_token: 'ms-access', calendar_id: null, is_sync_from_provider: false });
    expect(grant.meta.outlookTimezone).toBeUndefined();
  });
});

describe('a reconnect whose write fails', () => {
  /**
   * The forget and the save are one transaction, and the provider calls that
   * end the old connection run only after it commits. Goes red if the old
   * grant is deleted, revoked or its channel stopped before the save is known
   * to have landed.
   */
  it('leaves the old connection whole and makes no revoke or stop call', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'a-access', refreshToken: 'a-refresh', syncFromProvider: true, syncToProvider: true,
      scope: GOOGLE_FULL_SCOPE, meta: { accountId: 'a-sub', accountEmail: 'a@gmail.com' },
      syncCursor: 'cursor-a', calendarId: 'cal-a',
    });
    const imported = await seedLiveSync('google');
    const before = await grantRow(owner.uid, 'google');
    const { state, cookie } = await startConnect('google');
    route('channels/stop', { status: 204 });
    route(GOOGLE_REVOKE_URL, { status: 200, json: {} });
    route(GOOGLE_TOKEN_URL, { json: googleGrant({ id_token: jwt({ sub: 'b-sub', email: 'b@gmail.com' }) }) });
    const calendarTokens = require('../../src/modules/calendar/shared/calendarTokens');
    const failing = jest.spyOn(calendarTokens, 'updateTokenMeta').mockRejectedValueOnce(new Error('write failed'));

    try {
      const res = await finishConnect('google', state, cookie);
      expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=exchange_failed`);
      expect(failing).toHaveBeenCalled();
    } finally {
      failing.mockRestore();
    }

    expect(await grantRow(owner.uid, 'google')).toEqual(before);
    expect(await importKept(imported)).toBe(true);
    expect(await subscriptionsOf(owner.uid)).toEqual(['chan-old']);
    expect(callsMatching(GOOGLE_REVOKE_URL)).toHaveLength(0);
    expect(callsMatching('channels/stop')).toHaveLength(0);
  });
});

describe('a disconnect racing a refresh', () => {
  /**
   * The refresh is held at Microsoft while the disconnect runs. Goes red if the
   * refresh's write can recreate the row the disconnect removed, which leaves a
   * "disconnected" person holding live tokens.
   */
  it('leaves no row once both finish', async () => {
    await plantProviderToken(owner.uid, 'microsoft', {
      accessToken: 'ms-old', refreshToken: 'ms-refresh', scope: 'Calendars.ReadWrite', meta: { accountId: 'tenant-1:object-1' },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    route(MS_TOKEN_URL, async () => {
      await held;
      return { json: { access_token: 'ms-new', refresh_token: 'ms-rotated', scope: MS_FULL_SCOPE } };
    });

    const refreshing = request().post(`${A}/refresh-microsoft-token`).send({ token: tokenFor({ uid: owner.uid }) }).then((r) => r);
    await waitForCall(MS_TOKEN_URL);
    let unlinked = false;
    const unlinking = owner.api.post(`${A}/unlink-microsoft`).send({}).then((r) => { unlinked = true; return r; });
    // Give an unserialized disconnect time to finish while the refresh is still held.
    const deadline = Date.now() + 500;
    while (!unlinked && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [, unlink] = await Promise.all([refreshing, unlinking]);

    expect(unlink.status).toBe(200);
    expect(await grantRow(owner.uid, 'microsoft')).toBeNull();
  });
});

describe('the state cookie on a secure request', () => {
  /**
   * Over HTTPS the cookie carries the `__Host-` prefix, which the browser only
   * accepts as Secure, host-only and on path `/`, so no sibling subdomain can
   * plant or overwrite it. Goes red if the name, Secure or the path regress.
   */
  it('is a __Host- cookie on path /, and the callback reads it back', async () => {
    const res = await owner.api.post(`${A}/connect-google`).set('X-Forwarded-Proto', 'https').send({});
    expect(res.status).toBe(200);
    const set = setCookies(res).find((c) => c.startsWith('__Host-plx_oauth_state=')) || '';
    expect(set).toMatch(/; Path=\/(;|$)/);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).not.toMatch(/Domain=/i);
    expect(setCookies(res).some((c) => c.startsWith(`${STATE_COOKIE}=`))).toBe(false);
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });

    const cb = await request()
      .get(`${A}/google-callback?code=c&state=${stateFrom(res.body.authUrl)}`)
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', set.split(';')[0]);

    expect(cb.header.location).toBe(`${FRONTEND}/dashboard?google_connected=true`);
    expect(setCookies(cb).some((c) => c.startsWith('__Host-plx_oauth_state=;'))).toBe(true);
  });
});

describe('a callback whose database write fails', () => {
  /**
   * A Drizzle error names the failed query's parameters in its message, and
   * here those are the tokens. Goes red if the callback logs the error object
   * or its message instead of a fixed line and the error code.
   */
  it('logs neither token', async () => {
    const util = require('util');
    const calendarTokens = require('../../src/modules/calendar/shared/calendarTokens');
    const { state, cookie } = await startConnect('google');
    route(GOOGLE_TOKEN_URL, { json: googleGrant() });
    const failure = Object.assign(new Error('Failed query: insert into user_oauth_tokens\nparams: u,google,g-access,g-refresh'), {
      cause: { code: '23505' },
    });
    const failing = jest.spyOn(calendarTokens, 'saveTokens').mockRejectedValueOnce(failure);
    const logged: string[] = [];
    const capture = (...args: unknown[]) => { logged.push(args.map((a) => util.inspect(a, { depth: 5 })).join(' ')); };
    const errors = jest.spyOn(console, 'error').mockImplementation(capture);
    const warns = jest.spyOn(console, 'warn').mockImplementation(capture);

    try {
      const res = await finishConnect('google', state, cookie);
      expect(location(res)).toBe(`${FRONTEND}/dashboard?google_error=exchange_failed`);
      expect(failing).toHaveBeenCalled();
    } finally {
      failing.mockRestore();
      errors.mockRestore();
      warns.mockRestore();
    }

    expect(logged.join('\n')).toContain('23505');
    expect(logged.join('\n')).not.toMatch(/g-access|g-refresh/);
  });
});
