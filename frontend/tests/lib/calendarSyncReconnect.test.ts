/**
 * The Google and Outlook calendar sync services share two contracts that the
 * reconnect banners and the background sync both depend on:
 *
 * - A 401 from the provider becomes a typed reconnect error carrying a fixed
 *   code, and the `is*ReconnectRequiredError` guard is how every caller tells
 *   that apart from any other failure.
 * - On localhost the OAuth redirect URIs never match, so a sync is skipped
 *   without a request rather than failing noisily. jsdom serves the test page
 *   from `http://localhost/`, which is exactly that branch.
 */
jest.unmock('@/services/googleCalendarSync.service');
jest.unmock('@/services/outlookCalendarSync.service');
jest.unmock('@/services/requestDeduplicator');

import {
  GOOGLE_CALENDAR_RECONNECT_CODE,
  GoogleCalendarReconnectRequiredError,
  GoogleCalendarSync,
  isGoogleCalendarReconnectRequiredError,
} from '@/services/googleCalendarSync.service';
import {
  OUTLOOK_CALENDAR_RECONNECT_CODE,
  OutlookCalendarReconnectRequiredError,
  OutlookCalendarSync,
  isOutlookCalendarReconnectRequiredError,
} from '@/services/outlookCalendarSync.service';
import { setupApiMock } from '../support/apiMock';

const PROVIDERS = [
  {
    name: 'Google',
    code: GOOGLE_CALENDAR_RECONNECT_CODE,
    expectedCode: 'GOOGLE_CALENDAR_RECONNECT_REQUIRED',
    ReconnectError: GoogleCalendarReconnectRequiredError,
    isReconnectError: isGoogleCalendarReconnectRequiredError,
    sync: (lawFirmId: string) => GoogleCalendarSync.syncFromGoogle(lawFirmId),
  },
  {
    name: 'Outlook',
    code: OUTLOOK_CALENDAR_RECONNECT_CODE,
    expectedCode: 'OUTLOOK_CALENDAR_RECONNECT_REQUIRED',
    ReconnectError: OutlookCalendarReconnectRequiredError,
    isReconnectError: isOutlookCalendarReconnectRequiredError,
    sync: (lawFirmId: string) => OutlookCalendarSync.syncFromOutlook(lawFirmId),
  },
];

const api = setupApiMock();

describe.each(PROVIDERS)('$name calendar sync', ({ code, expectedCode, ReconnectError, isReconnectError, sync }) => {
  it('tags a reconnect error with its fixed code', () => {
    const err = new ReconnectError('Reconnect me');

    expect(code).toBe(expectedCode);
    expect(err.code).toBe(expectedCode);
    expect(err.message).toBe('Reconnect me');
  });

  it('tells a reconnect error apart from any other error', () => {
    expect(isReconnectError(new ReconnectError('Reconnect me'))).toBe(true);
    expect(isReconnectError(new Error('x'))).toBe(false);
  });

  it('skips a sync on localhost without sending a request', async () => {
    await expect(sync('test-lawfirm')).resolves.toEqual({ success: false, skipped: true });

    expect(api.calls()).toEqual([]);
  });
});
