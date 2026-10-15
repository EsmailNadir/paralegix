/**
 * Editing a person client's related contact, through the REAL clients
 * transport.
 *
 * The link's own fields (relationship, primary) need `clients.manage`. The
 * contact's identity (name, email, phone, title, notes) is the shared directory
 * record, and the server asks for `contacts.manage` whenever any of those keys
 * is in the body. So the save must send only the identity fields that changed:
 * resending them all made a role with `clients.manage` but not
 * `contacts.manage` get a 403 for ticking Primary.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/contactHooks/useContactDuplicateCheck', () => ({
  useContactDuplicateCheck: () => ({ duplicates: [] }),
}));
jest.mock('@/components/ui/EntityPicker', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientContactModal from '@/components/clientComp/ClientContactModal';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import type { ClientContact } from '@/types';

const LINK_URL = '/lawfirms/firm-1/clients/client-1/contacts/link-1';
const GUARDIAN = {
  id: 'link-1',
  contactId: 'contact-1',
  name: 'Gina Guardian',
  email: 'gina@example.test',
  phone: '555-0100',
  title: 'Guardian',
  notes: 'Prefers mornings',
  relationship: 'Guardian',
  isPrimary: false,
} as unknown as ClientContact;

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.put(LINK_URL, { message: 'ok' });
});

afterEach(() => api.restore());

function renderEditor(onClose = jest.fn()) {
  renderWithProviders(
    <ClientContactModal
      open
      onClose={onClose}
      onSaved={jest.fn()}
      lawFirmId="firm-1"
      clientId="client-1"
      clientType="person"
      editing={GUARDIAN}
    />,
  );
  return onClose;
}

function checkboxFor(label: string): HTMLElement {
  const checkbox = screen.getByText(label).closest('label')?.querySelector('input');
  if (!checkbox) throw new Error(`No checkbox for ${label}`);
  return checkbox;
}

const putBody = () => {
  const calls = api.calls('PUT');
  expect(calls).toHaveLength(1);
  return calls[0].body as Record<string, unknown>;
};

// Red if: the identity fields are resent unchanged, which needs contacts.manage.
it('sends only the link fields when only Primary is changed', async () => {
  const user = userEvent.setup();
  const onClose = renderEditor();

  await user.click(checkboxFor('Primary contact'));
  await user.click(screen.getByRole('button', { name: 'Save Changes' }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(putBody()).toEqual({ relationship: 'Guardian', isPrimary: true });
});

it('sends an identity field the user changed', async () => {
  const user = userEvent.setup();
  const onClose = renderEditor();

  const phone = screen.getByPlaceholderText('Phone');
  await user.clear(phone);
  await user.type(phone, '555-0199');
  await user.click(screen.getByRole('button', { name: 'Save Changes' }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(putBody()).toEqual({ phone: '555-0199', relationship: 'Guardian', isPrimary: false });
});

it('sends null for an identity field the user emptied', async () => {
  const user = userEvent.setup();
  const onClose = renderEditor();

  await user.clear(screen.getByPlaceholderText('Email'));
  await user.click(screen.getByRole('button', { name: 'Save Changes' }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(putBody()).toEqual({ email: null, relationship: 'Guardian', isPrimary: false });
});
