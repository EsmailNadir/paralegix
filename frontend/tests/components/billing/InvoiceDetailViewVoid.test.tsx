/**
 * "Void Invoice" on the invoice detail view: a More menu action for members
 * who manage invoices, offered only while the invoice is open and has no
 * payments, confirmed in a dialog, sent once to the void route of the
 * invoice's own context (matter or client).
 *
 * Red if the menu item loses its permission, voided, paid or payments guard,
 * the confirmation copy changes, the request goes to the wrong context, a
 * double click sends twice, or a refusal is not shown.
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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import InvoiceDetailView from '@/components/billingComp/InvoiceDetailView';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
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
const MATTER_LIST = `${BILLING}/invoices/matter/${MATTER}`;

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

async function openMoreMenu() {
  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
}

async function openVoidConfirm() {
  await openMoreMenu();
  await userEvent.click(await screen.findByRole('button', { name: 'Void Invoice' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('when Void Invoice is offered', () => {
  it('is in the More menu of an open invoice with no payments', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice()] });
    renderView();
    await openMoreMenu();
    expect(await screen.findByRole('button', { name: 'Void Invoice' })).toBeInTheDocument();
  });

  it('is hidden from a member without billing.manageInvoices', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice()] });
    renderView();
    await openMoreMenu();
    expect(await screen.findByRole('button', { name: 'Download Invoice PDF' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void Invoice' })).not.toBeInTheDocument();
  });

  it('is hidden once the invoice is voided', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice({ status: 'voided' })] });
    renderView();
    await openMoreMenu();
    expect(await screen.findByRole('button', { name: 'Delete Invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void Invoice' })).not.toBeInTheDocument();
  });

  it('is hidden on a paid invoice', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, {
      invoices: [invoice({ status: 'paid', isPaid: true, amountPaid: 400, remainingBalance: 0 })],
    });
    renderView();
    await openMoreMenu();
    expect(await screen.findByRole('button', { name: 'Delete Invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void Invoice' })).not.toBeInTheDocument();
  });

  it('is hidden while payments are recorded, even on a part-paid invoice', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, {
      invoices: [invoice({
        status: 'partial',
        amountPaid: 100,
        remainingBalance: 300,
        payments: [{ amount: 100, date: '2026-04-03', paymentMethod: 'manual' }],
      } as Partial<Invoice>)],
    });
    renderView();
    await openMoreMenu();
    expect(await screen.findByRole('button', { name: 'Delete Invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void Invoice' })).not.toBeInTheDocument();
  });
});

describe('confirming the void', () => {
  it('states what voiding does before anything is sent', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice()] });
    renderView();
    const confirm = await openVoidConfirm();
    expect(within(confirm).getByText(
      'This cancels the invoice and its payment link stops working. Its time entries, flat fees and expenses become billable again. This cannot be undone.',
    )).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('voids a client invoice once through the client route, reloads it and confirms', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, sequence(
      { invoices: [invoice()] },
      { invoices: [invoice({ status: 'voided' })] },
    ));
    api.postExact(`${BILLING}/invoices/client/${CLIENT}/${INVOICE}/void`, {
      message: 'Invoice voided successfully', invoice: invoice({ status: 'voided' }),
    });
    renderView();
    const confirm = await openVoidConfirm();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Void invoice' }));

    expect(await screen.findByText('Invoice voided')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(1);
    expect(api.calls('POST')[0].url).toContain(`/invoices/client/${CLIENT}/${INVOICE}/void`);
    await openMoreMenu();
    expect(screen.queryByRole('button', { name: 'Void Invoice' })).not.toBeInTheDocument();
  });

  it('voids a matter invoice once through the matter route', async () => {
    seedIncidental();
    api.getExact(MATTER_LIST, { invoices: [invoice({ clientId: CLIENT })] });
    api.get(`/matters/${MATTER}/clients`, { clients: [] });
    api.postExact(`${BILLING}/invoices/matter/${MATTER}/${INVOICE}/void`, {
      message: 'Invoice voided successfully', invoice: invoice({ status: 'voided' }),
    });
    renderView('matter');
    const confirm = await openVoidConfirm();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Void invoice' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].url).toContain(`/invoices/matter/${MATTER}/${INVOICE}/void`);
  });

  it('sends nothing when the dialog is cancelled', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice()] });
    renderView();
    const confirm = await openVoidConfirm();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('sends one request when the confirm button is clicked twice', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice()] });
    api.postExact(`${BILLING}/invoices/client/${CLIENT}/${INVOICE}/void`, {
      message: 'Invoice voided successfully', invoice: invoice({ status: 'voided' }),
    });
    renderView();
    const confirm = await openVoidConfirm();
    const button = within(confirm).getByRole('button', { name: 'Void invoice' });
    await userEvent.dblClick(button);
    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')).toHaveLength(1);
  });

  it('shows the backend refusal and leaves the invoice as it was on a 409', async () => {
    seedIncidental();
    api.getExact(CLIENT_LIST, { invoices: [invoice()] });
    api.postExact(`${BILLING}/invoices/client/${CLIENT}/${INVOICE}/void`, {
      status: 409, body: { error: 'This invoice has already been voided.' },
    });
    renderView();
    const confirm = await openVoidConfirm();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Void invoice' }));

    expect(await screen.findByText('This invoice has already been voided.')).toBeInTheDocument();
    expect(screen.queryByText('Invoice voided')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'April Services' })).toBeInTheDocument();
  });
});
