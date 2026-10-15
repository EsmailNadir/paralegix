jest.unmock('@/services/settings.service');
jest.unmock('@/services/requestDeduplicator');
const mockUser = { uid: 'test-uid' };
let mockRecordId = 'record-a';
const mockNavigate = jest.fn();
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }) }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ associations: [], associationsLoading: false, activeAssociation: { clientRecordId: mockRecordId }, selectionRequired: false }) }));

import React from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Settings from '@/app/client/lawfirm/[lawFirmId]/settings/page';
import { DEFAULT_CLIENT_SETTINGS } from '@/types/preferences';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock, sequence } from '../../support/apiMock';
const api = setupApiMock();
const base = '/api/client-portal/lawfirm/firm-a/settings';
beforeEach(() => { mockRecordId = 'record-a'; mockNavigate.mockReset(); });

it('focuses repeated save errors, retains preferences, and announces a record-scoped keyboard retry', async () => {
  api.getExact(`${base}?clientRecordId=record-a`, { settings: DEFAULT_CLIENT_SETTINGS });
  api.putExact(`${base}?clientRecordId=record-a`, sequence(
    { status: 403, body: { error: 'Settings update denied' } },
    { status: 403, body: { error: 'Settings update denied' } }, { message: 'Saved' },
  ));
  const user = userEvent.setup();
  renderWithProviders(<Settings />);
  const check = await screen.findByRole('checkbox', { name: 'Email on new invoice' });
  await user.click(check);
  const save = screen.getByRole('button', { name: 'Save Settings' });
  for (let i = 0; i < 2; i += 1) {
    save.focus();
    await user.keyboard('{Enter}');
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Settings update denied');
    expect(error.parentElement).toHaveFocus();
    expect(check).not.toBeChecked();
    await user.click(within(error).getByRole('button', { name: 'Close' }));
    expect(save).toHaveFocus();
  }
  await user.keyboard('{Enter}');
  await screen.findByText('Settings saved successfully.');
  expect(screen.getAllByRole('status').filter(status => status.textContent?.includes('Settings saved successfully'))).toHaveLength(1);
  expect(save).toHaveFocus();
  expect(api.calls('PUT')).toHaveLength(3);
  expect(api.calls('PUT')[2].body).toEqual({ settings: {
    ...DEFAULT_CLIENT_SETTINGS, notifications: { ...DEFAULT_CLIENT_SETTINGS.notifications, emailOnNewInvoice: false },
  } });
  // The save handler returns focus to Save on the next animation frame; let it run so it cannot
  // pull focus off the link after the link is focused.
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const account = screen.getByRole('link', { name: 'Account Settings' });
  expect(account).toHaveAttribute('href', '/account');
  account.focus();
  await user.keyboard('{Enter}');
  expect(mockNavigate).toHaveBeenCalledWith('/account');
});

it('prevents saving unloaded fallback settings and recovers after revisiting the page', async () => {
  api.getExact(`${base}?clientRecordId=record-a`, sequence(
    { status: 503, body: { error: 'Preferences unavailable' } },
    { settings: { ...DEFAULT_CLIENT_SETTINGS, notifications: { ...DEFAULT_CLIENT_SETTINGS.notifications, emailOnNewInvoice: false } } },
  ));
  const view = renderWithProviders(<Settings />);
  const error = await screen.findByRole('alert');
  expect(error.parentElement).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Save Settings' })).toBeDisabled();
  expect(within(error).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  view.unmount();
  renderWithProviders(<Settings />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save Settings' })).toBeEnabled());
  expect(screen.getByRole('checkbox', { name: 'Email on new invoice' })).not.toBeChecked();
  expect(api.calls('GET')).toHaveLength(2);
  expect(api.calls('PUT')).toHaveLength(0);
});

it('ignores a previous record response that arrives after the selected record settings', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  api.getExact(`${base}?clientRecordId=record-a`, async () => { await gate; return { settings: DEFAULT_CLIENT_SETTINGS }; });
  api.getExact(`${base}?clientRecordId=record-b`, { settings: { ...DEFAULT_CLIENT_SETTINGS, notifications: { ...DEFAULT_CLIENT_SETTINGS.notifications, emailOnNewInvoice: false } } });
  const { rerender } = renderWithProviders(<Settings />);
  await waitFor(() => expect(api.calls('GET')).toHaveLength(1));
  mockRecordId = 'record-b';
  rerender(<Settings />);
  const checkbox = await screen.findByRole('checkbox', { name: 'Email on new invoice' });
  expect(checkbox).not.toBeChecked();
  await act(async () => { release(); await gate; await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox).not.toBeChecked();
});
