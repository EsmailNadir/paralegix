/**
 * The contact directory form, through the REAL contacts transport.
 *
 * A non-person contact is called an "Organization" everywhere else in the app,
 * and an email address is checked for shape before it is saved, the same as on
 * every client form. A malformed address would otherwise reach the directory
 * and fail later, when something tries to send to it.
 */
jest.unmock('@/services/contacts.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/contactHooks/useContactDuplicateCheck', () => ({
  useContactDuplicateCheck: () => ({ duplicates: [] }),
}));
jest.mock('@/components/clientComp/ClientOrganizationAutocomplete', () => ({
  __esModule: true,
  default: ({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) => (
    <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContactFormModal from '@/components/contactsComp/ContactFormModal';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.post('/contacts', { contact: { id: 'contact-1', name: 'Jane Roe', contactType: 'person' } });
});

afterEach(() => api.restore());

function renderForm(onSaved = jest.fn()) {
  renderWithProviders(<ContactFormModal open onClose={jest.fn()} onSaved={onSaved} lawFirmId="firm-1" />);
  return onSaved;
}

describe('the contact type', () => {
  // Red if: the non-person type is still labelled "Company".
  it('offers Organization and names the field for it', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: /^Type/ }));
    expect(screen.queryByRole('option', { name: 'Company' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Organization' }));

    expect(screen.getByLabelText('Organization name *')).toBeInTheDocument();
  });
});

describe('the email address', () => {
  // Red if: a malformed address is posted to the directory.
  it('refuses a malformed address without saving', async () => {
    const user = userEvent.setup();
    const onSaved = renderForm();

    await user.type(screen.getByLabelText('Name *'), 'Jane Roe');
    await user.type(screen.getByLabelText('Email'), 'jane.roe-at-example');
    await user.click(screen.getByRole('button', { name: 'Create Contact' }));

    expect(await screen.findByText('Please enter a valid email address')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  // Red if: the check also blocks a well-formed address.
  it('saves a well-formed address', async () => {
    const user = userEvent.setup();
    const onSaved = renderForm();

    await user.type(screen.getByLabelText('Name *'), 'Jane Roe');
    await user.type(screen.getByLabelText('Email'), 'jane@example.com');
    await user.click(screen.getByRole('button', { name: 'Create Contact' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual(expect.objectContaining({ email: 'jane@example.com' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('Escape while the save is in flight', () => {
  // Red if: the dialog stays dismissible during the save, so Escape abandons it
  // and a refused save reports its error into a closed dialog.
  it('does not close the dialog until the save settles', async () => {
    const post = holdResponse();
    api.post('/contacts', post.handler);
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(<ContactFormModal open onClose={onClose} onSaved={jest.fn()} lawFirmId="firm-1" />);

    await user.type(screen.getByLabelText('Name *'), 'Jane Roe');
    await user.click(screen.getByRole('button', { name: 'Create Contact' }));
    await post.untilRequested();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => post.release({ contact: { id: 'contact-1', name: 'Jane Roe', contactType: 'person' } }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
