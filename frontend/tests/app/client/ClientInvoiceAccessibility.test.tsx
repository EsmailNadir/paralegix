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
import userEvent from '@testing-library/user-event';
import InvoicePage from '@/app/client/lawfirm/[lawFirmId]/billing/[invoiceId]/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock } from '../../support/apiMock';
const api = setupApiMock();
beforeEach(() => {
  api.getExact('/api/client-portal/lawfirm/firm-a/invoices/invoice-a?clientRecordId=record-a', { invoice: {
    id: 'invoice-a', invoiceName: 'INV-101', status: 'outstanding', totalAmount: 400, amountPaid: 125, remainingBalance: 275, stripePaymentRequested: true,
    invoiceDate: '2026-10-01', flatFees: [{ id: 'fee-a', name: 'Estate plan review', description: 'Estate plan review', amount: 400 }],
    payments: [{ id: 'payment-a', date: '2026-10-02', amount: 125, note: 'Initial payment', recordedByName: 'Firm A' }],
  } });
});
it('exposes the existing payments disclosure state and its dated amount table', async () => {
  const user = userEvent.setup();
  renderWithProviders(<InvoicePage />);
  const toggle = await screen.findByRole('button', { name: /Payments \(1\)/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = document.getElementById(toggle.getAttribute('aria-controls')!);
  expect(panel).toHaveTextContent('Initial payment');
  expect(panel).toHaveTextContent('$125.00');
  toggle.focus();
  await user.keyboard('{Enter}');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Initial payment')).not.toBeInTheDocument();
  await user.keyboard('{Enter}');
  expect(screen.getByText('Initial payment')).toBeInTheDocument();
  expect(toggle).toHaveFocus();
});
it('focuses a checkout refusal while keeping the loaded invoice and its existing payment control', async () => {
  api.getExact('/api/client-portal/lawfirm/firm-a/billing/pay/invoice-a/options?clientRecordId=record-a', { status: 403, body: { error: 'Payment temporarily unavailable' } });
  const user = userEvent.setup();
  renderWithProviders(<InvoicePage />);
  const pay = await screen.findByRole('button', { name: 'Pay Now' });
  expect(screen.getByText('Estate plan review')).toBeInTheDocument();
  pay.focus();
  await user.keyboard('{Enter}');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Payment temporarily unavailable');
  expect(alert).toHaveFocus();
  expect(screen.getByText('Estate plan review')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pay Now' })).toBeEnabled();
  expect(api.callsTo('/billing/pay/invoice-a/options')).toHaveLength(1);
});
