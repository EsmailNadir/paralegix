/**
 * The portal invoice summary prints money the client paid as a plain amount.
 * Red if the Paid row is shown as a negative again, or if the remaining balance
 * stops reflecting what the server reports.
 */
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@react-pdf/renderer', () => ({ __esModule: true, pdf: jest.fn(), StyleSheet: { create: (s: unknown) => s } }));
const mockUser = { uid: 'test-uid' };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a', invoiceId: 'invoice-a' }) }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
const mockFirms = [{ id: 'firm-a', name: 'Firm A' }];
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ lawFirms: mockFirms, associations: [], associationsLoading: false, activeAssociation: { clientRecordId: 'record-a' }, selectionRequired: false }) }));
import React from 'react';
import { screen, within } from '@testing-library/react';
import InvoicePage from '@/app/client/lawfirm/[lawFirmId]/billing/[invoiceId]/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';

const api = setupApiMock();

beforeEach(() => {
  api.getExact('/api/client-portal/lawfirm/firm-a/invoices/invoice-a?clientRecordId=record-a', { invoice: {
    id: 'invoice-a', invoiceName: 'INV-101', status: 'outstanding', totalAmount: 400, amountPaid: 125, totalWrittenOff: 50, remainingBalance: 225,
    invoiceDate: '2026-10-01', flatFees: [{ id: 'fee-a', name: 'Estate plan review', description: 'Estate plan review', amount: 400 }],
    payments: [{ id: 'payment-a', date: '2026-10-02', amount: 125, note: 'Initial payment', recordedByName: 'Firm A' }],
  } });
});

const rowAmount = (label: string) => within(screen.getByText(label).parentElement!).getByText(/\$/).textContent;

it('prints the Paid row as a plain amount, with credits still a deduction', async () => {
  renderWithProviders(<InvoicePage />);
  await screen.findByText('Remaining Balance');
  expect(rowAmount('Paid')).toBe('$125.00');
  expect(rowAmount('Adjustments')).toBe('-$50.00');
  expect(rowAmount('Remaining Balance')).toBe('$225.00');
});
