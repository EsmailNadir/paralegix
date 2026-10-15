/**
 * Every money-moving save on the invoice detail view sends one request however
 * fast its button is pressed. A double click lands both clicks before React
 * re-renders the button as disabled, so only a ref taken synchronously in the
 * handler stops the second request: a duplicate payment, credit note or added
 * amount moves real money twice.
 *
 * Every service stays real and only the transport is faked, with a delayed
 * response so the first request is still in flight when the second click lands.
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
import { act, screen, waitFor, within } from '@testing-library/react';
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

/** Two clicks before React re-renders, which is what a fast double click is. */
function doubleClick(button: HTMLElement) {
  act(() => {
    button.click();
    button.click();
  });
}

/** Red if more than one request of `method` goes out, including a late second one. */
async function expectSentOnce(method: 'POST' | 'PUT' | 'PATCH') {
  await waitFor(() => expect(api.calls(method)).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(api.calls(method)).toHaveLength(1);
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
  jest.clearAllMocks();
});

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

it('records one payment however many times Record Payment is clicked', async () => {
  seed(invoice());
  api.putExact(`${INVOICE_URL}/payment`, { body: { invoice: invoice() }, delayMs: 150 });
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
  const dialog = await screen.findByRole('dialog', { name: 'Record Payment' });
  doubleClick(within(dialog).getByRole('button', { name: 'Record Payment' }));

  await expectSentOnce('PUT');
});

it('adds one credit note however many times Add Credit Note is clicked', async () => {
  seed(invoice());
  api.postExact(`${INVOICE_URL}/credit-note`, { body: { invoice: invoice() }, delayMs: 150 });
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
  await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '40');
  doubleClick(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

  await expectSentOnce('POST');
});

it('adds the amount once however many times Add Amount is clicked', async () => {
  seed(invoice());
  api.patchExact(`${INVOICE_URL}/add-amount`, { body: { invoice: invoice() }, delayMs: 150 });
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  await userEvent.click(screen.getByRole('button', { name: 'Add Amount' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add Amount to Invoice' });
  await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
  doubleClick(within(dialog).getByRole('button', { name: 'Add Amount' }));

  await expectSentOnce('PATCH');
});

it('creates one payment plan however many times Create Payment Plan is clicked', async () => {
  seed(invoice());
  api.postExact(`${INVOICE_URL}/payment-plan`, { body: { invoice: invoice() }, delayMs: 150 });
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: 'Setup Payment Plan' }));
  const dialog = await screen.findByRole('dialog', { name: 'Set up payment plan' });
  await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
  doubleClick(within(dialog).getByRole('button', { name: 'Create Payment Plan' }));

  await expectSentOnce('POST');
});

it('records one installment payment however many times Record Payment is clicked', async () => {
  seed(planned());
  api.putExact(`${INVOICE_URL}/payment`, { body: { invoice: planned() }, delayMs: 150 });
  renderView();

  const dialog = await openInstallment();
  doubleClick(within(dialog).getByRole('button', { name: 'Record Payment' }));

  await expectSentOnce('PUT');
});

it('reschedules an installment once however many times Reschedule is clicked', async () => {
  seed(planned());
  api.patchExact(`${INVOICE_URL}/payment-plan/installment/0`, { body: { invoice: planned() }, delayMs: 150 });
  renderView();

  await openInstallment();
  await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reschedule Installment' });
  const buttons = within(dialog).getAllByRole('button', { name: 'Reschedule' });
  doubleClick(buttons[buttons.length - 1]);

  await expectSentOnce('PATCH');
});

// The guard must be released when validation refuses the amount, or the
// corrected retry would be swallowed.
it('still saves a corrected credit note after refusing a third decimal place', async () => {
  seed(invoice());
  api.postExact(`${INVOICE_URL}/credit-note`, { invoice: invoice() });
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
  const amount = within(dialog).getByPlaceholderText('0.00');
  await userEvent.type(amount, '10.005');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));
  expect(await within(dialog).findByText('Amounts can have at most two decimal places.')).toBeInTheDocument();
  expect(api.calls('POST')).toHaveLength(0);

  await userEvent.clear(amount);
  await userEvent.type(amount, '10.05');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

  await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
  expect(api.calls('POST')[0].body).toMatchObject({ amount: 10.05 });
});

// Same for a refusal the server returns: the next attempt must go out.
it('sends a retry after the server refuses a payment', async () => {
  seed(invoice());
  api.putExact(`${INVOICE_URL}/payment`, { status: 400, body: { error: 'Payment refused' } });
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
  const dialog = await screen.findByRole('dialog', { name: 'Record Payment' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));
  expect(await within(dialog).findByText('Payment refused')).toBeInTheDocument();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));
  await waitFor(() => expect(api.calls('PUT')).toHaveLength(2));
});
