jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/hooks/useEntityLookup', () => ({
  useEntityLookup: () => ({ items: [], hasMore: false, loading: false }),
  useDuplicateNameCheck: () => ({ duplicate: null }),
}));

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AttachClientModal from '@/components/clientComp/AttachClientModal';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;
const attach = jest.fn();

beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
  attach.mockReset().mockResolvedValue(undefined);
  api.get('/clients/lookup', (call) => ({
    items: call.query.exactName?.[0] === 'Beta Holdings'
      ? [{ id: 'org-b', label: 'Beta Holdings' }]
      : [{ id: 'org-a', label: 'Acme Holdings' }],
    hasMore: false,
  }));
  api.post('/clients', { status: 201, body: { clientId: 'client-new' } });
  api.post('/clients/org-a/contacts', { id: 'link-a' });
  api.post('/clients/org-b/contacts', { id: 'link-b' });
});

afterEach(() => api.restore());

it('links to the current organization after an earlier suggestion is replaced', async () => {
  const user = userEvent.setup();
  renderWithProviders(<AttachClientModal open initialMode="create" onClose={jest.fn()} lawFirmId="firm-1"
    target={{ label: 'Task', attachedClientIds: [], attach, invalidateKeys: [] }} />);

  await user.type(screen.getByRole('textbox', { name: 'Name *' }), 'Dana Whitfield');
  const organization = screen.getByRole('combobox', { name: 'Organization' });
  await user.type(organization, 'acme');
  await user.click(await screen.findByRole('option', { name: 'Acme Holdings' }));
  await user.clear(organization);
  await user.type(organization, 'Beta Holdings');
  await user.click(screen.getByRole('button', { name: 'Create & Add' }));

  await waitFor(() => expect(attach).toHaveBeenCalledWith({ clientId: 'client-new', name: 'Dana Whitfield' }));
  expect(api.callsTo('/clients/org-b/contacts')).toHaveLength(1);
  expect(api.callsTo('/clients/org-a/contacts')).toHaveLength(0);
  expect(api.callsTo('/clients')[0].body).toEqual(expect.objectContaining({ organization: 'Beta Holdings' }));
});
