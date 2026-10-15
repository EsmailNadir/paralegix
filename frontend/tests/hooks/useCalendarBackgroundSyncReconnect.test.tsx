/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://app.paralegix.test"}
 *
 * A grant the API reports as needing a reconnect raises the firm shell's
 * reconnect banner.
 *
 * `GET /settings/user` derives `googleCalendarState` / `microsoftCalendarState`
 * from the stored grant. For `reconnect_required` and `permission_required` it
 * reports `loggedInWith*: false`, so the background sync stops calling the
 * provider and the 401 that used to raise the banner never happens. Without
 * this, sync stops silently and only General Settings says why.
 *
 * What has to break for these to go red: the hook not announcing either state,
 * announcing for a grant that can still sync, or announcing again on every
 * refetch of the same state (which re-opens a banner the person dismissed).
 */
jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');
jest.unmock('@/services/googleCalendarSync.service');
jest.unmock('@/services/outlookCalendarSync.service');

import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';

import { useCalendarBackgroundSync } from '@/hooks/useCalendarBackgroundSync';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import GoogleCalendarReconnectBanner from '@/components/GoogleCalendarReconnectBanner';
import OutlookCalendarReconnectBanner from '@/components/OutlookCalendarReconnectBanner';
import { makeTestQueryClient } from '../support/renderWithProviders';
import { setupApiMock, sequence } from '../support/apiMock';

const api = setupApiMock();

function SyncEngine() {
  useCalendarBackgroundSync('firm-a');
  return null;
}

/** The firm shell's arrangement: both banners, then the sync engine. */
function renderShell() {
  const queryClient = makeTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <FirmSettingsProvider lawFirmId="firm-a" initialSettings={{}}>
        <GoogleCalendarReconnectBanner />
        <OutlookCalendarReconnectBanner />
        <SyncEngine />
      </FirmSettingsProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function preferences(overrides: Record<string, unknown>) {
  return { preferences: { loggedInWithGoogle: false, loggedInWithMicrosoft: false, ...overrides } };
}

beforeEach(() => window.localStorage.clear());

it('shows the Google reconnect banner when the grant needs a reconnect', async () => {
  api.get('/settings/user', preferences({ googleCalendarState: 'reconnect_required' }));

  renderShell();

  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('Google Calendar needs to be reconnected. Open Settings → General.');
  expect(within(banner).getByRole('button', { name: 'Open Settings' })).toBeInTheDocument();
});

it('shows the Microsoft reconnect banner when calendar permission was not granted', async () => {
  api.get('/settings/user', preferences({ microsoftCalendarState: 'permission_required' }));

  renderShell();

  const banner = await screen.findByRole('alert');
  expect(banner).toHaveTextContent('Microsoft Calendar needs to be reconnected. Open Settings -> General.');
});

it('shows no banner for grants that can still sync', async () => {
  api.get('/settings/user', preferences({ googleCalendarState: 'unverified', microsoftCalendarState: 'connected' }));

  const queryClient = renderShell();

  // Prove the preferences arrived before asserting nothing was announced.
  await act(async () => {
    await queryClient.getQueryCache().find({ queryKey: ['userSyncSettings', 'firm-a'] })?.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(queryClient.getQueryData(['userSyncSettings', 'firm-a'])).toMatchObject({ googleCalendarState: 'unverified' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not reopen a dismissed banner when the same state is read again', async () => {
  api.get('/settings/user', sequence(
    preferences({ googleCalendarState: 'reconnect_required' }),
    preferences({ googleCalendarState: 'reconnect_required', googleConnectedEmail: 'pat@gmail.com' }),
  ));
  const user = userEvent.setup();

  const queryClient = renderShell();
  const banner = await screen.findByRole('alert');
  await user.click(within(banner).getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['userSyncSettings', 'firm-a'] });
    // Let the re-read reach the hook and any announcement reach the banner.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(queryClient.getQueryData(['userSyncSettings', 'firm-a'])).toMatchObject({ googleConnectedEmail: 'pat@gmail.com' });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
