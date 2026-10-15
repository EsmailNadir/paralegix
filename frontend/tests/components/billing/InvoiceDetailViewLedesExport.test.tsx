/**
 * The invoice-level actions on the invoice detail view: adding an amount,
 * adding a credit note, recording a payment (with its overpayment and trust
 * guards), deleting a payment and deleting the invoice.
 *
 * Driven through the REAL billing, clients and trust services against a faked
 * transport, so each test pins the exact request the action sends (url and
 * body) and what the page shows when the server refuses it.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@react-pdf/renderer', () => ({
  pdf: jest.fn(),
  Document: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  Page: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
  View: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  StyleSheet: { create: (s: unknown) => s },
  Image: (props: Record<string, unknown>) => React.createElement('img', props),
}));

jest.mock('@/hooks/useUsers', () => ({
  __esModule: true,
  useLawFirmUsers: () => ({ users: [], loading: false }),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import InvoiceDetailView from '@/components/billingComp/InvoiceDetailView';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { resetPermissions } from '../../support/permissions';
import type { Invoice } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const BILLING = `${API}/lawfirms/${FIRM}/billing`;
const INVOICE_URL = `${BILLING}/invoices/client/${CLIENT}/${INVOICE}`;
const LIST_URL = `${BILLING}/invoices/client/${CLIENT}`;

let api: ApiMock;

const invoice = {
  id: INVOICE,
  invoiceName: 'April Services',
  invoiceNumber: 'INV-2001',
  invoiceDate: '2026-04-01',
  dueDate: null,
  clientId: CLIENT,
  status: 'unpaid',
  isPaid: false,
  totalAmount: 400,
  totalHours: 2,
  flatFeesAmount: 0,
  amountPaid: 0,
  totalWrittenOff: 0,
  remainingBalance: 400,
  payments: [],
  creditNotes: [],
  timeEntries: [{ id: 'te-1', description: 'Contract review', hours: 2, rate: 200, amount: 400 }],
  flatFees: [],
  expenses: [],
  auditLog: [],
  stripePaymentRequested: false,
  createdAt: '2026-04-01T00:00:00.000Z',
} as unknown as Invoice;

beforeEach(() => {
  api = installApiMock();
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${FIRM}/status`, { connected: true, chargesEnabled: true });
  api.get(`/clients/${CLIENT}`, { client: { id: CLIENT, name: 'Acme Co', email: 'ap@acme.test' } });
  api.get('/clients/lookup', { items: [], hasMore: false });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/clients/${CLIENT}/balance`, { clientId: CLIENT, totalBalanceCents: 0, accountBalances: [] });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/accounts`, { accounts: [] });
  api.getExact(LIST_URL, { invoices: [invoice] });
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('Download LEDES', () => {
  // Red if: a refused export returns quietly, so the firm clicks Download and
  // nothing happens, with no hint that the file was never produced.
  it('reports a refused export instead of doing nothing', async () => {
    api.getExact(`${INVOICE_URL}/export/ledes`, { status: 403, body: { error: 'You are not on this matter' } });
    renderWithProviders(
      <InvoiceDetailView lawFirmId={FIRM} entityId={CLIENT} invoiceId={INVOICE} contextType="client" backHref="/back" backLabel="Back" />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Download LEDES' }));

    expect(await screen.findByText('You are not on this matter')).toBeInTheDocument();
    expect(api.callsTo(`/${INVOICE}/export/ledes`)).toHaveLength(1);
  });
});
