/**
 * The portal invoice's payments table says what processing fee the client
 * paid on top of a payment, so the amount they were charged adds up.
 * Red if a payment's fee is missing, or if a payment with no fee mentions one.
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
import { screen } from '@testing-library/react';
import InvoicePage from '@/app/client/lawfirm/[lawFirmId]/billing/[invoiceId]/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
import { scanAccessibility } from '../../support/accessibility';

const api = setupApiMock();

beforeEach(() => {
  api.getExact('/api/client-portal/lawfirm/firm-a/invoices/invoice-a?clientRecordId=record-a', { invoice: {
    id: 'invoice-a', invoiceName: 'INV-101', status: 'outstanding', totalAmount: 125_000, amountPaid: 100_000, totalWrittenOff: 0, remainingBalance: 25_000,
    invoiceDate: '2026-10-01', flatFees: [{ id: 'fee-a', name: 'Trial preparation', description: 'Trial preparation', amount: 125_000 }],
    payments: [
      { id: 'payment-a', date: '2026-10-02', amount: 100_000, paymentSource: 'stripe', surchargeCents: 494_000 },
      { id: 'payment-b', date: '2026-10-03', amount: 50, paymentSource: 'external', surchargeCents: 0 },
    ],
  } });
});

it('shows the processing fee under the payment it was paid on, and only there', async () => {
  const { container } = renderWithProviders(<InvoicePage />);

  expect(await screen.findByText('+ $4,940.00 processing fee paid by client')).toBeInTheDocument();
  expect(screen.getAllByText(/processing fee paid by client/)).toHaveLength(1);
  expect((await scanAccessibility(container)).violations).toEqual([]);
});
