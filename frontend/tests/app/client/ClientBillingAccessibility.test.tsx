jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@react-pdf/renderer', () => ({ __esModule: true, pdf: jest.fn(), StyleSheet: { create: (s: unknown) => s } }));
const mockUser = { uid: 'test-uid' };
const mockNavigate = jest.fn();
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ lawFirmId: 'firm-a' }), useSearchParams: () => new URLSearchParams() }));
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
jest.mock('@/contexts/ClientPortalContext', () => ({ useClientPortal: () => ({ associations: [], associationsLoading: false, activeAssociation: { clientRecordId: 'record-a' }, selectionRequired: false }) }));
import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Billing from '@/app/client/lawfirm/[lawFirmId]/billing/page';
import { renderWithProviders } from '../../support/renderWithProviders';
import { setupApiMock, sequence } from '../../support/apiMock';
const api = setupApiMock();
beforeEach(() => {
  api.get('/billing', { invoices: [
    { id: 'invoice-a', invoiceName: 'INV-101', status: 'outstanding', totalAmount: 400, amountPaid: 0, stripePaymentRequested: true,
      flatFees: [{ id: 'fee-a', name: 'Review the estate plan', description: 'Review the estate plan', amount: 400 }] },
    { id: 'invoice-b', invoiceName: 'INV-102', status: 'paid', totalAmount: 75, amountPaid: 75 },
  ], totalItems: 2, summary: { totalBilled: 475, totalPaid: 75, totalOutstanding: 400 }, statusCounts: { outstanding: 1, paid: 1 } });
});
it('exposes filter selection, keyboard invoice details, and named invoice destinations', async () => {
  const user = userEvent.setup();
  renderWithProviders(<Billing />);
  const all = await screen.findByRole('button', { name: 'All 2' });
  expect(all).toHaveAttribute('aria-pressed', 'true');
  const toggle = screen.getByRole('button', { name: 'Details for INV-101' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  toggle.focus();
  await user.keyboard('{Enter}');
  const panel = document.getElementById(toggle.getAttribute('aria-controls')!);
  expect(panel).toHaveTextContent('Review the estate plan');
  expect(panel).toHaveTextContent('$400.00');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard('{Enter}');
  expect(screen.queryByText('Review the estate plan')).not.toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'View invoice INV-101' });
  expect(link).toHaveAttribute('href', '/client/lawfirm/firm-a/billing/invoice-a');
  link.focus();
  await user.keyboard('{Enter}');
  expect(mockNavigate).toHaveBeenCalledWith('/client/lawfirm/firm-a/billing/invoice-a');
  expect(screen.getByRole('button', { name: 'Download PDF for INV-102' })).toBeEnabled();
});
it('focuses a checkout refusal and restores the matching invoice payment action on dismissal', async () => {
  api.getExact('/api/client-portal/lawfirm/firm-a/billing/pay/invoice-a/options?clientRecordId=record-a', { status: 403, body: { error: 'Payments unavailable' } });
  const user = userEvent.setup();
  renderWithProviders(<Billing />);
  const pay = await screen.findByRole('button', { name: 'Pay invoice INV-101' });
  pay.focus();
  await user.keyboard('{Enter}');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Payments unavailable');
  expect(alert.parentElement).toHaveFocus();
  await user.click(within(alert).getByRole('button', { name: 'Close' }));
  expect(pay).toHaveFocus();
  expect(api.callsTo('/billing/pay/invoice-a/options')).toHaveLength(1);
  expect(screen.getByText('INV-102')).toBeInTheDocument();
});

it('announces a failed statement read and retries without claiming the ledger is empty', async () => {
  api.getExact('/api/client-portal/lawfirm/firm-a/billing?clientRecordId=record-a', sequence(
    { status: 403, body: { error: 'Statement temporarily unavailable' } },
    { invoices: [{ id: 'statement-invoice', invoiceName: 'INV-HISTORY', invoiceDate: '2026-10-01', totalAmount: 125, amountPaid: 0, payments: [], creditNotes: [] }] },
  ));
  const user = userEvent.setup();
  renderWithProviders(<Billing />);
  await screen.findByText('INV-101');
  await user.click(screen.getByRole('button', { name: 'Statement' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Statement temporarily unavailable');
  expect(screen.queryByText('No transactions to display')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Invoices' }));
  await user.click(screen.getByRole('button', { name: 'Statement' }));
  expect(await screen.findByText(/INV-HISTORY/)).toBeInTheDocument();
  expect(screen.getByRole('table')).toHaveTextContent('$125.00');
});
