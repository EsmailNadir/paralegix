/**
 * The money fields in the invoice detail dialogs are named by their labels.
 *
 * Add Amount, Add Credit Note and Record Installment Payment each render a
 * visible label over a `$` amount input. Without `htmlFor`/`id` the input has no
 * accessible name, so a screen reader announces a bare "spin button" and
 * `getByLabelText` cannot find it.
 *
 * RED IF: any of the three amount labels loses its `htmlFor`, or the Credit
 * Note subtitle goes back to a literal "--" separator.
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
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { resetPermissions } from '../../support/permissions';
import type { Invoice, Client } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const LIST_URL = `${API}/lawfirms/${FIRM}/billing/invoices/client/${CLIENT}`;

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

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

it('names the Add Amount input by its label', async () => {
  seed(invoice());
  renderView();

  await openMenuAction('Add Amount');
  const dialog = await screen.findByRole('dialog', { name: 'Add Amount to Invoice' });
  expect(within(dialog).getByLabelText(/Amount to Add/)).toBe(within(dialog).getByPlaceholderText('0.00'));
});

it('names the Credit Note amount input by its label', async () => {
  seed(invoice());
  renderView();

  await openMenuAction('Add Credit Note');
  const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
  expect(within(dialog).getByLabelText(/^Amount/)).toBe(within(dialog).getByPlaceholderText('0.00'));
  expect(within(dialog).getByText('Amount *')).toHaveAttribute('class', 'mb-1 block text-sm font-medium text-on-surface');
  expect(within(dialog).getByText('Description')).toHaveAttribute('class', 'mb-1 block text-sm font-medium text-on-surface');
});

it('sends the credit-note fields through the invoice detail save handler', async () => {
  seed(invoice());
  api.postExact(`${LIST_URL}/${INVOICE}/credit-note`, { invoice: invoice() });
  renderView();
  await openMenuAction('Add Credit Note');
  const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
  await userEvent.click(within(dialog).getByRole('button', { name: /Write Off/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Adjustment' }));
  await userEvent.type(within(dialog).getByLabelText(/^Amount/), '12.34');
  await userEvent.type(within(dialog).getByLabelText('Description'), 'Billing correction');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Credit Note' })).not.toBeInTheDocument());
  expect(api.callsTo('/credit-note')).toHaveLength(1);
  expect(api.callsTo('/credit-note')[0].body).toEqual({ amount: 12.34, type: 'adjustment', description: 'Billing correction' });
});

it('separates the Credit Note subtitle with a comma, not a literal "--"', async () => {
  seed(invoice());
  renderView();

  await openMenuAction('Add Credit Note');
  const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
  expect(within(dialog).getByText(/^Invoice: May Services/)).toHaveTextContent(
    'Invoice: May Services, Remaining: $400.00',
  );
  expect(dialog).not.toHaveTextContent('--');
});

it('names the installment payment amount input by its label', async () => {
  seed(invoice({
    paymentPlan: {
      enabled: true,
      installmentAmount: 200,
      frequencyDays: 30,
      planStartDate: '2026-05-01',
      expectedPayments: [
        { dueDate: '2026-05-15', amount: 200, status: 'pending' as const },
        { dueDate: '2026-06-15', amount: 200, status: 'pending' as const },
      ],
    },
  } as Partial<Invoice>));
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: /^Payment Plan/ }));
  await userEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0]);
  const dialog = await screen.findByRole('dialog', { name: 'Record Installment Payment' });
  expect(within(dialog).getByLabelText(/Payment Amount/)).toBe(within(dialog).getByRole('spinbutton'));
});
