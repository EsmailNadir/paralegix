/**
 * Credit notes, "Add Amount", and the balance the invoice detail view shows
 * after them, driven through the REAL billing service against a faked transport.
 *
 * A credit note (write-off, discount, adjustment) lowers what is owed without a
 * payment; "Add Amount" raises the total without a line item. Both are money
 * the client sees, so the request body and the resulting summary are asserted
 * to the cent, and a refusal must surface as a banner on the invoice rather
 * than replacing it with a "not found" panel.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
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
import type { Invoice, Client } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const INVOICE_BASE = `${API}/lawfirms/${FIRM}/billing/invoices/client/${CLIENT}`;
const LIST_URL = INVOICE_BASE;
const CREDIT_NOTE_URL = `${INVOICE_BASE}/${INVOICE}/credit-note`;
const ADD_AMOUNT_URL = `${INVOICE_BASE}/${INVOICE}/add-amount`;

let api: ApiMock;

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE,
    invoiceName: 'May Services',
    invoiceNumber: 'INV-3001',
    invoiceDate: '2026-05-01',
    dueDate: null,
    clientId: CLIENT,
    clientName: 'Acme Co',
    clientEmail: 'ap@acme.test',
    status: 'unpaid',
    isPaid: false,
    totalAmount: 400,
    totalHours: 4,
    flatFeesAmount: 0,
    amountPaid: 0,
    totalWrittenOff: 0,
    remainingBalance: 400,
    payments: [],
    creditNotes: [],
    timeEntries: [{ id: 'te-1', description: 'Contract review', hours: 4, rate: 100, amount: 400 }],
    flatFees: [],
    expenses: [],
    auditLog: [],
    stripePaymentRequested: false,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  } as Invoice;
}

function seed(seeded: Invoice) {
  api.getExact(LIST_URL, { invoices: [seeded] });
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${FIRM}/status`, { connected: false });
  api.get(`/clients/${CLIENT}`, {
    client: { id: CLIENT, userId: 'portal-uid-1', name: 'Acme Co', email: 'ap@acme.test' } as Client,
  });
  api.get('/clients/lookup', { items: [], hasMore: false });
}

function renderView() {
  return renderWithProviders(
    <InvoiceDetailView
      lawFirmId={FIRM}
      entityId={CLIENT}
      invoiceId={INVOICE}
      contextType="client"
      backHref={`/lawfirm/${FIRM}/clients/${CLIENT}?tab=billing`}
      backLabel="Back to Client Billing"
    />,
  );
}

async function openMenuAction(label: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  await userEvent.click(await screen.findByRole('button', { name: label }));
}

/** The right-rail summary card, where each figure sits on its own labelled row. */
function summaryRow(label: string): HTMLElement {
  const card = screen.getByRole('heading', { name: 'Summary' }).parentElement as HTMLElement;
  return within(card).getByText(label).parentElement as HTMLElement;
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
  jest.clearAllMocks();
});

describe('adding a credit note', () => {
  it('sends a discount with its amount and description', async () => {
    seed(invoice());
    api.postExact(CREDIT_NOTE_URL, { invoice: invoice() });
    renderView();

    await openMenuAction('Add Credit Note');
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    expect(dialog).toHaveTextContent('Remaining: $400.00');

    await userEvent.click(within(dialog).getByRole('button', { name: /Type/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Discount' }));
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '37.25');
    await userEvent.type(within(dialog).getByPlaceholderText(/Courtesy discount/), 'Loyalty');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual({ amount: 37.25, description: 'Loyalty', type: 'discount' });
  });

  it('describes a credit note left without a description by its type', async () => {
    seed(invoice());
    api.postExact(CREDIT_NOTE_URL, { invoice: invoice() });
    renderView();

    await openMenuAction('Add Credit Note');
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    expect(api.calls('POST')[0].body).toEqual({ amount: 10, description: 'write off', type: 'write_off' });
  });

  it('will not submit a zero credit', async () => {
    seed(invoice());
    renderView();

    await openMenuAction('Add Credit Note');
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    const submit = within(dialog).getByRole('button', { name: 'Add Credit Note' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '0');
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '.01');
    expect(submit).toBeEnabled();
  });

  // The backend stores cents and answers a third decimal place with a bare 400,
  // so the dialog has to refuse it first, with the shared money wording.
  it('refuses 10.005 inside the dialog and sends nothing', async () => {
    seed(invoice());
    renderView();

    await openMenuAction('Add Credit Note');
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10.005');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    expect(await within(dialog).findByText('Amounts can have at most two decimal places.')).toBeInTheDocument();
    expect(api.calls('POST')).toHaveLength(0);
  });

  it('keeps the invoice on screen with the refusal as a banner when the credit is rejected', async () => {
    seed(invoice());
    api.postExact(CREDIT_NOTE_URL, { status: 400, body: { error: 'Credit exceeds the remaining balance' } });
    renderView();

    await openMenuAction('Add Credit Note');
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    expect(await screen.findByText('Credit exceeds the remaining balance')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'May Services' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Invoice not found' })).not.toBeInTheDocument();
  });
});

describe('adding an amount', () => {
  it('sends the amount and trimmed note, then reloads the raised total', async () => {
    seed(invoice());
    api.getExact(LIST_URL, sequence(
      { invoices: [invoice()] },
      { invoices: [invoice({ totalAmount: 475.5, remainingBalance: 475.5 })] },
    ));
    api.patchExact(ADD_AMOUNT_URL, { invoice: invoice() });
    renderView();

    await openMenuAction('Add Amount');
    const dialog = await screen.findByRole('dialog', { name: 'Add Amount to Invoice' });
    expect(dialog).toHaveTextContent('Current total: $400.00');
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '75.50');
    await userEvent.type(within(dialog).getByPlaceholderText(/scope change/), '  Scope change  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Amount' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(api.calls('PATCH')[0].body).toEqual({ amount: 75.5, note: 'Scope change' });
    await waitFor(() => expect(within(summaryRow('Total')).getByText('$475.50')).toBeInTheDocument());
  });

  it('omits a blank note rather than sending whitespace', async () => {
    seed(invoice());
    api.patchExact(ADD_AMOUNT_URL, { invoice: invoice() });
    renderView();

    await openMenuAction('Add Amount');
    const dialog = await screen.findByRole('dialog', { name: 'Add Amount to Invoice' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '5');
    await userEvent.type(within(dialog).getByPlaceholderText(/scope change/), '   ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Amount' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(api.calls('PATCH')[0].body).toEqual({ amount: 5 });
  });

  it('refuses 10.005 inside the dialog and sends nothing', async () => {
    seed(invoice());
    renderView();

    await openMenuAction('Add Amount');
    const dialog = await screen.findByRole('dialog', { name: 'Add Amount to Invoice' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10.005');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Amount' }));

    expect(await within(dialog).findByText('Amounts can have at most two decimal places.')).toBeInTheDocument();
    expect(api.calls('PATCH')).toHaveLength(0);
  });

  it('keeps the invoice on screen with the refusal as a banner when the amount is rejected', async () => {
    seed(invoice());
    api.patchExact(ADD_AMOUNT_URL, { status: 403, body: { error: 'Invoice is locked' } });
    renderView();

    await openMenuAction('Add Amount');
    const dialog = await screen.findByRole('dialog', { name: 'Add Amount to Invoice' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Amount' }));

    expect(await screen.findByText('Invoice is locked')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'May Services' })).toBeInTheDocument();
  });
});

describe('credit notes already on the invoice', () => {
  const credited = () => invoice({
    amountPaid: 150,
    totalWrittenOff: 50.25,
    remainingBalance: 199.75,
    payments: [{ amount: 150, date: '2026-05-05' }],
    creditNotes: [
      { id: 'cn-1', type: 'discount', amount: 20.25, description: 'Loyalty' },
      { id: 'cn-2', type: 'write_off', amount: 30, description: 'Courtesy' },
    ],
  } as Partial<Invoice>);

  it('subtracts credits and payments from the total in the summary, to the cent', async () => {
    seed(credited());
    renderView();

    await screen.findByRole('heading', { name: 'May Services' });
    expect(within(summaryRow('Total')).getByText('$400.00')).toBeInTheDocument();
    expect(within(summaryRow('Credits / Adjustments')).getByText('-$50.25')).toBeInTheDocument();
    expect(within(summaryRow('Paid')).getByText('$150.00')).toBeInTheDocument();
    expect(within(summaryRow('Remaining Balance')).getByText('$199.75')).toBeInTheDocument();
    // 150 + 50.25 of 400 applied.
    expect(screen.getByText('50% applied')).toBeInTheDocument();
  });

  it('lists each credit note with a negative amount and its type', async () => {
    seed(credited());
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Credit Notes (2)' }));
    const loyalty = screen.getByText('Loyalty').closest('tr') as HTMLElement;
    expect(within(loyalty).getByText('Discount')).toBeInTheDocument();
    expect(within(loyalty).getByText('-$20.25')).toBeInTheDocument();
  });

  it('removes a credit note by its id', async () => {
    seed(credited());
    api.delete('/credit-note', { invoice: credited() });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Credit Notes (2)' }));
    const row = screen.getByText('Courtesy').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove credit note' }));
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Credit Note' })).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].pathname).toBe(new URL(CREDIT_NOTE_URL).pathname);
    expect(api.calls('DELETE')[0].query).toEqual({ creditNoteId: ['cn-2'] });
  });

  it('shows a refused removal as a banner and keeps the credit note listed', async () => {
    seed(credited());
    api.delete('/credit-note', { status: 409, body: { error: 'Credit note already applied' } });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Credit Notes (2)' }));
    const row = screen.getByText('Courtesy').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove credit note' }));
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Credit Note' })).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('Credit note already applied')).toBeInTheDocument();
    expect(screen.getByText('Courtesy')).toBeInTheDocument();
  });

  it('offers no removal to someone who cannot manage invoices', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seed(credited());
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Credit Notes (2)' }));
    const row = screen.getByText('Courtesy').closest('tr') as HTMLElement;
    expect(within(row).getByText('-$30.00')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Remove credit note' })).not.toBeInTheDocument();
  });
});

describe('an over-settled invoice', () => {
  it('shows the credit owed back to the client instead of a remaining balance', async () => {
    // Line items edited down to 300 after 350 was collected: 50 is owed back.
    seed(invoice({
      totalAmount: 300,
      amountPaid: 350,
      remainingBalance: 0,
      isPaid: true,
      status: 'paid',
      payments: [{ amount: 350, date: '2026-05-05' }],
    }));
    renderView();

    await screen.findByRole('heading', { name: 'May Services' });
    expect(within(summaryRow('Credit Due')).getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText('Over-settled: refund or apply to another invoice')).toBeInTheDocument();
    expect(screen.queryByText('Remaining Balance')).not.toBeInTheDocument();
  });
});
