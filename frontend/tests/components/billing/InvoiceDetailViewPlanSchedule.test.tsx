/**
 * The bulk payment-plan schedule editor saves exactly the amounts typed.
 *
 * It used to keep the raw float and send it rounded, so 50.004 typed into an
 * installment was saved as 50.00 without a word; because the rounding also
 * hid the third decimal from the sum check, the schedule "balanced". A third
 * decimal place is now refused at save, and nothing is sent.
 *
 * RED IF: savePlanSchedule sends a schedule containing a row typed with more
 * than two decimals, or refuses a whole-cent schedule that balances.
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
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import InvoiceDetailView from '@/components/billingComp/InvoiceDetailView';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import type { Invoice, Client } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const BILLING = `${API}/lawfirms/${FIRM}/billing`;
const LIST_URL = `${BILLING}/invoices/client/${CLIENT}`;
const TRUST = `${API}/lawfirms/${FIRM}/trust`;

let api: ApiMock;

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE,
    invoiceName: 'April Services',
    invoiceNumber: 'INV-2001',
    invoiceDate: '2026-04-01',
    dueDate: null,
    clientId: CLIENT,
    clientName: 'Acme Co',
    clientEmail: 'ap@acme.test',
    status: 'unpaid',
    isPaid: false,
    totalAmount: 100,
    totalHours: 2,
    flatFeesAmount: 0,
    amountPaid: 0,
    totalWrittenOff: 0,
    remainingBalance: 100,
    payments: [],
    creditNotes: [],
    timeEntries: [{ id: 'te-1', description: 'Drafted engagement letter', hours: 2, rate: 50, amount: 100 }],
    flatFees: [],
    expenses: [],
    auditLog: [],
    stripePaymentRequested: false,
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  } as Invoice;
}

function client(): Client {
  return { id: CLIENT, userId: 'portal-uid-1', name: 'Acme Co', email: 'ap@acme.test' } as Client;
}

/**
 * Seed every read the view makes on mount. Trust is answered with an empty
 * balance unless a spec seeds its own, so the trust option stays hidden.
 */
function seed(seeded: Invoice, opts: { trust?: boolean } = {}) {
  api.getExact(LIST_URL, { invoices: [seeded] });
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${FIRM}/status`, { connected: false });
  api.get(`/clients/${CLIENT}`, { client: client() });
  api.get('/clients/lookup', { items: [], hasMore: false });
  if (!opts.trust) {
    api.getExact(`${TRUST}/clients/${CLIENT}/balance`, { totalBalanceCents: 0, accountBalances: [] });
    api.getExact(`${TRUST}/accounts`, { accounts: [] });
  }
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

const SCHEDULE_URL = `${BILLING}/invoices/client/${CLIENT}/${INVOICE}/payment-plan/schedule`;

function planInvoice(): Invoice {
  return invoice({
    paymentPlan: {
      enabled: true,
      installmentAmount: 50,
      frequencyDays: 30,
      planStartDate: '2999-01-01',
      expectedPayments: [
        { dueDate: '2999-01-01', amount: 50, status: 'pending', matchedPaymentIndex: null },
        { dueDate: '2999-02-01', amount: 50, status: 'pending', matchedPaymentIndex: null },
      ],
    },
  } as Partial<Invoice>);
}

async function openEditor() {
  await userEvent.click(await screen.findByRole('button', { name: /^Payment Plan/ }));
  await userEvent.click(await screen.findByRole('button', { name: /Edit plan/ }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  api = installApiMock();
  grantPermissions(['billing.viewInvoices', 'billing.manageInvoices', 'billing.recordPayments']);
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

it('refuses a third decimal place and sends nothing', async () => {
  seed(planInvoice());
  api.patchExact(SCHEDULE_URL, { invoice: planInvoice() });
  renderView();

  const dialog = await openEditor();
  const [first, second] = within(dialog).getAllByPlaceholderText('0.00');
  // 50.004 + 49.996 = 100.00 after rounding, so the old mismatch check passed.
  fireEvent.change(first, { target: { value: '50.004' } });
  fireEvent.change(second, { target: { value: '49.996' } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));

  expect((await screen.findAllByText('Amounts can have at most two decimal places.')).length).toBeGreaterThan(0);
  expect(api.callsTo('/payment-plan/schedule')).toHaveLength(0);
});

it('saves a whole-cent schedule that balances, with the amounts as typed', async () => {
  seed(planInvoice());
  api.patchExact(SCHEDULE_URL, { invoice: planInvoice() });
  renderView();

  const dialog = await openEditor();
  const [first, second] = within(dialog).getAllByPlaceholderText('0.00');
  fireEvent.change(first, { target: { value: '50.01' } });
  fireEvent.change(second, { target: { value: '49.99' } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));

  await waitFor(() => expect(api.callsTo('/payment-plan/schedule')).toHaveLength(1));
  const body = api.callsTo('/payment-plan/schedule')[0].body as { installments: Array<{ amount: number }> };
  expect(body.installments.map((i) => i.amount)).toEqual([50.01, 49.99]);
});

it('clears the refusal once the row is retyped to whole cents', async () => {
  seed(planInvoice());
  api.patchExact(SCHEDULE_URL, { invoice: planInvoice() });
  renderView();

  const dialog = await openEditor();
  const [first, second] = within(dialog).getAllByPlaceholderText('0.00');
  fireEvent.change(first, { target: { value: '50.004' } });
  fireEvent.change(second, { target: { value: '49.996' } });
  fireEvent.change(first, { target: { value: '50.01' } });
  fireEvent.change(second, { target: { value: '49.99' } });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));

  await waitFor(() => expect(api.callsTo('/payment-plan/schedule')).toHaveLength(1));
});

it('marks the row with a third decimal inline as it is typed, before any save', async () => {
  seed(planInvoice());
  renderView();

  const dialog = await openEditor();
  const [first, second] = within(dialog).getAllByPlaceholderText('0.00');
  fireEvent.change(first, { target: { value: '10.999' } });

  const firstRow = first.closest('tr') as HTMLElement;
  const secondRow = second.closest('tr') as HTMLElement;
  expect(within(firstRow).getByRole('alert')).toHaveTextContent('Amounts can have at most two decimal places.');
  expect(within(secondRow).queryByRole('alert')).not.toBeInTheDocument();

  fireEvent.change(first, { target: { value: '10.99' } });
  expect(within(firstRow).queryByRole('alert')).not.toBeInTheDocument();
});

function planInvoiceWithRows(count: number): Invoice {
  const rows = Array.from({ length: count }, (_, i) => ({
    dueDate: `2999-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    amount: 1,
    status: 'pending',
    matchedPaymentIndex: null,
  }));
  return invoice({
    paymentPlan: { enabled: true, installmentAmount: 1, frequencyDays: 30, planStartDate: rows[0].dueDate, expectedPayments: rows },
  } as Partial<Invoice>);
}

it('stops adding installments at 120 and says why, in words that fit adding rows', async () => {
  seed(planInvoiceWithRows(119));
  renderView();

  const dialog = await openEditor();
  expect(within(dialog).getAllByPlaceholderText('0.00')).toHaveLength(119);
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();

  const add = within(dialog).getByRole('button', { name: 'Add installment' });
  await userEvent.click(add);
  expect(within(dialog).getAllByPlaceholderText('0.00')).toHaveLength(120);
  const limit = within(dialog).getByRole('alert');
  expect(limit).toHaveTextContent('A payment plan can have at most 120 installments.');
  expect(limit).not.toHaveTextContent(/larger installment amount/i);

  await userEvent.click(add);
  expect(within(dialog).getAllByPlaceholderText('0.00')).toHaveLength(120);
});

it('marks an installment unpaid naming the payment that settled it', async () => {
  const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
  const settled = invoice({
    amountPaid: 50,
    remainingBalance: 50,
    payments: [{ id: PAYMENT_ID, amount: 50, date: '2026-04-01' }],
    paymentPlan: {
      enabled: true,
      installmentAmount: 50,
      frequencyDays: 30,
      planStartDate: '2999-01-01',
      expectedPayments: [
        { dueDate: '2999-01-01', amount: 50, status: 'paid', matchedPaymentIndex: 0 },
        { dueDate: '2999-02-01', amount: 50, status: 'pending', matchedPaymentIndex: null },
      ],
    },
  } as Partial<Invoice>);
  seed(settled);
  api.delete('/payment-plan/installment/0/payment', { invoice: settled });
  renderView();

  await userEvent.click(await screen.findByRole('button', { name: /^Payment Plan/ }));
  await userEvent.click(await screen.findByRole('button', { name: 'Mark as unpaid' }));

  await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
  expect(api.calls('DELETE')[0].pathname).toMatch(/\/payment-plan\/installment\/0\/payment$/);
  expect(api.calls('DELETE')[0].query).toEqual({ paymentId: [PAYMENT_ID] });
});
