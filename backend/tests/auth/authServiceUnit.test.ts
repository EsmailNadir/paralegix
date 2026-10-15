/**
 * The authenticated half of `/api/auth`: who the caller is, the record they
 * create for themselves, their own settings, and the calendar-provider links.
 *
 * `tests/auth/registrationAndInvites.test.ts` covers the registration and invite
 * flows. This file covers what an already-signed-in caller can do to their OWN
 * account, and the two rules that stop them doing it to somebody else's:
 *
 *   IDENTITY COMES FROM THE TOKEN, NEVER THE BODY. Every route here derives the
 *   subject from `req.user.uid`. `create-user` is the one that takes an email in
 *   the body, and it refuses any address but the authenticated one, so a caller
 *   cannot mint or overwrite a record for an address they do not hold.
 *
 *   ACCOUNT TYPE IS IMMUTABLE ONCE SET. `firm_member` and `client` reach
 *   different halves of the product, so a self-service flip is a privilege
 *   change. Only 'pending' may be resolved.
 *
 * The response SHAPES are asserted rather than just the status, because the
 * frontend reads specific keys off each one: a route that answered 200 with an
 * empty body would pass a status-only test and break every caller.
 */
import { randomUUID } from 'crypto';
import {
  testPool,
  createFirm,
  ownerOf,
  as,
  request,
  tokenFor,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { userRow } from '../support/rows';

let firm: Firm;
let owner: Actor;

/** A signed-in caller who has no `users` row yet. */
function strangerWith(email: string) {
  const uid = `new-user-${randomUUID().slice(0, 8)}`;
  return { uid, api: as(tokenFor({ uid, email })) };
}

beforeEach(async () => {
  firm = await createFirm({ name: 'Auth Test Firm' });
  owner = await ownerOf(firm.id);
});

describe('GET /user-type', () => {
  it('reports the caller own type and that they need no registration', async () => {
    const res = await owner.api.get('/api/auth/user-type');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userType: 'firm_member', needsRegistration: false });
  });

  it('reports a client as a client, not as a firm member', async () => {
    // The two types reach different halves of the product, and the frontend
    // routes on this single field. A handler that returned a constant would pass
    // the case above on its own.
    const uid = `portal-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Portal Person', 'client')`,
      [uid, `${uid}@example.test`],
    );

    const res = await as(tokenFor({ uid })).get('/api/auth/user-type');

    expect(res.body).toEqual({ userType: 'client', needsRegistration: false });
  });

  it('flags a pending account as needing registration', async () => {
    const uid = `pending-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Half Signed Up', 'pending')`,
      [uid, `${uid}@example.test`],
    );

    const res = await as(tokenFor({ uid })).get('/api/auth/user-type');

    // The /verify-email page polls this to decide whether to send the caller
    // through registration. Getting `needsRegistration` wrong strands a real
    // person on that screen.
    expect(res.body).toEqual({ userType: 'pending', needsRegistration: true });
  });

  it('answers 404 for a token with no users row behind it', async () => {
    const res = await strangerWith('nobody@example.test').api.get('/api/auth/user-type');

    // Characterises the answer a brand-new Firebase identity gets BEFORE
    // `create-user` runs. It is a 404 rather than a synthesised 'pending', so a
    // caller cannot tell "not registered" from "registered as pending" by status
    // alone, and the frontend has to handle both.
    expect(res.status).toBe(404);
  });

  it('refuses a request carrying no token', async () => {
    // `request()` is the anonymous agent: `as()` always attaches a bearer header,
    // so it cannot express this case at all.
    const res = await request().get('/api/auth/user-type');

    expect(res.status).toBe(401);
  });
});

describe('POST /create-user', () => {
  it('writes the users row for the authenticated caller', async () => {
    const stranger = strangerWith('created@example.test');

    const res = await stranger.api.post('/api/auth/create-user').send({
      email: 'created@example.test',
      name: 'Jane Candidate',
      userType: 'firm_member',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: stranger.uid });
    // The row, not the response. The response is a message; the row is what
    // every later request resolves the caller against.
    expect(await userRow(stranger.uid)).toMatchObject({
      email: 'created@example.test',
      name: 'Jane Candidate',
      user_type: 'firm_member',
    });
  });

  it('refuses an email that is not the authenticated one, and writes nothing', async () => {
    const stranger = strangerWith('mine@example.test');

    const res = await stranger.api.post('/api/auth/create-user').send({
      email: 'someone.else@example.test',
      name: 'Not Me',
      userType: 'firm_member',
    });

    // The whole guard. Without it a signed-in caller could create or claim the
    // record for any address, which is how an invite addressed to that address
    // would then be consumed.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
    expect(await userRow(stranger.uid)).toBeNull();
    const { rows } = await testPool.query(
      'select 1 from users where email = $1', ['someone.else@example.test'],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to flip an account type that is already set', async () => {
    const stranger = strangerWith('settled@example.test');
    await stranger.api.post('/api/auth/create-user').send({
      email: 'settled@example.test', name: 'Settled', userType: 'client',
    });

    const flip = await stranger.api.post('/api/auth/create-user').send({
      email: 'settled@example.test', name: 'Settled', userType: 'firm_member',
    });

    // `client` and `firm_member` are answered by different halves of the API, so
    // a self-service flip is a privilege change. The row must be unmoved.
    expect(flip.status).toBe(400);
    expect(await userRow(stranger.uid)).toMatchObject({ user_type: 'client' });
  });

  it('resolves a pending account rather than refusing it', async () => {
    // The one type transition that IS allowed, and the reason the guard above
    // cannot simply be "reject any second call".
    const uid = `pending-${randomUUID().slice(0, 8)}`;
    await testPool.query(
      `insert into users (id, email, name, user_type) values ($1, $2, 'Half Signed Up', 'pending')`,
      [uid, `${uid}@example.test`],
    );

    const res = await as(tokenFor({ uid })).post('/api/auth/create-user').send({
      email: `${uid}@example.test`, name: 'Now Decided', userType: 'firm_member',
    });

    expect(res.status).toBe(200);
    expect(await userRow(uid)).toMatchObject({ user_type: 'firm_member' });
  });

  it('rejects a body with no userType', async () => {
    const stranger = strangerWith('nofields@example.test');

    const res = await stranger.api.post('/api/auth/create-user').send({
      email: 'nofields@example.test',
    });

    expect(res.status).toBe(400);
    expect(await userRow(stranger.uid)).toBeNull();
  });

  it('rejects a userType outside the allowed pair', async () => {
    const stranger = strangerWith('admin@example.test');

    const res = await stranger.api.post('/api/auth/create-user').send({
      email: 'admin@example.test', userType: 'admin',
    });

    // The enum is the only thing between a self-service signup and an arbitrary
    // user_type string, and `pending` is deliberately not offerable here either.
    expect(res.status).toBe(400);
    expect(await userRow(stranger.uid)).toBeNull();
  });
});

describe('GET and POST /api/settings/user', () => {
  // The four sync directions live in typed `user_settings` columns, not in the
  // preferences jsonb: `calendarTokens.getSettings` reads the columns and lets
  // them override same-named jsonb keys, so a toggle that only reached the jsonb
  // would read back correctly and still leave the sync engines on the old value.
  // Every case below goes through the HTTP route for that reason.
  const readSettings = () => owner.api.get('/api/settings/user');
  const writeSettings = (actor: Actor, preferences: Record<string, unknown>) =>
    actor.api.post('/api/settings/user').send({ preferences });

  it('round-trips the sync toggles', async () => {
    const saved = await writeSettings(owner, {
      allowParalegixToGoogleSync: true,
      allowGoogleToParalegixSync: false,
      googleCalendarTarget: 'paralegix',
    });

    const res = await readSettings();

    expect(saved.status).toBe(200);
    // `false` is asserted alongside `true`: a write that stored every named key
    // as truthy would pass a test that only checked the enabled one.
    expect(res.body.preferences.allowParalegixToGoogleSync).toBe(true);
    expect(res.body.preferences.allowGoogleToParalegixSync).toBe(false);
    expect(res.body.preferences.googleCalendarTarget).toBe('paralegix');
  });

  it('lands a sync toggle where the calendar engines read it', async () => {
    await writeSettings(owner, { allowParalegixToGoogleSync: true });

    // The engines never read the route's response; they call
    // `calendarTokens.getSettings`. Asserting the column directly is what
    // separates "the API echoed it back" from "sync will actually run".
    const { rows } = await testPool.query(
      `select is_sync_to_provider as allow_paralegix_to_google_sync
         from user_oauth_tokens where user_id = $1 and provider = 'google'`,
      [owner.uid],
    );
    expect(rows[0]?.allow_paralegix_to_google_sync).toBe(true);
  });

  it('keeps unmentioned settings when only one is written', async () => {
    await writeSettings(owner, { allowParalegixToGoogleSync: true });

    await writeSettings(owner, { allowOutlookToParalegixSync: true });

    // A whole-row overwrite instead of a patch would silently switch the first
    // toggle back off, and nothing on the screen would say so.
    const res = await readSettings();
    expect(res.body.preferences.allowParalegixToGoogleSync).toBe(true);
    expect(res.body.preferences.allowOutlookToParalegixSync).toBe(true);
  });

  it('rejects a calendar target outside the allowed pair', async () => {
    const res = await writeSettings(owner, { googleCalendarTarget: 'somewhere-else' });

    expect(res.status).toBe(400);
    expect((await readSettings()).body.preferences.googleCalendarTarget).toBeUndefined();
  });

  it('does not let one caller read or write another caller settings', async () => {
    const other = await ownerOf((await createFirm({ name: 'Neighbour LLP' })).id);
    await writeSettings(other, { allowParalegixToGoogleSync: true });

    await writeSettings(owner, { allowOutlookToParalegixSync: true });

    // Both rows are keyed on the token's uid alone, so there is no id a caller
    // could aim elsewhere. This proves the two rows really are separate rather
    // than one shared row the last writer wins.
    const mine = await readSettings();
    const theirs = await other.api.get('/api/settings/user');
    expect(mine.body.preferences.allowParalegixToGoogleSync).toBe(false);
    expect(mine.body.preferences.allowOutlookToParalegixSync).toBe(true);
    expect(theirs.body.preferences.allowParalegixToGoogleSync).toBe(true);
    expect(theirs.body.preferences.allowOutlookToParalegixSync).toBe(false);
  });
});

/**
 * Plant a provider token the way the OAuth callback does, straight into
 * `user_oauth_tokens`.
 *
 * There is no HTTP route that accepts a raw token any more: the client-supplied
 * `/auth/update-{google,microsoft}-token` pair was removed in favour of the
 * server-side code exchange (`/auth/connect-{google,microsoft}`), which a test
 * cannot drive without a real provider. Writing the row is the same end state
 * that exchange reaches, and it is what `check-microsoft` reads.
 */
async function plantProviderToken(
  uid: string,
  provider: 'google' | 'microsoft',
  { accessToken, refreshToken }: { accessToken: string; refreshToken?: string },
) {
  await testPool.query(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, token_updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (user_id, provider) do update set
       access_token = excluded.access_token,
       refresh_token = coalesce(excluded.refresh_token, user_oauth_tokens.refresh_token),
       token_updated_at = now()`,
    [uid, provider, accessToken, refreshToken ?? null],
  );
}

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

describe('the calendar provider links', () => {
  // Disconnecting Google calls Google's revoke endpoint, so no case here may
  // reach the real network. A case that cares about the answer overrides this.
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
  });
  afterEach(() => fetchSpy.mockRestore());

  const revokeCalls = () => fetchSpy.mock.calls.filter(([url]) => url === GOOGLE_REVOKE_URL);

  it('reports no Microsoft token before one is stored', async () => {
    const res = await owner.api.get('/api/auth/check-microsoft');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasMicrosoftToken: false, tokenUpdatedAt: null });
  });

  it('reports the Microsoft token once one is stored', async () => {
    await plantProviderToken(owner.uid, 'microsoft', {
      accessToken: 'ms-access-token', refreshToken: 'ms-refresh-token',
    });

    const res = await owner.api.get('/api/auth/check-microsoft');

    // The negative case above passes against a handler that always says false.
    // This is the one that tells them apart.
    expect(res.body.hasMicrosoftToken).toBe(true);
    expect(res.body.tokenUpdatedAt).toEqual(expect.any(String));
  });

  it('treats a freshly stored token as calendar access that needs no reauth', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-access-token' });

    const res = await owner.api.get('/api/auth/check-calendar-access');

    // `tokenLikelyValid` is an age check, so a token written moments ago has to
    // come back valid. A broken age computation surfaces as a reauth prompt on
    // every page load.
    expect(res.body).toMatchObject({
      hasCalendarAccess: true,
      tokenLikelyValid: true,
      needsReauth: false,
    });
  });

  it('asks for reauth when the stored token is old', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-access-token' });
    await testPool.query(
      `update user_oauth_tokens set token_updated_at = now() - interval '3 hours'
        where user_id = $1 and provider = 'microsoft'`,
      [owner.uid],
    );

    const res = await owner.api.get('/api/auth/check-calendar-access');

    // The other side of the one-hour window. Without this case the freshness
    // check could be missing entirely and both tests above would still pass.
    expect(res.body).toMatchObject({
      hasCalendarAccess: true,
      tokenLikelyValid: false,
      needsReauth: true,
    });
  });

  it('removes the Microsoft token and its sync flags on unlink', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-access-token' });
    await owner.api.post('/api/settings/user')
      .send({ preferences: { allowOutlookToParalegixSync: true } });

    const res = await owner.api.post('/api/auth/unlink-microsoft').send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Three separate things have to move: the token row, the connected flag, and
    // both sync toggles. A leftover toggle keeps the sync engine trying against
    // credentials that are gone.
    expect((await owner.api.get('/api/auth/check-microsoft')).body.hasMicrosoftToken).toBe(false);
    const settings = await owner.api.get('/api/settings/user');
    expect(settings.body.preferences.loggedInWithMicrosoft).toBe(false);
    expect(settings.body.preferences.allowOutlookToParalegixSync).toBe(false);
    const { rows } = await testPool.query(
      `select 1 from user_oauth_tokens where user_id = $1 and provider = 'microsoft'`,
      [owner.uid],
    );
    expect(rows).toHaveLength(0);
  });

  it('removes the Google token and its sync flags on unlink', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'g-access-token', refreshToken: 'g-refresh-token',
    });
    await owner.api.post('/api/settings/user')
      .send({ preferences: { allowGoogleToParalegixSync: true } });

    const res = await owner.api.post('/api/auth/unlink-google').send({});

    expect(res.status).toBe(200);
    const settings = await owner.api.get('/api/settings/user');
    expect(settings.body.preferences.loggedInWithGoogle).toBe(false);
    expect(settings.body.preferences.allowGoogleToParalegixSync).toBe(false);
    const { rows } = await testPool.query(
      `select 1 from user_oauth_tokens where user_id = $1 and provider = 'google'`,
      [owner.uid],
    );
    expect(rows).toHaveLength(0);
  });

  /**
   * Disconnect ends the grant at Google too, so the person's Google account no
   * longer lists Paralegix as having calendar access. Goes red if the revoke
   * call is removed, or if it is sent after the row (and so the token) is gone.
   */
  it('revokes the Google grant before removing it', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'g-access-token', refreshToken: 'g-refresh-token',
    });

    const res = await owner.api.post('/api/auth/unlink-google').send({});

    expect(res.status).toBe(200);
    const calls = revokeCalls();
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('token=g-refresh-token');
    expect((await testPool.query(
      `select 1 from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    )).rows).toHaveLength(0);
  });

  it.each([
    ['refuses the revoke', () => fetchSpy.mockImplementation(async () => new Response('backend error', { status: 500 }))],
    ['cannot be reached', () => fetchSpy.mockImplementation(async () => { throw new Error('ECONNRESET'); })],
  ])('still disconnects when Google %s', async (_label, arrange) => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'g-access-token', refreshToken: 'g-refresh-token',
    });
    arrange();

    const res = await owner.api.post('/api/auth/unlink-google').send({});

    expect(res.status).toBe(200);
    expect(revokeCalls()).toHaveLength(1);
    expect((await testPool.query(
      `select 1 from user_oauth_tokens where user_id = $1 and provider = 'google'`, [owner.uid],
    )).rows).toHaveLength(0);
  });

  it('makes no revoke call when disconnecting Microsoft', async () => {
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'ms-access-token', refreshToken: 'ms-refresh' });

    const res = await owner.api.post('/api/auth/unlink-microsoft').send({});

    // Microsoft has no per-app revoke for delegated tokens; deleting is all there is.
    expect(res.status).toBe(200);
    expect(revokeCalls()).toHaveLength(0);
  });

  /**
   * Disconnecting Google must stop the remote channel while the bearer token
   * still exists. Deleting the token first makes `channels/stop` impossible,
   * leaving Google to deliver notifications until the seven-day channel ttl.
   *
   * Goes red if `unlinkGoogle` drops its stop-before-delete call, changes the
   * channel's resource id, or stops deleting the local channel row after the
   * remote stop succeeds.
   */
  it('stops the caller Google watch channel before unlinking its token', async () => {
    await plantProviderToken(owner.uid, 'google', {
      accessToken: 'g-access-token', refreshToken: 'g-refresh-token',
    });

    const channelId = `unlink-channel-${randomUUID().slice(0, 8)}`;
    const resourceId = 'unlink-resource';
    const seeded = await testPool.query(
      `insert into calendar_subscriptions (provider, id, user_id, law_firm_id, calendar_id, resource, secret, expiration)
       values ('google', $1, $2, $3, 'primary', $4, 'watch-secret', now() + interval '7 days')`,
      [channelId, owner.uid, firm.id, resourceId],
    );
    expect(seeded.rowCount).toBe(1);

    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const res = await owner.api.post('/api/auth/unlink-google').send({});

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://www.googleapis.com/calendar/v3/channels/stop',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer g-access-token' }),
          body: JSON.stringify({ id: channelId, resourceId }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }

    expect((await testPool.query(
      `select id from calendar_subscriptions where provider = 'google' and id = $1`, [channelId],
    )).rows).toHaveLength(0);
    expect((await testPool.query(
      `select dedupe_key from calendar_sync_failures
        where kind = 'stop_channel' and dedupe_key = $1`, [channelId],
    )).rows).toHaveLength(0);
  });

  it('unlinks only the caller own provider tokens', async () => {
    const other = await ownerOf((await createFirm({ name: 'Neighbour LLP' })).id);
    await plantProviderToken(other.uid, 'microsoft', { accessToken: 'their-token' });
    await plantProviderToken(owner.uid, 'microsoft', { accessToken: 'my-token' });

    await owner.api.post('/api/auth/unlink-microsoft').send({});

    // The delete is scoped by uid alone, so a lost predicate would empty the
    // table for everybody and nothing on the caller's own screen would show it.
    expect((await other.api.get('/api/auth/check-microsoft')).body.hasMicrosoftToken).toBe(true);
  });
});

describe('the Google OAuth callback', () => {
  it('redirects to the settings page carrying the provider error', async () => {
    const res = await owner.api.get('/api/auth/google-callback?error=access_denied');

    expect(res.status).toBe(302);
    expect(res.header.location).toContain('google_error=access_denied');
  });

  it('redirects rather than erroring when the code and state are missing', async () => {
    const res = await owner.api.get('/api/auth/google-callback');

    // This lands in a browser address bar, so a 400 would show the user a raw
    // JSON error page. Every failure path has to end at a real screen.
    expect(res.status).toBe(302);
    expect(res.header.location).toContain('google_error=');
  });

  it('redirects with an error rather than trusting an unknown state', async () => {
    const res = await owner.api.get('/api/auth/google-callback?code=abc&state=not-a-real-state');

    // `state` is the CSRF defence: it must be one this server minted. Accepting
    // an unknown one would let a third party complete an OAuth link into
    // somebody else's account.
    expect(res.status).toBe(302);
    expect(res.header.location).toContain('google_error=');
    const { rows } = await testPool.query(
      `select 1 from user_oauth_tokens where user_id = $1 and provider = 'google'`,
      [owner.uid],
    );
    expect(rows).toHaveLength(0);
  });
});
