/**
 * Payment and delete actions on the client Billing tab's invoice cards.
 *
 * - A voided invoice offers no way to take a payment. Red if the card's Pay
 *   button or the invoice dialog's Record Payment button goes back to checking
 *   only `isPaid`: the firm cancelled the bill, but `isPaid` stays false, so the
 *   tab invited a payment no other invoice surface offers.
 * - A failed delete from the card menu says so. Red if the error is only logged:
 *   the confirm dialog closes on click, so the firm was left looking at an
 *   invoice it believed it had deleted, with no word of why it was still there.
 */
const mockInvoices: Record<string, unknown>[] = [];
const mockDeleteInvoice = jest.fn();

jest.mock('@/services/billing.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    listFirmInvoicesPage: async () => ({
      invoices: mockInvoices,
      totalItems: mockInvoices.length,
      statusCounts: {},
      summary: { ownedCount: mockInvoices.length, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
    }),
    listPlans: async () => [],
    deleteInvoice: (...args: unknown[]) => mockDeleteInvoice(...args),
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
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ClientDetail from '@/components/clientComp/ClientDetail';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

function directInvoice(overrides: Record<string, unknown> = {}) {
  return {
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
    totalAmount: 500,
    amountPaid: 0,
    remainingBalance: 500,
    payments: [],
    timeEntries: [],
    flatFees: [],
    creditNotes: [],
    ...overrides,
  };
}

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
  mockInvoices.length = 0;
  mockDeleteInvoice.mockReset();
});
afterEach(() => api.restore());

async function openBillingTab() {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));
  return screen.findByText('Retainer top-up');
}

async function openInvoiceDialog() {
  fireEvent.click(await openBillingTab());
  return screen.findByRole('dialog', { name: 'Retainer top-up' });
}

describe('payment actions', () => {
  it('offers Pay on an open invoice card and Record Payment in its dialog', async () => {
    mockInvoices.push(directInvoice());
    const card = await openBillingTab();
    expect(screen.getByRole('button', { name: 'Pay' })).toBeInTheDocument();

    fireEvent.click(card);
    const dialog = await screen.findByRole('dialog', { name: 'Retainer top-up' });
    expect(within(dialog).getByRole('button', { name: 'Record Payment' })).toBeInTheDocument();
  });

  it('offers no Pay on a voided invoice card', async () => {
    // Still reads as owing its whole total: only the status says it was cancelled.
    mockInvoices.push(directInvoice({ status: 'voided' }));
    await openBillingTab();

    expect(screen.queryByRole('button', { name: 'Pay' })).not.toBeInTheDocument();
  });

  it('offers no Record Payment in a voided invoice dialog', async () => {
    mockInvoices.push(directInvoice({ status: 'voided' }));
    const dialog = await openInvoiceDialog();

    // The dialog rendered its footer, so the absence below is not a render race.
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
  });
});

describe('deleting from the card menu', () => {
  it('tells the firm when the delete is refused', async () => {
    mockInvoices.push(directInvoice());
    mockDeleteInvoice.mockRejectedValue(new Error('Invoice has payments recorded'));
    await openBillingTab();

    await userEvent.click(screen.getByRole('button', { name: 'Invoice actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete invoice' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockDeleteInvoice).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Invoice has payments recorded')).toBeInTheDocument();
  });
});
