/**
 * Changing calendar sync on the general settings page refreshes the cached sync
 * preferences.
 *
 * The firm layout runs the calendar background sync for as long as the
 * workspace is open, reading the user's sync flags from the
 * `['userSyncSettings', firm]` query. That observer never remounts and the firm
 * QueryClient no longer refetches on window focus, so unless this page
 * invalidates the query after saving, the background sync keeps pulling from a
 * calendar the user just switched off.
 *
 * What has to break for this to go red: the invalidation removed from a sync
 * direction or calendar target save.
 *
 * The connection rows read the API's derived `googleCalendarState` and
 * `microsoftCalendarState`, never the Firebase sign-in providers, so a person
 * who signed in with Google but never granted calendar access is not shown as
 * connected. The connect outcome on the URL is the firm shell's job, not this
 * page's.
 */
const mockUpdateUserSettings = jest.fn();
const mockGetUserSettings = jest.fn();
const mockCheckGoogleAuth = jest.fn();
const mockLinkGoogle = jest.fn();
const mockUnlinkGoogle = jest.fn();
const mockUnlinkMicrosoft = jest.fn();
const mockCheckOutlookAuth = jest.fn();
const mockTrack = jest.fn();
let mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-1/settings/general',
  useParams: () => ({ lawFirmId: 'firm-1' }),
  useSearchParams: () => mockSearchParams,
}));

jest.mock('@/lib/analytics/analytics', () => ({
  __esModule: true,
  track: (...args: unknown[]) => mockTrack(...args),
}));

jest.mock('@/services/settings.service', () => ({
  __esModule: true,
  default: {
    getUserSettings: (...args: unknown[]) => mockGetUserSettings(...args),
    updateUserSettings: (...args: unknown[]) => mockUpdateUserSettings(...args),
  },
}));

jest.mock('@/services/auth.service', () => ({
  __esModule: true,
  default: {
    linkGoogle: (...args: unknown[]) => mockLinkGoogle(...args),
    unlinkGoogle: (...args: unknown[]) => mockUnlinkGoogle(...args),
    unlinkMicrosoft: (...args: unknown[]) => mockUnlinkMicrosoft(...args),
  },
}));

jest.mock('@/services/googleCalendarSync.service', () => ({
  __esModule: true,
  GoogleCalendarSync: {
    checkGoogleAuth: (...args: unknown[]) => mockCheckGoogleAuth(...args),
    enableSilentSync: jest.fn().mockResolvedValue(undefined),
    disableSilentSync: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/services/outlookCalendarSync.service', () => ({
  __esModule: true,
  OutlookCalendarSync: {
    checkOutlookAuth: (...args: unknown[]) => mockCheckOutlookAuth(...args),
  },
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GeneralSettingsPage from '@/app/lawfirm/[lawFirmId]/settings/general/page';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';

function settingsWith(preferences: Record<string, unknown>) {
  mockGetUserSettings.mockResolvedValue({ preferences });
}

beforeEach(() => {
  mockUpdateUserSettings.mockReset().mockResolvedValue({});
  mockGetUserSettings.mockReset();
  settingsWith({ googleCalendarState: 'connected', loggedInWithGoogle: true, allowGoogleToParalegixSync: true });
  mockCheckGoogleAuth.mockReset().mockResolvedValue({ authenticated: false });
  mockLinkGoogle.mockReset().mockResolvedValue(undefined);
  mockUnlinkGoogle.mockReset().mockResolvedValue(undefined);
  mockUnlinkMicrosoft.mockReset().mockResolvedValue(undefined);
  mockCheckOutlookAuth.mockReset().mockResolvedValue({ authenticated: false });
  mockTrack.mockReset();
  mockSearchParams = new URLSearchParams();
});

async function googleRow() {
  const label = await screen.findByText('Google', { selector: 'div' });
  return label.parentElement!.parentElement as HTMLElement;
}

it('invalidates the cached sync preferences after the Google sync direction is saved', async () => {
  const user = userEvent.setup();
  const { queryClient } = renderWithProviders(<GeneralSettingsPage />);
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  const trigger = await screen.findByRole('button', { name: /Google Calendar Sync/i });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  await user.click(trigger);
  await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'None' }));

  await waitFor(() => expect(mockUpdateUserSettings).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['userSyncSettings', 'firm-1'] }));
});

describe('the Google connection row', () => {
  it('shows a grant without calendar permission as needing permission, not connected', async () => {
    settingsWith({ googleCalendarState: 'permission_required', loggedInWithGoogle: false });
    const user = userEvent.setup();

    renderWithProviders(<GeneralSettingsPage />);

    const row = await googleRow();
    expect(await within(row).findByText('Permission needed: reconnect and allow calendar access')).toBeInTheDocument();
    expect(within(row).queryByText(/^Connected/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Google Calendar Sync/i })).toBeDisabled();

    await user.click(within(row).getByRole('button', { name: 'Reconnect Google' }));
    expect(mockLinkGoogle).toHaveBeenCalledTimes(1);
  });

  it('shows a lost grant as needing a reconnect', async () => {
    settingsWith({ googleCalendarState: 'reconnect_required', loggedInWithGoogle: false });

    renderWithProviders(<GeneralSettingsPage />);

    const row = await googleRow();
    expect(await within(row).findByText('Connection lost: reconnect to resume sync')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Reconnect Google' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('keeps an older unverified grant syncing while asking for a reconnect', async () => {
    settingsWith({ googleCalendarState: 'unverified', loggedInWithGoogle: true });

    renderWithProviders(<GeneralSettingsPage />);

    const row = await googleRow();
    expect(await within(row).findByText('Reconnect to confirm access')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Google Calendar Sync/i })).not.toBeDisabled());
  });

  it('takes the resolved state from check-auth when it differs from the stored read', async () => {
    settingsWith({ googleCalendarState: 'unverified', loggedInWithGoogle: true });
    mockCheckGoogleAuth.mockResolvedValue({ authenticated: false, state: 'permission_required', email: 'pat@gmail.com' });

    renderWithProviders(<GeneralSettingsPage />);

    const row = await googleRow();
    expect(await within(row).findByText('Permission needed: reconnect and allow calendar access')).toBeInTheDocument();
  });

  it('shows a connected grant with the account address check-auth reports', async () => {
    mockCheckGoogleAuth.mockResolvedValue({ authenticated: true, state: 'connected', email: 'pat@gmail.com' });

    renderWithProviders(<GeneralSettingsPage />);

    const row = await googleRow();
    expect(await within(row).findByText('Connected: pat@gmail.com')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('reads a Google sign-in with no calendar grant as not connected', async () => {
    settingsWith({ googleCalendarState: 'disconnected', loggedInWithGoogle: false });

    renderWithProviders(<GeneralSettingsPage />);

    const row = await googleRow();
    expect(await within(row).findByText('Not connected')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Connect Google' })).toBeInTheDocument();
    expect(mockCheckGoogleAuth).not.toHaveBeenCalled();
  });
});

describe('a connect outcome on the URL', () => {
  it('leaves it to the firm shell: no connected claim, no tracking, no settings write', async () => {
    settingsWith({ googleCalendarState: 'disconnected', loggedInWithGoogle: false });
    mockSearchParams = new URLSearchParams('google_connected=true');

    renderWithProviders(<GeneralSettingsPage />);

    const row = await googleRow();
    expect(await within(row).findByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText(/connected successfully/)).not.toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockUpdateUserSettings).not.toHaveBeenCalled();
  });

  it('never prints the raw error code', async () => {
    mockSearchParams = new URLSearchParams('google_error=permission_required');

    renderWithProviders(<GeneralSettingsPage />);

    await googleRow();
    expect(screen.queryByText(/permission_required/)).not.toBeInTheDocument();
  });
});

describe('disconnecting Google', () => {
  // The layout's background sync and the get-started checklist read these two
  // caches and never refetch on focus, so a disconnect that leaves them alone
  // keeps syncing against a grant the server has already deleted.
  it('refreshes the shared calendar caches and turns the Google sync directions off', async () => {
    mockCheckGoogleAuth.mockResolvedValue({ authenticated: true, state: 'connected', email: 'pat@gmail.com' });
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<GeneralSettingsPage />);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    const row = await googleRow();
    await within(row).findByText('Connected: pat@gmail.com');
    expect(screen.getByText('Sync existing tasks & events')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Disconnect' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Disconnect calendar' })).getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('Google account disconnected. You can reconnect anytime.')).toBeInTheDocument();
    expect(mockUnlinkGoogle).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['userSyncSettings', 'firm-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['getStartedProgress', 'firm-1', 'calendar'] });
    expect(screen.queryByText('Sync existing tasks & events')).not.toBeInTheDocument();
  });

  it('leaves the caches and the sync directions alone when the disconnect fails', async () => {
    mockCheckGoogleAuth.mockResolvedValue({ authenticated: true, state: 'connected', email: 'pat@gmail.com' });
    mockUnlinkGoogle.mockRejectedValue(new Error('Failed to disconnect Google'));
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<GeneralSettingsPage />);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    const row = await googleRow();
    await within(row).findByText('Connected: pat@gmail.com');
    await user.click(within(row).getByRole('button', { name: 'Disconnect' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Disconnect calendar' })).getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('Failed to disconnect Google')).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByText('Sync existing tasks & events')).toBeInTheDocument();
  });
});

describe('disconnecting Microsoft', () => {
  it('refreshes the shared calendar caches and turns the Outlook sync directions off', async () => {
    settingsWith({ microsoftCalendarState: 'connected', loggedInWithMicrosoft: true, allowOutlookToParalegixSync: true });
    mockCheckOutlookAuth.mockResolvedValue({ authenticated: true, state: 'connected', email: 'pat@outlook.test' });
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<GeneralSettingsPage />);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    const label = await screen.findByText('Microsoft', { selector: 'div' });
    const row = label.parentElement!.parentElement as HTMLElement;
    await within(row).findByText('Connected: pat@outlook.test');
    expect(screen.getByText('Sync existing tasks & events')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Disconnect' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Disconnect calendar' })).getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('Microsoft account disconnected. You can reconnect anytime.')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['userSyncSettings', 'firm-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['getStartedProgress', 'firm-1', 'calendar'] });
    expect(screen.queryByText('Sync existing tasks & events')).not.toBeInTheDocument();
  });
});

it('offers removing Paralegix copies when disconnecting a calendar', async () => {
  mockCheckGoogleAuth.mockResolvedValue({ authenticated: true, state: 'connected', email: 'pat@gmail.com' });
  const user = userEvent.setup();
  renderWithProviders(<GeneralSettingsPage />);
  const row = await googleRow();
  await within(row).findByText('Connected: pat@gmail.com');
  await user.click(within(row).getByRole('button', { name: 'Disconnect' }));
  const dialog = screen.getByRole('dialog', { name: 'Disconnect calendar' });
  const removal = within(dialog).getByRole('checkbox', { name: 'Remove Paralegix events from this calendar' });
  expect(removal).not.toBeChecked();
  await user.click(removal);
  await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(mockUnlinkGoogle).toHaveBeenCalledWith({ removeParalegixEvents: true }));
});

describe('a refused sync save', () => {
  // Red if the dropdown keeps the refused choice: it then claims a sync
  // direction the server never stored.
  it('puts the Google sync direction back to what is saved', async () => {
    const user = userEvent.setup();
    mockUpdateUserSettings.mockRejectedValue(new Error('Calendar sync is locked by your firm admin'));
    renderWithProviders(<GeneralSettingsPage />);

    const trigger = await screen.findByRole('button', { name: /Google Calendar Sync/i });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    expect(trigger).toHaveTextContent('Import Events from Google');
    await user.click(trigger);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'None' }));

    expect(await screen.findByText('Calendar sync is locked by your firm admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Google Calendar Sync/i })).toHaveTextContent('Import Events from Google');
  });

  it('puts the Google calendar target back to what is saved', async () => {
    const user = userEvent.setup();
    settingsWith({
      googleCalendarState: 'connected', allowGoogleToParalegixSync: true, googleCalendarTarget: 'default',
    });
    mockUpdateUserSettings.mockRejectedValue(new Error('Refused'));
    renderWithProviders(<GeneralSettingsPage />);

    const trigger = await screen.findByRole('button', { name: /Google Calendar Target/i });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    await user.click(trigger);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Separate Paralegix Calendar' }));

    expect(await screen.findByText('Refused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Google Calendar Target/i })).toHaveTextContent('Your Main Calendar');
  });
});

describe('a firm calendar sync lock', () => {
  // The backend refuses a locked key for every member, administrators
  // included, and reads the locked value back in its place, exactly as it does
  // for a locked theme. A live control for an admin changed nothing.
  it('disables the sync directions for an administrator who manages locks too', async () => {
    renderWithProviders(
      <FirmSettingsProvider lawFirmId="firm-1" initialSettings={{ locks: { calendarSyncEnabled: true } }}>
        <GeneralSettingsPage />
      </FirmSettingsProvider>,
    );

    const trigger = await screen.findByRole('button', { name: /Google Calendar Sync/i });
    await waitFor(() => expect(screen.getAllByText('Calendar sync is managed by your firm administrator.').length).toBeGreaterThan(0));
    expect(trigger).toBeDisabled();
  });
});
