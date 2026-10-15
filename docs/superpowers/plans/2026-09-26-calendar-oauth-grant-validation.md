# Calendar OAuth Grant Validation Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Plan tasks usually build on each other, so execute inline by default; split a task out to a subagent only when it is genuinely independent; see the `delegating-to-subagents` skill.

**Status:** Tasks 1 to 11 implemented on 2026-10-05 and verified by the automated checks (uncommitted). Only Task 11 Step 4, the provider smoke tests in a real browser, remains; delete this plan once they pass. The durable description now lives in `docs/features/authentication.md` and `docs/features/calendar.md`. One addition beyond the tasks: a refresh records the account its ID token names on rows connected before identity was recorded, so existing connections learn their account before their next reconnect (`recordAccountIfUnknown`, `calendarTokens.ts`).

**Goal:** Report a Google or Microsoft calendar as connected only when Paralegix holds a durable token, for a known provider account, that carries the calendar permission the integration uses. Keep a working connection intact when a reconnect fails, and stop social sign-in from creating or overwriting a calendar connection.

**Architecture:** One pure module, `calendarGrant.ts`, owns the requested and required scopes, scope parsing, ID-token identity and the connection-state rule. The two OAuth callbacks validate everything before any write and return typed error codes. Every status reader (check-auth routes, the user-settings read, the outbound-sync pre-check) derives state from the stored row through that module, so the frontend stops guessing from Firebase `providerData` or HTTP 200s.

**Tech Stack:** Express 5 + Drizzle/pg (backend), Jest through the real routes with the `support/googleFetch.ts` fetch wall, Next.js 16 / React 19 + Jest/RTL (frontend).

**Scope:** The server-side authorization-code flows, token refresh, status reads, disconnect, the social sign-in token path, and the frontend consumers (General Settings, Calendar, get-started, background sync). No schema change: `user_oauth_tokens.scope` and `user_oauth_tokens.meta` (jsonb) already exist (`backend/db/schema/10_identity.sql:134-154`).

**Out of scope (noted, not planned):** the post-connect watch channel and subscription open on `lawFirmIds[0]` only (`auth.service.ts:946-958`, `1066-1078`); the frontend `checkCalendarAccess`, `checkMicrosoftConnection` and `checkMicrosoftTokenStatus` helpers (`frontend/src/services/auth.service.ts:609-855`) have no caller outside tests, and `/auth/check-calendar-access` reads only the Microsoft token (`auth.service.ts:731-745`) although its frontend test calls it Google.

---

## Findings in the current code

None of the nine findings in the 2026-09-26 version is fixed. Three were wrong or have moved and are corrected here (marked *corrected*). Findings 10 to 17 are new.

1. **No scope check on either callback.** Google requests `calendar calendar.events userinfo.email openid` (`backend/src/modules/auth/auth.service.ts:868`); `handleGoogleCallback` saves the tokens and sets `loggedInWithGoogle: true` without reading `tokenData.scope` (`:927-944`). Microsoft does the same (`:1055-1064`). The scope strings are duplicated at `:868`, `:996`, `:1041` and in the Firebase providers (`frontend/src/services/auth.service.ts:35-52`).
2. **Google `calendar` is the required scope.** `calendar.events` alone cannot create the Paralegix calendar. Unchanged from the old plan.
3. **Microsoft `Calendars.ReadWrite` is required**; `MailboxSettings.*` is optional (mailbox time-zone write is already non-fatal) and `Calendars.ReadWrite.Shared` is unused. An omitted token-response `scope` means the token covers the requested scopes.
4. **`saveTokens` already takes `scope`** (`backend/src/modules/calendar/shared/calendarTokens.ts:210-222`) and coalesces it, but no caller passes it. Neither refresh path records the refreshed `scope` (`calendarHelpers.ts:194-201`, `:281-284`; `auth.service.ts:774-781`).
5. **Identity-only probes.** `checkAuth` calls `/oauth2/v1/userinfo` (`backend/src/modules/calendar/google/google.service.ts:645-668`) and Graph `/me` (`outlook/outlook.service.ts:703-716`). The frontend turns any 200 into `authenticated: true` without reading the body (`frontend/src/services/googleCalendarSync.service.ts:294-315`, `outlookCalendarSync.service.ts:357-378`). `useGetStartedProgress.ts:62-74` inherits this.
6. **Flags seeded from Firebase identity.** Registration and first login set `loggedInWithGoogle`/`loggedInWithMicrosoft` from `providerData` (`auth.service.ts:340-350`, `:446-450`, `:561-565`, `:575-587`). General Settings falls back to `providerData` too (`frontend/src/app/lawfirm/[lawFirmId]/settings/general/page.tsx:138-158`).
7. *Corrected.* **Social sign-in tokens DO carry calendar scope.** The old plan (and the comment at `auth.service.ts:593-595`) says popup tokens lack calendar scopes. They do not: the Firebase Google and Microsoft providers request `calendar` and `Calendars.ReadWrite` (`frontend/src/services/auth.service.ts:35-52`), and every login posts that access token (`:154-162`, `:196-205`, `:776`, `:792`, `googleCalendarSync.service.ts:142`). `persistOAuthTokens` (`auth.service.ts:318-331`, called at `:444`, `:544`, `:559`, `:596`) upserts it over the calendar row and keeps the old refresh token. If the person signs in with a different Google or Microsoft account from the one they connected, Paralegix writes to the sign-in account's calendar for up to an hour, then the 401 refresh silently swaps back to the connected account.
8. *Corrected.* **Who reads the flags.** Backend outbound sync does not read `loggedInWith*`; it gates on `access_token is not null and is_sync_to_provider` (`calendarTokens.ts:110-124`, used at `calendar.events.ts:81`), so a popup-only row with an access token and no refresh token qualifies. The flags are read by the frontend only: `useCalendarBackgroundSync.ts:59`, `:85`, `Calendar.tsx:289-292`, and General Settings. The Calendar self-heal persists `loggedInWithGoogle: true` after the identity-only probe (`frontend/src/components/calendarComp/Calendar.tsx:349-370`).
9. *Corrected.* **Callback redirects.** Every failure goes to `${FRONTEND_URL}/lawfirm/settings` (`backend/src/modules/auth/auth.routes.ts:179`, `:183`, `:193`, `:221`, `:225`, `:236`), which is not a route (only `frontend/src/app/lawfirm/[lawFirmId]/` exists), so the person lands on a 404. The URL carries the raw `err.message` or Microsoft `error_description` (trace and correlation ids included). Success goes to the state's `return_url` (`:187-190`). `backend/tests/auth/oauthCodeExchange.test.ts:244-325`, `:439-457` and `backend/tests/auth/authServiceUnit.test.ts:470-500` pin this behavior and must change.
10. **Client can write the connection flags.** `PUT /api/settings/user` accepts `loggedInWithGoogle`, `loggedInWithMicrosoft` and `googleConnectedEmail` (`backend/src/modules/settings/settings.validation.ts:105-107`) and merges them into preferences (`settings.service.ts:170`). This is the write path the self-heal and `unlinkGoogle`/`unlinkMicrosoft` (`frontend/src/services/auth.service.ts:589`, `:606`) use.
11. **OAuth state lookup.** Both callbacks select by `state` only, never by `provider` (`auth.service.ts:882-886`, `:1007-1011`), then delete in a second statement (`:899`, `:1025`), so two concurrent callbacks with one state can both pass. The provider-error branch returns before the state is read (`auth.routes.ts:177-180`, `:219-222`), so a denied consent cannot reach its `return_url`.
12. **State is bound to a uid, not to a browser.** Anyone signed in can mint a state for their own uid (`POST /connect-google`) and hand the provider URL to someone else; when that person consents, their calendar tokens land on the minting account. Nothing ties the callback to the browser that started the flow.
13. **No provider account identity is stored.** Google keeps only `preferences.googleConnectedEmail`, overwritten on every connect from `/userinfo` (`auth.service.ts:796-830`); `login_hint` (`:873-875`) is a hint, and `prompt=select_account` lets the person pick another account. Microsoft stores nothing. Reconnecting to a different account keeps the old `sync_cursor`, `calendar_id`, `app_calendar_id`, provider imports and watch channel or subscription.
14. **A connect without a refresh token is accepted.** Both callbacks save `refreshToken || null` and mark connected (`auth.service.ts:935`, `:1063`); `oauthCodeExchange.test.ts:341-353` and `:429-437` pin it. Background sync then dies within the hour.
15. **Refresh failure is never recorded.** `refreshMicrosoftToken` and `refreshGoogleToken` return `null` for `invalid_grant` and for a 5xx alike (`calendarHelpers.ts:175-207`, `:260-291`). Callers throw `requiresReAuth` per call (`:242-246`, `:352-355`) and webhook handlers swallow it (`outlook.service.ts:1565-1568`), but the row still reads as connected forever. A Google 403 for insufficient scope triggers a pointless refresh and retry (`calendarHelpers.ts:334-351`).
16. **Disconnect does not revoke.** `unlinkGoogle` deletes the row (`auth.service.ts:710-728`) but never calls Google's revoke endpoint, so the grant stays live in the person's Google account. Microsoft has no per-app revoke for delegated tokens; deletion is the only option.
17. **Only General Settings reads the outcome.** `google_connected`/`google_error` and the Microsoft pair are handled only in `settings/general/page.tsx:202-241`, which sets `loggedInWith*: true` and fires `calendar_connected` analytics from the URL alone. A reconnect started from `/auth/reconnect` (`frontend/src/app/auth/reconnect/page.tsx:36-47`) returns to a page that shows nothing.

## Connection contract

Separate **signed in with a provider** from **calendar connected**. Firebase identity is valid for login and is never evidence of a calendar grant.

| Provider | Required | Optional or redundant | Token-response handling | Account identity |
| --- | --- | --- | --- | --- |
| Google | Exact `https://www.googleapis.com/auth/calendar`, plus a refresh token (new, or the stored one for the same account) | `calendar.events` (covered by `calendar`), identity scopes | Split `scope` on whitespace, exact match. Missing or empty `scope` is unverified and cannot create a connection. | `id_token` claim `sub` (stored as `meta.accountId`), `email` as `meta.accountEmail` |
| Microsoft | `Calendars.ReadWrite`, plus a refresh token (new, or the stored one for the same account) | `Calendars.ReadWrite.Shared`, `MailboxSettings.Read`, `MailboxSettings.ReadWrite`, identity scopes | Split on whitespace, strip a `https://graph.microsoft.com/` prefix, compare case-insensitively. Omitted `scope` means the requested set. | `id_token` claims `tid` + `oid` (`meta.accountId = tid:oid`), `preferred_username` or `email` as `meta.accountEmail`, `tid` as `meta.tenantId` |

The ID token comes straight from the provider's token endpoint over TLS in the code flow, so OIDC Core 3.1.3.7 allows reading its claims without a signature check. No ID token or no subject means identity is unverified and the callback refuses.

**Connection state** (derived, never stored as a flag):

| State | Rule | `authenticated` | Sync allowed |
| --- | --- | --- | --- |
| `disconnected` | no row, or no `refresh_token` | false | no |
| `reconnect_required` | `meta.grantState = 'reconnect_required'` (refresh got `invalid_grant`) | false | no |
| `permission_required` | `meta.grantState = 'permission_required'`, or recorded `scope` lacks the required scope | false | no |
| `unverified` | refresh token present, `scope` null (legacy row) | false | yes, during rollout |
| `connected` | refresh token present, recorded `scope` has the required scope | true | yes |

`check-auth` resolves `unverified` on first read: Google through `https://oauth2.googleapis.com/tokeninfo?access_token=...` (returns `scope`), Microsoft through one locked refresh (the refresh response carries `scope`). Status reads otherwise use only the stored row, with no provider call.

## Verified against provider documentation (2026-10-05)

- Google's token response `scope` lists only the scopes the person actually granted; with granular consent an app "must verify which scopes were actually granted" (Google, *Using OAuth 2.0 for Web Server Applications*). A refresh token is returned with `access_type=offline`; `initGoogleConnect` already sends `prompt=consent select_account`, so every consent returns one. Revoking a refresh token at `POST https://oauth2.googleapis.com/revoke` (`token=` form parameter) ends the whole grant. A denial redirects with `error=access_denied`.
- Microsoft's token response `scope` is optional and, "if omitted, the token is for the scopes requested on the initial leg"; a refresh token comes only with `offline_access` and an ID token only with `openid` (Microsoft identity platform, *OAuth 2.0 authorization code flow*). Microsoft's own example returns the scope **URL-encoded** (`https%3A%2F%2Fgraph.microsoft.com%2Fmail.read`), so `grantedScopes` must `decodeURIComponent` each token before stripping the Graph prefix. Confidential clients may use the code-redemption ID token's claims; `tid` + `oid` identify the account.
- The state cookie (D3) works as designed: both redirect URIs are on the API host (`GOOGLE_REDIRECT_URI`, `MICROSOFT_REDIRECT_URI`), the provider's return is a top-level GET that carries a `SameSite=Lax` cookie, the app and API are same-site in every environment (`localhost`, `staging.paralegix.com`/`api-staging`, `paralegix.com`/`api`), and CORS already allows credentials (`backend/src/app.ts`).

Corrections this review added to the tasks:

- **Task 1:** URL-decode Microsoft scope tokens (test: `'https%3A%2F%2Fgraph.microsoft.com%2FCalendars.ReadWrite'` passes `hasRequiredScope`).
- **Task 8:** `/auth/reconnect` (`frontend/src/app/auth/reconnect/page.tsx`) reconnects through a Firebase redirect, which yields a pop-up access token with no refresh token. With D1 that path writes nothing, so the page must start the server code flow instead (`connectGoogleCalendar` / `connectMicrosoftCalendar` with its `return` parameter). Delete `reconnectGoogleRedirect`, `reconnectMicrosoftRedirect`, `processReconnectRedirectResult`, `processReconnectCredential` and the uncalled `GoogleCalendarSyncService.handleRedirectResult`. Nothing in the app links to the page, but keep the route so an old link still works.
- **Task 7:** `POST /api/auth/refresh-microsoft-token` returns the raw Microsoft access token to the browser, and the only caller (`ensureValidToken`, `outlookCalendarSync.service.ts`) uses it as a yes/no signal. Return `{ refreshed: true }` instead and make `AuthService.refreshMicrosoftToken` return a boolean.
- **Naming:** the settings read returns `googleCalendarState` and `microsoftCalendarState` (Task 10's `microsoftCalendarState` is renamed to match `loggedInWithMicrosoft`).

## Decisions (approved 2026-10-05, as recommended)

- **D1. Social sign-in stops touching calendar tokens.** *Recommended:* remove the calendar scopes from the Firebase providers, stop posting `googleAccessToken`/`microsoftAccessToken` to `/auth/login` and `/auth/complete-registration`, and delete `persistOAuthTokens`. Alternative: keep the scopes but never write popup tokens. Either way the sign-in consent screen stops being the calendar consent.
- **D2. Reconnecting to a different provider account.** *Recommended:* treat it as disconnect then connect: stop the watch channel or subscription, forget provider imports, clear `sync_cursor`/`calendar_id`/`app_calendar_id`, turn both sync directions off, revoke the old Google grant. Alternative: refuse and ask the person to disconnect first.
- **D3. Bind the OAuth state to the starting browser.** *Recommended:* yes. `connect-*` sets an httpOnly, SameSite=Lax cookie holding the state (path `/api/auth`, 10 minutes); the callback refuses a state that does not match it. Needs `credentials: 'include'` on the connect fetch, the same pattern as `docs-session`.
- **D4. Revoke Google on disconnect.** *Recommended:* yes, best-effort POST to `https://oauth2.googleapis.com/revoke` before deleting the row; a failure is logged and the disconnect proceeds. Microsoft: delete only, documented.
- **D5. Scope minimization.** *Recommended:* stop requesting Google `calendar.events` and Microsoft `Calendars.ReadWrite.Shared` and `MailboxSettings.Read` (covered by `MailboxSettings.ReadWrite`). Changes the consent screen only.
- **D6. Where a connect outcome shows.** *Recommended:* the backend falls back to `/dashboard` when no safe `return_url` exists, and the outcome handler moves from General Settings into a small hook mounted by the firm layout, so any return page shows it. Alternative: keep it on General Settings and have `/auth/reconnect` default its return to that page.

## File structure

- Create `backend/src/modules/calendar/shared/calendarGrant.ts`: scope constants, `grantedScopes`, `hasRequiredScope`, `accountFromIdToken`, `connectionState`, `CalendarConnectError`.
- Modify `backend/src/modules/auth/auth.service.ts`: `initGoogleConnect`, `initMicrosoftConnect`, both callbacks, `persistOAuthTokens` and its callers, `upsertSettings`, the login seeding block, `unlinkGoogle`, `unlinkMicrosoft`, `refreshMicrosoftToken`.
- Modify `backend/src/modules/auth/auth.routes.ts:168-238`: callback redirects.
- Modify `backend/src/modules/calendar/shared/calendarTokens.ts`: `getOutboundSyncCapabilities`, add `getConnectionRow`.
- Modify `backend/src/modules/calendar/shared/calendarHelpers.ts:175-364`: refresh outcome and scope recording.
- Modify `google/google.service.ts:645-668`, `outlook/outlook.service.ts:703-716`: `checkAuth`.
- Modify `backend/src/modules/settings/settings.repository.ts:116-143`, `settings.validation.ts:105-107`.
- Modify frontend `services/auth.service.ts`, `services/googleCalendarSync.service.ts`, `services/outlookCalendarSync.service.ts`, `types/preferences.ts`, `app/lawfirm/[lawFirmId]/settings/general/page.tsx`, `components/calendarComp/Calendar.tsx`.

---

### Task 1: The grant module

**Files:**
- Create: `backend/src/modules/calendar/shared/calendarGrant.ts`
- Test: `backend/tests/calendar/calendarGrant.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import {
  grantedScopes, hasRequiredScope, accountFromIdToken, connectionState,
  GOOGLE_CALENDAR_SCOPE,
} from '../../src/modules/calendar/shared/calendarGrant';

const jwt = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('granted scopes', () => {
  it('accepts Google calendar without calendar.events', () => {
    expect(hasRequiredScope('google', grantedScopes('google', { scope: `${GOOGLE_CALENDAR_SCOPE} openid` })!)).toBe(true);
  });
  it('refuses Google calendar.events alone, and never matches by substring', () => {
    const scopes = grantedScopes('google', { scope: `${GOOGLE_CALENDAR_SCOPE}.events ${GOOGLE_CALENDAR_SCOPE}.readonly` })!;
    expect(hasRequiredScope('google', scopes)).toBe(false);
  });
  it('treats a missing Google scope as unverified', () => {
    expect(grantedScopes('google', {})).toBeNull();
    expect(grantedScopes('google', { scope: '   ' })).toBeNull();
  });
  it('reads a Microsoft scope with the Graph prefix, case-insensitively', () => {
    const scopes = grantedScopes('microsoft', { scope: 'https://graph.microsoft.com/calendars.readwrite User.Read' })!;
    expect(hasRequiredScope('microsoft', scopes)).toBe(true);
  });
  it('treats an omitted Microsoft scope as the requested set', () => {
    expect(hasRequiredScope('microsoft', grantedScopes('microsoft', {})!)).toBe(true);
  });
  it('refuses Microsoft without Calendars.ReadWrite', () => {
    expect(hasRequiredScope('microsoft', grantedScopes('microsoft', { scope: 'Calendars.Read User.Read' })!)).toBe(false);
  });
});

describe('account identity', () => {
  it('reads the Google subject and email', () => {
    expect(accountFromIdToken('google', jwt({ sub: '123', email: 'A@Gmail.com' })))
      .toEqual({ accountId: '123', accountEmail: 'a@gmail.com', tenantId: null });
  });
  it('keys a Microsoft account by tenant and object id', () => {
    expect(accountFromIdToken('microsoft', jwt({ tid: 't1', oid: 'o1', preferred_username: 'x@firm.com' })))
      .toEqual({ accountId: 't1:o1', accountEmail: 'x@firm.com', tenantId: 't1' });
  });
  it('returns null for a missing or malformed token', () => {
    expect(accountFromIdToken('google', undefined)).toBeNull();
    expect(accountFromIdToken('google', 'not-a-jwt')).toBeNull();
    expect(accountFromIdToken('microsoft', jwt({ tid: 't1' }))).toBeNull();
  });
});

describe('connection state', () => {
  const row = (over: object = {}) => ({ refresh_token: 'r', scope: GOOGLE_CALENDAR_SCOPE, meta: {}, ...over });
  it.each([
    [null, 'disconnected'],
    [row({ refresh_token: null }), 'disconnected'],
    [row({ meta: { grantState: 'reconnect_required' } }), 'reconnect_required'],
    [row({ meta: { grantState: 'permission_required' } }), 'permission_required'],
    [row({ scope: `${GOOGLE_CALENDAR_SCOPE}.events` }), 'permission_required'],
    [row({ scope: null }), 'unverified'],
    [row(), 'connected'],
  ])('%j is %s', (r, expected) => {
    expect(connectionState('google', r as any)).toBe(expected);
  });
});
```

Goes red if: matching becomes substring (`includes`), the Microsoft omitted-scope rule is dropped, a row without a refresh token counts as connected, or a legacy null scope is read as connected or denied.

- [ ] **Step 2: Run it to verify it fails**

Run (from `backend/`): `npx jest tests/calendar/calendarGrant.test.ts`
Expected: FAIL, cannot find module `calendarGrant`.

- [ ] **Step 3: Write the module**

```typescript
/**
 * What a calendar OAuth grant must contain, and how a stored grant reads.
 *
 * The callbacks, the refresh paths and every status reader share these rules,
 * so "connected" means the same thing on every screen and in background sync.
 */
export type CalendarProvider = 'google' | 'microsoft';
export type CalendarConnectionState =
  'connected' | 'unverified' | 'permission_required' | 'reconnect_required' | 'disconnected';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const MICROSOFT_CALENDAR_SCOPE = 'calendars.readwrite';

// D5 decides whether calendar.events, Calendars.ReadWrite.Shared and
// MailboxSettings.Read stay in these lists.
export const GOOGLE_REQUESTED_SCOPES = [
  GOOGLE_CALENDAR_SCOPE,
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];
export const MICROSOFT_REQUESTED_SCOPES = [
  'offline_access', 'Calendars.ReadWrite', 'Calendars.ReadWrite.Shared',
  'MailboxSettings.Read', 'MailboxSettings.ReadWrite', 'User.Read', 'email', 'openid', 'profile',
];

const GRAPH_PREFIX = /^https:\/\/graph\.microsoft\.com\//i;

/** Scopes a token response granted, or null when Google left them out. */
export function grantedScopes(provider: CalendarProvider, tokenResponse: any): string[] | null {
  const raw = typeof tokenResponse?.scope === 'string' ? tokenResponse.scope : '';
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (provider === 'microsoft') {
    // Microsoft documents an omitted scope as covering the authorization request.
    const list = tokens.length ? tokens : MICROSOFT_REQUESTED_SCOPES;
    return list.map((t: string) => t.replace(GRAPH_PREFIX, ''));
  }
  return tokens.length ? tokens : null;
}

export function hasRequiredScope(provider: CalendarProvider, scopes: string[]): boolean {
  if (provider === 'google') return scopes.includes(GOOGLE_CALENDAR_SCOPE);
  return scopes.some((s) => s.replace(GRAPH_PREFIX, '').toLowerCase() === MICROSOFT_CALENDAR_SCOPE);
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
  if (typeof claims?.tid !== 'string' || typeof claims?.oid !== 'string') return null;
  return {
    accountId: `${claims.tid}:${claims.oid}`,
    accountEmail: email(claims.preferred_username) || email(claims.email),
    tenantId: claims.tid,
  };
}

export function connectionState(
  provider: CalendarProvider,
  row: { refresh_token: string | null; scope: string | null; meta: any } | null,
): CalendarConnectionState {
  if (!row || !row.refresh_token) return 'disconnected';
  const flagged = row.meta?.grantState;
  if (flagged === 'reconnect_required' || flagged === 'permission_required') return flagged;
  if (!row.scope) return 'unverified';
  return hasRequiredScope(provider, row.scope.split(/\s+/).filter(Boolean)) ? 'connected' : 'permission_required';
}

/** A callback outcome the route turns into a fixed error code in the redirect. */
export type CalendarConnectErrorCode =
  'access_denied' | 'admin_consent_required' | 'permission_required' | 'invalid_state'
  | 'expired_state' | 'exchange_failed' | 'missing_refresh_token' | 'identity_unverified';

export class CalendarConnectError extends Error {
  constructor(readonly code: CalendarConnectErrorCode, readonly returnUrl: string | null) {
    super(code);
  }
}
```

- [ ] **Step 4: Replace the duplicated scope strings.** In `auth.service.ts:868` use `GOOGLE_REQUESTED_SCOPES.join(' ')`; at `:996` and `:1041` use `MICROSOFT_REQUESTED_SCOPES.join(' ')`. If D5 is approved, trim the two lists now and assert in `oauthCodeExchange.test.ts:135-160` and `:376-389` that the consent URL's `scope` equals the trimmed list.

- [ ] **Step 5: Run and verify**

```bash
npx jest tests/calendar/calendarGrant.test.ts tests/auth/oauthCodeExchange.test.ts
npm run typecheck && npm run lint
```
Expected: all exit 0.

### Task 2: Atomic, provider-checked state and a code-only redirect contract

**Files:**
- Modify: `backend/src/modules/auth/auth.service.ts:881-903`, `:1005-1029`
- Modify: `backend/src/modules/auth/auth.routes.ts:168-238`
- Test: `backend/tests/auth/oauthCodeExchange.test.ts`, `backend/tests/auth/authServiceUnit.test.ts:470-500`

- [ ] **Step 1: Write the failing tests** in `oauthCodeExchange.test.ts`, using the existing `plantState`, `stateRow`, `tokenRow` and `location` helpers:
  - `'refuses a Microsoft state on the Google callback and leaves it unused'`: `plantState({ provider: 'microsoft', returnUrl: `${FRONTEND}/lawfirm/f1/settings/general` })`, call `/google-callback?code=c&state=...`. Assert `location(res)` is `${FRONTEND}/dashboard?google_error=invalid_state`, `callsMatching(GOOGLE_TOKEN_URL)` is empty, and `stateRow` is still present. Red if the lookup ignores `provider`.
  - `'returns a denied consent to the page that started it, and spends the state'`: connect with return URL `/lawfirm/f1/settings/general`, call `/google-callback?error=access_denied&state=...`. Assert location `${FRONTEND}/lawfirm/f1/settings/general?google_error=access_denied` and `stateRow` null. Red if the error branch skips the state.
  - `'maps a tenant that needs admin approval to one code and drops the description'`: Microsoft `?error=access_denied&error_description=AADSTS65001%3A%20trace%20id%20abc&state=...`. Assert location ends `microsoft_error=admin_consent_required` and does not contain `AADSTS` or `trace`.
  - `'spends a state once under concurrent callbacks'`: fire two `/google-callback` requests with the same state via `Promise.all`; assert exactly one `GOOGLE_TOKEN_URL` call. Red if select-then-delete returns.
- [ ] **Step 2: Change the assertions that pinned the old contract** (only these, all in `oauthCodeExchange.test.ts`): `:254` and `:462` to `${FRONTEND}/dashboard?<provider>_error=invalid_state`; `:263` and `:471` to `expired_state` (dashboard, since a planted state has no return URL); `:299` and `:456` to `/dashboard?<provider>_error=invalid_state` (no state, so no return URL); `:311`, `:323`, `:494`, `:506` to `/dashboard?<provider>_error=exchange_failed`; `:444` and `:450` to `/dashboard?microsoft_error=access_denied` (no state given). In `authServiceUnit.test.ts`, `:475` stays green (`google_error=access_denied`); `:484` and `:497` keep their `toContain('google_error=')` form. Run `npx jest tests/auth/oauthCodeExchange.test.ts tests/auth/authServiceUnit.test.ts`; expected FAIL on the new and changed cases only.
- [ ] **Step 3: Implement.** One shared helper in `auth.service.ts` replaces both lookups:

```typescript
async function consumeOAuthState(state: string, provider: CalendarProvider, ttlMs: number) {
  if (!state) throw new CalendarConnectError('invalid_state', null);
  // Delete-returning spends the state in the same statement that reads it.
  const rows = await tokenQuery(state, (executor) => executor
    .delete(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.provider, provider)))
    .returning());
  const row = rows[0];
  if (!row) throw new CalendarConnectError('invalid_state', null);
  if (Date.now() - row.createdAt.getTime() > ttlMs) throw new CalendarConnectError('expired_state', row.returnUrl);
  return row;
}
```

  Callbacks take `{ code, state, providerError, providerErrorDescription }`. A provider error consumes the state first, then throws `access_denied`, or `admin_consent_required` when the description contains `AADSTS65001` or `AADSTS90094` or the error is `consent_required`. A failed exchange or a missing access token throws `exchange_failed` with the state's `returnUrl`. In `auth.routes.ts`, one function builds every redirect:

```typescript
function connectRedirect(res: any, provider: 'google' | 'microsoft', returnUrl: string | null, outcome: string) {
  const base = returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard`;
  const sep = base.includes('?') ? '&' : '?';
  const param = outcome === 'connected' ? `${provider}_connected=true` : `${provider}_error=${encodeURIComponent(outcome)}`;
  res.redirect(`${base}${sep}${param}`);
}
```

  Catch `CalendarConnectError` and pass `err.code`; any other error logs and redirects with `exchange_failed`. Never put `err.message` in the URL.
- [ ] **Step 4: Run** `npx jest tests/auth/oauthCodeExchange.test.ts tests/auth/authServiceUnit.test.ts`. Expected: PASS.
- [ ] **Step 5: Verify** `npm run typecheck && npm run lint` in `backend/`, both exit 0.

### Task 3: Validate scope, identity and refresh token before any write

**Files:**
- Modify: `backend/src/modules/auth/auth.service.ts:796-830` (`syncGoogleConnectedEmail`), `:905-962`, `:1031-1082`
- Modify: `backend/src/modules/calendar/shared/calendarTokens.ts` (add `getConnectionRow`)
- Test: `backend/tests/auth/oauthCodeExchange.test.ts`

- [ ] **Step 1: Write the failing tests.** Extend `tokenRow` to also select `scope, meta`. Build ID tokens with the `jwt()` helper from Task 1. Cases:
  - Google full grant: assert stored `scope` equals the response scope, `meta.accountId = 'g-sub'`, `meta.accountEmail`, redirect `google_connected=true`. Red if scope is not passed to `saveTokens`.
  - Google `calendar.events` only, and identity scopes only: redirect `google_error=permission_required`, `tokenRow` null, `loggedInWithGoogle` undefined, no watch-channel call.
  - Google with no `scope` field: `permission_required`, nothing stored.
  - Google with no `id_token`: `identity_unverified`, nothing stored.
  - Microsoft without `Calendars.ReadWrite`: `microsoft_error=permission_required`, nothing stored, no subscription call. Microsoft with `scope` omitted: connected, and stored `scope` is the requested set.
  - Reconnect preserves a working grant: `plantProviderToken(owner.uid, 'google', { accessToken: 'old-a', refreshToken: 'old-r', syncFromProvider: true })` with `scope` and `meta.accountId = 'g-sub'`, then a callback granting only `calendar.events`. Assert the row is byte-for-byte unchanged (access, refresh, scope, meta, `is_sync_from_provider`). Same for Microsoft.
  - Same account, no new refresh token: keeps `old-r`, stores the new access token and scope.
  - No new refresh token and no stored one: `missing_refresh_token`, nothing stored. Change `:341-353` and `:429-437`, which pinned the opposite, to this outcome.
  - Replace `:327-339` ("still connects when the profile lookup fails") with `'takes the connected address from the ID token without calling userinfo'`: assert `callsMatching('oauth2/v1/userinfo')` is empty and `googleConnectedEmail` comes from the ID token.
- [ ] **Step 2: Run** `npx jest tests/auth/oauthCodeExchange.test.ts`; expected FAIL on these cases.
- [ ] **Step 3: Implement.** Add to `calendarTokens.ts`:

```typescript
/** The stored grant for one provider, as connectionState() reads it. */
export async function getConnectionRow(userId: string, provider: 'google' | 'microsoft') {
  const { rows } = await calendarSql(
    `select access_token, refresh_token, scope, meta from user_oauth_tokens where user_id = $1 and provider = $2 limit 1`,
    [userId, provider],
  );
  return rows[0] || null;
}
```

  In each callback, after the exchange and before any write, in this order: `grantedScopes` then `hasRequiredScope` (else `permission_required`); `accountFromIdToken(provider, tokenData.id_token)` (else `identity_unverified`); load `getConnectionRow`; `sameAccount = existing?.meta?.accountId ? existing.meta.accountId === account.accountId : legacyGoogleEmailMatches` (Google legacy rows compare `googleConnectedEmail` with `account.accountEmail`; Microsoft legacy rows count as a different account); refresh token is `tokenData.refresh_token`, or `existing.refresh_token` only when `sameAccount` (else `missing_refresh_token`). Then write: `saveTokens(userId, provider, { accessToken, refreshToken, scope: scopes.join(' ') })`, `updateTokenMeta(userId, provider, { accountId, accountEmail, tenantId, grantState: null })`, and for Google `persistGoogleConnectedEmail(userId, account.accountEmail)`. Delete `syncGoogleConnectedEmail`'s use in the callback. Keep `saveSettings({ loggedInWith...: true })` until Task 6 removes the flag writes.
- [ ] **Step 4: Run** `npx jest tests/auth/oauthCodeExchange.test.ts tests/calendar/calendarGrant.test.ts`. Expected: PASS.
- [ ] **Step 5: Verify** `npm run typecheck && npm run lint`, exit 0.

### Task 4: Reconnecting to a different account (needs D2)

**Files:**
- Modify: `backend/src/modules/auth/auth.service.ts:690-728` (extract `forgetProviderConnection`), both callbacks
- Test: `backend/tests/auth/oauthCodeExchange.test.ts`, `backend/tests/auth/authServiceUnit.test.ts:365-468`

- [ ] **Step 1: Write the failing test** `'treats a different Google account as a new connection'`: plant a row with `meta.accountId = 'a-sub'`, `sync_cursor`, `calendar_id`, `app_calendar_id`, `is_sync_to_provider = true`, a `calendar_subscriptions` watch row and one imported external event; callback with `sub: 'b-sub'` and a new refresh token. Assert: the watch-stop request was made, the imported event is gone, `sync_cursor`/`calendar_id`/`app_calendar_id` are null, both sync columns false, the row holds the B tokens and `meta.accountId = 'b-sub'`. Microsoft twin with `tid:oid`. Red if the account comparison is removed.
- [ ] **Step 2: Run** `npx jest tests/auth/oauthCodeExchange.test.ts -t "different"`; expected FAIL.
- [ ] **Step 3: Implement.** Extract the body of `unlinkGoogle`/`unlinkMicrosoft` into `forgetProviderConnection(userId, provider, { revoke })`; the unlinks call it, and each callback calls it when `!sameAccount && existing?.refresh_token` before saving the new tokens. The existing unlink tests at `authServiceUnit.test.ts:365-468` must stay green untouched.
- [ ] **Step 4: Run** `npx jest tests/auth/oauthCodeExchange.test.ts tests/auth/authServiceUnit.test.ts`. Expected: PASS.
- [ ] **Step 5: Verify** `npm run typecheck && npm run lint`.

### Task 5: Bind the state to the starting browser (needs D3)

**Files:**
- Modify: `backend/src/modules/auth/auth.routes.ts:157-238`
- Modify: `frontend/src/services/auth.service.ts:512-573` (`credentials: 'include'` on both connect calls)
- Test: `backend/tests/auth/oauthCodeExchange.test.ts`, `frontend/tests/services/authCalendarConnections.test.ts`

- [ ] **Step 1: Write the failing tests.** Backend: `'refuses a callback from a browser that did not start the connection'`: connect, then call the callback without the `Set-Cookie` value from the connect response; assert `google_error=invalid_state` and no token call. Update every other callback test in the file to send `Cookie: <name>=<state>` from the connect response (`res.header['set-cookie']`). Frontend: in `authCalendarConnections.test.ts:49` and `:104`, assert the connect request carries `credentials: 'include'`.
- [ ] **Step 2: Run** both files (`npx jest tests/auth/oauthCodeExchange.test.ts` in `backend/`, `npx jest tests/services/authCalendarConnections.test.ts` in `frontend/`); expected FAIL.
- [ ] **Step 3: Implement.** `connect-*` sets `plx_oauth_state` (httpOnly, `sameSite: 'lax'`, `secure` in production, `path: '/api/auth'`, `maxAge` 10 minutes) to the minted state. Each callback reads it from `req.headers.cookie` (split on `;`, no new dependency), compares with `crypto.timingSafeEqual` against the query state, and clears it. A mismatch throws `invalid_state` before `consumeOAuthState`.
- [ ] **Step 4: Run** the two files again. Expected: PASS.
- [ ] **Step 5: Verify** `npm run typecheck && npm run lint` in both packages.

### Task 6: One status reader for every consumer

**Files:**
- Modify: `backend/src/modules/calendar/google/google.service.ts:645-668`, `outlook/outlook.service.ts:703-716`
- Modify: `backend/src/modules/settings/settings.repository.ts:116-143`, `settings.validation.ts:105-107`
- Modify: `backend/src/modules/calendar/shared/calendarTokens.ts:110-124`
- Modify: `backend/src/modules/auth/auth.service.ts` (drop the `loggedInWith*: true` writes from Task 3)
- Test: `backend/tests/calendar/googleSyncRoutes.test.ts:290-321`, `outlookSyncRoutes.test.ts:329+`, `backend/tests/auth/authServiceUnit.test.ts:206-308`, new `backend/tests/calendar/calendarConnectionStatus.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `googleSyncRoutes.test.ts:296`: change the expectation to `{ authenticated: true, state: 'connected', email: 'lawyer@firm.test' }` for a row seeded with the calendar scope and `meta.accountEmail`, and assert no `USERINFO` call. Add `'reports permission_required, not connected, when only identity scopes were granted'` and `'resolves a legacy row through tokeninfo and records its scope'` (route `oauth2.googleapis.com/tokeninfo` to `{ scope: 'openid email' }`; assert `state: 'permission_required'` and the stored `scope`). Microsoft twins in `outlookSyncRoutes.test.ts`, the legacy case resolved through one refresh routed to `MS_TOKEN_URL` with a `scope`.
  - `calendarConnectionStatus.test.ts`, through `GET /api/settings/user`: an access-token-only row reads `loggedInWithGoogle: false, googleCalendarState: 'disconnected'` even when preferences say `loggedInWithGoogle: true`; a connected row reads `true, 'connected'`; a legacy row reads `true, 'unverified'`. Through `PUT /api/settings/user`, `{ preferences: { loggedInWithGoogle: true } }` is rejected with 400 and stores nothing. And `getOutboundSyncCapabilities` returns `google: false` for a row with `is_sync_to_provider` but no refresh token, and for one with `meta.grantState = 'reconnect_required'`.
  - Red if: check-auth goes back to userinfo, the settings read trusts the preferences key, or the capability pre-check goes back to `access_token is not null`.
- [ ] **Step 2: Run** `npx jest tests/calendar/googleSyncRoutes.test.ts tests/calendar/outlookSyncRoutes.test.ts tests/calendar/calendarConnectionStatus.test.ts`; expected FAIL.
- [ ] **Step 3: Implement.**
  - `checkAuth(userId)`: load `getConnectionRow`; compute `connectionState`; for `unverified`, resolve once (Google `tokeninfo`, Microsoft a refresh under `refreshUnderLock`), record `scope` with `saveTokens`, and recompute. Return `{ authenticated: state === 'connected', state, email: row.meta?.accountEmail ?? null, message }`. Keep the existing 400 for no row.
  - `settings.repository.ts:126-142`: also select `refreshToken`, `scope`, `meta`; return `loggedInWithGoogle: ['connected','unverified'].includes(googleState)`, `googleCalendarState`, and the Microsoft pair, overriding whatever the preferences jsonb holds.
  - `settings.validation.ts`: remove the three keys. The object is `.passthrough()`, so add an explicit refinement that rejects them.
  - `getOutboundSyncCapabilities`: replace `t.access_token is not null` with `t.refresh_token is not null and t.meta->>'grantState' is null`.
  - Remove `saveSettings({ loggedInWithGoogle: true })` and the Microsoft twin from the callbacks, and `loggedInWith*` from `unlinkGoogle`/`unlinkMicrosoft`. Update the callback assertions that read the preferences flag (`oauthCodeExchange.test.ts:227`, `:314`, `:337`, `:352`, `:417`, `:497`) to read `loggedInWithGoogle`/`loggedInWithMicrosoft` from `GET /api/settings/user` instead.
- [ ] **Step 4: Run** the three files plus `tests/auth/oauthCodeExchange.test.ts tests/auth/authServiceUnit.test.ts`. Expected: PASS.
- [ ] **Step 5: Verify** `npm run typecheck && npm run lint`.

### Task 7: Refresh records scope and marks a dead grant

**Files:**
- Modify: `backend/src/modules/calendar/shared/calendarHelpers.ts:175-364`
- Modify: `backend/src/modules/auth/auth.service.ts:747-784` (`refreshMicrosoftToken`)
- Test: new `backend/tests/calendar/oauthRefreshGrant.test.ts`, `backend/tests/auth/oauthCodeExchange.test.ts:530-587`

- [ ] **Step 1: Write the failing tests** through `GET /api/google-calendar-sync/calendars` and `GET /api/outlook-calendar-sync/calendars` with a connected owner whose calendar list answers `[ {status: 401}, {status: 200, json: {items: []}} ]`:
  - refresh answers `{ access_token, scope: 'openid' }`: the row's `scope` is `openid` and `GET /api/settings/user` reports `permission_required`.
  - refresh answers `400 { error: 'invalid_grant' }`: response 401 with `requiresReAuth`, and the row's `meta.grantState` is `reconnect_required`.
  - refresh answers 503: `meta.grantState` stays null (transient failure is not a lost grant).
  - Google calendar list answers 403 with `ACCESS_TOKEN_SCOPE_INSUFFICIENT`: no refresh call is made and `meta.grantState` becomes `permission_required`.
  - Red if refresh drops `scope`, if `invalid_grant` and 5xx are treated alike, or if insufficient scope keeps triggering a refresh.
- [ ] **Step 2: Run** `npx jest tests/calendar/oauthRefreshGrant.test.ts`; expected FAIL.
- [ ] **Step 3: Implement.** Both refresh functions return the new token or a reason: on a non-OK response, read the JSON body; `invalid_grant` calls `updateTokenMeta(userId, provider, { grantState: 'reconnect_required' })`. On success, persist `scope` (Google: `saveTokens(userId, 'google', { accessToken, scope })` instead of `saveAccessToken`; Microsoft: add `scope` to the existing `saveTokens`) and clear `grantState` only when the new scope has the required one, else set `permission_required`. In `makeGoogleApiCall`, detect a 403 whose body contains `ACCESS_TOKEN_SCOPE_INSUFFICIENT` or `insufficientPermissions`, mark `permission_required` and throw the existing `requiresReAuth` error without refreshing. Apply the same outcome handling to `auth.service.ts:refreshMicrosoftToken`; the existing tests at `oauthCodeExchange.test.ts:530-587` stay green.
- [ ] **Step 4: Run** `npx jest tests/calendar/oauthRefreshGrant.test.ts tests/auth/oauthCodeExchange.test.ts tests/calendar/googleCalendarSync.test.ts tests/calendar/outlookSync.test.ts`. Expected: PASS.
- [ ] **Step 5: Verify** `npm run typecheck && npm run lint`.

### Task 8: Social sign-in stops writing calendar tokens (needs D1)

**Files:**
- Modify: `backend/src/modules/auth/auth.service.ts:318-350`, `:441-450`, `:540-601`
- Modify: `frontend/src/services/auth.service.ts:35-52`, `:143-210`, `:762-800`, `frontend/src/services/googleCalendarSync.service.ts:125-150`
- Test: `backend/tests/auth/registrationProviderIdentity.test.ts:154-252`, `frontend/tests/services/authSignInPersistence.test.ts:112-180`, `frontend/tests/services/authReconnectReturn.test.ts:63-160`

- [ ] **Step 1: Write the failing tests.** Backend: `'a Google sign-in leaves a connected calendar row untouched'`: plant a connected row (`old-a`, `old-r`, scope, `meta.accountId`), post `/api/auth/login` with `googleAccessToken: 'popup-a'`; assert the row is unchanged. `'a Google sign-in with no calendar connection creates no token row'`. `'a first login no longer records a calendar connection from the linked provider'`: replaces `:221-233`; assert `GET /api/settings/user` reports `loggedInWithGoogle: false`. Change `:155-213` (which pin that popup tokens are stored) to assert no row is written; `:235-252` stays as-is. Frontend: change `authSignInPersistence.test.ts:121`, `:152`, `:167` and `authReconnectReturn.test.ts:72`, `:111`, `:159` so the login body is `{ token }` only. Red if any popup token reaches `user_oauth_tokens`.
- [ ] **Step 2: Run** `npx jest tests/auth/registrationProviderIdentity.test.ts` (backend) and `npx jest tests/services/authSignInPersistence.test.ts tests/services/authReconnectReturn.test.ts` (frontend); expected FAIL.
- [ ] **Step 3: Implement.** Backend: delete `persistOAuthTokens` and its four calls, delete `upsertSettings` and the first-login seeding block (`:566-591`), and ignore `googleAccessToken`/`microsoftAccessToken`/`*RefreshToken` in the login and registration bodies. Frontend: remove every `addScope` calendar and mailbox line from both Firebase providers (keep identity scopes), stop sending provider access tokens in `signInWithGoogle`, `signInWithMicrosoft`, `processReconnectCredential` and `googleCalendarSync.service.ts:136-147`, and drop `pendingOAuthCredentials` if nothing else reads it.
- [ ] **Step 4: Run** the same files. Expected: PASS.
- [ ] **Step 5: Verify** backend `npm run typecheck && npm run lint`; frontend `npm run typecheck && npm run lint`.

### Task 9: Revoke Google on disconnect (needs D4)

**Files:**
- Modify: `backend/src/modules/auth/auth.service.ts` (`forgetProviderConnection` from Task 4)
- Test: `backend/tests/auth/authServiceUnit.test.ts:388-416`

- [ ] **Step 1: Write the failing tests** next to `'removes the Google token and its sync flags on unlink'`: `'revokes the Google grant before removing it'` asserts one POST to `https://oauth2.googleapis.com/revoke` whose body `token` is the stored refresh token; `'still disconnects when Google refuses the revoke'` routes revoke to 500 and asserts the row is gone and the route answers 200. Microsoft unlink makes no revoke call. Red if the revoke call is removed or its failure aborts the unlink.
- [ ] **Step 2: Run** `npx jest tests/auth/authServiceUnit.test.ts -t "revoke"`; expected FAIL.
- [ ] **Step 3: Implement** the best-effort revoke in `forgetProviderConnection` when `provider === 'google'`, inside `try/catch` with a logged warning.
- [ ] **Step 4: Run** `npx jest tests/auth/authServiceUnit.test.ts`. Expected: PASS.
- [ ] **Step 5: Verify** `npm run typecheck && npm run lint`.

### Task 10: Frontend reads the backend's state

Invoke the `paralegix-frontend` skill before changing General Settings; reuse its existing connection row and error banner.

**Files:**
- Modify: `frontend/src/services/googleCalendarSync.service.ts:294-315`, `outlookCalendarSync.service.ts:357-378`
- Modify: `frontend/src/types/preferences.ts:137-139`
- Modify: `frontend/src/app/lawfirm/[lawFirmId]/settings/general/page.tsx:133-241`, `:556-582`, `:850-880`
- Modify: `frontend/src/components/calendarComp/Calendar.tsx:272-274`, `:346-370`
- Modify: `frontend/src/services/auth.service.ts:487-499` (`getLinkedProviders`), `:575-607`
- Test: new `frontend/tests/services/calendarCheckAuth.test.ts`, `frontend/tests/app/lawfirm/settings/GeneralSettingsCalendarSync.test.tsx`, `frontend/tests/components/calendar/Calendar.test.tsx`, `frontend/tests/services/authCalendarConnections.test.ts:159-200`

- [ ] **Step 1: Write the failing tests.**
  - `calendarCheckAuth.test.ts` (`jest.unmock` both sync services, `installApiMock`): a 200 `{ authenticated: false, state: 'permission_required' }` returns `{ authenticated: false, state: 'permission_required' }` from `checkGoogleAuth` and `checkOutlookAuth`. Red if the service goes back to `authenticated: true` on any 200.
  - `GeneralSettingsCalendarSync.test.tsx`: with `getUserSettings` returning `googleCalendarState: 'permission_required'` and `getLinkedProviders` returning `hasGoogle: true`, the Google row shows the permission-needed copy and a Reconnect button, not `Connected`; with `?google_connected=true` but the status refetch answering `disconnected`, no `Connected` text and no `calendar_connected` track call; with `?google_error=permission_required`, the mapped plain-language message shows and the raw code does not.
  - `Calendar.test.tsx`: with `checkGoogleAuth` resolving `{ authenticated: true }` and flags off, `settingsService.updateUserSettings` is never called. Red if the self-heal returns.
  - `authCalendarConnections.test.ts:160-195`: the disconnects no longer write `loggedInWith*` through settings.
- [ ] **Step 2: Run** (from `frontend/`) `npx jest tests/services/calendarCheckAuth.test.ts tests/app/lawfirm/settings/GeneralSettingsCalendarSync.test.tsx tests/components/calendar/Calendar.test.tsx tests/services/authCalendarConnections.test.ts`; expected FAIL.
- [ ] **Step 3: Implement.**
  - Both `check*Auth` return `{ authenticated: !!data.authenticated, state: data.state ?? 'disconnected', email }`.
  - General Settings: derive each row from `googleCalendarState`/`microsoftCalendarState` (`Connected`, `Reconnect to confirm access` for `unverified`, `Permission needed` for `permission_required`, `Reconnect` for `reconnect_required`). Drop the `providerData` fallback (`:138-158`) and `getLinkedProviders` if unused. On `*_connected=true`, refetch settings and track `calendar_connected` only when the refetch says `connected`. Map each error code to one sentence; unknown codes get a generic sentence. If D6 is approved, move this handler into a hook mounted by the firm layout.
  - Calendar: delete the self-heal effect and the comment at `:272-274`.
  - `auth.service.ts` unlinks: drop the `updateIntegrationSettings` calls.
- [ ] **Step 4: Run** the same files plus `tests/hooks/useGetStartedProgress.test.ts tests/hooks/useCalendarBackgroundSync.contract.test.tsx`. Expected: PASS.
- [ ] **Step 5: Verify** (from `frontend/`) `npm run ci:checks`, exit 0.

### Task 11: Documentation and final verification

**Files:**
- Modify: `docs/features/authentication.md`, `docs/features/calendar.md`

- [ ] **Step 1:** Document the grant rule, the five connection states, the legacy `unverified` path, refresh outcome recording, account switching, the state cookie, and that social sign-in never connects a calendar. Check `git diff` for em-dashes.
- [ ] **Step 2:** Backend, from `backend/`:

```bash
npx jest tests/calendar/calendarGrant.test.ts tests/auth/oauthCodeExchange.test.ts tests/auth/authServiceUnit.test.ts \
  tests/auth/registrationProviderIdentity.test.ts tests/calendar/googleSyncRoutes.test.ts tests/calendar/outlookSyncRoutes.test.ts \
  tests/calendar/calendarConnectionStatus.test.ts tests/calendar/oauthRefreshGrant.test.ts \
  tests/calendar/googleCalendarSync.test.ts tests/calendar/outlookSync.test.ts tests/calendar/calendarSyncGaps.test.ts
npm run typecheck && npm run lint && npm run build
```

  Do not run the full backend `npm test`.
- [ ] **Step 3:** Frontend, from `frontend/`: `npm run ci:checks && npm run test:unit && npm run build`.
- [ ] **Step 4:** Provider smoke tests (Google: neither box, events only, full; Microsoft: full consent and an admin-consent tenant; reconnect with a second account) need a browser and a separate user request under `AGENTS.md`. Stop after the automated checks and leave the work uncommitted.

## Acceptance criteria

- A Google grant without `calendar`, or a Microsoft grant without `Calendars.ReadWrite`, never creates or replaces a connection, and the person sees a permission-needed message on the page they started from.
- A failed reconnect leaves the prior row, scope, identity and sync settings byte-for-byte intact. Tokens from two provider accounts are never combined.
- Social sign-in never creates, overwrites or marks a calendar connection.
- Check-auth, the settings read, General Settings, Calendar, get-started and outbound sync all derive from `connectionState`; no identity probe, HTTP 200, preferences flag or Firebase `providerData` can report a calendar as connected.
- A revoked or downgraded grant is recorded on the next refresh and shown as reconnect or permission needed.
- Callback URLs carry only fixed codes, and every failure lands on a real page.
