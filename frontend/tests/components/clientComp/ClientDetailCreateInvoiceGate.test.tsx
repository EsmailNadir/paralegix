/**
 * The client Billing tab's "Create Invoice" button opens the invoice composer,
 * which needs `billing.manageInvoices`. A member who can read invoices but not
 * manage them sees the tab without the button.
 *
 * Red if the button stops being wrapped in `canManageInvoices`.
 */
jest.mock('@/services/billing.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    listFirmInvoicesPage: async () => ({
      invoices: [],
      totalItems: 0,
      statusCounts: {},
      summary: { ownedCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
    }),
    listPlans: async () => [],
  }),
);
jest.mock('@/services/clients.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getClient: async () => ({ id: 'client-1', name: 'Dana Client', email: 'dana@example.com', clientType: 'person' }),
    listClientCompanyRelationships: async () => [],
  }),
);
jest.mock('@/services/matters.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getMattersPaged: async () => ({ matters: [], totalItems: 0 }),
  }),
);

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';

let api: ApiMock;
beforeEach(() => { api = installApiMock(); api.allowUnhandled(); });
afterEach(() => { api.restore(); resetPermissions(); });

async function openBillingTab() {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));
  // The tab's own header proves the Billing tab rendered before any absence is asserted.
  await screen.findByRole('heading', { name: 'Billing Overview' });
}

it('offers Create Invoice to a member who can manage invoices', async () => {
  grantBaselineMember(['billing.viewInvoices', 'billing.manageInvoices']);
  await openBillingTab();
  expect(screen.getByRole('button', { name: 'Create Invoice' })).toBeInTheDocument();
});

it('hides Create Invoice from a member who can only read invoices', async () => {
  grantBaselineMember(['billing.viewInvoices']);
  await openBillingTab();
  expect(screen.queryByRole('button', { name: 'Create Invoice' })).not.toBeInTheDocument();
});
