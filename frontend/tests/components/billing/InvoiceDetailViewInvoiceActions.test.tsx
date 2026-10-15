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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import InvoiceDetailView from '@/components/billingComp/InvoiceDetailView';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import type { Invoice } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const BILLING = `${API}/lawfirms/${FIRM}/billing`;
const INVOICE_URL = `${BILLING}/invoices/client/${CLIENT}/${INVOICE}`;
const LIST_URL = `${BILLING}/invoices/client/${CLIENT}`;
const BACK_HREF = `/lawfirm/${FIRM}/clients/${CLIENT}`;

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

function seedIncidental(opts: { trustBalanceCents?: number } = {}) {
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${FIRM}/status`, { connected: true, chargesEnabled: true });
  api.get(`/clients/${CLIENT}`, { client: { id: CLIENT, name: 'Acme Co', email: 'ap@acme.test' } });
  api.get('/clients/lookup', { items: [], hasMore: false });
  const balanceCents = opts.trustBalanceCents ?? 0;
  api.getExact(`${API}/lawfirms/${FIRM}/trust/clients/${CLIENT}/balance`, {
    clientId: CLIENT,
    totalBalanceCents: balanceCents,
    accountBalances: balanceCents > 0
      ? [{ clientId: CLIENT, trustAccountId: 'ta-1', balanceCents }]
      : [],
  });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/accounts`, {
    accounts: [{ id: 'ta-1', name: 'IOLTA Main', status: 'active' }],
  });
}

function renderView() {
  return renderWithProviders(
    <InvoiceDetailView
      lawFirmId={FIRM}
      entityId={CLIENT}
      invoiceId={INVOICE}
      contextType="client"
      backHref={BACK_HREF}
      backLabel="Back to Client Billing"
    />,
  );
}

async function openMoreMenu() {
  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
}

beforeEach(() => {
  api = installApiMock();
  mockNavigate.mockReset();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('adding an amount to the invoice', () => {
  it('sends the typed amount and note, then shows the reloaded total', async () => {
    seedIncidental();
    api.getExact(LIST_URL, sequence(
      { invoices: [invoice()] },
      { invoices: [invoice({ totalAmount: 525.5, remainingBalance: 525.5 })] },
    ));
    api.patchExact(`${INVOICE_URL}/add-amount`, { invoice: invoice({ totalAmount: 525.5 }) });

    renderView();
    await openMoreMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Add Amount' }));

    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Add Amount' });
    // Nothing typed yet: the submit stays disabled so an empty amount never posts.
    expect(submit).toBeDisabled();

    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '125.50');
    await userEvent.type(within(dialog).getByPlaceholderText(/Additional services/), '  Scope change  ');
    await userEvent.click(submit);

    await waitFor(() => expect(api.callsTo(`/invoices/client/${CLIENT}/${INVOICE}/add-amount`)).toHaveLength(1));
    expect(api.callsTo('/add-amount')[0].body).toEqual({ amount: 125.5, note: 'Scope change' });
    expect(await screen.findAllByText('$525.50')).not.toHaveLength(0);
  });

  it('keeps the dialog open and shows the server refusal when the add is rejected', async () => {
    seedIncidental();
    api.getExact(LIST_URL, { invoices: [invoice()] });
    api.patchExact(`${INVOICE_URL}/add-amount`, {
      status: 409,
      body: { error: 'Invoice is locked for editing' },
    });

    renderView();
    await openMoreMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Add Amount' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Amount' }));

    expect(await within(dialog).findByText('Invoice is locked for editing')).toBeInTheDocument();
    // The refusal is drawn inside the dialog over the invoice, not a not-found page.
    expect(screen.getByRole('heading', { name: 'April Services' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(api.callsTo(`/invoices/client/${CLIENT}`).filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});

describe('adding a credit note', () => {
  it('falls back to the type name as the description when none is typed', async () => {
    seedIncidental();
    api.getExact(LIST_URL, sequence(
      { invoices: [invoice()] },
      {
        invoices: [invoice({
          totalWrittenOff: 40,
          remainingBalance: 360,
          creditNotes: [{ id: 'cn-1', amount: 40, description: 'write off', type: 'write_off', createdAt: '2026-04-02T00:00:00.000Z' }],
        } as Partial<Invoice>)],
      },
    ));
    api.postExact(`${INVOICE_URL}/credit-note`, { invoice: invoice() });

    renderView();
    await openMoreMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Remaining:\s*\$400\.00/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '40');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    await waitFor(() => expect(api.callsTo('/credit-note')).toHaveLength(1));
    expect(api.callsTo('/credit-note')[0].body).toEqual({
      amount: 40,
      description: 'write off',
      type: 'write_off',
    });
    // The reload surfaces the credit notes tab and the written-off total.
    expect(await screen.findByRole('button', { name: 'Credit Notes (1)' })).toBeInTheDocument();
    expect(screen.getAllByText('-$40.00').length).toBeGreaterThan(0);
  });
});

describe('recording a payment', () => {
  it('refuses an overpayment until "Allow overpayment" is ticked, then flags it on the request', async () => {
    seedIncidental();
    api.getExact(LIST_URL, { invoices: [invoice()] });
    api.putExact(`${INVOICE_URL}/payment`, { invoice: invoice() });

    renderView();
    await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    const dialog = await screen.findByRole('dialog');
    const amount = within(dialog).getByPlaceholderText('0.00');
    // Prefilled with the remaining balance, to the cent.
    expect(amount).toHaveValue(400);
    await userEvent.clear(amount);
    await userEvent.type(amount, '450');
    expect(within(dialog).getByText('Overpayment of $50.00')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));
    expect(await screen.findByText(/Payment exceeds remaining balance/)).toBeInTheDocument();
    expect(api.callsTo('/payment')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Allow overpayment' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo('/payment')).toHaveLength(1));
    expect(api.callsTo('/payment')[0].body).toMatchObject({
      paymentAmount: 450,
      allowOverpayment: true,
      nextPaymentDate: null,
    });
  });

  it('refuses a trust payment larger than the selected trust account holds, naming the available cents', async () => {
    seedIncidental({ trustBalanceCents: 12_345 });
    api.getExact(LIST_URL, { invoices: [invoice()] });

    renderView();
    await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    const dialog = await screen.findByRole('dialog');
    const trustToggle = await within(dialog).findByText('Pay from trust account');
    expect(within(dialog).getByText(/\$123\.45\s*available/)).toBeInTheDocument();
    await userEvent.click(trustToggle);

    // $400.00 balance prefilled; the account holds only $123.45.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await screen.findByText(
      'Insufficient trust balance in selected account. Available: $123.45',
    )).toBeInTheDocument();
    expect(api.callsTo('/payment')).toHaveLength(0);
  });

  it('sends a trust payment within the balance with the trust account and client on the request', async () => {
    seedIncidental({ trustBalanceCents: 50_000 });
    api.getExact(LIST_URL, { invoices: [invoice()] });
    api.putExact(`${INVOICE_URL}/payment`, { invoice: invoice() });

    renderView();
    await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByText('Pay from trust account'));
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '100.10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo('/payment')).toHaveLength(1));
    expect(api.callsTo('/payment')[0].body).toMatchObject({
      paymentAmount: 100.1,
      paymentSource: 'trust',
      trustAccountId: 'ta-1',
      trustClientId: CLIENT,
      trustClientName: 'Acme Co',
    });
    expect((api.callsTo('/payment')[0].body as Record<string, unknown>).allowOverpayment).toBeUndefined();
  });
});

describe('deleting a payment', () => {
  it('names the payment in the confirmation and deletes it by its index', async () => {
    seedIncidental();
    const paid = invoice({
      amountPaid: 150,
      remainingBalance: 250,
      payments: [
        { amount: 100, date: '2026-04-03', paymentMethod: 'manual' },
        { amount: 50, date: '2026-04-10', paymentMethod: 'manual' },
      ],
    } as Partial<Invoice>);
    api.getExact(LIST_URL, { invoices: [paid] });
    api.delete(`/invoices/client/${CLIENT}/${INVOICE}/payment`, { invoice: paid });

    renderView();
    await userEvent.click(await screen.findByRole('button', { name: 'Payments (2)' }));
    const deleteButtons = await screen.findAllByRole('button', { name: /Delete payment/i });
    await userEvent.click(deleteButtons[1]);

    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(
      'Remove payment of $50.00 from Apr 10, 2026? This will update the invoice balance.',
    )).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete Payment' }));

    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].query).toEqual({ paymentIndex: ['1'] });
  });
});

describe('deleting the invoice', () => {
  it('deletes through the client context and returns to the client billing page', async () => {
    seedIncidental();
    api.getExact(LIST_URL, { invoices: [invoice()] });
    api.deleteExact(INVOICE_URL, { status: 204, body: null });

    renderView();
    await openMoreMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Invoice' }));
    const confirm = await screen.findByRole('dialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(BACK_HREF));
    expect(api.calls('DELETE')).toHaveLength(1);
  });

  it('stays on the invoice with the refusal shown when the delete is rejected', async () => {
    seedIncidental();
    api.getExact(LIST_URL, { invoices: [invoice()] });
    api.deleteExact(INVOICE_URL, { status: 409, body: { error: 'Invoice has payments recorded' } });

    renderView();
    await openMoreMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Invoice' }));
    const confirm = await screen.findByRole('dialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Invoice has payments recorded')).toBeInTheDocument();
    expect(api.calls('DELETE')).toHaveLength(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'April Services' })).toBeInTheDocument();
  });
});

describe('permission gating of the invoice actions', () => {
  it('gives a payments-only role Record Payment but none of the invoice-changing actions', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seedIncidental();
    api.getExact(LIST_URL, { invoices: [invoice()] });

    renderView();
    expect(await screen.findByRole('button', { name: 'Record Payment' })).toBeInTheDocument();
    expect(screen.queryByText(/You can view this invoice/)).not.toBeInTheDocument();

    await openMoreMenu();
    expect(screen.getByRole('button', { name: 'Download Invoice PDF' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Amount' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Credit Note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download LEDES' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to Client' })).not.toBeInTheDocument();
  });

  it('offers no balance-changing actions on a paid invoice, even to a full-access member', async () => {
    seedIncidental();
    api.getExact(LIST_URL, {
      invoices: [invoice({ status: 'paid', isPaid: true, amountPaid: 400, remainingBalance: 0 })],
    });

    renderView();
    await screen.findByRole('heading', { name: 'April Services' });
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();

    await openMoreMenu();
    expect(screen.getByRole('button', { name: 'Delete Invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Amount' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Credit Note' })).not.toBeInTheDocument();
  });
});

describe('an over-settled invoice', () => {
  it('reports the excess as a credit due rather than a zero balance', async () => {
    seedIncidental();
    api.getExact(LIST_URL, {
      invoices: [invoice({
        totalAmount: 300,
        amountPaid: 350,
        remainingBalance: 0,
        status: 'paid',
        isPaid: true,
        payments: [{ amount: 350, date: '2026-04-05', paymentMethod: 'manual' }],
      } as Partial<Invoice>)],
    });

    renderView();
    await screen.findByRole('heading', { name: 'April Services' });
    expect(screen.getAllByText('Credit Due').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Over-settled: refund or apply to another invoice')).toBeInTheDocument();
  });
});
