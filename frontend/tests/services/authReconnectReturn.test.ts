/**
 * The /auth/reconnect landing page, run against a fake transport.
 *
 * Nothing in the app links here any more, but an old bookmark or email link
 * still can. The page must start the SERVER authorization-code flow, which is
 * the only path that yields a refresh token and a validated grant; a Firebase
 * redirect would hand back a pop-up access token the API no longer stores.
 *
 * What has to break for these to go red: the page going back to a Firebase
 * redirect, dropping its `return` parameter, defaulting the return to itself
 * (the callback would land here and start the flow again), or accepting a
 * return URL on another origin.
 */
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockQuery = new URLSearchParams();
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter, useSearchParams: () => mockQuery }));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import ReconnectPage from '@/app/auth/reconnect/page';
import { installApiMock, type ApiMock } from '../support/apiMock';
import { renderWithProviders } from '../support/renderWithProviders';

let api: ApiMock;
let startUrl: string;

beforeEach(() => {
  api = installApiMock();
  startUrl = window.location.href.split('#')[0];
  mockQuery = new URLSearchParams();
  mockRouter.push.mockReset();
  mockRouter.replace.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  api.restore();
  window.history.replaceState(null, '', startUrl);
  jest.restoreAllMocks();
});

function render(query: string) {
  mockQuery = new URLSearchParams(query);
  return renderWithProviders(React.createElement(ReconnectPage));
}

describe('starting a reconnect', () => {
  it('starts the Google code flow with the page it was given, and follows the consent URL', async () => {
    api.post('/auth/connect-google', { authUrl: `${startUrl}#google-consent` });

    render('provider=google&return=%2Flawfirm%2Ffirm-1%2Fcalendar');

    await waitFor(() => expect(window.location.hash).toBe('#google-consent'));
    const [call] = api.calls('POST');
    expect(call.body).toEqual({ returnUrl: `${window.location.origin}/lawfirm/firm-1/calendar` });
    expect(call.credentials).toBe('include');
    expect(screen.getByText('Redirecting to sign in...')).toBeInTheDocument();
  });

  it('starts the Microsoft code flow the same way', async () => {
    api.post('/auth/connect-microsoft', { authUrl: `${startUrl}#ms-consent` });

    render('provider=microsoft&return=%2Flawfirm%2Ffirm-1%2Ftasks');

    await waitFor(() => expect(window.location.hash).toBe('#ms-consent'));
    expect(api.calls('POST')[0].body).toEqual({ returnUrl: `${window.location.origin}/lawfirm/firm-1/tasks` });
  });

  it('returns to the dashboard, never to itself, when no page was given', async () => {
    api.post('/auth/connect-google', { authUrl: `${startUrl}#google-consent` });

    render('provider=google');

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual({ returnUrl: `${window.location.origin}/dashboard` });
  });

  it('refuses a return page on another site and uses the dashboard instead', async () => {
    api.post('/auth/connect-google', { authUrl: `${startUrl}#google-consent` });

    render('provider=google&return=https%3A%2F%2Fevil.example%2Fsteal');

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual({ returnUrl: `${window.location.origin}/dashboard` });
  });
});

describe('when the reconnect cannot start', () => {
  it('explains a missing provider without asking the server', async () => {
    render('');

    expect(await screen.findByText('Reconnect failed')).toBeInTheDocument();
    expect(screen.getByText('Missing or invalid provider. Use ?provider=google or ?provider=microsoft')).toBeInTheDocument();
    expect(api.calls()).toHaveLength(0);
  });

  it('shows the server refusal and stays on the page', async () => {
    api.post('/auth/connect-microsoft', { status: 400, body: { error: 'Microsoft integration is not configured' } });

    render('provider=microsoft');

    expect(await screen.findByText('Microsoft integration is not configured')).toBeInTheDocument();
    expect(window.location.href).toBe(startUrl);
  });
});

describe('arriving back with a connect outcome', () => {
  it('hands the outcome to the dashboard instead of starting another connect', async () => {
    render('provider=google&google_error=permission_required');

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/dashboard?google_error=permission_required'));
    expect(api.calls()).toHaveLength(0);
  });
});
