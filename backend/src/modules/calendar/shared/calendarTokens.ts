/**
 * Calendar OAuth token + sync-settings access (Postgres).
 *
 * Firestore stashed the Google/Microsoft tokens and a few sync extras on the
 * user doc, and the sync preferences on userSettings. The relational model
 * splits these:
 *   - tokens, the mailbox tz extras, AND the per-provider sync state (calendar
 *     id, app calendar id, sync cursor, the two direction flags) -> the
 *     user_oauth_tokens row for that provider
 *   - everything else -> users.preferences (jsonb)
 *
 * Migration 0217 dissolved `user_settings`. Its sync columns named Google
 * explicitly, so a third provider meant more columns on a table that had nothing
 * to do with providers; keyed by provider they are five columns and a new
 * provider is a new row.
 *
 * loadUserData() assembles the flat `userData` shape the sync engines expect
 * (googleAccessToken / microsoftAccessToken / googleSyncToken / outlookTimezone …).
 */

import { connectionState, syncAllowed, type CalendarProvider } from './calendarGrant';
import type { DrizzleExecutor } from '../../../shared/database/queryContext';

const { privilegedParameterizedQuery } = require('../../../shared/database/queryContext');

const calendarSql = (text: string, params: unknown[] = [], executor?: DrizzleExecutor) => privilegedParameterizedQuery(
  'calendar tokens are scoped by the authenticated user and provider', text, params, executor,
);

/**
 * The flat token-bearing shape the sync engines read.
 *
 * A provider's tokens are handed out only while its grant may still sync
 * (`syncAllowed(connectionState(...))`): a row whose refresh was refused, whose
 * calendar scope was withdrawn, or that holds no refresh token reads as having
 * no token, so every `if (!userData?.googleAccessToken)` guard in the engines
 * stops webhooks, renewals and manual syncs for it without a check of its own.
 *
 * A row that holds a token the gate withheld sets `googleGrantLost` /
 * `microsoftGrantLost`, so a user-facing call can answer "reconnect" rather than
 * "not connected".
 *
 * `includeUnusableGrants` is for teardown only (stopping a watch channel or a
 * subscription), which should still try whatever token the row holds.
 */
export async function loadUserData(userId: string, { includeUnusableGrants = false } = {}) {
  if (!userId) return null;
  const u = await calendarSql(`select id, name, email from users where id = $1 limit 1`, [userId]);
  // The users FK is soft-referenced (some member/client ids only live in auth),
  // so build the token-bearing shape even when there's no app users row.
  const data = u.rows[0] ? { ...u.rows[0] } : { id: userId, name: null, email: null };

  const t = await calendarSql(
    `select provider, access_token, refresh_token, scope, meta, sync_cursor from user_oauth_tokens where user_id = $1`,
    [userId]
  );
  data.googleSyncToken = null;
  for (const r of t.rows) {
    const meta = r.meta || {};
    const usable = includeUnusableGrants
      || syncAllowed(connectionState(r.provider as CalendarProvider, r));
    const lost = !usable && !!(r.access_token || r.refresh_token);
    if (r.provider === 'google') {
      data.googleGrantLost = lost;
      data.googleAccessToken = usable ? r.access_token || null : null;
      data.googleRefreshToken = usable ? r.refresh_token || null : null;
      data.googleSyncToken = r.sync_cursor || null;
      data.googleDeltaPageToken = meta.googleDeltaCursor === r.sync_cursor ? meta.googleDeltaPageToken || null : null;
    } else if (r.provider === 'microsoft') {
      data.microsoftGrantLost = lost;
      data.microsoftAccessToken = usable ? r.access_token || null : null;
      data.microsoftRefreshToken = usable ? r.refresh_token || null : null;
      data.outlookTimezone = meta.outlookTimezone || null;
      data.outlookMailboxTimezoneWritable = meta.outlookMailboxTimezoneWritable;
    }
  }
  return data;
}

/**
 * The flat, camelCase settings shape the sync engines read.
 *
 * Assembled from two places since migration 0217: the user row (timezone,
 * preferences) and that user's provider rows (the sync state). THE SHAPE IS
 * UNCHANGED, including the Google-named keys, because the engines and the
 * settings API both read them by those names.
 */
export async function getSettings(userId: string) {
  const { rows } = await calendarSql(
    `select u.timezone, u.preferences,
            g.calendar_id      as google_calendar_id,
            g.app_calendar_id  as paralegix_google_calendar_id,
            coalesce(g.is_sync_to_provider,   false) as allow_paralegix_to_google_sync,
            coalesce(g.is_sync_from_provider, false) as allow_google_to_paralegix_sync,
            coalesce(m.is_sync_to_provider,   false) as allow_paralegix_to_outlook_sync,
            coalesce(m.is_sync_from_provider, false) as allow_outlook_to_paralegix_sync
       from users u
       left join user_oauth_tokens g on g.user_id = u.id and g.provider = 'google'
       left join user_oauth_tokens m on m.user_id = u.id and m.provider = 'microsoft'
      where u.id = $1
      limit 1`,
    [userId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    ...(r.preferences || {}),
    timezone: r.timezone || null,
    allowParalegixToGoogleSync: r.allow_paralegix_to_google_sync,
    allowGoogleToParalegixSync: r.allow_google_to_paralegix_sync,
    allowParalegixToOutlookSync: r.allow_paralegix_to_outlook_sync,
    allowOutlookToParalegixSync: r.allow_outlook_to_paralegix_sync,
    googleCalendarId: r.google_calendar_id || null,
    paralegixGoogleCalendarId: r.paralegix_google_calendar_id || null,
  };
}

export async function getUserDataAndSettings(userId: string) {
  const [userData, settings] = await Promise.all([loadUserData(userId), getSettings(userId)]);
  return { userData, settings };
}

/**
 * C1: Cheap pre-check: does this user have at least one provider that is BOTH
 * usable AND has outbound sync enabled? One small query over the token rows.
 * Lets the fan-out skip members entirely before paying for a full
 * loadUserData()+getSettings().
 *
 * Usable means a refresh token is held and no refresh has recorded the grant as
 * lost or downgraded (`meta.grantState`). An access token alone expires within
 * the hour and cannot be renewed, so it does not qualify.
 *
 * Returns { google: bool, microsoft: bool }. True means "worth loading".
 *
 * `includeUnusableGrants` widens "usable" to "a connection is stored": the row
 * still holds a token, whatever its grant state. The outbound fan-out queues on
 * that, because an edit or delete made while the grant waits on a reconnect is
 * still owed to the copy on that calendar and is parked until the reconnect.
 * `ignoreSyncSetting` drops the outbound-sync flag, for deletes: a copy already
 * on the calendar is taken down even after the person stopped new pushes.
 */
export async function getOutboundSyncCapabilities(userId: string, {
  includeUnusableGrants = false, ignoreSyncSetting = false,
}: { includeUnusableGrants?: boolean; ignoreSyncSetting?: boolean } = {}) {
  if (!userId) return { google: false, microsoft: false };
  const { rows } = await calendarSql(
    `select
        bool_or(t.provider = 'google'
                and case when $2::boolean then (t.refresh_token is not null or t.access_token is not null)
                         else t.refresh_token is not null and t.meta->>'grantState' is null end
                and ($3::boolean or t.is_sync_to_provider))  as google,
        bool_or(t.provider = 'microsoft'
                and case when $2::boolean then (t.refresh_token is not null or t.access_token is not null)
                         else t.refresh_token is not null and t.meta->>'grantState' is null end
                and ($3::boolean or t.is_sync_to_provider)) as microsoft
       from user_oauth_tokens t
      where t.user_id = $1`,
    [userId, includeUnusableGrants, ignoreSyncSetting]
  );
  const r = rows[0] || {};
  return { google: !!r.google, microsoft: !!r.microsoft };
}

/**
 * Where each known settings key lives since migration 0217. `user` keys are
 * columns on the user row; the rest are per-provider columns on that user's
 * `user_oauth_tokens` row, which is why each carries the provider it belongs to.
 */
const USER_COLS: Record<string, string> = {
  timezone: 'timezone',
};
const PROVIDER_COLS: Record<string, { provider: 'google' | 'microsoft'; col: string }> = {
  allowParalegixToGoogleSync:  { provider: 'google',    col: 'is_sync_to_provider' },
  allowGoogleToParalegixSync:  { provider: 'google',    col: 'is_sync_from_provider' },
  allowParalegixToOutlookSync: { provider: 'microsoft', col: 'is_sync_to_provider' },
  allowOutlookToParalegixSync: { provider: 'microsoft', col: 'is_sync_from_provider' },
  googleCalendarId:            { provider: 'google',    col: 'calendar_id' },
  paralegixGoogleCalendarId:   { provider: 'google',    col: 'app_calendar_id' },
};

/**
 * Upsert sync settings. Known keys land on their structured column; everything
 * else (googleCalendarTarget, outlook calendar prefs) merges into the
 * preferences jsonb on the user.
 *
 * A PROVIDER ROW IS CREATED IF IT DOES NOT EXIST. A user can toggle a sync
 * preference before connecting that provider, or after disconnecting it, and
 * before 0217 that landed in `user_settings` regardless. The insert keeps that
 * working: a row with null tokens is already handled everywhere, because the
 * capability pre-check tests `refresh_token is not null` explicitly.
 */
export async function saveSettings(userId: string, patch: any = {}, executor?: DrizzleExecutor) {
  const userCols: Record<string, any> = {};
  const byProvider = new Map<string, Record<string, any>>();
  const prefs: Record<string, any> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (USER_COLS[key]) { userCols[USER_COLS[key]] = value; continue; }
    const target = PROVIDER_COLS[key];
    if (!target) { prefs[key] = value; continue; }
    const row = byProvider.get(target.provider) || {};
    row[target.col] = value;
    byProvider.set(target.provider, row);
  }

  const userColNames = Object.keys(userCols);
  const hasPrefs = Object.keys(prefs).length > 0;
  if (userColNames.length || hasPrefs) {
    const sets = userColNames.map((c, i) => `${c} = $${i + 2}`);
    const params: any[] = [userId, ...userColNames.map((c) => userCols[c])];
    if (hasPrefs) {
      params.push(JSON.stringify(prefs));
      sets.push(`preferences = coalesce(preferences, '{}'::jsonb) || $${params.length}::jsonb`);
    }
    await calendarSql(
      `update users set ${sets.join(',')}, updated_at = now() where id = $1`,
      params,
      executor,
    );
  }

  for (const [provider, cols] of byProvider) {
    const names = Object.keys(cols);
    const params: any[] = [userId, provider, ...names.map((c) => cols[c])];
    // Only CREATE a provider row when the write turns something on. An absent
    // row already means every flag is false and every id is null, so writing
    // all-falsy values to a provider the user has no row for is a no-op rather
    // than a reason to manufacture one.
    //
    // This matters on disconnect: unlinking deletes the token row and then saves
    // settings with the sync flags off, and an unconditional upsert here would
    // recreate the row the unlink had just removed.
    const turnsSomethingOn = names.some((c) => cols[c] !== false && cols[c] != null);
    const placeholders = names.map((_, i) => `$${i + 3}`);
    await calendarSql(
      turnsSomethingOn
        ? `insert into user_oauth_tokens (user_id, provider, ${names.join(',')})
           values ($1, $2, ${placeholders.join(',')})
           on conflict (user_id, provider) do update set
             ${names.map((c) => `${c} = excluded.${c}`).join(',')}`
        : `update user_oauth_tokens set ${names.map((c, i) => `${c} = $${i + 3}`).join(',')}
            where user_id = $1 and provider = $2`,
      params,
      executor,
    );
  }
}

/** The stored grant for one provider, as `connectionState()` reads it. */
export async function getConnectionRow(userId: string, provider: CalendarProvider, executor?: DrizzleExecutor) {
  if (!userId) return null;
  const { rows } = await calendarSql(
    `select access_token, refresh_token, scope, meta from user_oauth_tokens where user_id = $1 and provider = $2 limit 1`,
    [userId, provider],
    executor,
  );
  return rows[0] || null;
}

/** Upsert provider tokens (refresh token preserved if not provided). */
export async function saveTokens(
  userId: string, provider: any, { accessToken, refreshToken, scope, expiresAt }: any = {}, executor?: DrizzleExecutor,
) {
  await calendarSql(
    `insert into user_oauth_tokens (user_id, provider, access_token, refresh_token, scope, expires_at, token_updated_at)
     values ($1,$2,$3,$4,$5,$6, now())
     on conflict (user_id, provider) do update set
       access_token = coalesce(excluded.access_token, user_oauth_tokens.access_token),
       refresh_token = coalesce(excluded.refresh_token, user_oauth_tokens.refresh_token),
       scope = coalesce(excluded.scope, user_oauth_tokens.scope),
       expires_at = coalesce(excluded.expires_at, user_oauth_tokens.expires_at),
       token_updated_at = now()`,
    [userId, provider, accessToken || null, refreshToken || null, scope || null, expiresAt || null],
    executor,
  );
}

/**
 * Store an access token (and the scope it carries, when known) read back for
 * the token already on the row. Update-only: it never recreates a row.
 */
export async function saveAccessToken(userId: string, provider: any, accessToken: any, scope: string | null = null) {
  await calendarSql(
    `update user_oauth_tokens set access_token = $3, scope = coalesce($4, scope), token_updated_at = now()
      where user_id = $1 and provider = $2`,
    [userId, provider, accessToken, scope]
  );
}

/**
 * Persist what one refresh returned, in a single statement keyed on the refresh
 * token that was redeemed.
 *
 * Update-only, and only while the row still holds that refresh token: a
 * refresh that finishes after a disconnect writes nothing instead of
 * recreating the row, and one that started on an account since replaced by a
 * reconnect cannot overwrite the newer connection. `grantState` is left as it
 * is when undefined. `account` is recorded only on a row that has none, since a
 * refresh cannot change whose grant it is.
 */
export async function recordRefresh(userId: string, provider: CalendarProvider, redeemedRefreshToken: string, {
  accessToken, refreshToken = null, scope = null, grantState, account = null,
}: {
  accessToken: string;
  refreshToken?: string | null;
  scope?: string | null;
  grantState?: string | null;
  account?: { accountId: string; accountEmail: string | null; tenantId: string | null } | null;
}) {
  await calendarSql(
    `update user_oauth_tokens set
       access_token = $4,
       refresh_token = coalesce($5, refresh_token),
       scope = coalesce($6, scope),
       meta = coalesce(meta, '{}'::jsonb) || $7::jsonb
              || case when coalesce(meta->>'accountId', '') = '' then $8::jsonb else '{}'::jsonb end,
       token_updated_at = now()
     where user_id = $1 and provider = $2 and refresh_token = $3`,
    [userId, provider, redeemedRefreshToken, accessToken, refreshToken, scope,
      JSON.stringify(grantState === undefined ? {} : { grantState }),
      JSON.stringify(account
        ? { accountId: account.accountId, accountEmail: account.accountEmail, tenantId: account.tenantId }
        : {})],
  );
}

/**
 * Merge `metaPatch` into the row's meta. `refreshToken` narrows the write to a
 * row still holding that token, for a refresh outcome that must not land on a
 * newer connection.
 */
export async function updateTokenMeta(
  userId: string, provider: any, metaPatch: any, { refreshToken, executor }: { refreshToken?: string; executor?: DrizzleExecutor } = {},
) {
  await calendarSql(
    refreshToken
      ? `update user_oauth_tokens set meta = coalesce(meta, '{}'::jsonb) || $3::jsonb
          where user_id = $1 and provider = $2 and refresh_token = $4`
      : `update user_oauth_tokens set meta = coalesce(meta, '{}'::jsonb) || $3::jsonb where user_id = $1 and provider = $2`,
    refreshToken
      ? [userId, provider, JSON.stringify(metaPatch || {}), refreshToken]
      : [userId, provider, JSON.stringify(metaPatch || {})],
    executor,
  );
}

export async function deleteTokens(userId: string, provider: any, executor?: DrizzleExecutor) {
  await calendarSql(`delete from user_oauth_tokens where user_id = $1 and provider = $2`, [userId, provider], executor);
}

/**
 * Persist the Google incremental sync position on the user's google row.
 *
 * CLEARING IT NEVER CREATES THE ROW. `unlinkGoogle` deletes the token row and
 * then clears the cursor, so an unconditional upsert here would resurrect the
 * row the unlink had just removed, taking the sync flags that live on it with
 * it. An absent row already means "no cursor".
 */
export async function setGoogleSyncToken(userId: string, syncToken: any, executor?: DrizzleExecutor) {
  await calendarSql(
    syncToken
      ? `insert into user_oauth_tokens (user_id, provider, sync_cursor) values ($1, 'google', $2)
         on conflict (user_id, provider) do update set sync_cursor = $2`
      : `update user_oauth_tokens set sync_cursor = $2
          where user_id = $1 and provider = 'google'`,
    [userId, syncToken || null],
    executor,
  );
}
