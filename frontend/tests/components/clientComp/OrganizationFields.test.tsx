jest.unmock('@/services/clients.service');
jest.unmock('@/services/leads.service');
jest.unmock('@/services/requestDeduplicator');

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContactFormModal from '@/components/contactsComp/ContactFormModal';
import LeadDetailModal from '@/components/leadComp/LeadDetailModal';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
  __resetDuplicateRequestGuard();
  api.get('/clients/lookup', { items: [{ id: 'org-1', label: 'Delgado Freight LLC' }], hasMore: false });
  api.get('/lead-stages', { stages: [] });
});
afterEach(() => api.restore());

it.each(['contact', 'lead'])('autocompletes an organization in the %s form', async (surface) => {
  const user = userEvent.setup();
  renderWithProviders(surface === 'contact'
    ? <ContactFormModal open onClose={jest.fn()} onSaved={jest.fn()} lawFirmId="firm-1" />
    : <LeadDetailModal open onClose={jest.fn()} lawFirmId="firm-1" lead={null} />);

  const organization = screen.getByRole('combobox', { name: 'Organization' });
  await user.type(organization, 'delgado');
  await user.click(await screen.findByRole('option', { name: 'Delgado Freight LLC' }));

  expect(organization).toHaveValue('Delgado Freight LLC');
  expect(api.callsTo('/clients/lookup')[0].query).toEqual(expect.objectContaining({ clientType: ['company'], search: ['delgado'] }));
});
