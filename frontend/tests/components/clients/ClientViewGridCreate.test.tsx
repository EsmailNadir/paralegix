/**
 * Creating a client from the clients list, through the REAL clients transport.
 *
 *   "NONE" IS STORED AS NO PREFERENCE. The form's None option has to go out as
 *   null; leaving the field out takes the server's 'email' default, so a firm
 *   that chose None found the client marked as preferring email.
 */
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/useEntityLookup', () => ({
  useDuplicateNameCheck: () => ({ duplicate: null }),
  useEntityLookup: () => ({ items: [], hasMore: false, loading: false }),
}));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import ClientViewGrid from '@/components/clientComp/ClientViewGrid';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  api.get('/lawfirms/firm-1/clients', { clients: [], totalItems: 0 });
  api.post('/lawfirms/firm-1/clients', { status: 201, body: { message: 'ok', clientId: 'client-new' } });
});

afterEach(() => {
  api.restore();
});

async function addPerson(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /New Client/ }));
  await user.type(screen.getByPlaceholderText('Full name'), 'Dana Whitfield');
  await user.click(screen.getByRole('button', { name: 'Add Client' }));
}

const creates = () => api.calls('POST').filter((c) => c.pathname.endsWith('/lawfirms/firm-1/clients'));

describe('the preferred contact method of a new client', () => {
  it('sends null when None is left chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClientViewGrid lawFirmId="firm-1" />);

    await addPerson(user);

    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(creates()[0].body).toHaveProperty('preferredContactMethod', null);
  });
});
