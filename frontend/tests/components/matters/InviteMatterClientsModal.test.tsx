/**
 * `InviteMatterClientsModal`'s "Add email" path, which hands the client to
 * `EditClientModal` to add an address and send the invite in one save.
 *
 * When that invite is refused, `EditClientModal` stays open and says so. The
 * caller's `onAfter` (a refresh) must not close it underneath that message, or
 * the firm is left believing the invite went out.
 */
const mockListClients = jest.fn();
const mockUpdateClientProfile = jest.fn();
const mockInvite = jest.fn();
jest.mock('@/services/matters.service', () => ({
  __esModule: true,
  default: {
    listClients: (...args: unknown[]) => mockListClients(...args),
    updateClientProfile: (...args: unknown[]) => mockUpdateClientProfile(...args),
  },
}));
jest.mock('@/services/clients.service', () => ({
  __esModule: true,
  default: { inviteClientToLawFirm: (...args: unknown[]) => mockInvite(...args) },
}));
jest.mock('@/hooks/useEntityLookup', () => ({
  useDuplicateNameCheck: () => ({ duplicate: null }),
}));
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../support/renderWithProviders';
import InviteMatterClientsModal from '@/components/matterComp/InviteMatterClientsModal';

beforeEach(() => {
  mockListClients.mockReset().mockResolvedValue([
    { id: 'client-1', name: 'Alice Smith', clientType: 'person', lawFirmId: 'firm-1', matterId: 'matter-1' },
  ]);
  mockUpdateClientProfile.mockReset().mockResolvedValue({ message: 'ok' });
  mockInvite.mockReset().mockRejectedValue(new Error('The email provider is unavailable'));
});

// Red if: the refresh callback also clears the client being edited, which
// closes the edit dialog before its invite-failure message can be read.
it('leaves the refused-invite message on screen after adding an email', async () => {
  const user = userEvent.setup();
  renderWithProviders(<InviteMatterClientsModal open onClose={jest.fn()} lawFirmId="firm-1" matterId="matter-1" />);

  await user.click(await screen.findByRole('button', { name: 'Add email' }));
  await user.type(screen.getByPlaceholderText('email@example.com'), 'alice@example.com');
  await user.click(screen.getByRole('checkbox', { name: /Invite to client portal/ }));
  await user.click(screen.getByRole('button', { name: 'Update Client' }));

  expect(await screen.findByText(/invite email could not be sent/i)).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Edit Client' })).toBeInTheDocument();
});
