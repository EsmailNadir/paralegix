import { createBoundedCache } from '../../../shared/utils/boundedCache';
import { accountFromIdToken, grantedScopes, hasRequiredScope, type CalendarProvider } from './calendarGrant';
import { htmlToText } from './htmlToText';
const calendarTokens = require('./calendarTokens');
const { AppError } = require('../../../shared/errors/AppError');
const { withLock, AdvisoryLockTimeoutError } = require('../../../shared/database/advisoryLock');
const { privilegedParameterizedQuery } = require('../../../shared/database/queryContext');

const calendarSql = (text: string, params: unknown[] = []) => privilegedParameterizedQuery(
  'calendar OAuth refresh is scoped by the authenticated user and provider', text, params,
);

// ── token-refresh de-dup ────────────────────────────────────────────
// Concurrent 401s for the same user used to each fire a refresh and race to
// persist. One clobbering the other's token. Share a single in-flight refresh
// per (provider,user) so concurrent calls await the same result.
const inflightRefresh = new Map();
function dedupeRefresh(key: any, fn: any) {
  const existing = inflightRefresh.get(key);
  if (existing) return existing;
  const p = (async () => {
    try { return await fn(); }
    finally { inflightRefresh.delete(key); }
  })();
  inflightRefresh.set(key, p);
  return p;
}

/**
 * How long a refresh may wait for another worker's refresh to finish.
 *
 * Longer than the 2s default because the work under this lock includes a round
 * trip to Microsoft or Google. The in-process `dedupeRefresh` above collapses
 * every concurrent 401 on ONE instance into a single waiter, so the number of
 * connections this can pin is bounded by the instance count, not by traffic.
 */
const REFRESH_LOCK_TIMEOUT_MS = 8000;

/**
 * Read just the persisted tokens for one provider, bypassing every cache.
 *
 * Used inside the refresh lock, where the whole point is to see what another
 * worker may have just written.
 */
async function readPersistedTokens(userId: string, provider: any) {
  const { rows } = await calendarSql(
    `select access_token, refresh_token from user_oauth_tokens where user_id = $1 and provider = $2 limit 1`,
    [userId, provider]
  );
  return rows[0] ? { accessToken: rows[0].access_token, refreshToken: rows[0].refresh_token } : null;
}

/**
 * A refresh that could not be completed: the token endpoint was unreachable or
 * answered 5xx/429, the new token could not be saved, or another instance held
 * the refresh lock too long. It says nothing about the grant, so it is a 503
 * the caller can retry, never the reconnect prompt a refused grant earns.
 */
export class CalendarRefreshUnavailableError extends AppError {
  constructor(provider: CalendarProvider) {
    super(
      `${provider === 'google' ? 'Google' : 'Microsoft'} is not reachable right now. Please try again shortly.`,
      503,
      'CALENDAR_REFRESH_UNAVAILABLE',
    );
  }
}

/** Whether a token endpoint's non-ok status is a refusal rather than a failed attempt. */
function isRefusalStatus(status: number) {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Serialize a token refresh for one (provider, user) across every instance.
 *
 * `dedupeRefresh` only dedupes within one process, which is enough for Google —
 * its refresh tokens do not rotate, and the Google path persists only the access
 * token, so a lost race is harmless. **Microsoft's refresh tokens DO rotate.**
 * `refreshMicrosoftToken` persists the new refresh token, so two instances
 * refreshing at once means the loser redeems an already-invalidated token, gets
 * a hard failure, and surfaces as `requiresReAuth` — breaking that user's
 * Outlook sync until they manually reconnect.
 *
 * Re-reading inside the lock is what makes the waiter cheap: by the time it
 * acquires, the winner has usually already persisted a fresh access token, so
 * the waiter returns that instead of burning a second refresh (and, for
 * Microsoft, instead of redeeming a token that is now dead).
 *
 * The write itself (`calendarTokens.recordRefresh`) only lands on a row still
 * holding the redeemed refresh token, so a refresh that loses a race with a
 * disconnect or a reconnect writes nothing. The lock is what stops two
 * instances redeeming the same rotating token in the first place; the connect
 * and disconnect paths take it too, so they never interleave with a refresh.
 */
function refreshUnderLock(provider: any, userId: string, currentRefreshToken: any, doRefresh: any) {
  const key = `${provider}:${userId}`;
  return dedupeRefresh(key, async () => {
    try {
      return await withLock('OAUTH_REFRESH', key, async () => {
        const persisted = await readPersistedTokens(userId, provider);
        // Someone else rotated while we waited: their access token is fresh and
        // our refresh token is stale (Microsoft) or redundant (Google).
        if (
          persisted
          && persisted.accessToken
          && currentRefreshToken
          && persisted.refreshToken
          && persisted.refreshToken !== currentRefreshToken
        ) {
          invalidateUserData(userId);
          return persisted.accessToken;
        }
        const token = await doRefresh();
        // The 5s user-data cache hands out token objects that the refresh path
        // mutates in place, so a cached entry can otherwise carry the stale
        // refresh token past this lock and into the next refresh attempt.
        if (token) invalidateUserData(userId);
        return token;
      }, { lockTimeoutMs: REFRESH_LOCK_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof AdvisoryLockTimeoutError) {
        // Contention past the timeout: fall back to whatever is persisted rather
        // than failing the caller's API call outright.
        const persisted = await readPersistedTokens(userId, provider);
        if (persisted && persisted.accessToken) {
          invalidateUserData(userId);
          return persisted.accessToken;
        }
        throw new CalendarRefreshUnavailableError(provider);
      }
      throw err;
    }
  });
}

// ── short-TTL user-data/settings cache ──────────────────────────────
// A single calendar event fan-out calls getUserDataAndSettings once per
// user×provider×entity (2 SQL each). Cache briefly so repeated lookups within a
// fan-out reuse the same object (token refreshes mutate it in-place, so the fresh
// token still propagates; a disconnect is picked up after the short TTL).
const USER_DATA_TTL_MS = 5000;

/**
 * Users held at once.
 *
 * The key is a user id, so it grows with the customer base. The short TTL did
 * not bound it: expiry was lazy, and the sweep ran only after the map had
 * passed 500 and removed only entries that had already expired, so a fan-out
 * touching more than 500 distinct users inside one TTL window grew it without
 * limit. At the ceiling the least recently used entry is evicted, which costs
 * two queries.
 */
const USER_DATA_CACHE_MAX_ENTRIES = Number(process.env.CALENDAR_USER_DATA_CACHE_MAX_ENTRIES) || 2000;

const userDataCache = createBoundedCache<any>({
  name: 'calendarUserData',
  maxEntries: USER_DATA_CACHE_MAX_ENTRIES,
  ttlMs: USER_DATA_TTL_MS,
});

/**
 * Drop a user's cached token/settings object.
 *
 * Called after a token refresh. The cached value is handed out by reference and
 * the refresh path mutates it in place, so without this a cached entry can carry
 * a refresh token that has already been redeemed — which for Microsoft, whose
 * refresh tokens rotate, means the next attempt redeems a dead token.
 */
export function invalidateUserData(userId: string) {
  if (userId) userDataCache.delete(userId);
}

/**
 * A provider description (Outlook body or Google description, HTML or plain
 * text) as plain text. Links keep their targets; see `htmlToText`.
 */
export function cleanHtmlContent(htmlContent: any) {
  return htmlToText(htmlContent);
}

/**
 * Record what a refused refresh says about the grant. Only `invalid_grant`
 * (revoked access, expired or rotated-away refresh token) means the grant is
 * gone; a 5xx or an unreadable body is transient and records nothing. Written
 * only while the row still holds the token that was refused.
 */
async function recordRefreshRefusal(
  userId: string, provider: CalendarProvider, status: number, bodyText: string, redeemedRefreshToken: string,
) {
  let error: unknown = null;
  try { error = JSON.parse(bodyText)?.error; } catch { /* not JSON: nothing to record */ }
  if (status >= 400 && status < 500 && error === 'invalid_grant') {
    await calendarTokens.updateTokenMeta(userId, provider, { grantState: 'reconnect_required' }, {
      refreshToken: redeemedRefreshToken,
    });
  }
}

/**
 * Persist a successful refresh with the scope it carries, and set or clear the
 * recorded grant problem to match: a refresh whose scope still includes the
 * calendar permission clears it, one without records `permission_required`.
 * A Google response that names no scope leaves both as they were. An ID token
 * in the response names the account, which a row connected before identity was
 * recorded keeps, so its next reconnect is not mistaken for a different account.
 *
 * Microsoft rotates refresh tokens, so its new one is stored with the access
 * token; Google's does not rotate. Either way the write lands only on a row
 * still holding the token that was redeemed (`recordRefresh`).
 */
async function recordRefreshSuccess(userId: string, provider: CalendarProvider, tokenData: any, redeemedRefreshToken: string) {
  const scopes = grantedScopes(provider, tokenData);
  await calendarTokens.recordRefresh(userId, provider, redeemedRefreshToken, {
    accessToken: tokenData.access_token,
    refreshToken: provider === 'microsoft' ? tokenData.refresh_token || null : null,
    scope: scopes ? scopes.join(' ') : null,
    grantState: scopes ? (hasRequiredScope(provider, scopes) ? null : 'permission_required') : undefined,
    account: accountFromIdToken(provider, tokenData.id_token),
  });
}

/**
 * Refresh a Microsoft access token using the refresh token.
 * Persists the new tokens and what the response says about the grant.
 */
export async function refreshMicrosoftToken(userId: string, refreshToken: any) {
  try {
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        client_secret: process.env.MICROSOFT_CLIENT_SECRET || '',
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('calendarHelpers: Microsoft token refresh failed:', response.status, errText);
      if (!isRefusalStatus(response.status)) throw new CalendarRefreshUnavailableError('microsoft');
      await recordRefreshRefusal(userId, 'microsoft', response.status, errText, refreshToken);
      return null;
    }

    const tokenData = await response.json();
    if (!tokenData?.access_token) return null;
    await recordRefreshSuccess(userId, 'microsoft', tokenData, refreshToken);
    return tokenData.access_token;
  } catch (error: any) {
    if (error instanceof CalendarRefreshUnavailableError) throw error;
    // A database error's message carries the query parameters, which here are
    // the tokens, so only its code is logged.
    console.error('calendarHelpers: Microsoft token refresh error:', error?.cause?.code ?? error?.code ?? 'unknown');
    throw new CalendarRefreshUnavailableError('microsoft');
  }
}

/**
 * Run `fn` holding the same per-(provider, user) lock a refresh takes, so a
 * connect or disconnect never interleaves with a refresh's read and write.
 */
export function withRefreshLock<T>(provider: CalendarProvider, userId: string, fn: () => Promise<T>): Promise<T> {
  return withLock('OAUTH_REFRESH', `${provider}:${userId}`, fn, { lockTimeoutMs: REFRESH_LOCK_TIMEOUT_MS });
}

/**
 * Refresh one provider's token under the cross-instance refresh lock. Returns
 * the new access token, or null when the refresh did not succeed, whether the
 * grant was refused or the attempt failed. Its callers read the outcome off the
 * row's recorded grant state, which only a refusal sets.
 */
export async function refreshGrant(provider: 'google' | 'microsoft', userId: string, refreshToken: string) {
  try {
    return await refreshUnderLock(provider, userId, refreshToken, () => (provider === 'google'
      ? refreshGoogleToken(userId, refreshToken)
      : refreshMicrosoftToken(userId, refreshToken)));
  } catch (err) {
    if (err instanceof CalendarRefreshUnavailableError) return null;
    throw err;
  }
}

/** Retry explicit throttling; safe reads and deletes also retry transient server errors. */
async function fetchCalendarRequest(url: any, options: any) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    const limited = response.status === 429 || (response.status === 403 && await isGoogleRateLimit403(response));
    const safeMethod = ['GET', 'DELETE'].includes((options.method || 'GET').toUpperCase());
    if (attempt >= 2 || !(limited || (safeMethod && [500, 502, 503, 504].includes(response.status)))) return response;
    const retryAfter = response.headers.get('Retry-After');
    const parsedSeconds = retryAfter === null ? NaN : Number(retryAfter);
    const delay = retryAfter === null ? 250 * (2 ** attempt)
      : Number.isFinite(parsedSeconds) ? Math.max(0, parsedSeconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (!Number.isFinite(delay) || delay > 5000) return response;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Make a Microsoft Graph API call with automatic token refresh on 401.
 */
export async function makeMicrosoftGraphCall(userId: string, userData: any, url: any, options: any = {}) {
  try {
    const response = await fetchCalendarRequest(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${userData.microsoftAccessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.ok) return response;

    if (response.status === 401) {
      const refreshToken = userData.microsoftRefreshToken;
      if (refreshToken) {
        const newAccessToken = await refreshUnderLock('microsoft', userId, refreshToken, () => refreshMicrosoftToken(userId, refreshToken));
        if (newAccessToken) {
          userData.microsoftAccessToken = newAccessToken;
          const retryResponse = await fetchCalendarRequest(url, {
            ...options,
            headers: {
              'Authorization': `Bearer ${newAccessToken}`,
              'Content-Type': 'application/json',
              ...options.headers,
            },
          });
          return retryResponse;
        }
      }
      // No refresh token, or the grant was refused: require re-auth. A refresh
      // that could not be completed has already thrown its retryable 503.
      const error: any = new Error('Microsoft token expired. Please reconnect your Microsoft account.');
      error.code = 'NO_REFRESH_TOKEN';
      error.requiresReAuth = true;
      throw error;
    }

    return response;
  } catch (error: any) {
    console.error('Error in makeMicrosoftGraphCall:', error);
    throw error;
  }
}

/**
 * Refresh a Google access token using the refresh token.
 * Persists the new access token and what the response says about the grant.
 */
export async function refreshGoogleToken(userId: string, refreshToken: any) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('calendarHelpers: Google token refresh failed:', response.status, errText);
      if (!isRefusalStatus(response.status)) throw new CalendarRefreshUnavailableError('google');
      await recordRefreshRefusal(userId, 'google', response.status, errText, refreshToken);
      return null;
    }

    const tokenData = await response.json();
    if (!tokenData?.access_token) return null;
    await recordRefreshSuccess(userId, 'google', tokenData, refreshToken);
    return tokenData.access_token;
  } catch (error: any) {
    if (error instanceof CalendarRefreshUnavailableError) throw error;
    // A database error's message carries the query parameters, which here are
    // the tokens, so only its code is logged.
    console.error('calendarHelpers: Google token refresh error:', error?.cause?.code ?? error?.code ?? 'unknown');
    throw new CalendarRefreshUnavailableError('google');
  }
}

/**
 * Decide whether a Google 403 is a rate-limit/quota error (back off. Refreshing
 * the token would be a pointless extra call) vs an auth-style 403 (treat like a
 * 401 and refresh). Peeks at a CLONE of the response so the body stays readable
 * for the caller. Conservative: only the well-known rate/quota reasons short
 * circuit; anything else preserves the historical refresh-on-403 behavior.
 */
const GOOGLE_RATE_LIMIT_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/i;

async function isGoogleRateLimit403(response: any) {
  try {
    const body = await response.clone().text();
    return GOOGLE_RATE_LIMIT_REASONS.test(body);
  } catch {
    return false;
  }
}

/**
 * A 403 because the token lacks a scope (the person unticked calendar access).
 * Refreshing cannot add a scope, so this is recorded as `permission_required`
 * and reported as needing a reconnect instead of being retried. Matched on the
 * scope-specific reason and message only: a plain `insufficientPermissions` is
 * also what Google answers for a calendar the account cannot write to.
 */
const GOOGLE_SCOPE_403 = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i;

async function isGoogleScope403(response: any) {
  try {
    return GOOGLE_SCOPE_403.test(await response.clone().text());
  } catch {
    return false;
  }
}

/**
 * Make a Google API call with automatic token refresh on 401 (and auth-style 403).
 */
export async function makeGoogleApiCall(userId: string, userData: any, url: any, options: any = {}) {
  try {
    const response = await fetchCalendarRequest(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${userData.googleAccessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.ok) return response;

    // C7: a 403 rateLimitExceeded/quotaExceeded is NOT an auth failure. Refreshing
    // the token wastes a call and re-hits the same limit. Return it so the caller
    // surfaces/backs off. Only a 401 (or a non-rate-limit 403) drives a refresh.
    if (response.status === 403 && await isGoogleRateLimit403(response)) {
      return response;
    }

    if (response.status === 403 && await isGoogleScope403(response)) {
      // Only on the grant this call was made with: a reconnect saved while the
      // call was in flight holds a new refresh token and keeps its state.
      await calendarTokens.updateTokenMeta(userId, 'google', { grantState: 'permission_required' }, {
        refreshToken: userData.googleRefreshToken,
      });
      const error: any = new Error('Google calendar permission was not granted. Please reconnect your Google account.');
      error.code = 'NO_REFRESH_TOKEN';
      error.requiresReAuth = true;
      throw error;
    }

    if (response.status === 401 || response.status === 403) {
      const refreshToken = userData.googleRefreshToken;
      if (refreshToken) {
        const newAccessToken = await refreshUnderLock('google', userId, refreshToken, () => refreshGoogleToken(userId, refreshToken));
        if (newAccessToken) {
          // Update userData in-place so callers see the fresh token
          userData.googleAccessToken = newAccessToken;
          const retryResponse = await fetchCalendarRequest(url, {
            ...options,
            headers: {
              'Authorization': `Bearer ${newAccessToken}`,
              'Content-Type': 'application/json',
              ...options.headers,
            },
          });
          return retryResponse;
        }
      }
      const error: any = new Error('Google token expired. Please reconnect your Google account.');
      error.code = 'NO_REFRESH_TOKEN';
      error.requiresReAuth = true;
      throw error;
    }

    return response;
  } catch (error: any) {
    if (error.code === 'NO_REFRESH_TOKEN') throw error;
    console.error('Error in makeGoogleApiCall:', error);
    throw error;
  }
}

/**
 * Get user data and settings. Returns null fields if not found.
 */
export async function getUserDataAndSettings(userId: string) {
  const cached = userDataCache.get(userId);
  if (cached) return cached;
  const value = await calendarTokens.getUserDataAndSettings(userId);
  userDataCache.set(userId, value);
  return value;
}

// Every form a source marker has been written in: "(Task from Paralegix)"
// now, and earlier "<dash> Task from Paralegix" and the bare phrase. The dash
// is built from its code point so this file never holds the character itself.
const MARKER_KINDS = '(Task|Matter event|Client event|External event|Billing item) from Paralegix';
const OLD_MARKER_DASH = String.fromCharCode(0x2014);
const markerPattern = (flags: string) => new RegExp(
  `^[ \\t]*(?:\\r?\\n[ \\t]*)*(?:${OLD_MARKER_DASH}[ \\t]*)?\\(?\\s*${MARKER_KINDS}\\s*\\)?\\s*(?=\\r?$)`, `${flags}m`,
);

/**
 * Strip Paralegix source markers from a description so they don't
 * get written back into Paralegix entities on inbound sync.
 * Handles every marker form and entity type; stripping twice changes nothing.
 */
export function stripSourceMarker(text: any) {
  if (!text) return '';
  return String(text).replace(markerPattern('gi'), '').trim();
}

// Exchange's encoding of a UID it did not generate (MS-OXOCAL 2.2.1.27): the
// "vCal-Uid" tag and a 1 in 4 little-endian bytes, then the UID, then a NUL.
const VCAL_UID_TAG = Buffer.from('vCal-Uid\x01\x00\x00\x00', 'latin1');
// A Global Object Id is at least 40 bytes before its variable data.
const MIN_GOID_HEX_LENGTH = 80;

/**
 * The invitation's iCalendar UID in one form both providers agree on, or null.
 *
 * Google reports the UID as sent (`iCalUID`). Microsoft Graph reports
 * `iCalUId` as the hex of the meeting's Global Object Id, and for a meeting
 * organized outside Exchange (a Google invite) that id wraps the original UID
 * behind the "vCal-Uid" tag, so it is unwrapped here. A meeting organized in
 * Exchange reaches Google with the hex id itself as its UID, which already
 * matches. Compared lower-cased, since hex case differs between the two.
 */
export function normalizeICalUid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length >= MIN_GOID_HEX_LENGTH && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)) {
    const bytes = Buffer.from(value, 'hex');
    const at = bytes.indexOf(VCAL_UID_TAG);
    if (at >= 0) {
      const start = at + VCAL_UID_TAG.length;
      const nul = bytes.indexOf(0, start);
      const uid = bytes.subarray(start, nul < 0 ? bytes.length : nul).toString('utf8').trim();
      if (uid) return uid.toLowerCase();
    }
  }
  return value.toLowerCase();
}

/**
 * Detect whether an event description contains a Paralegix source marker,
 * indicating the event was originally created by an outbound Paralegix sync.
 */
export function isParalegixOriginated(text: any) {
  if (!text) return false;
  return markerPattern('i').test(cleanHtmlContent(text));
}

const EVENT_TYPE_LABEL_PATTERN = /^(?:Court Date|Hearing|Deposition|Filing Deadline|Discovery Cutoff|Mediation|Arbitration|Trial|Appeal Deadline|Statute of Limitations|Meeting|Event):[ \t]*[^\n]*\n*/i;
const GOOGLE_TASK_READONLY_NOTICE_PATTERN = /\s*Changes made to the title, description, or attachments will not be saved\.\s*To make edits,\s*please go to:\s*https:\/\/tasks\.google\.com\/task\/[^\s\n]+/gi;
// The link `calendarDescriptionBuilder` writes above the marker. Recognized
// anywhere, since a provider can append its own text (a Teams block) after it.
const PARALEGIX_LINK_LINE = /^[ \t]*Open in Paralegix:[ \t]*https?:\/\/\S+[ \t]*(?:\n|$)/gim;
const CLIENT_LINE = /^Client:[ \t]*[^\n]*\n*/i;
// "Clients:" then one line per client, up to the blank line that closes the section.
const CLIENTS_BLOCK = /^Clients:\n[\s\S]*?(?:\n\n+|$)/i;
const LOCATION_LINE = /^Location:[ \t]*[^\n]*\n*/i;
const EXTERNAL_LINE = /^External event:[ \t]*[^\n]*\n*/i;
// The marker kind each mapped entity type's push writes.
const MARKER_KIND_BY_ENTITY: Record<string, string> = {
  task: 'task', matterEvent: 'matter event', clientEvent: 'client event',
};

/**
 * Strip what outbound sync wrote around the user's own text.
 *
 * Outbound format, sections joined by a blank line (`calendarDescriptionBuilder`):
 *   task:         [client section] [description] [footer]
 *   matter event: [client section] TypeLabel: Title [Location: ...] [notes] [footer]
 *   client event: [client section] TypeLabel: Title [notes] [footer]
 *   external:     External event: Title [notes] [marker]
 * where the footer is "Open in Paralegix: <url>" over the source marker.
 *
 * The marker is the anchor. Without one the text is not Paralegix's (a
 * colleague's invitation, a description rewritten in the provider) and only
 * the link line and Google's read-only notice come off. With one, the header
 * sections that marker's entity type writes are removed from the top, once
 * each and in the builder's order, so notes that open with a header-shaped
 * line of their own are kept.
 *
 * `entityType` is the item a calendar mapping says the event was pushed for.
 * It stands in for a marker the member deleted in the provider: the text is
 * still the one Paralegix wrote, and leaving its header sections in would
 * write them into the notes and add another copy on every round trip.
 */
export function stripCalendarHeader(text: any, entityType?: string | null) {
  if (!text) return '';

  let cleaned = String(text).replace(/\r\n?/g, '\n').replace(GOOGLE_TASK_READONLY_NOTICE_PATTERN, '');
  const kind = cleaned.match(markerPattern('i'))?.[1]?.toLowerCase()
    || (entityType ? MARKER_KIND_BY_ENTITY[entityType] : null)
    || null;
  cleaned = cleaned.replace(PARALEGIX_LINK_LINE, '');
  cleaned = stripSourceMarker(cleaned);
  if (!kind) return cleaned.trim();

  if (kind !== 'billing item' && kind !== 'external event') {
    cleaned = CLIENTS_BLOCK.test(cleaned) ? cleaned.replace(CLIENTS_BLOCK, '') : cleaned.replace(CLIENT_LINE, '');
  }
  if (kind === 'matter event' || kind === 'client event') {
    const labelled = EVENT_TYPE_LABEL_PATTERN.test(cleaned);
    cleaned = cleaned.replace(EVENT_TYPE_LABEL_PATTERN, '');
    if (labelled && kind === 'matter event') cleaned = cleaned.replace(LOCATION_LINE, '');
  }
  if (kind === 'external event') cleaned = cleaned.replace(EXTERNAL_LINE, '');

  return cleaned.trim();
}
