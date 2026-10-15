/**
 * Sign-in through auth.service, run against a fake transport.
 *
 * Covers what a sign-in decides: how long the Firebase session survives, what
 * the backend login receives, and which failure message reaches the login
 * screen. Social sign-in is identity only: no provider access token reaches the
 * login or the registration that follows, so signing in never creates or
 * overwrites a calendar connection.
 */
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithPopup: jest.fn(),
  getRedirectResult: jest.fn(),
  signOut: jest.fn(),
  setPersistence: jest.fn().mockResolvedValue(undefined),
  browserSessionPersistence: { type: 'SESSION' },
  indexedDBLocalPersistence: { type: 'LOCAL' },
  onAuthStateChanged: jest.fn(),
  updateProfile: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn(),
  sendEmailVerification: jest.fn(),
  GoogleAuthProvider: Object.assign(
    jest.fn().mockImplementation(() => ({ addScope: jest.fn() })),
    { credentialFromResult: jest.fn() },
  ),
  OAuthProvider: Object.assign(
    jest.fn().mockImplementation(() => ({ addScope: jest.fn(), setCustomParameters: jest.fn() })),
    { credentialFromResult: jest.fn() },
  ),
}));

import * as firebaseAuth from 'firebase/auth';
import { installApiMock, type ApiMock } from '../support/apiMock';
import authService from '@/services/auth.service';

const fb = jest.mocked(firebaseAuth);
let api: ApiMock;

// The providers are built once, when auth.service loads, so their scope
// requests are read here before any per-test reset can clear them.
function scopesRequestedBy(provider: jest.Mock): string[] {
  const instance = provider.mock.results[0]?.value as { addScope: jest.Mock } | undefined;
  return (instance?.addScope.mock.calls ?? []).map(([scope]) => scope as string);
}
const googleSignInScopes = scopesRequestedBy(jest.mocked(firebaseAuth.GoogleAuthProvider) as unknown as jest.Mock);
const microsoftSignInScopes = scopesRequestedBy(jest.mocked(firebaseAuth.OAuthProvider) as unknown as jest.Mock);

function credentialFor(token: string) {
  return {
    user: { uid: 'u-oauth', getIdToken: jest.fn().mockResolvedValue(token) },
  } as unknown as firebaseAuth.UserCredential;
}

beforeEach(() => {
  api = installApiMock();
  fb.setPersistence.mockClear();
  fb.signInWithPopup.mockReset();
  fb.signInWithEmailAndPassword.mockReset();
  jest.mocked(firebaseAuth.GoogleAuthProvider.credentialFromResult).mockReset();
  jest.mocked(firebaseAuth.OAuthProvider.credentialFromResult).mockReset();
});

afterEach(() => {
  api.restore();
});

describe('social sign-in consent', () => {
  // Calendar access is granted only through the server-side connect flow. A
  // sign-in that asked for it would put the calendar on the sign-in consent
  // screen and hand the browser a token the app no longer uses.
  it('asks Google for identity scopes only', () => {
    expect(googleSignInScopes).toEqual([
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]);
  });

  it('asks Microsoft for identity scopes only', () => {
    expect(microsoftSignInScopes).toEqual(['User.Read', 'email', 'openid', 'profile']);
  });
});

describe('email and password sign-in', () => {
  it('keeps the session on this device by default', async () => {
    fb.signInWithEmailAndPassword.mockResolvedValue(credentialFor('id-token-1'));
    api.post('/auth/login', { userData: { id: 'u1', userType: 'firm_member' } });

    await authService.signIn('pat@example.com', 'secret');

    expect(fb.setPersistence).toHaveBeenCalledWith(expect.anything(), fb.indexedDBLocalPersistence);
  });

  it('drops the session when the tab closes on a shared computer', async () => {
    fb.signInWithEmailAndPassword.mockResolvedValue(credentialFor('id-token-1'));
    api.post('/auth/login', { userData: { id: 'u1' } });

    await authService.signIn('pat@example.com', 'secret', false);

    // Persistence is set before the credential is exchanged; a session that
    // outlived the tab on a public machine would leave matter data reachable.
    expect(fb.setPersistence).toHaveBeenCalledWith(expect.anything(), fb.browserSessionPersistence);
    expect(fb.setPersistence.mock.invocationCallOrder[0])
      .toBeLessThan(fb.signInWithEmailAndPassword.mock.invocationCallOrder[0]);
  });

  it('sends only the Firebase ID token to the backend login and returns its user record', async () => {
    fb.signInWithEmailAndPassword.mockResolvedValue(credentialFor('id-token-1'));
    api.post('/auth/login', { userData: { id: 'u1', userType: 'client' } });

    const result = await authService.signIn('pat@example.com', 'secret');

    expect(fb.signInWithEmailAndPassword).toHaveBeenCalledWith(expect.anything(), 'pat@example.com', 'secret');
    expect(api.calls('POST')[0].body).toEqual({ token: 'id-token-1' });
    expect(result.userData).toEqual({ id: 'u1', userType: 'client' });
  });

  it('surfaces the backend refusal message when the login is rejected', async () => {
    fb.signInWithEmailAndPassword.mockResolvedValue(credentialFor('id-token-1'));
    api.post('/auth/login', { status: 403, body: { error: 'This account has been deactivated' } });

    await expect(authService.signIn('pat@example.com', 'secret'))
      .rejects.toThrow('This account has been deactivated');
  });

  it('never reaches the backend when Firebase refuses the password', async () => {
    fb.signInWithEmailAndPassword.mockRejectedValue(new Error('auth/wrong-password'));

    await expect(authService.signIn('pat@example.com', 'nope')).rejects.toThrow('auth/wrong-password');
    expect(fb.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
    expect(api.calls()).toHaveLength(0);
  });
});

describe('Google sign-in', () => {
  it('sends only the ID token to the backend login, never the Google access token', async () => {
    fb.signInWithPopup.mockResolvedValue(credentialFor('g-id-token'));
    jest.mocked(firebaseAuth.GoogleAuthProvider.credentialFromResult)
      .mockReturnValue({ accessToken: 'g-access' } as any);
    api.post('/auth/login', { userData: { id: 'u1' }, needsRegistration: true });

    const result = await authService.signInWithGoogle();

    expect(api.calls('POST')[0].body).toEqual({ token: 'g-id-token' });
    // needsRegistration is what routes a first-time OAuth user to
    // /complete-registration instead of a dashboard with no account behind it.
    expect(result.needsRegistration).toBe(true);
    expect(result.userData).toEqual({ id: 'u1' });
  });

  it('uses tab-scoped persistence when asked not to remember the device', async () => {
    fb.signInWithPopup.mockResolvedValue(credentialFor('g-id-token'));
    api.post('/auth/login', { userData: { id: 'u1' } });

    await authService.signInWithGoogle(false);

    expect(fb.setPersistence).toHaveBeenCalledWith(expect.anything(), fb.browserSessionPersistence);
  });

  it('registers with only the ID token and user type after a Google sign-in', async () => {
    fb.signInWithPopup.mockResolvedValue(credentialFor('g-id-token'));
    jest.mocked(firebaseAuth.GoogleAuthProvider.credentialFromResult)
      .mockReturnValue({ accessToken: 'g-access' } as any);
    api.post('/auth/login', { needsRegistration: true });
    api.post('/auth/complete-registration', { userData: { id: 'u1' } });

    await authService.signUpWithGoogle();
    await authService.completeOAuthRegistration('firm_member');

    const registration = api.calls('POST')[1];
    expect(registration.url).toContain('/auth/complete-registration');
    expect(registration.body).toEqual({
      token: 'mock-token',
      userType: 'firm_member',
    });
  });

  it('drops the captured access token when the backend login fails', async () => {
    fb.signInWithPopup.mockResolvedValue(credentialFor('g-id-token'));
    jest.mocked(firebaseAuth.GoogleAuthProvider.credentialFromResult)
      .mockReturnValue({ accessToken: 'g-access' } as any);
    api.post('/auth/login', { status: 500, body: { error: 'Login service unavailable' } });
    api.post('/auth/complete-registration', { userData: { id: 'u1' } });

    await expect(authService.signInWithGoogle()).rejects.toThrow('Login service unavailable');
    await authService.completeOAuthRegistration('client');

    // A token from a failed sign-in must not be attached to a later
    // registration, which may be for a different account.
    expect(api.calls('POST')[1].body).toEqual({ token: 'mock-token', userType: 'client' });
  });
});

describe('Microsoft sign-in', () => {
  it('sends only the ID token to the backend login, never the Microsoft access token', async () => {
    fb.signInWithPopup.mockResolvedValue(credentialFor('m-id-token'));
    jest.mocked(firebaseAuth.OAuthProvider.credentialFromResult)
      .mockReturnValue({ accessToken: 'm-access' } as any);
    api.post('/auth/login', { userData: { id: 'u2' }, needsRegistration: false });

    const result = await authService.signUpWithMicrosoft();

    expect(api.calls('POST')[0].body).toEqual({ token: 'm-id-token' });
    expect(result.needsRegistration).toBe(false);
    expect(fb.setPersistence).toHaveBeenCalledWith(expect.anything(), fb.indexedDBLocalPersistence);
  });

  it('uses tab-scoped persistence when asked not to remember the device', async () => {
    fb.signInWithPopup.mockResolvedValue(credentialFor('m-id-token'));
    api.post('/auth/login', { userData: { id: 'u2' } });

    await authService.signInWithMicrosoft(false);

    expect(fb.setPersistence).toHaveBeenCalledWith(expect.anything(), fb.browserSessionPersistence);
  });

  it('registers with only the ID token and user type after a Microsoft sign-in', async () => {
    fb.signInWithPopup.mockResolvedValue(credentialFor('m-id-token'));
    jest.mocked(firebaseAuth.OAuthProvider.credentialFromResult)
      .mockReturnValue({ accessToken: 'm-access' } as any);
    api.post('/auth/login', { needsRegistration: true });
    api.post('/auth/complete-registration', { userData: { id: 'u2' } });

    await authService.signInWithMicrosoft();
    await authService.completeOAuthRegistration('client');
    expect(api.calls('POST')[1].body).toEqual({
      token: 'mock-token',
      userType: 'client',
    });
  });

  it('drops the captured Microsoft token when the backend login fails', async () => {
    fb.signInWithPopup.mockResolvedValueOnce(credentialFor('m-id-token'));
    jest.mocked(firebaseAuth.OAuthProvider.credentialFromResult)
      .mockReturnValue({ accessToken: 'm-access' } as any);
    api.post('/auth/login', { status: 401, body: { error: 'Microsoft account not allowed' } });
    api.post('/auth/complete-registration', { userData: { id: 'u2' } });

    await expect(authService.signInWithMicrosoft()).rejects.toThrow('Microsoft account not allowed');
    await authService.completeOAuthRegistration('client');

    expect(api.calls('POST')[1].body).toEqual({ token: 'mock-token', userType: 'client' });
  });
});
