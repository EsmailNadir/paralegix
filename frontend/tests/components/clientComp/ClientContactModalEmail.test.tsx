/**
 * Email shape checking in the client contact form, through the REAL clients
 * transport.
 *
 * The form writes an email in two places: a new related contact on a person
 * client, and a new person added to an organization's roster (which creates a
 * client record). Every client form refuses a malformed address before it
 * saves, so this one must too, or the address lands on a record the firm later
 * invoices or emails.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/contactHooks/useContactDuplicateCheck', () => ({
  useContactDuplicateCheck: () => ({ duplicates: [] }),
}));
// The existing-record picker is not the subject; the typed-in path is.
jest.mock('@/components/ui/EntityPicker', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientContactModal from '@/components/clientComp/ClientContactModal';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.post('/clients/client-1/contacts', { message: 'Contact created', contactId: 'contact-1' });
});

afterEach(() => api.restore());

function renderForm(clientType: 'person' | 'company', onSaved = jest.fn()) {
  renderWithProviders(
    <ClientContactModal
      open
      onClose={jest.fn()}
      onSaved={onSaved}
      lawFirmId="firm-1"
      clientId="client-1"
      clientType={clientType}
      editing={null}
    />,
  );
  return onSaved;
}

describe.each([
  ['a person client', 'person' as const, 'Add Contact'],
  ['an organization client', 'company' as const, 'Add Client'],
])('adding a new contact to %s', (_label, clientType, submitLabel) => {
  // Red if: a malformed address is posted.
  it('refuses a malformed email without saving', async () => {
    const user = userEvent.setup();
    const onSaved = renderForm(clientType);

    await user.type(screen.getByLabelText('Name *'), 'Riley Park');
    await user.type(screen.getByLabelText('Email'), 'riley@nowhere');
    await user.click(screen.getByRole('button', { name: submitLabel }));

    expect(await screen.findByText('Please enter a valid email address')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  // Red if: the check also blocks a well-formed address.
  it('saves a well-formed email', async () => {
    const user = userEvent.setup();
    const onSaved = renderForm(clientType);

    await user.type(screen.getByLabelText('Name *'), 'Riley Park');
    await user.type(screen.getByLabelText('Email'), 'riley@example.com');
    await user.click(screen.getByRole('button', { name: submitLabel }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual(expect.objectContaining({ email: 'riley@example.com' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
