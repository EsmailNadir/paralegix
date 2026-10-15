/**
 * The invoice dialog on the client Billing tab (opened by clicking an invoice
 * card).
 *
 * - Its Remaining tile reads the same balance as every other invoice surface
 *   (`getInvoiceRemainingBalance`). Red if it goes back to the server's raw
 *   `remainingBalance`, which is not zeroed for a voided invoice, so a cancelled
 *   invoice read as still owing its whole total here and $0.00 everywhere else.
 * - A failed delete says so and leaves the dialog open. Red if the error is only
 *   logged, which left the firm looking at an invoice it thought it had deleted.
 * - A billed time entry's rate prints as currency. Red if it goes back to a
 *   literal `$` beside the raw number ("$250.5").
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

async function openInvoiceDialog() {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));
  fireEvent.click(await screen.findByText('Retainer top-up'));
  return screen.findByRole('dialog', { name: 'Retainer top-up' });
}

function tileValue(dialog: HTMLElement, label: string) {
  return within(dialog).getByText(label).nextElementSibling;
}

describe('client Billing tab invoice dialog', () => {
  it('shows a voided invoice as owing nothing', async () => {
    mockInvoices.push(directInvoice({ status: 'voided' }));
    const dialog = await openInvoiceDialog();

    expect(tileValue(dialog, 'Remaining')).toHaveTextContent('$0.00');
  });

  it('shows an open invoice balance from its total, payments and write-offs', async () => {
    mockInvoices.push(directInvoice({ amountPaid: 120.1, totalWrittenOff: 30, remainingBalance: 349.9 }));
    const dialog = await openInvoiceDialog();

    expect(tileValue(dialog, 'Remaining')).toHaveTextContent('$349.90');
  });

  it('prints a billed time entry rate as currency', async () => {
    mockInvoices.push(directInvoice({
      timeEntries: [{ id: 'te-1', name: 'Hearing prep', hours: 2, rate: 250.5, amount: 501 }],
    }));
    const dialog = await openInvoiceDialog();

    expect(within(dialog).getByText(/× \$250\.50/)).toBeInTheDocument();
  });

  it('reports a failed delete and stays open', async () => {
    mockInvoices.push(directInvoice());
    mockDeleteInvoice.mockRejectedValue(new Error('Invoice has payments recorded'));
    const dialog = await openInvoiceDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, Delete' }));

    await waitFor(() => expect(mockDeleteInvoice).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText('Invoice has payments recorded')).toBeInTheDocument();
    expect(dialog).not.toHaveClass('overlay-card-exit');
  });
});
