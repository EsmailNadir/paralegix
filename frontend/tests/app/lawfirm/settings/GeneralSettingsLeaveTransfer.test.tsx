/**
 * Leaving the firm as its last owner, from the general settings page.
 *
 * The first leave is refused with LAST_ADMIN_TRANSFER_REQUIRED and opens the
 * transfer dialog. The transfer itself is the request that hands the firm to
 * someone else, so its outcome belongs in that dialog: a refusal is shown there,
 * beside the successor the user picked, rather than on the page banner behind a
 * dialog that has already closed.
 *
 * What has to break for this to go red: the page swallowing the transfer's
 * failure (so the dialog closes as if it worked) or routing it to the page error.
 */
const mockLeaveLawFirm = jest.fn();
const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-1/settings/general',
  useParams: () => ({ lawFirmId: 'firm-1' }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/services/lawfirm.service', () => {
  const fallbacks = new Map<PropertyKey, jest.Mock>();
  const service = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'leaveLawFirm') return (...args: unknown[]) => mockLeaveLawFirm(...args);
      if (!fallbacks.has(prop)) fallbacks.set(prop, jest.fn().mockResolvedValue({}));
      return fallbacks.get(prop);
    },
  });
  return { __esModule: true, default: service };
});

jest.mock('@/services/settings.service', () => ({
  __esModule: true,
  default: {
    getUserSettings: jest.fn().mockResolvedValue({ preferences: {} }),
    updateUserSettings: jest.fn().mockResolvedValue({}),
  },
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GeneralSettingsPage from '@/app/lawfirm/[lawFirmId]/settings/general/page';
import { renderWithProviders } from '../../../support/renderWithProviders';

function lastAdminRefusal() {
  return Object.assign(new Error('Transfer ownership before leaving'), {
    code: 'LAST_ADMIN_TRANSFER_REQUIRED',
    eligibleMembers: [{ userId: 'u-ben', name: 'Ben Ortiz' }],
  });
}

beforeEach(() => {
  mockLeaveLawFirm.mockReset();
  mockPush.mockReset();
});

async function openTransferDialog(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<GeneralSettingsPage />);
  await user.click(await screen.findByRole('button', { name: 'Leave Law Firm' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Leave Law Firm' }));
  const dialog = await screen.findByRole('dialog', { name: 'Transfer Ownership' });
  await user.click(within(dialog).getByRole('button', { name: /^New Admin/ }));
  await user.click(screen.getByRole('option', { name: 'Ben Ortiz' }));
  return dialog;
}

it('shows a refused transfer inside the transfer dialog, which stays open', async () => {
  const user = userEvent.setup();
  mockLeaveLawFirm
    .mockRejectedValueOnce(lastAdminRefusal())
    .mockRejectedValueOnce(new Error('Ben Ortiz cannot own this firm'));
  const dialog = await openTransferDialog(user);

  await user.click(within(dialog).getByRole('button', { name: 'Transfer & Leave' }));

  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Ben Ortiz cannot own this firm');
  expect(mockLeaveLawFirm).toHaveBeenLastCalledWith('firm-1', { newAdminUserId: 'u-ben' });
  expect(screen.getByRole('dialog', { name: 'Transfer Ownership' })).toBeInTheDocument();
  // Once, in the dialog, not again on the page behind it.
  expect(screen.getAllByText('Ben Ortiz cannot own this firm')).toHaveLength(1);
  expect(mockPush).not.toHaveBeenCalled();
});

it('leaves for the dashboard once the transfer succeeds', async () => {
  const user = userEvent.setup();
  mockLeaveLawFirm
    .mockRejectedValueOnce(lastAdminRefusal())
    .mockResolvedValueOnce({ message: 'Left law firm successfully' });
  const dialog = await openTransferDialog(user);

  await user.click(within(dialog).getByRole('button', { name: 'Transfer & Leave' }));

  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
});
