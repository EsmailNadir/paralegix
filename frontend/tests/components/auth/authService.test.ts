/**
 * The frontend auth service, tested OFFLINE against a fake transport.
 *
 * `auth.service.ts` reports 0%. It is the layer that decides whether a person
 * gets into the app, which app they get into, and whether they are sent to
 * finish registering. A mistake here does not corrupt data; it lets the wrong
 * person past a gate, or strands a legitimate one outside it.
 *
 * Only the methods that talk to the API are covered. The Firebase SDK calls
 * (`signIn`, `signUp`, `signInWithGoogle`) go through the global mock in
 * `tests/setup.ts` and would be testing that mock rather than this module.
 *
 * THE HEADLINE FINDING is `checkRegistrationStatus`, which swallows every
 * failure and answers "no registration needed". That is characterised below
 * rather than changed, because failing the other way has its own cost.
 */
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import authService from '@/services/auth.service';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('checkRegistrationStatus', () => {
  it('reports a user who still needs to register', async () => {
    api.get('/auth/user-type', { needsRegistration: true, userType: 'client' });

    const result = await authService.checkRegistrationStatus();

    // The OAuth path lands here: Firebase has authenticated the person, but the
    // product has never seen them. Answering wrongly sends them to a dashboard
    // with no account behind it.
    expect(result.needsRegistration).toBe(true);
    expect(result.userType).toBe('client');
  });

  it('reports a registered user as not needing it', async () => {
    api.get('/auth/user-type', { needsRegistration: false, userType: 'firm_member' });

    const result = await authService.checkRegistrationStatus();

    // The negative half. Without it, a method that always said "true" would
    // satisfy the case above and send every returning user back through
    // registration.
    expect(result.needsRegistration).toBe(false);
    expect(result.userType).toBe('firm_member');
  });

  it('defaults a MISSING needsRegistration to false', async () => {
    api.get('/auth/user-type', { userType: 'client' });

    // `undefined` would be falsy at the call site anyway, but it would also fail
    // any strict comparison a caller writes. Normalising to a boolean here is
    // what makes `=== false` safe upstream.
    expect((await authService.checkRegistrationStatus()).needsRegistration).toBe(false);
  });

  it('CHARACTERISATION: answers "no registration needed" when the request FAILS', async () => {
    api.get('/auth/user-type', { status: 500, body: { error: 'Server error' } });

    const result = await authService.checkRegistrationStatus();

    // Fail-open. A 500, a network error and a thrown exception all produce the
    // same answer as a successful "you are registered", so a user with no
    // account is waved through to a dashboard where every request then fails.
    //
    // The other direction has a real cost too: failing closed would push a
    // fully-registered user back through registration whenever the API hiccups,
    // which is the more common event. So this is a deliberate trade rather than
    // an oversight, and it is recorded so the trade is visible and this test
    // goes red if someone flips it.
    expect(result.needsRegistration).toBe(false);
  });

  it('CHARACTERISATION: answers the same on a 403', async () => {
    api.get('/auth/user-type', { status: 403, body: { error: 'Forbidden' } });

    // Worth its own case, because a 403 is the response a revoked or
    // unauthorised account gets, and it is treated identically to success.
    expect((await authService.checkRegistrationStatus()).needsRegistration).toBe(false);
  });

  it('sends the Authorization header', async () => {
    api.get('/auth/user-type', { needsRegistration: false });

    await authService.checkRegistrationStatus();

    // This route answers with the caller's own account state, so it has to say
    // who is asking. Without the header the server cannot scope the answer.
    expect(api.calls('GET')[0].headers.authorization).toMatch(/^Bearer /);
  });
});

describe('completeOAuthRegistration', () => {
  it('POSTs the chosen user type with the token', async () => {
    api.post('/auth/complete-registration', { userData: { id: 'u1', userType: 'client' } });

    await authService.completeOAuthRegistration('client');

    // The user type decides which application the person lands in. It travels in
    // the BODY here rather than being inferred server-side, because at this
    // point the account does not exist yet to infer it from.
    const body = api.calls('POST')[0].body as Record<string, unknown>;
    expect(body.userType).toBe('client');
    expect(body.token).toBeTruthy();
  });

  it('sends firm_member when that is chosen', async () => {
    api.post('/auth/complete-registration', { userData: { id: 'u1' } });

    await authService.completeOAuthRegistration('firm_member');

    // The negative half of the case above: a method that hardcoded 'client'
    // would satisfy it and put every new firm member into the client portal.
    expect((api.calls('POST')[0].body as Record<string, unknown>).userType)
      .toBe('firm_member');
  });

  it('returns the created user record', async () => {
    api.post('/auth/complete-registration', {
      userData: { id: 'u1', name: 'New Person', userType: 'client' },
    });

    const result = await authService.completeOAuthRegistration('client');

    expect(result.userData.id).toBe('u1');
  });

  it('THROWS when registration is refused', async () => {
    api.post('/auth/complete-registration', {
      status: 400, body: { error: 'Authenticated user does not match requested email' },
    });

    // Registration failing silently is the worst outcome here: the caller
    // proceeds as though an account exists, and the person is left in a state
    // the product cannot describe.
    await expect(authService.completeOAuthRegistration('client'))
      .rejects.toThrow(/does not match/i);
  });

  it('carries the server message rather than a generic one', async () => {
    api.post('/auth/complete-registration', {
      status: 409, body: { error: 'That email is already registered to another firm' },
    });

    await expect(authService.completeOAuthRegistration('firm_member'))
      .rejects.toThrow(/already registered to another firm/i);
  });
});

describe('updateName', () => {
  it('PUTs the trimmed name', async () => {
    api.put('/users/update-name', { message: 'Updated', name: 'Pat Person' });

    await authService.updateName('  Pat Person  ');

    // Trimmed before sending, so the stored name does not carry the user's stray
    // spaces into every screen and every document that renders it.
    expect((api.calls('PUT')[0].body as Record<string, unknown>).name).toBe('Pat Person');
  });

  it('refuses an empty name', async () => {
    await expect(authService.updateName('')).rejects.toThrow(/required/i);

    // Refused BEFORE any request. A blank display name makes a person
    // unidentifiable in every assignment list and audit entry.
    expect(api.calls()).toHaveLength(0);
  });

  it('refuses a whitespace-only name', async () => {
    await expect(authService.updateName('   ')).rejects.toThrow(/required/i);

    // `min length 1` on the raw string would accept this. The check has to trim
    // first, which is the same rule the backend applies to client and matter
    // names.
    expect(api.calls()).toHaveLength(0);
  });

  it('refuses a name over the length cap', async () => {
    await expect(authService.updateName('x'.repeat(101))).rejects.toThrow(/less than 100/i);

    expect(api.calls()).toHaveLength(0);
  });

  it('ACCEPTS a name exactly at the cap', async () => {
    api.put('/users/update-name', { message: 'Updated', name: 'x'.repeat(100) });

    await authService.updateName('x'.repeat(100));

    // The boundary. An off-by-one here refuses a name the rule allows, and the
    // user cannot tell why.
    expect(api.calls('PUT')).toHaveLength(1);
  });

  it('measures the cap AFTER trimming', async () => {
    api.put('/users/update-name', { message: 'Updated', name: 'x'.repeat(100) });

    await authService.updateName(`   ${'x'.repeat(100)}   `);

    // A hundred characters surrounded by spaces is a hundred characters. Testing
    // the untrimmed length would refuse it.
    expect(api.calls('PUT')).toHaveLength(1);
  });

  it('throws when the server refuses the update', async () => {
    api.put('/users/update-name', { status: 403, body: { error: 'Forbidden' } });

    await expect(authService.updateName('Pat Person')).rejects.toBeDefined();
  });

  it('sends the Authorization header', async () => {
    api.put('/users/update-name', { message: 'Updated', name: 'Pat Person' });

    await authService.updateName('Pat Person');

    expect(api.calls('PUT')[0].headers.authorization).toMatch(/^Bearer /);
  });
});

describe('the docs session', () => {
  it('opens a session with the Authorization header', async () => {
    api.post('/auth/docs-session', { ok: true });

    await authService.startDocsSession();

    // The docs site is gated on a cookie this endpoint mints. A failure to call
    // it leaves a signed-in user bounced back to the login page from the docs.
    expect(api.calls('POST')).toHaveLength(1);
    // The cookie is minted only after the API verifies a Firebase token, so the
    // header is the whole basis for issuing it.
    expect(api.calls('POST')[0].headers.authorization).toMatch(/^Bearer /);
  });

  it('ends a session', async () => {
    api.delete('/auth/docs-session', { ok: true });

    await authService.endDocsSession();

    // Sign-out has to clear it, or the docs stay readable after the user has
    // left the application.
    expect(api.calls('DELETE')).toHaveLength(1);
  });
});
