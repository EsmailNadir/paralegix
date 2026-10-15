/**
 * Deleting a direct invoice from the client Billing tab closes its detail panel,
 * which stays mounted for its exit animation. The panel must fade out showing the
 * delete confirmation the user just answered; clearing that confirmation on close
 * swaps the red "Yes, Delete" box back to the plain "Delete" button mid-fade.
 *
 * What has to break for this to go red: `handleDeleteDirectInvoice` resetting
 * `confirmDelete` when it closes the panel.
 */

const mockDirectInvoice = {
  id: 'inv-direct-1',
  invoiceName: 'Retainer top-up',
  invoiceNumber: 'INV-7',
  invoiceDate: '2026-04-07',
  createdAt: '2026-04-07T00:00:00.000Z',
  contextType: 'client',
  entityId: 'client-1',
  clientId: 'client-1',
  billingRelation: 'owned',
  status: 'unpaid',
  isPaid: false,
  totalAmount: 50,
  amountPaid: 0,
  remainingBalance: 50,
  payments: [],
  timeEntries: [],
  flatFees: [],
  creditNotes: [],
};

const mockDeleteInvoice = jest.fn();

jest.mock('@/services/billing.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    listFirmInvoicesPage: async () => ({
      invoices: [mockDirectInvoice],
      totalItems: 1,
      statusCounts: {},
      summary: { ownedCount: 1, totalBilled: 50, totalPaid: 0, totalOutstanding: 50 },
    }),
    listPlans: async () => [],
    deleteInvoice: (...args: unknown[]) => mockDeleteInvoice(...args),
  }),
);

jest.mock('@/services/clients.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getClient: async () => ({
      id: 'client-1',
      name: 'Dana Client',
      email: 'dana@example.com',
      clientType: 'person',
    }),
    listClientCompanyRelationships: async () => [],
  }),
);

jest.mock('@/services/matters.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    getMattersPaged: async () => ({ matters: [], totalItems: 0 }),
  }),
);

import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

let api: ApiMock;

beforeEach(() => {
  // The page's incidental direct reads (Stripe status and the like) are not the
  // subject; keep them off the network.
  api = installApiMock();
  api.allowUnhandled();
  mockDeleteInvoice.mockReset();
  mockDeleteInvoice.mockResolvedValue(undefined);
});

afterEach(() => {
  api.restore();
});

describe('ClientDetail direct invoice delete', () => {
  it('keeps the delete confirmation on the invoice panel while it animates closed', async () => {
    renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));
    fireEvent.click(await screen.findByText('Retainer top-up'));

    const panel = await screen.findByRole('dialog', { name: 'Retainer top-up' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Yes, Delete' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, Delete' }));
    });

    expect(mockDeleteInvoice).toHaveBeenCalledWith(
      { type: 'client', lawFirmId: 'firm-1', entityId: 'client-1' },
      'inv-direct-1',
    );
    // Closed and fading, with the answered confirmation still on it.
    expect(panel).toHaveClass('overlay-card-exit');
    expect(
      screen.getByText('Are you sure you want to delete this invoice? This cannot be undone.'),
    ).toBeInTheDocument();
    // `ui/Modal` fades out with the content it had when it closed, which is the
    // confirmation mid-delete.
    expect(screen.getByRole('button', { name: 'Deleting...' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
