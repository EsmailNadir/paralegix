jest.unmock('@/services/privacy.service');
jest.unmock('@/services/auth.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/lib/utils/csv', () => ({ downloadJson: jest.fn() }));
const mockRouter = { push: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signOut } from 'firebase/auth';
import AccountPrivacySection from '@/components/settingsComp/AccountPrivacySection';
import { downloadJson } from '@/lib/utils/csv';
import { setupApiMock, sequence } from '../../support/apiMock';

const api = setupApiMock();
beforeEach(() => jest.clearAllMocks());

it('focuses repeated export failures and returns to the failed action before a keyboard retry', async () => {
  api.getExact('/api/privacy/me/export', sequence(
    { status: 503, body: { error: 'Export unavailable' } },
    { status: 503, body: { error: 'Export unavailable' } },
    { user: { id: 'test-uid' }, records: ['own record'] },
  ));
  render(<AccountPrivacySection />);
  const button = screen.getByRole('button', { name: 'Export My Data' });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(button);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Export unavailable');
    expect(api.callsTo('/privacy/me/export')).toHaveLength(attempt + 1);
    expect(alert.parentElement).toHaveFocus();
  }
  expect(downloadJson).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(button).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByText('Your data export has been downloaded.')).toBeInTheDocument();
  expect(downloadJson).toHaveBeenCalledWith('paralegix-my-data.json', { user: { id: 'test-uid' }, records: ['own record'] });
  expect(button).toHaveFocus();
});

it('focuses a refused erasure without signing out and permits a successful confirmed retry', async () => {
  api.delete('/privacy/me', sequence({ status: 403, body: { error: 'Transfer ownership first' } }, { message: 'Erased' }));
  api.delete('/auth/docs-session', {});
  render(<AccountPrivacySection />);
  const trigger = screen.getByRole('button', { name: 'Delete My Account' });
  await userEvent.click(trigger);
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete My Account' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Transfer ownership first');
  expect(api.callsTo('/privacy/me')).toHaveLength(1);
  expect(signOut).not.toHaveBeenCalled();
  expect(mockRouter.push).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(alert.parentElement).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(trigger).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete My Account' }));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/'));
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(api.callsTo('/privacy/me')).toHaveLength(2);
  expect(trigger).toBeDisabled();
});

it('announces a pending export and leaves the action usable after completion', async () => {
  let release!: () => void;
  api.getExact('/api/privacy/me/export', async () => { await new Promise<void>(resolve => { release = resolve; }); return { user: { id: 'test-uid' } }; });
  render(<AccountPrivacySection />);
  await userEvent.click(screen.getByRole('button', { name: 'Export My Data' }));
  await waitFor(() => expect(api.callsTo('/privacy/me/export')).toHaveLength(1));
  try {
    expect(screen.getByRole('status')).toHaveTextContent('Exporting your data...');
    expect(screen.getByRole('button', { name: 'Export My Data' })).toBeDisabled();
  } finally { await act(async () => release()); }
  expect(downloadJson).toHaveBeenCalledWith('paralegix-my-data.json', { user: { id: 'test-uid' } });
});
