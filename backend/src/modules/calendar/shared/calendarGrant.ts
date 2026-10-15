/**
 * What a calendar OAuth grant must contain, and how a stored grant reads.
 *
 * The callbacks, the refresh paths and every status reader share these rules,
 * so "connected" means the same thing on every screen and in background sync.
 * Firebase sign-in identity is never evidence of a calendar grant; only a row
 * in `user_oauth_tokens` with a refresh token and the calendar scope is.
 */
export type CalendarProvider = 'google' | 'microsoft';
export type CalendarConnectionState =
  'connected' | 'unverified' | 'permission_required' | 'reconnect_required' | 'disconnected';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const MICROSOFT_CALENDAR_SCOPE = 'calendars.readwrite';

// `calendar` covers everything `calendar.events` would grant, so only the
// broader scope is requested.
export const GOOGLE_REQUESTED_SCOPES = [
  GOOGLE_CALENDAR_SCOPE,
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];
// MailboxSettings.ReadWrite covers the read, and shared calendars are unused.
export const MICROSOFT_REQUESTED_SCOPES = [
  'offline_access', 'Calendars.ReadWrite', 'MailboxSettings.ReadWrite',
  'User.Read', 'email', 'openid', 'profile',
];

const GRAPH_PREFIX = /^https:\/\/graph\.microsoft\.com\//i;

function decodeScope(token: string) {
  try { return decodeURIComponent(token); } catch { return token; }
}

/**
 * Scopes a token response granted, or null when Google left them out.
 *
 * Microsoft documents an omitted scope as covering the authorization request,
 * and its example response URL-encodes each scope, so tokens are decoded before
 * the Graph prefix is stripped.
 */
export function grantedScopes(provider: CalendarProvider, tokenResponse: any): string[] | null {
  const raw = typeof tokenResponse?.scope === 'string' ? tokenResponse.scope : '';
  const tokens: string[] = raw.split(/\s+/).filter(Boolean);
  if (provider === 'microsoft') {
    if (!tokens.length) return [...MICROSOFT_REQUESTED_SCOPES];
    return tokens.map((t) => decodeScope(t).replace(GRAPH_PREFIX, ''));
  }
  return tokens.length ? tokens : null;
}

/** Exact match for Google; case-insensitive, prefix-tolerant for Microsoft. */
export function hasRequiredScope(provider: CalendarProvider, scopes: string[]): boolean {
  if (provider === 'google') return scopes.includes(GOOGLE_CALENDAR_SCOPE);
  return scopes.some((s) => decodeScope(s).replace(GRAPH_PREFIX, '').toLowerCase() === MICROSOFT_CALENDAR_SCOPE);
}

export interface ProviderAccount { accountId: string; accountEmail: string | null; tenantId: string | null }

/**
 * The provider account an ID token names. The token came straight from the
 * provider's token endpoint over TLS, which OIDC Core 3.1.3.7 accepts in place
 * of a signature check for the code flow.
 */
export function accountFromIdToken(provider: CalendarProvider, idToken: unknown): ProviderAccount | null {
  if (typeof idToken !== 'string') return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  let claims: any;
  try { claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
  const email = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
  if (provider === 'google') {
    if (typeof claims?.sub !== 'string' || !claims.sub) return null;
    return { accountId: claims.sub, accountEmail: email(claims.email), tenantId: null };
  }
  if (typeof claims?.tid !== 'string' || !claims.tid || typeof claims?.oid !== 'string' || !claims.oid) return null;
  return {
    accountId: `${claims.tid}:${claims.oid}`,
    accountEmail: email(claims.preferred_username) || email(claims.email),
    tenantId: claims.tid,
  };
}

export interface StoredGrant { refresh_token: string | null; scope: string | null; meta: any }

/**
 * The connection state of a stored row. Derived on every read, never stored as
 * a flag: a refresh failure or a downgraded scope is recorded on the row
 * (`meta.grantState`, `scope`) and this function turns that into the state.
 */
export function connectionState(provider: CalendarProvider, row: StoredGrant | null): CalendarConnectionState {
  if (!row || !row.refresh_token) return 'disconnected';
  const flagged = row.meta?.grantState;
  if (flagged === 'reconnect_required' || flagged === 'permission_required') return flagged;
  if (!row.scope) return 'unverified';
  return hasRequiredScope(provider, row.scope.split(/\s+/).filter(Boolean)) ? 'connected' : 'permission_required';
}

/** States in which a row may still be used to sync. */
export function syncAllowed(state: CalendarConnectionState) {
  return state === 'connected' || state === 'unverified';
}

const STATE_MESSAGES: Record<Exclude<CalendarConnectionState, 'connected'>, string> = {
  unverified: 'Reconnect to confirm calendar access.',
  permission_required: 'Calendar permission was not granted. Reconnect and allow calendar access.',
  reconnect_required: 'The calendar connection has expired. Please reconnect.',
  disconnected: 'The calendar is not connected.',
};

/** The body both check-auth routes answer with. */
export function connectionReport(state: CalendarConnectionState, email: string | null) {
  if (state === 'connected') return { authenticated: true, state, email };
  return { authenticated: false, state, email, message: STATE_MESSAGES[state] };
}

/** A callback outcome the route turns into a fixed error code in the redirect. */
export type CalendarConnectErrorCode =
  'access_denied' | 'admin_consent_required' | 'permission_required' | 'invalid_state'
  | 'expired_state' | 'exchange_failed' | 'missing_refresh_token' | 'identity_unverified';

export class CalendarConnectError extends Error {
  constructor(readonly code: CalendarConnectErrorCode, readonly returnUrl: string | null) {
    super(code);
    this.name = 'CalendarConnectError';
  }
}
