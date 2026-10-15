/**
 * The refund-due banner on the invoice detail view: shown to members who
 * manage invoices when money is owed back to the payer, worded by why, with the
 * amount formatted as currency.
 *
 * Red if the banner is dropped, shown without a refund, shown to a member who
 * cannot manage invoices, the reason wording is swapped, the amount is
 * mis-formatted, or a voided invoice with a refund gains a payment action.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/trust.service');
jest.unmock('@/services/matters.service');
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

import React from 'react';
import { screen } from '@testing-library/react';

import InvoiceDetailView from '@/components/billingComp/InvoiceDetailView';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import type { Invoice } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const MATTER = 'matter-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const BILLING = `${API}/lawfirms/${FIRM}/billing`;
const CLIENT_LIST = `${BILLING}/invoices/client/${CLIENT}`;

let api: ApiMock;

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
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
    ...overrides,
  } as Invoice;
}

function seedIncidental() {
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${FIRM}/status`, { connected: true, chargesEnabled: true });
  api.get(`/clients/${CLIENT}`, { client: { id: CLIENT, name: 'Acme Co', email: 'ap@acme.test' } });
  api.get('/clients/lookup', { items: [], hasMore: false });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/clients/${CLIENT}/balance`, {
    clientId: CLIENT, totalBalanceCents: 0, accountBalances: [],
  });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/accounts`, { accounts: [] });
}

function renderView(contextType: 'client' | 'matter' = 'client') {
  return renderWithProviders(
    <InvoiceDetailView
      lawFirmId={FIRM}
      entityId={contextType === 'client' ? CLIENT : MATTER}
      invoiceId={INVOICE}
      contextType={contextType}
      backHref={`/lawfirm/${FIRM}/clients/${CLIENT}`}
      backLabel="Back to Billing"
    />,
  );
}



beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});


const VOIDED_COPY = 'Refund due: $125.50 was paid after this invoice was voided. Refund it from your payment processor.';
const OVERPAID_COPY = 'Overpaid by $75.00. Refund the difference or apply it to another invoice.';

describe('the refund-due banner', () => {
  it('says money arrived after the invoice was voided', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice({
      status: 'voided', amountPaid: 125.5, remainingBalance: 0,
      payments: [{ amount: 125.5, date: '2026-04-03', paymentMethod: 'stripe' }],
      refundDue: { amount: 125.5, reason: 'voided' },
    } as Partial<Invoice>)] });
    renderView();
    expect(await screen.findByText(VOIDED_COPY)).toBeInTheDocument();
  });

  it('says the invoice was overpaid and by how much', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice({
      status: 'paid', isPaid: true, amountPaid: 475, remainingBalance: 0,
      payments: [{ amount: 475, date: '2026-04-03', paymentMethod: 'manual' }],
      refundDue: { amount: 75, reason: 'overpaid' },
    } as Partial<Invoice>)] });
    renderView();
    expect(await screen.findByText(OVERPAID_COPY)).toBeInTheDocument();
  });

  it('is absent when no refund is due', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice({ refundDue: null } as Partial<Invoice>)] });
    renderView();
    expect(await screen.findByText('April Services')).toBeInTheDocument();
    expect(screen.queryByText(/Refund due:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Overpaid by/)).not.toBeInTheDocument();
  });

  it('is hidden from a member without billing.manageInvoices', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice({
      status: 'voided', amountPaid: 125.5, remainingBalance: 0,
      refundDue: { amount: 125.5, reason: 'voided' },
    } as Partial<Invoice>)] });
    renderView();
    expect(await screen.findByText('April Services')).toBeInTheDocument();
    expect(screen.queryByText(VOIDED_COPY)).not.toBeInTheDocument();
  });

  it('leaves a voided invoice with a refund showing its Voided badge, its payment and no Record Payment action', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice({
      status: 'voided', amountPaid: 125.5, remainingBalance: 0,
      payments: [{ amount: 125.5, date: '2026-04-03', paymentMethod: 'stripe' }],
      refundDue: { amount: 125.5, reason: 'voided' },
    } as Partial<Invoice>)] });
    renderView();
    expect(await screen.findByText(VOIDED_COPY)).toBeInTheDocument();
    expect(screen.getAllByText('Voided').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$125.50').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
  });
});
