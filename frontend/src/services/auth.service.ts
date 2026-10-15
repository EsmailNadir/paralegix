import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  setPersistence,
  browserSessionPersistence,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
  sendEmailVerification,
  GoogleAuthProvider,
  OAuthProvider,
  type User,
  type Unsubscribe,
} from 'firebase/auth';
// auth will be imported dynamically to avoid SSR issues
import { toApiError } from '@/lib/utils/apiErrors';
// Two transports, deliberately. `publicFetch` bounds a request without any
// session machinery, which is what the sign-in, registration and sign-out calls
// need: they run before a session exists or while one is being torn down, so
// apiFetch's 401 recovery (refresh the token, retry, then reload the page) has
// nothing to refresh and would reload the page mid-login. `apiFetch` is for the
// calls that legitimately act on an established session.
import { apiFetch, publicFetch } from '@/lib/utils/fetchWithTokenRefresh';
import requestDeduplicator from './requestDeduplicator';

// Define API URL - fallback to localhost:5001 if env var is not set
const API_URL: string = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

// Sign-in providers ask for identity only. Calendar access is granted through
// the server-side connect flow (connectGoogleCalendar / connectMicrosoftCalendar),
// which is the only path that yields a refresh token the API can validate, so
// signing in never creates or overwrites a calendar connection.
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/userinfo.email');
googleProvider.addScope('https://www.googleapis.com/auth/userinfo.profile');

const microsoftProvider = new OAuthProvider('microsoft.com');
microsoftProvider.setCustomParameters({ prompt: 'select_account', tenant: 'common' });
microsoftProvider.addScope('User.Read');
microsoftProvider.addScope('email');
microsoftProvider.addScope('openid');
microsoftProvider.addScope('profile');

export interface BackendLoginResponse {
  userData?: any;
  hasCalendarAccess?: boolean;
  needsRegistration?: boolean;
  message?: string;
}

export interface SignUpAdditionalData {
  name: string;
  userType?: 'client' | 'firm_member';
  [key: string]: any;
}

/**
 * Keys and key prefixes this app writes to localStorage/sessionStorage that
 * carry matter, client, or billing content rather than a bare device
 * preference. Swept on sign-out so none of it outlives the session on a
 * shared firm workstation. `paralegix-theme` and other UI-only prefs are
 * deliberately excluded - clearing those would flash the wrong theme on the
 * next login for no security benefit.
 */
const CLEAR_ON_SIGN_OUT_PREFIXES = [
  'paralegix_timer',
  'noteReplyDraft:',
  'tasksFilter_',
  'mattersFilter_',
  'filesFilter_',
  'filesClientFilter_',
  'paralegix-sidebar:',
  'paralegix-client-lawfirm',
  'paralegix:google:calendar-sync:',
  'paralegix:outlook:calendar-sync:',
  'verify-email-address',
];

function clearAppStorage(): void {
  if (typeof window === 'undefined') return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      Object.keys(store)
        .filter((k) => CLEAR_ON_SIGN_OUT_PREFIXES.some((p) => k.startsWith(p)))
        .forEach((k) => store.removeItem(k));
    } catch {
      // Storage can be unavailable (e.g. private browsing); sign-out must still proceed.
    }
  }
}

class AuthService {
  // Helper to get Firebase auth instance (dynamic import to avoid SSR)
  private async getAuth() {
    const { auth: firebaseAuth } = await import('@/lib/firebase/config');
    if (!firebaseAuth) {
      throw new Error('Firebase Auth not initialized');
    }
    return firebaseAuth;
  }

  private redirectToUrl(url: string): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (typeof window.location.assign === 'function') {
      window.location.assign(url);
      return;
    }

    window.location.href = url;
  }

  /**
   * @param persistent When false (a shared/public computer), the session is
   * dropped as soon as the tab closes instead of surviving indefinitely in
   * IndexedDB - the default `indexedDBLocalPersistence` has no idle timeout.
   */
  async signInWithGoogle(persistent = true): Promise<{ user: User; userData?: any; needsRegistration?: boolean }> {
    const firebaseAuth = await this.getAuth();
    await setPersistence(firebaseAuth, persistent ? indexedDBLocalPersistence : browserSessionPersistence);
    const userCredential = await signInWithPopup(firebaseAuth, googleProvider);
    const idToken = await userCredential.user.getIdToken();

    const response = await publicFetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: idToken }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Backend authentication failed');
    }

    const data = (await response.json()) as BackendLoginResponse;
    return {
      user: userCredential.user,
      userData: data.userData,
      needsRegistration: data.needsRegistration
    };
  }

  /** @param persistent See {@link signInWithGoogle}. */
  async signInWithMicrosoft(persistent = true): Promise<{ user: User; userData?: any; needsRegistration?: boolean }> {
    const auth = await this.getAuth();
    await setPersistence(auth, persistent ? indexedDBLocalPersistence : browserSessionPersistence);
    const userCredential = await signInWithPopup(auth, microsoftProvider);
    const idToken = await userCredential.user.getIdToken();

    const response = await publicFetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: idToken }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Backend authentication failed');
    }

    const data = (await response.json()) as BackendLoginResponse;
    return {
      user: userCredential.user,
      userData: data.userData,
      needsRegistration: data.needsRegistration
    };
  }

  /** @param persistent See {@link signInWithGoogle}. */
  async signIn(email: string, password: string, persistent = true): Promise<{ user: User; userData?: any }> {
    try {
      const auth = await this.getAuth();
      await setPersistence(auth, persistent ? indexedDBLocalPersistence : browserSessionPersistence);
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const idToken = await userCredential.user.getIdToken();

      const response = await publicFetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: idToken }),
      });

      if (!response.ok) {
        throw await toApiError(response, 'Backend authentication failed');
      }

      const data = (await response.json()) as BackendLoginResponse;
      return { user: userCredential.user, userData: data.userData };
    } catch (error) {
      throw error;
    }
  }

  // OAuth signup - now returns needsRegistration flag
  async signUpWithGoogle(): Promise<{ user: User; userData?: any; needsRegistration?: boolean }> {
    return this.signInWithGoogle();
  }

  async signUpWithMicrosoft(): Promise<{ user: User; userData?: any; needsRegistration?: boolean }> {
    return this.signInWithMicrosoft();
  }

  // Complete OAuth registration with userType selection
  async completeOAuthRegistration(userType: 'client' | 'firm_member'): Promise<{ userData: any }> {
    try {
      const auth = await this.getAuth();
      const user = auth.currentUser;
      if (!user) {
        throw new Error('No authenticated user');
      }

      const idToken = await user.getIdToken();

      const response = await publicFetch(`${API_URL}/auth/complete-registration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: idToken, userType }),
      });

      if (!response.ok) {
        throw await toApiError(response, 'Registration failed');
      }

      const data = await response.json();
      return { userData: data.userData };
    } catch (error) {
      throw error;
    }
  }

  // Check if current user needs to complete registration
  async checkRegistrationStatus(): Promise<{ needsRegistration: boolean; userType?: string }> {
    try {
      const auth = await this.getAuth();
      const user = auth.currentUser;
      if (!user) {
        return { needsRegistration: false };
      }

      const idToken = await user.getIdToken();

      const response = await apiFetch(`${API_URL}/auth/user-type`, {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${idToken}`,
          'Content-Type': 'application/json'
        },
      });

      if (!response.ok) {
        return { needsRegistration: false };
      }

      const data = await response.json();
      return { 
        needsRegistration: data.needsRegistration || false,
        userType: data.userType
      };
    } catch (error) {
      console.error('Error checking registration status:', error);
      return { needsRegistration: false };
    }
  }

  async signUp(email: string, password: string, additionalData: SignUpAdditionalData): Promise<User> {
    try {
      if (!additionalData.userType || !['client', 'firm_member'].includes(additionalData.userType)) {
        throw new Error('userType must be either "client" or "firm_member"');
      }

      const auth = await this.getAuth();
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(userCredential.user, {
        displayName: additionalData.name,
      });

      // Mint the ID token. updateProfile above is already awaited, so no blind
      // sleep is needed; if the first mint races, force-refresh once.
      let idToken: string;
      try {
        idToken = await userCredential.user.getIdToken();
      } catch {
        idToken = await userCredential.user.getIdToken(true);
      }

      const response = await publicFetch(`${API_URL}/auth/create-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ email, ...additionalData }),
      });

      if (!response.ok) {
        // rollback firebase user if backend profile creation fails
        await userCredential.user.delete();
        throw await toApiError(response, 'Failed to create user profile');
      }

      return userCredential.user;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Exchange the current Firebase session for the documentation-site cookie.
   *
   * The docs site is a separate static deployment that cannot see the Firebase
   * session, so it is gated on an httpOnly cookie the API sets on the parent
   * domain. `credentials: 'include'` is what allows the API's Set-Cookie to
   * stick when the app and API are different subdomains.
   */
  async startDocsSession(): Promise<void> {
    const auth = await this.getAuth();
    const user = auth.currentUser;
    if (!user) throw new Error('No authenticated user');

    const idToken = await user.getIdToken();
    const response = await apiFetch(`${API_URL}/auth/docs-session`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (!response.ok) {
      throw await toApiError(response, 'Could not open the documentation site');
    }
  }

  /** Drop the documentation cookie. Best-effort: called on sign-out. */
  async endDocsSession(): Promise<void> {
    await publicFetch(`${API_URL}/auth/docs-session`, {
      method: 'DELETE',
      credentials: 'include',
    });
  }

  async signOutUser(): Promise<void> {
    try {
      const auth = await this.getAuth();
      // Before signOut: the docs cookie lives on the parent domain and would
      // otherwise outlive the session, leaving the docs site readable after the
      // user signed out. Never let its failure block the actual sign-out.
      await this.endDocsSession().catch(() => {});
      await signOut(auth);
      // Clear token cache on logout
      const { clearTokenCache } = await import('@/lib/utils/auth');
      clearTokenCache();
      clearAppStorage();
    } catch (error) {
      throw error;
    }
  }

  onAuthStateChange(callback: (user: User | null) => void): Unsubscribe {
    let realUnsubscribe: Unsubscribe | null = null;
    import('@/lib/firebase/config').then(({ auth: firebaseAuth }) => {
      if (firebaseAuth) {
        realUnsubscribe = onAuthStateChanged(firebaseAuth, callback);
      }
    });
    return () => { realUnsubscribe?.(); };
  }

  async getCurrentUser(): Promise<User | null> {
    const auth = await this.getAuth();
    return auth.currentUser;
  }

  async forgotPassword(email: string): Promise<void> {
    try {
      const auth = await this.getAuth();
      await sendPasswordResetEmail(auth, email);
    } catch (error) {
      throw error;
    }
  }

  async sendVerificationEmail(): Promise<void> {
    const auth = await this.getAuth();
    const user = auth.currentUser;
    if (!user) throw new Error('No authenticated user');
    await sendEmailVerification(user);
  }

  async updateName(name: string): Promise<{ message: string; name: string }> {
    const auth = await this.getAuth();
    const user = auth.currentUser;
    if (!user) throw new Error('Not authenticated');
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Name is required and must be a non-empty string');
    }

    if (name.trim().length > 100) {
      throw new Error('Name must be less than 100 characters');
    }

    const trimmedName = name.trim();

    await updateProfile(user, {
      displayName: trimmedName,
    });

    const idToken = await user.getIdToken();
    const response = await apiFetch(`${API_URL}/users/update-name`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${idToken}` 
      },
      body: JSON.stringify({ name: trimmedName }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to update name');
    }

    return response.json();
  }

  async linkGoogle(): Promise<void> {
    // Use the backend OAuth2 authorization code flow to get real Google
    // refresh tokens for calendar access. This redirects the user away.
    await this.connectGoogleCalendar();
  }

  /**
   * Initiate backend OAuth2 authorization code flow for Google.
   * This redirects the user to Google for consent, then back to the app
   * with real access + refresh tokens stored server-side.
   */
  async connectGoogleCalendar(returnUrl?: string): Promise<void> {
    const auth = await this.getAuth();
    const user = auth.currentUser;
    if (!user) throw new Error('Not authenticated');

    const idToken = await user.getIdToken();

    const response = await apiFetch(`${API_URL}/auth/connect-google`, {
      method: 'POST',
      // The response sets an httpOnly cookie that binds the OAuth state to this
      // browser; the callback refuses a state that arrives without it.
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        returnUrl: returnUrl || (typeof window !== 'undefined' ? window.location.href : undefined),
      }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to initiate Google connection');
    }

    const { authUrl } = await response.json();
    this.redirectToUrl(authUrl);
  }

  async linkMicrosoft(): Promise<void> {
    // Use the backend OAuth2 authorization code flow to get real Microsoft
    // refresh tokens for calendar access. This redirects the user away.
    await this.connectMicrosoftCalendar();
  }

  /**
   * Initiate backend OAuth2 authorization code flow for Microsoft.
   * This redirects the user to Microsoft for consent, then back to the app
   * with real access + refresh tokens stored server-side.
   */
  async connectMicrosoftCalendar(returnUrl?: string): Promise<void> {
    const auth = await this.getAuth();
    const user = auth.currentUser;
    if (!user) throw new Error('Not authenticated');

    const idToken = await user.getIdToken();

    const response = await apiFetch(`${API_URL}/auth/connect-microsoft`, {
      method: 'POST',
      // The response sets an httpOnly cookie that binds the OAuth state to this
      // browser; the callback refuses a state that arrives without it.
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        returnUrl: returnUrl || (typeof window !== 'undefined' ? window.location.href : undefined),
      }),
    });

    if (!response.ok) {
      throw await toApiError(response, 'Failed to initiate Microsoft connection');
    }

    const { authUrl } = await response.json();
    this.redirectToUrl(authUrl);
  }

  async unlinkGoogle({ removeParalegixEvents = false }: { removeParalegixEvents?: boolean } = {}): Promise<void> {
    const auth = await this.getAuth();
    const user = auth.currentUser;
    if (!user) throw new Error('Not authenticated');
    // Only clear backend calendar tokens, don't touch Firebase Auth providers.
    // The user's sign-in method must stay intact regardless of calendar connection state.
    const idToken = await user.getIdToken();
    const res = await apiFetch(`${API_URL}/auth/unlink-google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ removeParalegixEvents }),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to disconnect Google');
    }
  }

  async unlinkMicrosoft({ removeParalegixEvents = false }: { removeParalegixEvents?: boolean } = {}): Promise<void> {
    const auth = await this.getAuth();
    const user = auth.currentUser;
    if (!user) throw new Error('Not authenticated');
    // Only clear backend calendar tokens, don't touch Firebase Auth providers.
    // The user's sign-in method must stay intact regardless of calendar connection state.
    const idToken = await user.getIdToken();
    const res = await apiFetch(`${API_URL}/auth/unlink-microsoft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ removeParalegixEvents }),
    });
    if (!res.ok) {
      throw await toApiError(res, 'Failed to disconnect Microsoft');
    }
  }
  
  async checkCalendarAccess(): Promise<boolean> {
    try {
      const auth = await this.getAuth();
      const user = auth.currentUser;
      if (!user) return false;
      
      const idToken = await user.getIdToken();
      
      const data = await requestDeduplicator.execute<{hasCalendarAccess?: boolean}>(
        `${API_URL}/auth/check-calendar-access`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${idToken}` }
        }
      );
      
      return data.hasCalendarAccess || false;
    } catch (error) {
      console.error('Error checking calendar access:', error);
      return false;
    }
  }

  async checkMicrosoftConnection(): Promise<boolean> {
    try {
      const auth = await this.getAuth();
      const user = auth.currentUser;
      if (!user) return false;

      const idToken = await user.getIdToken();
      
      const data = await requestDeduplicator.execute<{hasMicrosoftToken?: boolean}>(
        `${API_URL}/auth/check-microsoft`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${idToken}` }
        }
      );
      
      return data.hasMicrosoftToken || false;
    } catch (error) {
      console.error('Error checking Microsoft connection:', error);
      return false;
    }
  }
  
  async refreshMicrosoftAuth(): Promise<boolean> {
    // Redirect to backend OAuth2 flow to get fresh tokens including a real refresh token.
    // This navigates away, so it won't return true/false in the same session.
    try {
      await this.connectMicrosoftCalendar();
      return true;
    } catch (error) {
      console.error('Failed to refresh Microsoft auth:', error);
      throw error;
    }
  }

  /**
   * Ask the API to refresh the stored Microsoft grant. The token itself stays
   * server-side; the answer is only whether the refresh worked.
   */
  async refreshMicrosoftToken(): Promise<boolean> {
    try {
      const auth = await this.getAuth();
      const user = auth.currentUser;
      if (!user) {
        throw new Error('No authenticated user');
      }

      const idToken = await user.getIdToken();
      
      const response = await publicFetch(`${API_URL}/auth/refresh-microsoft-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: idToken }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('Failed to refresh Microsoft token:', errorText);
        return false;
      }

      const data = await response.json();
      return data?.refreshed === true;
    } catch (error) {
      console.warn('Error refreshing Microsoft token:', error);
      return false;
    }
  }

  async forceGoogleReAuth(): Promise<void> {
    // Never use popup sign-in for reconnect flows. It can switch the browser to a
    // different Firebase Auth user and send follow-up writes to the wrong users/{uid} doc.
    await this.connectGoogleCalendar(typeof window !== 'undefined' ? window.location.href : undefined);
  }

  async forceMicrosoftReAuth(): Promise<void> {
    // Use the backend OAuth code flow so reconnect stays attached to the current uid.
    await this.connectMicrosoftCalendar(typeof window !== 'undefined' ? window.location.href : undefined);
  }

  async silentMicrosoftReAuth(): Promise<boolean> {
    try {
      const auth = await this.getAuth();
      const currentUser = auth.currentUser;
      if (!currentUser) {
        return false;
      }

      const hasMicrosoft = currentUser.providerData.some(p => p.providerId === 'microsoft.com');
      if (!hasMicrosoft) {
        return false;
      }

      try {
        await currentUser.getIdToken(true);
        return false;
      } catch {
        return false;
      }
    } catch (error) {
      console.error('❌ Silent Microsoft re-auth failed:', error);
      return false;
    }
  }

  async manualMicrosoftReAuth(returnUrl?: string): Promise<void> {
    await this.connectMicrosoftCalendar(
      returnUrl || (typeof window !== 'undefined' ? window.location.href : undefined),
    );
  }

  async checkMicrosoftTokenStatus(): Promise<{
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    lastUpdated?: string;
    isValid?: boolean;
  }> {
    try {
      const auth = await this.getAuth();
      const user = auth.currentUser;
      if (!user) {
        return {
          hasAccessToken: false,
          hasRefreshToken: false
        };
      }

      const idToken = await user.getIdToken();
      
      const data = await requestDeduplicator.execute<any>(
        `${API_URL}/auth/check-microsoft`,
        {
          method: 'GET',
          headers: { 
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        hasAccessToken: !!data.hasMicrosoftToken,
        hasRefreshToken: !!data.hasMicrosoftToken,
        lastUpdated: data.tokenUpdatedAt,
        isValid: data.hasMicrosoftToken
      };
    } catch (error) {
      console.error('Failed to check Microsoft token status:', error);
      return {
        hasAccessToken: false,
        hasRefreshToken: false
      };
    }
  }
}

const authService = new AuthService();
export default authService;
