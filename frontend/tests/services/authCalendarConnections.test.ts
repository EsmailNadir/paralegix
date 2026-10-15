/**
 * The calendar-provider half of auth.service, run against a fake transport.
 *
 * Connecting Google or Microsoft is a backend OAuth code flow: the service asks
 * the API for a consent URL and sends the browser there. Disconnecting clears
 * the backend tokens; the connection state is derived server-side from them, so
 * nothing is written to the user settings. The status checks
 * decide whether the calendar UI offers "connect" or "connected", and they are
 * built to fail closed (report not connected) rather than throw.
 *
 * The redirect is observed through a same-document fragment URL, the one kind
 * of navigation jsdom actually performs, so `window.location` really changes.
 */
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');
jest.unmock('@/services/settings.service');

import * as firebaseConfig from '@/lib/firebase/config';
import { installApiMock, type ApiMock } from '../support/apiMock';
import authService from '@/services/auth.service';

const config = firebaseConfig as unknown as {
  auth: { currentUser: { providerData: unknown[]; getIdToken: jest.Mock } | null };
};
const signedInUser = config.auth.currentUser;
let api: ApiMock;
let startUrl: string;

function consentUrl(tag: string) {
  return `${startUrl}#${tag}`;
}

beforeEach(() => {
  api = installApiMock();
  startUrl = window.location.href.split('#')[0];
  config.auth.currentUser = signedInUser;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  api.restore();
  config.auth.currentUser = signedInUser;
  if (signedInUser) signedInUser.providerData = [];
  window.history.replaceState(null, '', startUrl);
  jest.restoreAllMocks();
});

describe('connecting Google Calendar', () => {
  it('asks for a consent URL with the given return URL and sends the browser there', async () => {
    api.post('/auth/connect-google', { authUrl: consentUrl('google-consent') });

    await authService.connectGoogleCalendar('https://app.example.com/settings/general');

    const call = api.calls('POST')[0];
    expect(call.body).toEqual({ returnUrl: 'https://app.example.com/settings/general' });
    expect(call.headers.authorization).toBe('Bearer mock-token');
    // The API binds the OAuth state to this browser with a cookie set on this
    // response; without credentials the callback refuses the state.
    expect(call.credentials).toBe('include');
    expect(window.location.hash).toBe('#google-consent');
  });

  it('returns the person to the page they started on when no return URL is given', async () => {
    api.post('/auth/connect-google', { authUrl: consentUrl('google-consent') });

    await authService.linkGoogle();

    expect(api.calls('POST')[0].body).toEqual({ returnUrl: startUrl });
    expect(window.location.hash).toBe('#google-consent');
  });

  it('reconnects through the same flow, returning to the current page', async () => {
    api.post('/auth/connect-google', { authUrl: consentUrl('google-reconsent') });

    await authService.forceGoogleReAuth();

    expect(api.calls('POST')[0].body).toEqual({ returnUrl: startUrl });
    expect(window.location.hash).toBe('#google-reconsent');
  });

  it('surfaces the server refusal and does not navigate', async () => {
    api.post('/auth/connect-google', { status: 400, body: { error: 'Google integration is not configured' } });

    await expect(authService.connectGoogleCalendar()).rejects.toThrow('Google integration is not configured');

    expect(api.calls('POST')).toHaveLength(1);
    expect(window.location.href).toBe(startUrl);
  });

  it('refuses when nobody is signed in, without asking the server', async () => {
    config.auth.currentUser = null;

    await expect(authService.connectGoogleCalendar()).rejects.toThrow('Not authenticated');
    expect(api.calls()).toHaveLength(0);
  });
});

describe('connecting Microsoft Calendar', () => {
  it('asks for a consent URL with the given return URL and sends the browser there', async () => {
    api.post('/auth/connect-microsoft', { authUrl: consentUrl('ms-consent') });

    await authService.connectMicrosoftCalendar('https://app.example.com/calendar');

    expect(api.calls('POST')[0].body).toEqual({ returnUrl: 'https://app.example.com/calendar' });
    expect(api.calls('POST')[0].credentials).toBe('include');
    expect(window.location.hash).toBe('#ms-consent');
  });

  it('defaults the return URL to the current page for link, force and manual reconnect', async () => {
    api.post('/auth/connect-microsoft', { authUrl: consentUrl('ms-consent') });

    await authService.linkMicrosoft();
    window.history.replaceState(null, '', startUrl);
    await authService.forceMicrosoftReAuth();
    window.history.replaceState(null, '', startUrl);
    await authService.manualMicrosoftReAuth();

    expect(api.calls('POST').map((c) => c.body)).toEqual([
      { returnUrl: startUrl },
      { returnUrl: startUrl },
      { returnUrl: startUrl },
    ]);
  });

  it('keeps an explicit return URL on a manual reconnect', async () => {
    api.post('/auth/connect-microsoft', { authUrl: consentUrl('ms-consent') });

    await authService.manualMicrosoftReAuth('https://app.example.com/tasks');

    expect(api.calls('POST')[0].body).toEqual({ returnUrl: 'https://app.example.com/tasks' });
  });

  it('reports true from refreshMicrosoftAuth once the redirect has started', async () => {
    api.post('/auth/connect-microsoft', { authUrl: consentUrl('ms-consent') });

    await expect(authService.refreshMicrosoftAuth()).resolves.toBe(true);
    expect(window.location.hash).toBe('#ms-consent');
  });

  it('rethrows the server refusal from refreshMicrosoftAuth', async () => {
    api.post('/auth/connect-microsoft', { status: 502, body: { error: 'Microsoft is unavailable' } });

    await expect(authService.refreshMicrosoftAuth()).rejects.toThrow('Microsoft is unavailable');
    expect(window.location.href).toBe(startUrl);
  });

  it('refuses when nobody is signed in', async () => {
    config.auth.currentUser = null;

    await expect(authService.connectMicrosoftCalendar()).rejects.toThrow('Not authenticated');
    expect(api.calls()).toHaveLength(0);
  });
});

describe('disconnecting a calendar', () => {
  it('clears the Google tokens without writing a connection flag to settings', async () => {
    api.post('/auth/unlink-google', { ok: true });

    await authService.unlinkGoogle();

    // The API refuses a client-written connection flag, so the unlink is the
    // only request.
    expect(api.calls().map((c) => c.pathname)).toEqual(['/api/auth/unlink-google']);
  });

  it('leaves the Google setting alone when the server refuses the disconnect', async () => {
    api.post('/auth/unlink-google', { status: 500, body: { error: 'Could not revoke Google tokens' } });

    await expect(authService.unlinkGoogle()).rejects.toThrow('Could not revoke Google tokens');

    // Recording "disconnected" after a failed revoke would hide a live grant.
    expect(api.calls('POST')).toHaveLength(1);
  });

  it('clears the Microsoft tokens without writing a connection flag to settings', async () => {
    api.post('/auth/unlink-microsoft', { ok: true });

    await authService.unlinkMicrosoft();

    expect(api.calls().map((c) => c.pathname)).toEqual(['/api/auth/unlink-microsoft']);
  });

  it('leaves the Microsoft setting alone when the server refuses the disconnect', async () => {
    api.post('/auth/unlink-microsoft', { status: 403, body: { error: 'Forbidden' } });

    await expect(authService.unlinkMicrosoft()).rejects.toThrow('Forbidden');
    expect(api.calls('POST')).toHaveLength(1);
  });

  it('refuses either disconnect when nobody is signed in', async () => {
    config.auth.currentUser = null;

    await expect(authService.unlinkGoogle()).rejects.toThrow('Not authenticated');
    await expect(authService.unlinkMicrosoft()).rejects.toThrow('Not authenticated');
    expect(api.calls()).toHaveLength(0);
  });
});

describe('connection status checks', () => {
  it('reports Google calendar access the server confirms', async () => {
    api.get('/auth/check-calendar-access', { hasCalendarAccess: true });

    await expect(authService.checkCalendarAccess()).resolves.toBe(true);
    expect(api.calls('GET')[0].headers.authorization).toBe('Bearer mock-token');
  });

  it('reports no Google access when the server says so, or when the check fails', async () => {
    api.get('/auth/check-calendar-access', { hasCalendarAccess: false });
    await expect(authService.checkCalendarAccess()).resolves.toBe(false);

    api.get('/auth/check-calendar-access', { status: 500, body: { error: 'down' } });
    await expect(authService.checkCalendarAccess()).resolves.toBe(false);
    expect(api.calls('GET')).toHaveLength(2);
  });

  it('reports a Microsoft connection the server confirms, and none when the check fails', async () => {
    api.get('/auth/check-microsoft', { hasMicrosoftToken: true });
    await expect(authService.checkMicrosoftConnection()).resolves.toBe(true);

    api.get('/auth/check-microsoft', { status: 500, body: { error: 'Graph unavailable' } });
    await expect(authService.checkMicrosoftConnection()).resolves.toBe(false);
    expect(api.calls('GET')).toHaveLength(2);
  });

  it('reports nothing connected for a signed-out caller without asking the server', async () => {
    config.auth.currentUser = null;

    await expect(authService.checkCalendarAccess()).resolves.toBe(false);
    await expect(authService.checkMicrosoftConnection()).resolves.toBe(false);
    await expect(authService.checkMicrosoftTokenStatus())
      .resolves.toEqual({ hasAccessToken: false, hasRefreshToken: false });
    expect(api.calls()).toHaveLength(0);
  });

  it('maps the Microsoft token status from the server answer', async () => {
    api.get('/auth/check-microsoft', { hasMicrosoftToken: true, tokenUpdatedAt: '2026-09-01T12:00:00.000Z' });

    await expect(authService.checkMicrosoftTokenStatus()).resolves.toEqual({
      hasAccessToken: true,
      hasRefreshToken: true,
      lastUpdated: '2026-09-01T12:00:00.000Z',
      isValid: true,
    });
  });

  it('reports no Microsoft tokens when the status check fails', async () => {
    api.get('/auth/check-microsoft', { status: 500, body: { error: 'down' } });

    await expect(authService.checkMicrosoftTokenStatus())
      .resolves.toEqual({ hasAccessToken: false, hasRefreshToken: false });
    expect(api.calls('GET')).toHaveLength(1);
  });
});

describe('refreshMicrosoftToken', () => {
  it('reports true when the server confirms the refresh', async () => {
    api.post('/auth/refresh-microsoft-token', { refreshed: true });

    await expect(authService.refreshMicrosoftToken()).resolves.toBe(true);
    expect(api.calls('POST')[0].body).toEqual({ token: 'mock-token' });
  });

  it('reports false when the server does not confirm a refresh', async () => {
    api.post('/auth/refresh-microsoft-token', { microsoftAccessToken: 'raw-token' });

    // Only the explicit confirmation counts; a body without it is not a refresh.
    await expect(authService.refreshMicrosoftToken()).resolves.toBe(false);
    expect(api.calls('POST')).toHaveLength(1);
  });

  it('reports false when the refresh is refused', async () => {
    api.post('/auth/refresh-microsoft-token', { status: 400, text: 'no refresh token', headers: { 'content-type': 'text/plain' } });

    await expect(authService.refreshMicrosoftToken()).resolves.toBe(false);
    expect(api.calls('POST')).toHaveLength(1);
  });

  it('reports false for a signed-out caller without asking the server', async () => {
    config.auth.currentUser = null;

    await expect(authService.refreshMicrosoftToken()).resolves.toBe(false);
    expect(api.calls()).toHaveLength(0);
  });
});

describe('silentMicrosoftReAuth', () => {
  it('never claims success, even for a Microsoft account whose token refreshes', async () => {
    signedInUser!.providerData = [{ providerId: 'microsoft.com', email: 'pat@firm.com' }];
    signedInUser!.getIdToken.mockClear();

    await expect(authService.silentMicrosoftReAuth()).resolves.toBe(false);
    // A silent re-auth cannot mint a Microsoft Graph token, so the caller is
    // always told to fall back to the interactive flow.
    expect(signedInUser!.getIdToken).toHaveBeenCalledWith(true);
  });

  it('does not touch the token for an account with no Microsoft provider', async () => {
    signedInUser!.getIdToken.mockClear();

    await expect(authService.silentMicrosoftReAuth()).resolves.toBe(false);
    expect(signedInUser!.getIdToken).not.toHaveBeenCalled();
  });
});
