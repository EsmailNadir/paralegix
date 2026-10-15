/**
 * /auth/reconnect on a cold load, before Firebase has restored the session.
 *
 * The connect call reads `auth.currentUser`, which is still null until Firebase
 * finishes restoring the persisted session. Starting the connect on mount
 * therefore failed with "Not authenticated" for anyone who opened the link in a
 * fresh tab. The page has to wait for auth to settle, and a visitor who turns
 * out to be signed out goes to /login with this exact page as the return path.
 *
 * What has to break for these to go red: the page starting the connect before
 * auth settles, or a signed-out visitor seeing "Reconnect failed" (or landing
 * on /login without a `next` that brings them back to the same reconnect).
 */
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');

const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockQuery = new URLSearchParams();
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter, useSearchParams: () => mockQuery }));

const signedInUser = {
  uid: 'test-uid',
  email: 'pat@firm.test',
  emailVerified: true,
  providerData: [],
  getIdToken: jest.fn().mockResolvedValue('mock-token'),
};
const mockAuthState: { user: typeof signedInUser | null; loading: boolean } = { user: null, loading: true };
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => mockAuthState }));
// Firebase's `currentUser` is null until the session is restored, exactly
// like the `user` the hook reports while it is still loading.
const mockFirebaseAuth: { currentUser: typeof signedInUser | null } = { currentUser: null };
jest.mock('@/lib/firebase/config', () => ({ auth: mockFirebaseAuth }));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import ReconnectPage from '@/app/auth/reconnect/page';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

let api: ApiMock;
let startUrl: string;

beforeEach(() => {
  api = installApiMock();
  startUrl = window.location.href.split('#')[0];
  mockRouter.push.mockReset();
  mockRouter.replace.mockReset();
  mockAuthState.user = null;
  mockAuthState.loading = true;
  mockFirebaseAuth.currentUser = null;
});

afterEach(() => {
  api.restore();
  window.history.replaceState(null, '', startUrl);
});

function render(query: string) {
  mockQuery = new URLSearchParams(query);
  return renderWithProviders(<ReconnectPage />);
}

it('waits for the session to be restored, then starts the connect', async () => {
  api.post('/auth/connect-google', { authUrl: `${startUrl}#google-consent` });

  const { rerender } = render('provider=google&return=%2Flawfirm%2Ffirm-1%2Fcalendar');

  // Give a premature connect every chance to run and fail.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.calls('POST')).toHaveLength(0);
  expect(screen.queryByText('Reconnect failed')).not.toBeInTheDocument();

  mockFirebaseAuth.currentUser = signedInUser;
  mockAuthState.user = signedInUser;
  mockAuthState.loading = false;
  rerender(<ReconnectPage />);

  await waitFor(() => expect(window.location.hash).toBe('#google-consent'));
  expect(api.calls('POST')).toHaveLength(1);
  expect(api.calls('POST')[0].body).toEqual({ returnUrl: `${window.location.origin}/lawfirm/firm-1/calendar` });
});

it('sends a signed-out visitor to sign in, with this reconnect as the return path', async () => {
  mockAuthState.loading = false;

  render('provider=microsoft&return=%2Flawfirm%2Ffirm-1%2Ftasks');

  const next = '/auth/reconnect?provider=microsoft&return=%2Flawfirm%2Ffirm-1%2Ftasks';
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(next)}`));
  expect(api.calls()).toHaveLength(0);
  expect(screen.queryByText('Reconnect failed')).not.toBeInTheDocument();
});
