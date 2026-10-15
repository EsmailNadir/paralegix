/**
 * A refused save on the invoice detail view is reported inside the dialog that
 * made it. The view's banner sits under the dialog's backdrop, so a refusal
 * written there is hidden while the form stays open for a retry, and a banner
 * error read by the dialog would leak an unrelated failure into it.
 *
 * Covers the edit-payment, credit-note, payment-plan, add-amount, installment
 * pay/reschedule and delete-payment dialogs. Every service
 * stays real and only the transport is faked.
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

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
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

const paid = () => invoice({
  amountPaid: 50,
  remainingBalance: 350,
  payments: [{ amount: 50, date: '2026-04-02', note: 'Check 7' }],
} as Partial<Invoice>);

function seed(seeded: Invoice) {
  api.getExact(LIST_URL, { invoices: [seeded] });
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${FIRM}/status`, { connected: false });
  api.get(`/clients/${CLIENT}`, { client: { id: CLIENT, name: 'Acme Co', email: 'ap@acme.test' } });
  api.get('/clients/lookup', { items: [], hasMore: false });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/clients/${CLIENT}/balance`, { clientId: CLIENT, totalBalanceCents: 0, accountBalances: [] });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/accounts`, { accounts: [] });
}

function renderView() {
  return renderWithProviders(
    <InvoiceDetailView
      lawFirmId={FIRM}
      entityId={CLIENT}
      invoiceId={INVOICE}
      contextType="client"
      backHref={`/lawfirm/${FIRM}/clients/${CLIENT}`}
      backLabel="Back to Client Billing"
    />,
  );
}

/** Red if the message is drawn anywhere other than inside `dialog`. */
async function expectOnlyInside(dialog: HTMLElement, message: string) {
  expect(await within(dialog).findByText(message)).toBeInTheDocument();
  expect(screen.getAllByText(message)).toHaveLength(1);
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
  jest.clearAllMocks();
});

describe('editing a payment', () => {
  async function openEdit() {
    await userEvent.click(await screen.findByRole('button', { name: 'Payments (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit payment' }));
    return screen.findByRole('dialog', { name: /Edit payment/i });
  }

  it('reports a refused edit inside the dialog only', async () => {
    seed(paid());
    api.patchExact(`${INVOICE_URL}/payment`, { status: 400, body: { error: 'Amount exceeds invoice total' } });
    renderView();

    const dialog = await openEdit();
    await userEvent.click(within(dialog).getByRole('button', { name: /Save/ }));

    await expectOnlyInside(dialog, 'Amount exceeds invoice total');
  });

  it('opens a fresh edit form without the previous refusal', async () => {
    seed(paid());
    api.patchExact(`${INVOICE_URL}/payment`, { status: 400, body: { error: 'Amount exceeds invoice total' } });
    renderView();

    let dialog = await openEdit();
    await userEvent.click(within(dialog).getByRole('button', { name: /Save/ }));
    expect(await within(dialog).findByText('Amount exceeds invoice total')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Edit payment/i })).not.toBeInTheDocument());

    dialog = await openEdit();
    expect(within(dialog).queryByText('Amount exceeds invoice total')).not.toBeInTheDocument();
  });
});

describe('adding a credit note', () => {
  async function openCreditNote() {
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    return screen.findByRole('dialog', { name: 'Add Credit Note' });
  }

  it('reports a refused credit note inside the dialog only', async () => {
    seed(invoice());
    api.postExact(`${INVOICE_URL}/credit-note`, { status: 400, body: { error: 'Credit exceeds the balance' } });
    renderView();

    const dialog = await openCreditNote();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '40');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    await expectOnlyInside(dialog, 'Credit exceeds the balance');
  });

  it('opens a fresh credit note form without the previous refusal', async () => {
    seed(invoice());
    api.postExact(`${INVOICE_URL}/credit-note`, { status: 400, body: { error: 'Credit exceeds the balance' } });
    renderView();

    let dialog = await openCreditNote();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '40');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));
    expect(await within(dialog).findByText('Credit exceeds the balance')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Credit Note' })).not.toBeInTheDocument());

    dialog = await openCreditNote();
    expect(within(dialog).queryByText('Credit exceeds the balance')).not.toBeInTheDocument();
  });
});

describe('setting up a payment plan', () => {
  async function openPlan() {
    await userEvent.click(await screen.findByRole('button', { name: 'Setup Payment Plan' }));
    return screen.findByRole('dialog', { name: 'Set up payment plan' });
  }

  it('reports a refused plan inside the dialog only', async () => {
    seed(invoice());
    api.postExact(`${INVOICE_URL}/payment-plan`, { status: 400, body: { error: 'Installment too small' } });
    renderView();

    const dialog = await openPlan();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Payment Plan' }));

    await expectOnlyInside(dialog, 'Installment too small');
  });

  it('opens a fresh plan form without the previous refusal', async () => {
    seed(invoice());
    api.postExact(`${INVOICE_URL}/payment-plan`, { status: 400, body: { error: 'Installment too small' } });
    renderView();

    let dialog = await openPlan();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Payment Plan' }));
    expect(await within(dialog).findByText('Installment too small')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set up payment plan' })).not.toBeInTheDocument());

    dialog = await openPlan();
    expect(within(dialog).queryByText('Installment too small')).not.toBeInTheDocument();
  });
});

describe('adding an amount', () => {
  async function openAddAmount() {
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Amount' }));
    return screen.findByRole('dialog', { name: 'Add Amount to Invoice' });
  }

  it('reports a refused add inside the dialog only', async () => {
    seed(invoice());
    api.patchExact(`${INVOICE_URL}/add-amount`, { status: 409, body: { error: 'Invoice is locked for editing' } });
    renderView();

    const dialog = await openAddAmount();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Amount' }));

    await expectOnlyInside(dialog, 'Invoice is locked for editing');
  });

  it('opens a fresh add-amount form without the previous refusal', async () => {
    seed(invoice());
    api.patchExact(`${INVOICE_URL}/add-amount`, { status: 409, body: { error: 'Invoice is locked for editing' } });
    renderView();

    let dialog = await openAddAmount();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Amount' }));
    expect(await within(dialog).findByText('Invoice is locked for editing')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Amount to Invoice' })).not.toBeInTheDocument());

    dialog = await openAddAmount();
    expect(within(dialog).queryByText('Invoice is locked for editing')).not.toBeInTheDocument();
  });
});

describe('an installment', () => {
  const planned = () => invoice({
    paymentPlan: {
      enabled: true,
      installmentAmount: 200,
      frequencyDays: 30,
      planStartDate: '2026-04-01',
      expectedPayments: [
        { dueDate: '2026-04-15', amount: 200, status: 'pending' as const },
        { dueDate: '2026-05-15', amount: 200, status: 'pending' as const },
      ],
    },
  } as Partial<Invoice>);

  async function openInstallment() {
    await userEvent.click(await screen.findByRole('button', { name: /^Payment Plan/ }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0]);
    return screen.findByRole('dialog', { name: 'Record Installment Payment' });
  }

  it('reports a refused installment payment inside the dialog only', async () => {
    seed(planned());
    api.putExact(`${INVOICE_URL}/payment`, { status: 409, body: { error: 'Installment already settled' } });
    renderView();

    const dialog = await openInstallment();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await expectOnlyInside(dialog, 'Installment already settled');
  });

  it('reports a refused reschedule inside the dialog only', async () => {
    seed(planned());
    api.patchExact(`${INVOICE_URL}/payment-plan/installment/0`, { status: 409, body: { error: 'Plan is locked' } });
    renderView();

    await openInstallment();
    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reschedule Installment' });
    const buttons = within(dialog).getAllByRole('button', { name: 'Reschedule' });
    await userEvent.click(buttons[buttons.length - 1]);

    await expectOnlyInside(dialog, 'Plan is locked');
  });

  it('opens a fresh installment form without the previous refusal', async () => {
    seed(planned());
    api.putExact(`${INVOICE_URL}/payment`, { status: 409, body: { error: 'Installment already settled' } });
    renderView();

    let dialog = await openInstallment();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));
    expect(await within(dialog).findByText('Installment already settled')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Record Installment Payment' })).not.toBeInTheDocument());

    dialog = await openInstallment();
    expect(within(dialog).queryByText('Installment already settled')).not.toBeInTheDocument();
  });
});

describe('deleting a payment', () => {
  async function openDelete() {
    await userEvent.click(await screen.findByRole('button', { name: 'Payments (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete payment' }));
    return screen.findByRole('dialog', { name: 'Delete payment' });
  }

  it('reports a refused delete inside the confirm only', async () => {
    seed(paid());
    api.delete('/payment', { status: 409, body: { error: 'Payment is reconciled and cannot be removed' } });
    renderView();

    const confirm = await openDelete();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete Payment' }));

    await expectOnlyInside(confirm, 'Payment is reconciled and cannot be removed');
  });

  it('opens a fresh confirm without the previous refusal', async () => {
    seed(paid());
    api.delete('/payment', { status: 409, body: { error: 'Payment is reconciled and cannot be removed' } });
    renderView();

    let confirm = await openDelete();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete Payment' }));
    expect(await within(confirm).findByText('Payment is reconciled and cannot be removed')).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete payment' })).not.toBeInTheDocument());

    confirm = await openDelete();
    expect(within(confirm).queryByText('Payment is reconciled and cannot be removed')).not.toBeInTheDocument();
  });
});
