/**
 * The client page's own edit form must be able to clear a preferred contact
 * method. "None" used to be omitted from the update, which the route reads as
 * "leave it alone", so the stored preference survived every save.
 *
 * The client service runs for real against a faked transport, so each case
 * proves the body of the PUT that left the page.
 */

jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: jest.fn(), isNavigating: false }),
}));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

const CLIENT_URL = '/lawfirms/firm-1/clients/client-1';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
  // The page also asks for conversations, relationships and lookups this spec
  // does not examine; those may go unanswered.
  api.allowUnhandled();
  __resetDuplicateRequestGuard();
  grantBaselineMember(['clients.manage']);
  api.get(CLIENT_URL, {
    client: {
      id: 'client-1', name: 'Dana Client', email: 'dana@example.com', clientType: 'person',
      status: 'active', preferredContactMethod: 'phone',
    },
  });
  api.get(`${CLIENT_URL}/summary`, { clientId: 'client-1', matters: null, billing: null });
  api.put(CLIENT_URL, { message: 'Client updated' });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

async function openEditForm(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  await screen.findByRole('heading', { name: /Dana Client/ });
  // The page header and the overview card each carry an Edit button that
  // opens the same form.
  await user.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
}

function putBody(): Record<string, unknown> {
  return api.calls('PUT')[0].body as Record<string, unknown>;
}

it('sends null when the user chooses None over a stored preference', async () => {
  const user = userEvent.setup();
  await openEditForm(user);

  await user.click(screen.getByRole('button', { name: /Preferred Contact/ }));
  await user.click(screen.getByRole('option', { name: 'None' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
  expect(putBody()).toHaveProperty('preferredContactMethod', null);
});

it('keeps sending a stored preference the user did not change', async () => {
  const user = userEvent.setup();
  await openEditForm(user);

  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
  expect(putBody()).toHaveProperty('preferredContactMethod', 'phone');
});
