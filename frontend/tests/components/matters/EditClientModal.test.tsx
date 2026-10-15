/**
 * Editing a client from a matter, through the REAL matters transport.
 *
 * The profile update is a PUT onto the shared client record, where a field that
 * is left out is left alone and `null` clears it. A blank input therefore has to
 * go out as `null`: sending nothing leaves the old phone number on the record
 * while the form shows it cleared.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/useEntityLookup');
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="Organization" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';
import EditClientModal from '@/components/matterComp/EditClientModal';
import { useDuplicateNameCheck } from '@/hooks/useEntityLookup';
import type { MatterClient } from '@/types';

const client: MatterClient = {
  id: 'client-1',
  name: 'Alice Smith',
  email: 'alice@example.com',
  phone: '(555) 123-4567',
  organization: 'Acme Corp',
  address: '1 Main St',
  clientType: 'person',
  lawFirmId: 'firm-1',
  matterId: 'matter-1',
};

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  (useDuplicateNameCheck as jest.Mock).mockReturnValue({ duplicate: null });
  api.put('/clients/client-1', { message: 'Client updated' });
});

afterEach(() => {
  api.restore();
});

const renderModal = (overrides: Partial<MatterClient> = {}, onAfter = jest.fn()) =>
  renderWithProviders(
    <EditClientModal
      open
      onClose={jest.fn()}
      lawFirmId="firm-1"
      client={{ ...client, ...overrides }}
      onAfter={onAfter}
    />,
  );

describe('clearing a field when editing a client from a matter', () => {
  it('sends null for every optional field the user blanked', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(await screen.findByDisplayValue('alice@example.com'));
    await user.clear(screen.getByDisplayValue('(555) 123-4567'));
    await user.clear(screen.getByLabelText('Organization'));
    await user.clear(screen.getByDisplayValue('1 Main St'));
    await user.click(screen.getByRole('button', { name: 'Update Client' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toEqual(expect.objectContaining({
      name: 'Alice Smith',
      email: null,
      phone: null,
      organization: null,
      address: null,
    }));
  });

  it('keeps sending the text of a field the user left filled in', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(await screen.findByDisplayValue('(555) 123-4567'));
    await user.click(screen.getByRole('button', { name: 'Update Client' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toEqual(expect.objectContaining({
      name: 'Alice Smith',
      email: 'alice@example.com',
      phone: null,
      organization: 'Acme Corp',
      address: '1 Main St',
    }));
  });
});

describe('the preferred contact method when editing a client from a matter', () => {
  const pickContactMethod = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    await user.click(await screen.findByRole('button', { name: /Preferred Contact/ }));
    await user.click(screen.getByRole('option', { name: label }));
  };

  // Red if: "None" is sent as an absent field, which the route reads as "leave it alone".
  it('sends null when the user chooses None over a stored preference', async () => {
    const user = userEvent.setup();
    renderModal({ preferredContactMethod: 'phone' });

    await pickContactMethod(user, 'None');
    await user.click(screen.getByRole('button', { name: 'Update Client' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    const body = api.calls('PUT')[0].body as Record<string, unknown>;
    expect(body).toHaveProperty('preferredContactMethod', null);
  });

  // Red if: the clear path also wipes a preference the user left alone.
  it('keeps sending a stored preference the user did not change', async () => {
    const user = userEvent.setup();
    renderModal({ preferredContactMethod: 'phone' });

    await user.click(await screen.findByRole('button', { name: 'Update Client' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toEqual(expect.objectContaining({ preferredContactMethod: 'phone' }));
  });
});

describe('Escape while the update is in flight', () => {
  // Red if: the dialog stays dismissible during the update, so Escape abandons
  // it and a later invite failure renders into a closed dialog.
  it('does not close the dialog until the update settles', async () => {
    const put = holdResponse();
    api.put('/clients/client-1', put.handler);
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <EditClientModal open onClose={onClose} lawFirmId="firm-1" client={client} onAfter={jest.fn()} />,
    );

    await user.click(await screen.findByRole('button', { name: 'Update Client' }));
    await put.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => put.release({ message: 'Client updated' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
