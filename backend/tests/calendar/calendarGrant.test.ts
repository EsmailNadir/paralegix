/**
 * The rules that decide whether a calendar OAuth grant is usable.
 *
 * Every callback, refresh path and status reader shares `calendarGrant.ts`, so
 * "connected" means the same thing on every screen and in background sync.
 * These are pure functions, so they are exercised directly.
 */
import {
  grantedScopes,
  hasRequiredScope,
  accountFromIdToken,
  connectionState,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_REQUESTED_SCOPES,
  MICROSOFT_REQUESTED_SCOPES,
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

  it('reads a URL-encoded Microsoft scope', () => {
    // Microsoft's own token-response example encodes the scope URL.
    const scopes = grantedScopes('microsoft', { scope: 'https%3A%2F%2Fgraph.microsoft.com%2FCalendars.ReadWrite openid' })!;
    expect(scopes).toContain('Calendars.ReadWrite');
    expect(hasRequiredScope('microsoft', scopes)).toBe(true);
  });

  it('treats an omitted Microsoft scope as the requested set', () => {
    expect(grantedScopes('microsoft', {})).toEqual(MICROSOFT_REQUESTED_SCOPES);
    expect(hasRequiredScope('microsoft', grantedScopes('microsoft', {})!)).toBe(true);
  });

  it('refuses Microsoft without Calendars.ReadWrite', () => {
    expect(hasRequiredScope('microsoft', grantedScopes('microsoft', { scope: 'Calendars.Read User.Read' })!)).toBe(false);
  });

  it('requests only the scopes the integration uses', () => {
    expect(GOOGLE_REQUESTED_SCOPES).toEqual([
      GOOGLE_CALENDAR_SCOPE,
      'https://www.googleapis.com/auth/userinfo.email',
      'openid',
    ]);
    expect(MICROSOFT_REQUESTED_SCOPES).not.toContain('Calendars.ReadWrite.Shared');
    expect(MICROSOFT_REQUESTED_SCOPES).not.toContain('MailboxSettings.Read');
    expect(MICROSOFT_REQUESTED_SCOPES).toEqual(expect.arrayContaining(['offline_access', 'Calendars.ReadWrite', 'openid']));
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
    expect(accountFromIdToken('google', 'h.%%%.s')).toBeNull();
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

  it('reads a stored Microsoft scope case-insensitively', () => {
    expect(connectionState('microsoft', { refresh_token: 'r', scope: 'calendars.readwrite openid', meta: null })).toBe('connected');
    expect(connectionState('microsoft', { refresh_token: 'r', scope: 'Calendars.Read', meta: null })).toBe('permission_required');
  });
});
