/**
 * `EditClientModal` beyond the profile write: the portal invite it can send,
 * and how it names an organization client.
 *
 *   A FAILED INVITE IS REPORTED. The profile is saved first and the invite sent
 *   after; when the invite is refused the firm must be told, with the reason,
 *   rather than the dialog closing as though the email went out.
 *
 *   A NON-PERSON CLIENT IS AN "ORGANIZATION" in every label, as it is in the
 *   other client forms.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/useEntityLookup', () => ({
  useDuplicateNameCheck: () => ({ duplicate: null }),
}));
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import EditClientModal from '@/components/matterComp/EditClientModal';
import type { MatterClient } from '@/types';

const person: MatterClient = {
  id: 'client-1',
  name: 'Alice Smith',
  email: 'alice@example.com',
  clientType: 'person',
  lawFirmId: 'firm-1',
  matterId: 'matter-1',
};

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('a portal invite that is refused after the profile saved', () => {
  // Red if: the invite error is swallowed and the dialog closes.
  it('keeps the dialog open and says the invite was not sent, with the reason', async () => {
    const user = userEvent.setup();
    api.put('/clients/client-1', { message: 'Client updated' });
    api.post('/send-client-invite', { status: 502, body: { error: 'The email provider is unavailable' } });
    const onClose = jest.fn();
    const onAfter = jest.fn();
    renderWithProviders(<EditClientModal open onClose={onClose} lawFirmId="firm-1" client={person} onAfter={onAfter} />);

    await user.click(await screen.findByRole('checkbox', { name: /Invite to client portal/ }));
    await user.click(screen.getByRole('button', { name: 'Update Client' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invite email could not be sent/i);
    expect(alert).toHaveTextContent('The email provider is unavailable');
    expect(api.calls('PUT')).toHaveLength(1);
    // The profile did save, so the page behind is refreshed; the dialog stays.
    await waitFor(() => expect(onAfter).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes as before when the invite is sent', async () => {
    const user = userEvent.setup();
    api.put('/clients/client-1', { message: 'Client updated' });
    api.post('/send-client-invite', { message: 'Invite sent' });
    const onClose = jest.fn();
    renderWithProviders(<EditClientModal open onClose={onClose} lawFirmId="firm-1" client={person} />);

    await user.click(await screen.findByRole('checkbox', { name: /Invite to client portal/ }));
    await user.click(screen.getByRole('button', { name: 'Update Client' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.callsTo('/send-client-invite')).toHaveLength(1);
  });
});

describe('an organization client', () => {
  // Red if: the dialog calls it a "Company".
  it('is labelled an Organization', () => {
    renderWithProviders(
      <EditClientModal open onClose={jest.fn()} lawFirmId="firm-1" client={{ ...person, name: 'Acme LLC', clientType: 'company' }} />,
    );

    expect(screen.getByLabelText('Organization Name *')).toHaveValue('Acme LLC');
    expect(screen.queryByText(/compan(y|ies)/i)).not.toBeInTheDocument();
  });
});
