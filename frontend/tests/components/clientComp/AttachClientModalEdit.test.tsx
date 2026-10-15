/**
 * `AttachClientModal` editing an existing client, through the REAL clients
 * transport.
 *
 * Two promises the edit view used to make and not keep:
 *
 *   "NONE" CLEARS A STORED CONTACT PREFERENCE. The update route leaves an
 *   omitted field alone and clears a null one, so None has to go out as null.
 *
 *   THE CLIENT TYPE IS NOT EDITABLE. A client's type is fixed once it exists (a
 *   database trigger refuses the change, and an organization's people hang off
 *   it through company links). The edit view shows the type as text, so it
 *   cannot offer a change that the save would silently drop.
 */
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
import AttachClientModal, { type AttachClientTarget } from '@/components/clientComp/AttachClientModal';
import { useEntityLookup, useDuplicateNameCheck } from '@/hooks/useEntityLookup';

const ALICE_ROW = { id: 'client-1', label: 'Alice Smith', sublabel: 'alice@example.com', clientType: 'person' };
const ACME_ROW = { id: 'client-2', label: 'Acme Holdings', sublabel: '', clientType: 'company' };

let api: ApiMock;

function target(): AttachClientTarget {
  return { label: 'Matter', attachedClientIds: [], attach: jest.fn().mockResolvedValue(undefined), invalidateKeys: [] };
}

beforeEach(() => {
  api = installApiMock();
  (useEntityLookup as jest.Mock).mockReturnValue({ items: [ALICE_ROW, ACME_ROW], hasMore: false, loading: false });
  (useDuplicateNameCheck as jest.Mock).mockReturnValue({ duplicate: null });
  api.get('/clients/client-1', {
    client: {
      id: 'client-1',
      name: 'Alice Smith',
      email: 'alice@example.com',
      phone: '555-0100',
      preferredContactMethod: 'phone',
      clientType: 'person',
    },
  });
  api.get('/clients/client-2', {
    client: { id: 'client-2', name: 'Acme Holdings', clientType: 'company', preferredContactMethod: 'email' },
  });
  api.put('/clients/client-1', { message: 'Client updated successfully' });
});

afterEach(() => {
  api.restore();
});

async function openEdit(user: ReturnType<typeof userEvent.setup>, index: number) {
  renderWithProviders(<AttachClientModal open onClose={jest.fn()} lawFirmId="firm-1" target={target()} />);
  await user.click(screen.getAllByRole('button', { name: 'Edit Client' })[index]);
}

describe('the preferred contact method when editing an existing client', () => {
  // Red if: None is sent as an absent field, so the stored preference survives.
  it('sends null when the user chooses None over a stored preference', async () => {
    const user = userEvent.setup();
    await openEdit(user, 0);
    const trigger = await screen.findByRole('button', { name: /Preferred Contact Method/ });
    await waitFor(() => expect(trigger).toHaveTextContent('Phone'));

    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'None' }));
    await user.click(screen.getByRole('button', { name: 'Save & Add' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toHaveProperty('preferredContactMethod', null);
  });

  // Red if: the clear path also wipes a preference the user left alone.
  it('keeps sending a stored preference the user did not change', async () => {
    const user = userEvent.setup();
    await openEdit(user, 0);
    const trigger = await screen.findByRole('button', { name: /Preferred Contact Method/ });
    await waitFor(() => expect(trigger).toHaveTextContent('Phone'));

    await user.click(screen.getByRole('button', { name: 'Save & Add' }));

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    expect(api.calls('PUT')[0].body).toEqual(expect.objectContaining({ preferredContactMethod: 'phone' }));
  });
});

describe('the client type when editing an existing client', () => {
  // Red if: the edit view still offers a type picker whose choice is never saved.
  it('shows an organization client type as text, not a picker', async () => {
    const user = userEvent.setup();
    await openEdit(user, 1);

    await screen.findByRole('heading', { name: /Edit Client/ });
    await waitFor(() => expect(screen.getByText('Organization Name *')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Client Type/ })).not.toBeInTheDocument();
    expect(screen.getByText('Client Type')).toBeInTheDocument();
    expect(screen.getByText('Organization')).toBeInTheDocument();
  });

  // Red if: making the edit view read-only also took the picker away from create.
  it('keeps the type picker when creating a new client', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AttachClientModal open onClose={jest.fn()} lawFirmId="firm-1" target={target()} />);

    await user.click(screen.getByRole('button', { name: /Create New Client/ }));

    expect(screen.getByRole('button', { name: /Client Type/ })).toBeInTheDocument();
  });
});

describe('saving before the client detail has loaded', () => {
  // The list row carries only name, email and type. A save sent before the
  // detail read answers sends null for the phone, address and preference it
  // never saw, wiping them. Red if: Save & Add is enabled while the read is
  // still in flight.
  it('keeps Save & Add disabled until the detail answers', async () => {
    const detail = holdResponse();
    api.get('/clients/client-1', detail.handler);
    const user = userEvent.setup();
    await openEdit(user, 0);
    await detail.untilRequested();

    const save = screen.getByRole('button', { name: 'Save & Add' });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(api.calls('PUT')).toHaveLength(0);

    await act(async () => detail.release({
      client: { id: 'client-1', name: 'Alice Smith', phone: '555-0100', preferredContactMethod: 'phone', clientType: 'person' },
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & Add' })).toBeEnabled());
  });

  // Red if: a failed detail read falls back silently to the list row, so the
  // save goes out with blanks over the stored phone and preference.
  it('reports a failed detail read and refuses the save', async () => {
    api.get('/clients/client-1', { status: 500, body: { error: 'Database unavailable' } });
    const user = userEvent.setup();
    await openEdit(user, 0);

    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    const save = screen.getByRole('button', { name: 'Save & Add' });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(api.calls('PUT')).toHaveLength(0);
  });
});

describe('dismissing while the edit save is in flight', () => {
  // Red if: the dialog stays dismissible during the save, so Escape or the
  // header close abandons it and a later failure lands in a closed dialog.
  it('ignores Escape and disables the close button until the save settles', async () => {
    const put = holdResponse();
    api.put('/clients/client-1', put.handler);
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<AttachClientModal open onClose={onClose} lawFirmId="firm-1" target={target()} />);
    await user.click(screen.getAllByRole('button', { name: 'Edit Client' })[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & Add' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Save & Add' }));
    await put.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

    await act(async () => put.release({ message: 'Client updated successfully' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
