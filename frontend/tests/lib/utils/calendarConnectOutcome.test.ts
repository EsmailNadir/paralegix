/**
 * Reading the outcome a calendar connect callback leaves on the return URL.
 *
 * The API redirects back with `?google_connected=true` or `?google_error=<code>`
 * (and the Microsoft pair). Codes are fixed strings, never provider text, and
 * the person must see one plain sentence for each, never the raw code.
 *
 * What has to break for these to go red: an outcome param no longer recognised,
 * a code rendered raw, an unknown code shown verbatim instead of the generic
 * sentence, or the forwarded query string picking up unrelated parameters.
 */
import {
  connectOutcomeMessage,
  connectOutcomeQuery,
  readConnectOutcome,
} from '@/lib/utils/calendarConnectOutcome';

describe('readConnectOutcome', () => {
  it.each([
    ['google_connected=true', { provider: 'google', connected: true, code: null }],
    ['microsoft_connected=true', { provider: 'microsoft', connected: true, code: null }],
    ['google_error=permission_required', { provider: 'google', connected: false, code: 'permission_required' }],
    ['tab=x&microsoft_error=admin_consent_required', { provider: 'microsoft', connected: false, code: 'admin_consent_required' }],
  ])('reads %s', (query, expected) => {
    expect(readConnectOutcome(new URLSearchParams(query))).toEqual(expected);
  });

  it('reads nothing from a URL without an outcome', () => {
    expect(readConnectOutcome(new URLSearchParams('tab=calendar'))).toBeNull();
    expect(readConnectOutcome(new URLSearchParams('google_connected=false'))).toBeNull();
  });
});

describe('connectOutcomeQuery', () => {
  it('keeps only the outcome parameters, ready to append to another path', () => {
    expect(connectOutcomeQuery(new URLSearchParams('provider=google&google_error=expired_state&x=1')))
      .toBe('?google_error=expired_state');
  });

  it('is empty when there is no outcome', () => {
    expect(connectOutcomeQuery(new URLSearchParams('provider=google'))).toBe('');
  });
});

describe('connectOutcomeMessage', () => {
  const codes = [
    'access_denied', 'admin_consent_required', 'permission_required', 'invalid_state',
    'expired_state', 'exchange_failed', 'missing_refresh_token', 'identity_unverified',
  ];

  it.each(codes)('gives %s its own plain sentence that never shows the code', (code) => {
    const google = connectOutcomeMessage('google', code);
    expect(google).not.toContain(code);
    expect(google).toMatch(/Google/);
    expect(google).toMatch(/\.$/);
    expect(connectOutcomeMessage('microsoft', code)).toMatch(/Microsoft/);
  });

  it('gives every known code a different sentence from the generic one', () => {
    const generic = connectOutcomeMessage('google', 'something_new');
    const sentences = codes.map((code) => connectOutcomeMessage('google', code));
    expect(new Set(sentences).size).toBe(codes.length);
    expect(sentences).not.toContain(generic);
  });

  it('falls back to a generic sentence for an unknown code, without echoing it', () => {
    expect(connectOutcomeMessage('microsoft', '<script>')).toBe('Microsoft Calendar could not be connected. Please try again.');
  });
});
