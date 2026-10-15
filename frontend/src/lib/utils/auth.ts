// Token cache for performance optimization
let cachedToken: { token: string; expiry: number; uid: string } | null = null;
const TOKEN_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Cache the resolved firebase auth reference to avoid repeated dynamic import overhead
let firebaseAuthRef: Awaited<typeof import('@/lib/firebase/config')>['auth'] | undefined;

async function getAuth() {
  if (!firebaseAuthRef) {
    const { auth } = await import('@/lib/firebase/config');
    firebaseAuthRef = auth;
  }
  return firebaseAuthRef;
}

/**
 * Wait for Firebase Auth to finish restoring the session on fresh page loads.
 * On a full page load, `auth.currentUser` is null until the internal
 * `onAuthStateChanged` fires. This helper waits for that first callback.
 */
let authReadyPromise: Promise<import('firebase/auth').User | null> | null = null;

function waitForAuthReady(firebaseAuth: NonNullable<Awaited<typeof import('@/lib/firebase/config')>['auth']>): Promise<import('firebase/auth').User | null> {
  if (!authReadyPromise) {
    authReadyPromise = new Promise(async (resolve) => {
      const { onAuthStateChanged } = await import('firebase/auth');
      const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
        unsubscribe();
        resolve(user);
      });
    });
  }
  return authReadyPromise;
}

/**
 * Clear the token cache (call on logout or when user changes)
 */
export function clearTokenCache(): void {
  cachedToken = null;
  firebaseAuthRef = undefined;
  authReadyPromise = null;
}

/**
 * The signed-in user's uid, or null when nobody is signed in.
 *
 * Used to scope things that must not be shared between two people on one
 * device, such as a remembered resumable upload session: without the uid in its
 * key, the next person to pick the same file would resume the first person's
 * upload into the first person's destination.
 */
export async function getFirebaseUid(): Promise<string | null> {
  const firebaseAuth = await getAuth();
  if (!firebaseAuth) return null;
  const user = firebaseAuth.currentUser ?? await waitForAuthReady(firebaseAuth);
  return user?.uid ?? null;
}

/**
 * Get the current user's Firebase ID token
 * Returns null if user is not authenticated
 */
export async function getFirebaseToken(forceRefresh: boolean = false): Promise<string | null> {
  const firebaseAuth = await getAuth();
  if (!firebaseAuth) {
    return null;
  }
  
  // On fresh page loads currentUser is null until Firebase restores the session.
  // Wait for auth to be ready before giving up.
  const user = firebaseAuth.currentUser ?? await waitForAuthReady(firebaseAuth);

  if (!user) {
    clearTokenCache();
    return null;
  }

  // CRITICAL: If the cached token is for a different user, clear it
  if (cachedToken && cachedToken.uid !== user.uid) {
    clearTokenCache();
  }

  // Check cache (only if not forcing refresh)
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiry && cachedToken.uid === user.uid) {
    return cachedToken.token;
  }

  try {
    // Force refresh the token to ensure it's for the current user
    const token = await user.getIdToken(forceRefresh);
    
    // Cache the token with the user's UID
    cachedToken = {
      token,
      expiry: Date.now() + TOKEN_CACHE_DURATION,
      uid: user.uid
    };
    
    return token;
  } catch (error) {
    console.error('Error getting Firebase token:', error);
    clearTokenCache();
    return null;
  }
}

/**
 * Get the current user's Firebase ID token, throwing if not authenticated
 */
export async function requireFirebaseToken(): Promise<string> {
  const token = await getFirebaseToken();
  
  if (!token) {
    throw new Error('User is not authenticated');
  }

  return token;
}

/**
 * Force refresh the token (use after login/logout)
 */
export async function refreshToken(): Promise<string | null> {
  clearTokenCache();
  return getFirebaseToken(true);
}

/**
 * Check if user is currently authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  const firebaseAuth = await getAuth();
  return firebaseAuth?.currentUser != null;
}

