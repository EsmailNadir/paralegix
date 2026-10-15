/**
 * Maps Firebase Auth error codes to user-friendly messages.
 * Returns null for errors that should be silently ignored (e.g., user closed popup).
 */

const ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Invalid email or password.',
  'auth/user-not-found': 'No account found with this email.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/user-disabled': 'This account has been disabled. Please contact support.',
  'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
  'auth/network-request-failed': 'Network error. Please check your connection and try again.',
  'auth/email-already-in-use': 'This email is already registered.',
  'auth/weak-password': 'Password is too weak. Please use at least 6 characters.',
  'auth/account-exists-with-different-credential': 'An account already exists with this email using a different sign-in method.',
  'auth/popup-blocked': 'Pop-up was blocked by your browser. Please allow pop-ups and try again.',
  'auth/requires-recent-login': 'Please sign in again to complete this action.',
  'auth/credential-already-in-use': 'This credential is already associated with another account.',
};

// These error codes should be silently ignored (user cancelled action)
const SILENT_ERRORS = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
]);

export function getFirebaseErrorMessage(error: unknown, fallback: string): string | null {
  if (!error) return fallback;

  // Firebase errors have a `code` property
  const code = (error as { code?: string }).code;
  if (code) {
    if (SILENT_ERRORS.has(code)) return null;
    if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  }

  // Also check error.message for embedded error codes (e.g., "Firebase: Error (auth/invalid-credential).")
  const message = error instanceof Error ? error.message : '';
  for (const [errorCode, friendlyMessage] of Object.entries(ERROR_MESSAGES)) {
    if (message.includes(errorCode)) return friendlyMessage;
  }
  for (const silentCode of SILENT_ERRORS) {
    if (message.includes(silentCode)) return null;
  }

  return fallback;
}
