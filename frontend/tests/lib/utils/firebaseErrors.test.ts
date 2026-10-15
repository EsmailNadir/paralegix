/**
 * The message a person sees when a sign-in, sign-up or re-auth fails.
 *
 * Two things are pinned. The silent codes (closing the Google or Microsoft
 * popup) must produce NO message: the caller treats null as "show nothing",
 * and a red "Login failed" for a deliberate cancel reads as a bug. And the
 * code must be found whether Firebase put it on `error.code` or only inside
 * the message text, which is how some SDK paths deliver it.
 */
import { getFirebaseErrorMessage } from '@/lib/utils/firebaseErrors';

const FALLBACK = 'Login failed. Please try again.';

function firebaseError(code: string, message = `Firebase: Error (${code}).`) {
  return Object.assign(new Error(message), { code });
}

describe('getFirebaseErrorMessage', () => {
  it.each([
    ['auth/invalid-credential', 'Invalid email or password.'],
    ['auth/user-not-found', 'No account found with this email.'],
    ['auth/wrong-password', 'Incorrect password.'],
    ['auth/too-many-requests', 'Too many failed attempts. Please try again later.'],
    ['auth/email-already-in-use', 'This email is already registered.'],
    ['auth/popup-blocked', 'Pop-up was blocked by your browser. Please allow pop-ups and try again.'],
    ['auth/requires-recent-login', 'Please sign in again to complete this action.'],
  ])('maps the code %p to its friendly message', (code, message) => {
    expect(getFirebaseErrorMessage(firebaseError(code), FALLBACK)).toBe(message);
  });

  it.each(['auth/popup-closed-by-user', 'auth/cancelled-popup-request'])(
    'returns null for the user-cancelled code %p carried only on error.code',
    (code) => {
      expect(getFirebaseErrorMessage(firebaseError(code, 'The popup closed.'), FALLBACK)).toBeNull();
    },
  );

  it('finds a known code embedded in the message when there is no code property', () => {
    const err = new Error('Firebase: Error (auth/user-disabled).');
    expect(getFirebaseErrorMessage(err, FALLBACK)).toBe(
      'This account has been disabled. Please contact support.',
    );
  });

  it('finds a silent code embedded in the message and stays silent', () => {
    expect(getFirebaseErrorMessage(new Error('Firebase: Error (auth/popup-closed-by-user).'), FALLBACK)).toBeNull();
  });

  it('falls back to the message scan when the code property is unknown', () => {
    const err = Object.assign(new Error('wrapped: auth/network-request-failed'), { code: 'wrapper/unknown' });
    expect(getFirebaseErrorMessage(err, FALLBACK)).toBe(
      'Network error. Please check your connection and try again.',
    );
  });

  it('uses the caller fallback for an unknown error, never the raw message', () => {
    // A raw SDK message ("Firebase: Error (auth/internal-error).") is noise to
    // a person signing in and can leak internals.
    expect(getFirebaseErrorMessage(firebaseError('auth/internal-error'), FALLBACK)).toBe(FALLBACK);
    expect(getFirebaseErrorMessage(new Error('boom'), FALLBACK)).toBe(FALLBACK);
  });

  it('uses the fallback for a falsy error and for a non-Error value', () => {
    expect(getFirebaseErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(getFirebaseErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
    expect(getFirebaseErrorMessage('auth/wrong-password', FALLBACK)).toBe(FALLBACK);
  });

  it('reads a code from a plain object that is not an Error', () => {
    expect(getFirebaseErrorMessage({ code: 'auth/invalid-email' }, FALLBACK)).toBe(
      'Please enter a valid email address.',
    );
  });
});
