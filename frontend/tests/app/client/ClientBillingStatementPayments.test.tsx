/**
 * The portal Statement of Account lists a payment in its own Payments column
 * as a plain amount. Red if the payment is printed as a negative again.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@react-pdf/renderer', () => ({ __esModule: true, pdf: jest.fn(), StyleSheet: { create: (s: unknown) => s } }));
jest.mock('next/navigation', () => ({
  useParams: () => ({ lawFirmId: 'firm-1' }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/client/lawfirm/firm-1/billing',
}));
jest.mock('@/contexts/ClientPortalContext', () => ({
  __esModule: true,
  useClientPortal: () => ({
    associations: [],
    associationsLoading: false,
    activeAssociation: { clientRecordId: 'record-1' },
    selectionRequired: false,
    setActiveClientRecordId: jest.fn(),
  }),
}));

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import ClientBillingPage from '@/app/client/lawfirm/[lawFirmId]/billing/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';

let api: ApiMock;

const invoice = {
  id: 'inv-1', invoiceName: 'Estate Plan', invoiceNumber: 'INV-1', status: 'partially_paid',
  totalAmount: 400, amountPaid: 125, remainingBalance: 275, invoiceDate: '2026-10-01', dueDate: '2026-10-31',
  payments: [{ id: 'pmt-1', date: '2026-10-02', amount: 125 }],
};

beforeEach(() => {
  api = installApiMock();
  api.allowUnhandled();
  api.get('/billing', {
    invoices: [invoice],
    totalItems: 1,
    summary: { totalBilled: 400, totalPaid: 125, totalOutstanding: 275 },
    statusCounts: { partially_paid: 1 },
  });
});

afterEach(() => api.restore());

it('shows a payment in the Payments column with no minus sign', async () => {
  renderWithProviders(<ClientBillingPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^Statement/ }));

  const row = (await screen.findByText('Payment for "Estate Plan"')).closest('tr')!;
  const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);
  // Date, Description, Charges, Payments, Balance.
  expect(cells[2]).toBe('-');
  expect(cells[3]).toBe('$125.00');
  expect(cells[4]).toBe('$275.00');
});
