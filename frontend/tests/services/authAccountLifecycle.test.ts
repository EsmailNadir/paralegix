/**
 * Account creation, sign-out and the signed-out guards in auth.service, run
 * against a fake transport.
 *
 * Sign-up is two writes in two systems (a Firebase user, then the backend
 * profile), so the interesting branch is the rollback when the second write is
 * refused. Sign-out is the one place shared-workstation data is swept, so it is
 * asserted key by key.
 */
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithPopup: jest.fn(),
  getRedirectResult: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
  setPersistence: jest.fn().mockResolvedValue(undefined),
  browserSessionPersistence: { type: 'SESSION' },
  indexedDBLocalPersistence: { type: 'LOCAL' },
  onAuthStateChanged: jest.fn(),
  updateProfile: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
  GoogleAuthProvider: Object.assign(
    jest.fn().mockImplementation(() => ({ addScope: jest.fn() })),
    { credentialFromResult: jest.fn() },
  ),
  OAuthProvider: Object.assign(
    jest.fn().mockImplementation(() => ({ addScope: jest.fn(), setCustomParameters: jest.fn() })),
    { credentialFromResult: jest.fn() },
  ),
}));

jest.mock('@/lib/utils/auth', () => ({ clearTokenCache: jest.fn() }));

import * as firebaseAuth from 'firebase/auth';
import * as firebaseConfig from '@/lib/firebase/config';
import { clearTokenCache } from '@/lib/utils/auth';
import { installApiMock, type ApiMock } from '../support/apiMock';
import authService from '@/services/auth.service';

const fb = jest.mocked(firebaseAuth);
const config = firebaseConfig as unknown as { auth: { currentUser: unknown } };
const signedInUser = config.auth.currentUser;
let api: ApiMock;

function newFirebaseUser(getIdToken: jest.Mock = jest.fn().mockResolvedValue('new-id-token')) {
  return { uid: 'new-uid', getIdToken, delete: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  api = installApiMock();
  config.auth.currentUser = signedInUser;
  jest.clearAllMocks();
});

afterEach(() => {
  api.restore();
  config.auth.currentUser = signedInUser;
  localStorage.clear();
  sessionStorage.clear();
});

describe('signUp', () => {
  it('refuses a missing user type before creating any Firebase account', async () => {
    await expect(authService.signUp('pat@example.com', 'pw', { name: 'Pat' }))
      .rejects.toThrow('userType must be either "client" or "firm_member"');

    expect(fb.createUserWithEmailAndPassword).not.toHaveBeenCalled();
    expect(api.calls()).toHaveLength(0);
  });

  it('refuses a user type outside client and firm_member', async () => {
    await expect(authService.signUp('pat@example.com', 'pw', { name: 'Pat', userType: 'admin' as any }))
      .rejects.toThrow('userType must be either "client" or "firm_member"');

    expect(fb.createUserWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it('creates the backend profile with the new account token, the email and every extra field', async () => {
    const user = newFirebaseUser();
    fb.createUserWithEmailAndPassword.mockResolvedValue({ user } as any);
    api.post('/auth/create-user', { id: 'new-uid' });

    const result = await authService.signUp('pat@example.com', 'pw', {
      name: 'Pat Person',
      userType: 'firm_member',
      phone: '555-0100',
    });

    expect(result).toBe(user);
    expect(fb.updateProfile).toHaveBeenCalledWith(user, { displayName: 'Pat Person' });
    const call = api.calls('POST')[0];
    expect(call.headers.authorization).toBe('Bearer new-id-token');
    expect(call.body).toEqual({
      email: 'pat@example.com',
      name: 'Pat Person',
      userType: 'firm_member',
      phone: '555-0100',
    });
    expect(user.delete).not.toHaveBeenCalled();
  });

  it('force-refreshes the ID token once when the first mint fails', async () => {
    const getIdToken = jest.fn()
      .mockRejectedValueOnce(new Error('token not ready'))
      .mockResolvedValueOnce('refreshed-token');
    fb.createUserWithEmailAndPassword.mockResolvedValue({ user: newFirebaseUser(getIdToken) } as any);
    api.post('/auth/create-user', { id: 'new-uid' });

    await authService.signUp('pat@example.com', 'pw', { name: 'Pat', userType: 'client' });

    expect(getIdToken).toHaveBeenNthCalledWith(2, true);
    expect(api.calls('POST')[0].headers.authorization).toBe('Bearer refreshed-token');
  });

  it('deletes the Firebase account and surfaces the server message when the profile is refused', async () => {
    const user = newFirebaseUser();
    fb.createUserWithEmailAndPassword.mockResolvedValue({ user } as any);
    api.post('/auth/create-user', { status: 409, body: { error: 'That email is already registered' } });

    await expect(authService.signUp('pat@example.com', 'pw', { name: 'Pat', userType: 'client' }))
      .rejects.toThrow('That email is already registered');

    // Without the rollback the person has a Firebase login with no profile
    // behind it, and every later sign-up with the same email fails.
    expect(user.delete).toHaveBeenCalledTimes(1);
  });
});

describe('signOutUser', () => {
  it('sweeps matter, client and billing keys from both storages and keeps UI preferences', async () => {
    api.delete('/auth/docs-session', { ok: true });
    localStorage.setItem('paralegix_timer', '{"running":true}');
    localStorage.setItem('mattersFilter_firm-1', 'open');
    localStorage.setItem('paralegix:google:calendar-sync:u1', 'x');
    localStorage.setItem('paralegix-theme', 'dark');
    sessionStorage.setItem('noteReplyDraft:n1', 'draft reply');
    sessionStorage.setItem('verify-email-address', 'pat@example.com');
    sessionStorage.setItem('unrelated', 'kept');

    await authService.signOutUser();

    expect(fb.signOut).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('paralegix_timer')).toBeNull();
    expect(localStorage.getItem('mattersFilter_firm-1')).toBeNull();
    expect(localStorage.getItem('paralegix:google:calendar-sync:u1')).toBeNull();
    expect(sessionStorage.getItem('noteReplyDraft:n1')).toBeNull();
    expect(sessionStorage.getItem('verify-email-address')).toBeNull();
    expect(localStorage.getItem('paralegix-theme')).toBe('dark');
    expect(sessionStorage.getItem('unrelated')).toBe('kept');
  });

  it('ends the docs session before signing out of Firebase and clears the token cache', async () => {
    api.delete('/auth/docs-session', { ok: true });

    await authService.signOutUser();

    expect(api.calls('DELETE')).toHaveLength(1);
    expect(clearTokenCache).toHaveBeenCalledTimes(1);
  });

  it('still signs out and sweeps storage when ending the docs session fails', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    localStorage.setItem('tasksFilter_firm-1', 'mine');

    await authService.signOutUser();

    fetchSpy.mockRestore();
    expect(fb.signOut).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('tasksFilter_firm-1')).toBeNull();
  });

  it('does not sweep storage when Firebase refuses the sign-out', async () => {
    api.delete('/auth/docs-session', { ok: true });
    fb.signOut.mockRejectedValueOnce(new Error('network'));
    localStorage.setItem('paralegix_timer', 'kept');

    await expect(authService.signOutUser()).rejects.toThrow('network');

    expect(fb.signOut).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('paralegix_timer')).toBe('kept');
  });
});

describe('the documentation session', () => {
  it('surfaces the server refusal when opening it', async () => {
    api.post('/auth/docs-session', { status: 403, body: { error: 'Docs are not enabled for this firm' } });

    await expect(authService.startDocsSession()).rejects.toThrow('Docs are not enabled for this firm');
  });

  it('refuses to open one when nobody is signed in', async () => {
    config.auth.currentUser = null;

    await expect(authService.startDocsSession()).rejects.toThrow('No authenticated user');
    expect(api.calls()).toHaveLength(0);
  });
});

describe('signed-out guards', () => {
  beforeEach(() => {
    config.auth.currentUser = null;
  });

  it('refuses to complete registration without a Firebase user', async () => {
    await expect(authService.completeOAuthRegistration('client')).rejects.toThrow('No authenticated user');
    expect(api.calls()).toHaveLength(0);
  });

  it('reports no registration needed without asking the server', async () => {
    await expect(authService.checkRegistrationStatus()).resolves.toEqual({ needsRegistration: false });
    expect(api.calls()).toHaveLength(0);
  });

  it('refuses a name change', async () => {
    await expect(authService.updateName('Pat')).rejects.toThrow('Not authenticated');
    expect(fb.updateProfile).not.toHaveBeenCalled();
  });

  it('refuses to send a verification email', async () => {
    await expect(authService.sendVerificationEmail()).rejects.toThrow('No authenticated user');
    expect(fb.sendEmailVerification).not.toHaveBeenCalled();
  });

  it('returns null for the current user', async () => {
    await expect(authService.getCurrentUser()).resolves.toBeNull();
  });
});

describe('password and verification emails', () => {
  it('sends the reset email for the given address', async () => {
    await authService.forgotPassword('pat@example.com');

    expect(fb.sendPasswordResetEmail).toHaveBeenCalledWith(config.auth, 'pat@example.com');
  });

  it('passes a reset failure through to the caller', async () => {
    fb.sendPasswordResetEmail.mockRejectedValueOnce(new Error('auth/user-not-found'));

    await expect(authService.forgotPassword('nobody@example.com')).rejects.toThrow('auth/user-not-found');
  });

  it('sends the verification email to the signed-in user', async () => {
    await authService.sendVerificationEmail();

    expect(fb.sendEmailVerification).toHaveBeenCalledWith(signedInUser);
  });

  it('updates the Firebase display name with the trimmed value before saving it', async () => {
    api.put('/users/update-name', { message: 'Updated', name: 'Pat' });

    await authService.updateName('  Pat  ');

    expect(fb.updateProfile).toHaveBeenCalledWith(signedInUser, { displayName: 'Pat' });
  });
});

describe('onAuthStateChange', () => {
  it('subscribes to Firebase and unsubscribes through the returned handle', async () => {
    const realUnsubscribe = jest.fn();
    fb.onAuthStateChanged.mockReturnValue(realUnsubscribe);
    const callback = jest.fn();

    const unsubscribe = authService.onAuthStateChange(callback);
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    expect(fb.onAuthStateChanged).toHaveBeenCalledWith(config.auth, callback);
    expect(realUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
