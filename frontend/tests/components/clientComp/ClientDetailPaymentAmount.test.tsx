/**
 * Recording a payment from the client Billing tab. Money is stored as whole
 * cents, so an amount with a third decimal place is refused under the amount
 * field and nothing is sent; a one-decimal amount goes out as typed.
 *
 * Red if handleRecordPayment goes back to parseFloat (the service is called with
 * 10.999 and no alert appears), or if the new parser refuses a real cents amount.
 */
const mockInvoice = {
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

const mockUpdateInvoicePayment = jest.fn();

jest.mock('@/services/billing.service', () =>
  require('../../support/mockServiceModule').mockServiceModule({
    listFirmInvoicesPage: async () => ({
      invoices: [mockInvoice],
      totalItems: 1,
      statusCounts: {},
      summary: { ownedCount: 1, totalBilled: 50, totalPaid: 0, totalOutstanding: 50 },
    }),
    listPlans: async () => [],
    updateInvoicePayment: (...args: unknown[]) => mockUpdateInvoicePayment(...args),
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

let api: ApiMock;
beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
  mockUpdateInvoicePayment.mockReset();
  mockUpdateInvoicePayment.mockResolvedValue(undefined);
});
afterEach(() => api.restore());

async function openPayDialog() {
  renderWithProviders(<ClientDetail lawFirmId="firm-1" clientId="client-1" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Billing/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Pay' }));
  return screen.findByRole('dialog', { name: 'Record Payment' });
}

async function typeAmount(dialog: HTMLElement, value: string) {
  const amount = within(dialog).getByPlaceholderText('0.00');
  await userEvent.clear(amount);
  await userEvent.type(amount, value);
}

it('refuses 10.999 under the amount field and sends nothing', async () => {
  const dialog = await openPayDialog();
  await typeAmount(dialog, '10.999');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Amounts can have at most two decimal places.',
  );
  expect(mockUpdateInvoicePayment).not.toHaveBeenCalled();

  // Editing the amount clears the message.
  await typeAmount(dialog, '10.99');
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
});

it('sends 10.5 as 10.5', async () => {
  const dialog = await openPayDialog();
  await typeAmount(dialog, '10.5');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

  await waitFor(() => expect(mockUpdateInvoicePayment).toHaveBeenCalledTimes(1));
  expect(mockUpdateInvoicePayment.mock.calls[0][2]).toMatchObject({ paymentAmount: 10.5 });
});
