import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getFirebaseToken } from '@/lib/utils/auth';
import { isPageHidden } from '@/lib/supabase/deferWhileHidden';

/**
 * Supabase Realtime client.
 *
 * Firebase Auth remains the source of truth for the user's identity. To use
 * Supabase Realtime (which is RLS-protected) we exchange the current Firebase
 * ID token for a short-lived Supabase JWT via the backend
 * (`GET /api/messaging/realtime-token`) and inject it with
 * `client.realtime.setAuth(token)`.
 *
 * This module is client-only. Supabase Realtime relies on the browser
 * WebSocket. Guard against SSR the same way the rest of the app guards
 * Firebase client usage.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Refresh the realtime JWT this many ms before it actually expires so a
// subscription never drops because of an expired token.
const REFRESH_LEEWAY_MS = 5 * 60 * 1000; // 5 minutes

let client: SupabaseClient | null = null;

/**
 * Singleton Supabase client configured for Realtime. Returns null on the
 * server (SSR) or when the required env vars are missing.
 */
export function getRealtimeClient(): SupabaseClient | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('Supabase Realtime disabled: missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY');
    }
    return null;
  }

  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // The realtime client re-reads its token from this callback on every
      // heartbeat and pushes the answer to every joined channel. Without it,
      // supabase-js supplies its own callback, which finds no Supabase Auth
      // session and answers with the anon key, so the messaging JWT would be
      // replaced within one heartbeat and RLS-protected channels would stop
      // receiving changes. Passing it also means `client.auth` is unavailable,
      // which is intended: Firebase is the identity provider.
      accessToken: async () => installedToken,
    });
  }

  return client;
}

interface RealtimeTokenResponse {
  token: string;
  expiresIn: number; // seconds
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// The realtime JWT is injected globally on the shared singleton client via
// realtime.setAuth(), so a single valid token serves every subscriber. Cache it
// (with its expiry) so the several hooks that mount together on a page reuse one
// token instead of each fetching its own. Cleared implicitly by letting it lapse
// past `currentTokenExpiresAt`; the refresh timer forces a re-fetch by nulling it.
let currentToken: string | null = null;
let currentTokenExpiresAt = 0; // epoch ms; 0 = no token yet

// The JWT last installed on the socket, and what the client's `accessToken`
// callback returns on each heartbeat. Unlike `currentToken` it is never nulled to
// force a re-fetch, so a heartbeat during an in-flight refresh keeps sending the
// token the channels already hold instead of none at all.
let installedToken: string | null = null;

// Coalesces concurrent authorize() calls (e.g. several hooks mounting on the same
// page) into one in-flight token fetch, so they share a single network request.
let inflight: Promise<SupabaseClient | null> | null = null;

// Reference count of active realtime subscribers. The auto-refresh timer is a
// single module-level global; without this it would keep re-authing for the
// whole tab lifetime even after every channel is gone. We only schedule a
// refresh while at least one subscriber is active, and we cancel the pending
// timer once the count drops to zero.
let activeSubscribers = 0;

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// Listeners told that the realtime connection is usable again after the token
// lapsed in a hidden tab. See `onRealtimeResume`.
const resumeListeners = new Set<() => void>();

// (Re)arm the single refresh timer to fire shortly before the cached token
// expires, but only while at least one subscriber is active and the tab is
// visible. A hidden tab is refreshed on its way back to visible instead (see
// `handleVisibilityChange`). Nulling the cached token before re-authing forces
// `authorizeRealtime()` to fetch a fresh JWT rather than reuse the one that's
// about to expire.
function scheduleRefresh(): void {
  clearRefreshTimer();
  if (activeSubscribers <= 0 || !currentToken || isPageHidden()) {
    return;
  }
  const refreshDelay = Math.max(currentTokenExpiresAt - Date.now() - REFRESH_LEEWAY_MS, 30 * 1000);
  refreshTimer = setTimeout(() => {
    currentToken = null;
    // Best-effort refresh; failures are non-fatal (the next mount will retry).
    authorizeRealtime().catch((err) => {
      if (process.env.NODE_ENV === 'development') {
        console.error('Failed to refresh Supabase realtime token:', err);
      }
    });
  }, refreshDelay);
}

// Hidden: stop the refresh timer, so a background tab holding the sidebar's
// notification channel does not mint a token every ten minutes all day.
// Visible: refresh straight away if the token is inside the refresh window or
// already gone, otherwise just re-arm the timer. A token that EXPIRED while
// hidden means the server has dropped every channel opened with it, so once the
// new token is installed the resume listeners are told to reopen and re-read.
function handleVisibilityChange(): void {
  if (isPageHidden()) {
    clearRefreshTimer();
    return;
  }
  if (activeSubscribers <= 0 || currentTokenExpiresAt === 0) {
    return;
  }
  const now = Date.now();
  if (currentToken && now < currentTokenExpiresAt - REFRESH_LEEWAY_MS) {
    scheduleRefresh();
    return;
  }
  const expired = now >= currentTokenExpiresAt;
  currentToken = null;
  authorizeRealtime()
    .then((supabase) => {
      if (!supabase || !expired) return;
      resumeListeners.forEach((listener) => {
        try {
          listener();
        } catch (err) {
          if (process.env.NODE_ENV === 'development') {
            console.error('Realtime resume listener failed:', err);
          }
        }
      });
    })
    .catch((err) => {
      if (process.env.NODE_ENV === 'development') {
        console.error('Failed to refresh Supabase realtime token on resume:', err);
      }
    });
}

/**
 * Register an active realtime subscriber. Call in an effect's setup; pair with
 * `releaseRealtime()` in the cleanup. While the count is > 0 the JWT refresh
 * timer is allowed to run and the tab's visibility is watched; when it returns
 * to 0 the pending refresh is cancelled and the watch removed, so the tab stops
 * re-authing once no channel is open.
 */
export function retainRealtime(): void {
  activeSubscribers += 1;
  if (activeSubscribers === 1 && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
}

/**
 * Release a previously-retained realtime subscriber. When the last subscriber
 * goes away the pending refresh timer is cleared so we don't keep fetching
 * tokens for a tab with no open channels.
 */
export function releaseRealtime(): void {
  activeSubscribers = Math.max(0, activeSubscribers - 1);
  if (activeSubscribers === 0) {
    clearRefreshTimer();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  }
}

/**
 * Subscribe to "the token lapsed while the tab was hidden and a new one is now
 * installed". The Realtime server closes a channel whose token expires, so a
 * subscriber must reopen its channel here and re-read over REST once, because
 * any change made while the channel was down was never delivered. Returns the
 * unsubscribe function.
 */
export function onRealtimeResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => {
    resumeListeners.delete(listener);
  };
}

async function fetchRealtimeToken(): Promise<RealtimeTokenResponse | null> {
  const firebaseToken = await getFirebaseToken();
  if (!firebaseToken) {
    return null;
  }

  const response = await fetch(`${API_URL}/messaging/realtime-token`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${firebaseToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch realtime token');
  }

  return response.json() as Promise<RealtimeTokenResponse>;
}

/**
 * Fetch a Supabase Realtime JWT (using the current Firebase ID token) and
 * inject it into the realtime client. Schedules an automatic refresh shortly
 * before the token expires so long-lived subscriptions stay authorized.
 *
 * Safe to call repeatedly. It reschedules the single refresh timer each time.
 * Returns the configured client, or null when running on the server / when the
 * user is unauthenticated.
 */
export async function authorizeRealtime(): Promise<SupabaseClient | null> {
  const supabase = getRealtimeClient();
  if (!supabase) {
    return null;
  }

  // Reuse a still-valid token. The shared client already has it injected, so the
  // other hooks mounting on the same page don't need to fetch again; just make
  // sure the refresh timer is armed while subscribers are active.
  if (currentToken && Date.now() < currentTokenExpiresAt - REFRESH_LEEWAY_MS) {
    scheduleRefresh();
    return supabase;
  }

  // Fold concurrent authorize() calls into one fetch.
  if (inflight) {
    return inflight;
  }

  inflight = (async () => {
    try {
      const data = await fetchRealtimeToken();
      if (!data?.token) {
        return null;
      }

      // Installed before setAuth, so a heartbeat that reads the callback while
      // setAuth is still running already gets the new token.
      installedToken = data.token;
      await supabase.realtime.setAuth(data.token);
      currentToken = data.token;
      currentTokenExpiresAt = Date.now() + (data.expiresIn || 3600) * 1000;

      // Schedule a refresh before the token expires, but only while at least one
      // channel is active. Once every subscriber has released, the timer stays
      // cleared and the tab stops re-authing until a new channel subscribes.
      scheduleRefresh();

      return supabase;
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Failed to authorize Supabase realtime:', err);
      }
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
