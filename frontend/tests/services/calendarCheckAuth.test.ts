/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://app.paralegix.test"}
 *
 * The calendar status probes and the Microsoft refresh signal, against a fake
 * transport.
 *
 * `check-auth` answers 200 for every stored grant and says in its body whether
 * the grant is usable. Reading "connected" off the status code alone is how a
 * grant without calendar permission used to show as connected everywhere. The
 * docblock moves jsdom off `localhost`, where both services skip every call.
 *
 * What has to break for these to go red: a probe that reports `authenticated:
 * true` for any 200 again, a probe that drops the `state` field, or the Outlook
 * transport treating an unconfirmed refresh as success and retrying.
 */
jest.unmock('@/services/googleCalendarSync.service');
jest.unmock('@/services/outlookCalendarSync.service');
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');

import { GoogleCalendarSync } from '@/services/googleCalendarSync.service';
import {
  OutlookCalendarSync,
  OUTLOOK_CALENDAR_RECONNECT_EVENT,
} from '@/services/outlookCalendarSync.service';
import { setupApiMock, sequence } from '../support/apiMock';

const api = setupApiMock();

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe.each([
  ['Google', '/google-calendar-sync/check-auth', () => GoogleCalendarSync.checkGoogleAuth()],
  ['Outlook', '/outlook-calendar-sync/check-auth', () => OutlookCalendarSync.checkOutlookAuth()],
])('%s check-auth', (_name, path, check) => {
  it('reports a grant without calendar permission as not connected, with its state', async () => {
    api.get(path, { authenticated: false, state: 'permission_required', email: 'pat@firm.test' });

    await expect(check()).resolves.toEqual({
      authenticated: false,
      state: 'permission_required',
      email: 'pat@firm.test',
    });
  });

  it('reports a connected grant and its account address', async () => {
    api.get(path, { authenticated: true, state: 'connected', email: 'pat@firm.test' });

    await expect(check()).resolves.toEqual({ authenticated: true, state: 'connected', email: 'pat@firm.test' });
  });

  it('reads an answer without a state as disconnected', async () => {
    api.get(path, { email: null });

    await expect(check()).resolves.toEqual({ authenticated: false, state: 'disconnected', email: undefined });
  });

  it('reports no state at all when the probe fails, so a caller keeps what it knows', async () => {
    api.get(path, { status: 500, body: { error: 'down' } });

    const result = await check();

    expect(result).toEqual({ authenticated: false });
    expect(api.callsTo(path)).toHaveLength(1);
  });
});

describe('Outlook token refresh on a stale grant', () => {
  it('retries the call once the API confirms the refresh', async () => {
    api.post('/outlook-calendar-sync/sync-from-outlook', sequence(
      { status: 401, body: { error: 'Microsoft token expired', code: 'MICROSOFT_REAUTH_REQUIRED' } },
      { success: true, synced: 3 },
    ));
    api.post('/auth/refresh-microsoft-token', { refreshed: true });

    await expect(OutlookCalendarSync.syncFromOutlook('firm-1')).resolves.toEqual({ success: true, synced: 3 });
    expect(api.callsTo('/outlook-calendar-sync/sync-from-outlook')).toHaveLength(2);
  });

  it('asks for a reconnect, without retrying, when the API does not confirm the refresh', async () => {
    const reconnect = jest.fn();
    window.addEventListener(OUTLOOK_CALENDAR_RECONNECT_EVENT, reconnect);
    api.post('/outlook-calendar-sync/sync-from-outlook', { status: 401, body: { error: 'Microsoft token expired', code: 'MICROSOFT_REAUTH_REQUIRED' } });
    api.post('/auth/refresh-microsoft-token', { status: 401, body: { error: 'invalid_grant' } });

    try {
      const result = await OutlookCalendarSync.syncFromOutlook('firm-1');

      expect(result.success).toBe(false);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(api.callsTo('/outlook-calendar-sync/sync-from-outlook')).toHaveLength(1);
    } finally {
      window.removeEventListener(OUTLOOK_CALENDAR_RECONNECT_EVENT, reconnect);
    }
  });
});
