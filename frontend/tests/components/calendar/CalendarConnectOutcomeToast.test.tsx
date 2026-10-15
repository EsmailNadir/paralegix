/**
 * The connect outcome a calendar OAuth callback leaves on the return URL,
 * reported by the shell of whatever page the person lands on.
 *
 * The callback URL is a claim, not proof: `?google_connected=true` only says the
 * API finished its callback. Success is shown, and `calendar_connected` tracked,
 * only when a fresh settings read says the grant is `connected`. An error code
 * becomes one plain sentence; the raw code never reaches the screen.
 *
 * What has to break for these to go red: success or analytics taken from the
 * URL alone again, the raw code rendered, the outcome params left on the URL
 * (a reload would report it twice), or the shell's caches not refreshed after a
 * confirmed connect.
 */
jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');

const mockTrack = jest.fn();
jest.mock('@/lib/analytics/analytics', () => ({
  __esModule: true,
  track: (...args: unknown[]) => mockTrack(...args),
}));

const mockReplace = jest.fn();
let mockQuery = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  usePathname: () => '/lawfirm/firm-1/calendar',
  useSearchParams: () => mockQuery,
}));

import React from 'react';
import { screen } from '@testing-library/react';
import CalendarConnectOutcomeToast from '@/components/calendarComp/CalendarConnectOutcomeToast';
import { setupApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { scanAccessibility } from '../../support/accessibility';

const api = setupApiMock();
const SETTINGS = '/api/settings/user?lawFirmId=firm-1';

function render(query: string, onConnected = jest.fn()) {
  mockQuery = new URLSearchParams(query);
  const utils = renderWithProviders(
    <CalendarConnectOutcomeToast lawFirmId="firm-1" onConnected={onConnected} />,
  );
  return { ...utils, onConnected };
}

beforeEach(() => {
  mockTrack.mockReset();
  mockReplace.mockReset();
});

describe('a connect the API reported as done', () => {
  it('confirms a connected Google grant, tracks it, and refreshes the shell', async () => {
    api.getExact(SETTINGS, { preferences: { googleCalendarState: 'connected', loggedInWithGoogle: true } });

    const { container, onConnected } = render('view=week&google_connected=true');

    expect(await screen.findByText('Google account connected successfully.')).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith('calendar_connected', { provider: 'google' });
    expect(onConnected).toHaveBeenCalledTimes(1);
    // The other params survive; only the outcome is consumed.
    expect(mockReplace).toHaveBeenCalledWith('/lawfirm/firm-1/calendar?view=week', { scroll: false });
    expect((await scanAccessibility(container)).violations).toEqual([]);
  });

  it('tracks a confirmed Microsoft grant under the outlook provider name', async () => {
    api.getExact(SETTINGS, { preferences: { microsoftCalendarState: 'connected' } });

    render('microsoft_connected=true');

    expect(await screen.findByText('Microsoft account connected successfully.')).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith('calendar_connected', { provider: 'outlook' });
  });

  it('does not claim success when the fresh read says the calendar is not connected', async () => {
    api.getExact(SETTINGS, { preferences: { googleCalendarState: 'disconnected', loggedInWithGoogle: false } });

    const { onConnected } = render('google_connected=true');

    expect(await screen.findByText('Google Calendar did not finish connecting. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/connected successfully/)).not.toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(api.calls()).toHaveLength(1);
  });

  it('does not claim success when the fresh read fails', async () => {
    api.getExact(SETTINGS, { status: 500, body: { error: 'down' } });

    render('google_connected=true');

    expect(await screen.findByText('Google Calendar did not finish connecting. Please try again.')).toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('a connect the API refused', () => {
  it('shows the sentence for the code, never the code itself, without reading settings', async () => {
    render('microsoft_error=permission_required');

    expect(await screen.findByText(
      'Microsoft Calendar was not connected because calendar access was not allowed. Connect again and allow calendar access.',
    )).toBeInTheDocument();
    expect(screen.queryByText(/permission_required/)).not.toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith('/lawfirm/firm-1/calendar', { scroll: false });
    expect(api.calls()).toHaveLength(0);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('falls back to a generic sentence for a code it does not know', async () => {
    render('google_error=brand_new_code');

    expect(await screen.findByText('Google Calendar could not be connected. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/brand_new_code/)).not.toBeInTheDocument();
  });
});

it('renders nothing and asks nothing when the URL carries no outcome', () => {
  const { container } = render('view=week');

  expect(container).toBeEmptyDOMElement();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(api.calls()).toHaveLength(0);
});
