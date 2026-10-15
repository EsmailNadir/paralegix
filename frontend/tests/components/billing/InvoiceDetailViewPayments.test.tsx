/**
 * Recording, editing and deleting payments on the invoice detail view, driven
 * through the REAL billing service against a faked transport so the request
 * body the page sends is what is asserted, not a mock's arguments.
 *
 * The money rules here are the ones a firm feels: a payment larger than what is
 * owed is refused unless the person says it is an overpayment, a payment from
 * trust is refused when the chosen trust account cannot cover it (compared in
 * integer cents), and an edit or delete addresses the payment by its real
 * position in the invoice's payment list.
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
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import type { Invoice, Client } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const BILLING = `${API}/lawfirms/${FIRM}/billing`;
const LIST_URL = `${BILLING}/invoices/client/${CLIENT}`;
const PAYMENT_URL = `${BILLING}/invoices/client/${CLIENT}/${INVOICE}/payment`;
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

async function openRecordPayment() {
  await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
  return screen.findByRole('dialog', { name: 'Record Payment' });
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
  jest.clearAllMocks();
});

describe('recording a payment', () => {
  it('prefills the amount with the remaining balance to the cent', async () => {
    seed(invoice({ totalAmount: 250.5, amountPaid: 100.25, remainingBalance: 150.25 }));
    renderView();

    const dialog = await openRecordPayment();

    expect(within(dialog).getByPlaceholderText('0.00')).toHaveValue(150.25);
  });

  it('refuses a payment above the remaining balance until overpayment is allowed, and sends nothing', async () => {
    seed(invoice());
    renderView();

    const dialog = await openRecordPayment();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '150');
    expect(within(dialog).getByText('Overpayment of $50.00')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByText(/Payment exceeds remaining balance/)).toBeInTheDocument();
    expect(api.calls('PUT')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Record Payment' })).toBeInTheDocument();
  });

  // The page banner sits under the dialog's backdrop, so a refusal written
  // there is hidden while the form stays open. Red if the reason is not shown
  // inside the dialog.
  it('shows a refused payment inside the dialog, which stays open', async () => {
    seed(invoice());
    api.putExact(PAYMENT_URL, { status: 409, body: { error: 'Invoice was paid by another user' } });
    renderView();

    const dialog = await openRecordPayment();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Invoice was paid by another user');
    expect(screen.getByRole('dialog', { name: 'Record Payment' })).toBeInTheDocument();
  });

  it('sends an allowed overpayment with the overpayment flag and the note and reference trimmed', async () => {
    seed(invoice());
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    renderView();

    const dialog = await openRecordPayment();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '120.10');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Allow overpayment' }));
    await userEvent.type(within(dialog).getByPlaceholderText('e.g. INV-001'), '  CHK-77  ');
    await userEvent.type(within(dialog).getByPlaceholderText(/Check #1234/), '  wire  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo('/payment')).toHaveLength(1));
    expect(api.callsTo('/payment')[0].body).toEqual({
      paymentAmount: 120.1,
      paidDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      nextPaymentDate: null,
      allowOverpayment: true,
      invoiceNumber: 'CHK-77',
      paymentNote: 'wire',
    });
  });

  it('sends an exact-balance payment without the overpayment flag and reloads the invoice', async () => {
    seed(invoice());
    // Registered after the seed so it wins: the load, then the reload after paying.
    api.getExact(LIST_URL, sequence(
      { invoices: [invoice()] },
      { invoices: [invoice({ amountPaid: 100, remainingBalance: 0, status: 'paid', isPaid: true,
        payments: [{ amount: 100, date: '2026-04-10' }] })] },
    ));
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    renderView();

    const dialog = await openRecordPayment();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const body = api.callsTo('/payment')[0].body as Record<string, unknown>;
    expect(body.paymentAmount).toBe(100);
    expect(body).not.toHaveProperty('allowOverpayment');
    // Paid in full: the header action to take another payment is gone.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument(),
    );
    expect(api.calls('GET').filter((c) => c.url === LIST_URL)).toHaveLength(2);
  });

  // Red if handleRecordPayment sends a sub-cent amount (the PUT is recorded) or
  // shows the refusal anywhere but under the amount field.
  it('refuses 10.999 under the amount field and sends nothing', async () => {
    seed(invoice());
    renderView();

    const dialog = await openRecordPayment();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '10.999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Amounts can have at most two decimal places.',
    );
    expect(api.calls('PUT')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Record Payment' })).toBeInTheDocument();

    // Editing the amount clears the message, so it never sits beside a fixed value.
    await userEvent.clear(amount);
    await userEvent.type(amount, '10.99');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  // The neighbouring legitimate case: one decimal place is a real cents amount
  // and goes out as typed. Red if the new parser rounds or refuses it.
  it('sends 10.5 as 10.5', async () => {
    seed(invoice());
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    renderView();

    const dialog = await openRecordPayment();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '10.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo('/payment')).toHaveLength(1));
    expect((api.callsTo('/payment')[0].body as Record<string, unknown>).paymentAmount).toBe(10.5);
  });
});

describe('sub-cent amounts on installments and edits', () => {
  const plan = {
    enabled: true,
    installmentAmount: 50,
    frequencyDays: 30,
    planStartDate: '2026-04-01',
    expectedPayments: [
      { dueDate: '2026-04-15', amount: 50, status: 'pending' as const },
      { dueDate: '2026-05-15', amount: 50, status: 'pending' as const },
    ],
  };

  // Red if handlePayInstallment still sends parseFloat(input) unchecked.
  it('refuses 10.999 on an installment payment and sends nothing', async () => {
    seed(invoice({ paymentPlan: plan }));
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: /^Payment Plan/ }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Record' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Record Installment Payment' });
    const amount = within(dialog).getByRole('spinbutton');
    await userEvent.clear(amount);
    await userEvent.type(amount, '10.999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Amounts can have at most two decimal places.',
    );
    expect(api.calls('PUT')).toHaveLength(0);
  });

  // Red if handleEditPayment still sends parseFloat(input) unchecked. An edit is
  // a PATCH, so the PATCH log is what stays empty.
  it('refuses 10.999 on a payment edit and sends nothing', async () => {
    seed(invoice({ totalAmount: 300, amountPaid: 40, remainingBalance: 260, payments: [{ amount: 40, date: '2026-04-10', note: 'Deposit' }] }));
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (1)' }));
    const row = screen.getByText('Deposit').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Edit payment' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit payment/i });
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '10.999');
    await userEvent.click(within(dialog).getByRole('button', { name: /Save/ }));

    expect(await within(dialog).findByText('Amounts can have at most two decimal places.')).toBeInTheDocument();
    expect(api.calls('PATCH')).toHaveLength(0);
  });
});

describe('paying from trust', () => {
  function seedTrust(balanceCents: number) {
    api.getExact(`${TRUST}/clients/${CLIENT}/balance`, {
      totalBalanceCents: balanceCents,
      accountBalances: [{ trustAccountId: 'ta-1', balanceCents }],
    });
    api.getExact(`${TRUST}/accounts`, {
      accounts: [{ id: 'ta-1', name: 'IOLTA', status: 'active' }],
    });
  }

  it('offers the trust option against the account balance and says when it covers the invoice', async () => {
    seed(invoice(), { trust: true });
    seedTrust(10000);
    renderView();

    const option = await screen.findByRole('button', { name: /Pay from Trust/ });
    expect(option).toHaveTextContent('$100.00 available');
    expect(option).toHaveTextContent('Covers balance');
  });

  it('does not claim the trust balance covers an invoice it falls a cent short of', async () => {
    seed(invoice({ totalAmount: 100.01, remainingBalance: 100.01 }), { trust: true });
    seedTrust(10000);
    renderView();

    const option = await screen.findByRole('button', { name: /Pay from Trust/ });
    expect(option).toHaveTextContent('$100.00 available');
    expect(option).not.toHaveTextContent('Covers balance');
  });

  it('refuses a trust payment larger than the selected account holds, by one cent', async () => {
    seed(invoice({ totalAmount: 100.01, remainingBalance: 100.01 }), { trust: true });
    seedTrust(10000);
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: /Pay from Trust/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Record Payment' });
    expect(within(dialog).getByPlaceholderText('0.00')).toHaveValue(100.01);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(
      await within(dialog).findByText('Insufficient trust balance in selected account. Available: $100.00'),
    ).toBeInTheDocument();
    expect(api.calls('PUT')).toHaveLength(0);
  });

  it('sends a covered trust payment tagged with the trust account and client', async () => {
    seed(invoice(), { trust: true });
    seedTrust(10000);
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: /Pay from Trust/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Record Payment' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo('/payment')).toHaveLength(1));
    expect(api.callsTo('/payment')[0].body).toMatchObject({
      paymentAmount: 100,
      paymentSource: 'trust',
      trustAccountId: 'ta-1',
      trustClientId: CLIENT,
      trustClientName: 'Acme Co',
    });
  });
});

describe('editing and deleting a recorded payment', () => {
  const sixPayments = [1, 2, 3, 4, 5, 6].map((n) => ({
    amount: n * 10,
    date: `2026-04-0${n}`,
    note: `Payment ${n}`,
  }));
  const paidInvoice = () => invoice({
    totalAmount: 300,
    amountPaid: 210,
    remainingBalance: 90,
    payments: sixPayments,
  });

  it('lists five payments and reveals the sixth on request', async () => {
    seed(paidInvoice());
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (6)' }));

    expect(screen.getByText('Payment 5')).toBeInTheDocument();
    expect(screen.queryByText('Payment 6')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(screen.getByText('Payment 6')).toBeInTheDocument();
  });

  it('deletes a payment by its real index, after confirming the amount being removed', async () => {
    seed(paidInvoice());
    api.delete('/payment', { invoice: paidInvoice() });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (6)' }));
    const row = screen.getByText('Payment 2').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete payment' }));

    const confirm = await screen.findByRole('dialog', { name: 'Delete payment' });
    expect(confirm).toHaveTextContent('Remove payment of $20.00 from Apr 02, 2026?');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete Payment' }));

    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].pathname).toBe(new URL(PAYMENT_URL).pathname);
    expect(api.calls('DELETE')[0].query).toEqual({ paymentIndex: ['1'] });
  });

  it('keeps the invoice on screen and names the reason when a delete is refused', async () => {
    seed(paidInvoice());
    api.delete('/payment', { status: 409, body: { error: 'Payment is reconciled and cannot be removed' } });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (6)' }));
    const row = screen.getByText('Payment 1').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete payment' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete payment' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete Payment' }));

    expect(await screen.findByText('Payment is reconciled and cannot be removed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'April Services' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Invoice not found' })).not.toBeInTheDocument();
  });

  it('sends an edited amount, date and reference for the payment at its index', async () => {
    seed(paidInvoice());
    api.patchExact(PAYMENT_URL, { invoice: paidInvoice() });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (6)' }));
    const row = screen.getByText('Payment 3').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Edit payment' }));

    const dialog = await screen.findByRole('dialog', { name: /Edit payment/i });
    const amount = within(dialog).getByPlaceholderText('0.00');
    expect(amount).toHaveValue(30);
    await userEvent.clear(amount);
    await userEvent.type(amount, '35.5');
    await userEvent.type(within(dialog).getByPlaceholderText('e.g. INV-001'), ' R-9 ');
    await userEvent.click(within(dialog).getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(api.calls('PATCH')[0].body).toEqual({
      paymentIndex: 2,
      amount: 35.5,
      date: '2026-04-03',
      note: 'Payment 3',
      invoiceNumber: 'R-9',
    });
  });

  it('shows a refused edit inside the edit dialog, which stays open', async () => {
    seed(paidInvoice());
    api.patchExact(PAYMENT_URL, { status: 400, body: { error: 'Amount exceeds invoice total' } });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (6)' }));
    const row = screen.getByText('Payment 3').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Edit payment' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit payment/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /Save/ }));

    expect(await within(dialog).findByText('Amount exceeds invoice total')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Edit payment/i })).toBeInTheDocument();
  });

  describe('when the invoice payload names each payment', () => {
    const PAYMENT_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const namedInvoice = () => invoice({
      totalAmount: 300,
      amountPaid: 30,
      remainingBalance: 270,
      payments: [
        { id: PAYMENT_IDS[0], amount: 10, date: '2026-04-01', note: 'First' },
        { id: PAYMENT_IDS[1], amount: 20, date: '2026-04-02', note: 'Second' },
      ],
    });

    it('deletes by the payment id, with its position as the fallback', async () => {
      seed(namedInvoice());
      api.delete('/payment', { invoice: namedInvoice() });
      renderView();

      await userEvent.click(await screen.findByRole('button', { name: 'Payments (2)' }));
      const row = screen.getByText('Second').closest('tr') as HTMLElement;
      await userEvent.click(within(row).getByRole('button', { name: 'Delete payment' }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete payment' });
      await userEvent.click(within(confirm).getByRole('button', { name: 'Delete Payment' }));

      await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
      expect(api.calls('DELETE')[0].query).toEqual({ paymentIndex: ['1'], paymentId: [PAYMENT_IDS[1]] });
    });

    it('sends one delete however many times the confirm button is clicked', async () => {
      seed(namedInvoice());
      api.delete('/payment', { body: { invoice: namedInvoice() }, delayMs: 150 });
      renderView();

      await userEvent.click(await screen.findByRole('button', { name: 'Payments (2)' }));
      const row = screen.getByText('First').closest('tr') as HTMLElement;
      await userEvent.click(within(row).getByRole('button', { name: 'Delete payment' }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete payment' });
      const button = within(confirm).getByRole('button', { name: 'Delete Payment' });
      // Two clicks before React re-renders, which is what a fast double click is.
      act(() => {
        button.click();
        button.click();
      });

      await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(api.calls('DELETE')).toHaveLength(1);
    });

    it('edits by the payment id', async () => {
      seed(namedInvoice());
      api.patchExact(PAYMENT_URL, { invoice: namedInvoice() });
      renderView();

      await userEvent.click(await screen.findByRole('button', { name: 'Payments (2)' }));
      const row = screen.getByText('Second').closest('tr') as HTMLElement;
      await userEvent.click(within(row).getByRole('button', { name: 'Edit payment' }));
      const dialog = await screen.findByRole('dialog', { name: /Edit payment/i });
      await userEvent.click(within(dialog).getByRole('button', { name: /Save/ }));

      await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
      expect(api.calls('PATCH')[0].body).toMatchObject({ paymentId: PAYMENT_IDS[1], paymentIndex: 1 });
    });
  });

  it('hides edit and delete on payments from a reader who cannot record payments', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.manageInvoices']);
    seed(paidInvoice());
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (6)' }));
    const row = screen.getByText('Payment 1').closest('tr') as HTMLElement;

    expect(within(row).getByRole('button', { name: 'View receipt' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Edit payment' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete payment' })).not.toBeInTheDocument();
  });
});

describe('trust reads follow trust.view', () => {
  // Red if the effect reads trust without checking trust.view: two requests the
  // backend is certain to refuse, on every invoice open.
  it('does not read trust for a member without trust.view', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seed(invoice());
    renderView();

    // The invoice rendered and its payment action is live, so the mount effects ran.
    expect(await screen.findByRole('button', { name: 'Record Payment' })).toBeInTheDocument();
    // callsTo matches a path SUFFIX, which '/trust/' never is, so filter on the segment.
    expect(api.calls().filter((c) => c.pathname.includes('/trust/'))).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Pay from Trust/ })).not.toBeInTheDocument();
  });

  // The paired positive case. Red if the guard is written so that it also
  // blocks members who do hold trust.view.
  it('reads the client balance and accounts for a member with trust.view', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments', 'trust.view']);
    seed(invoice());
    renderView();

    await screen.findByRole('button', { name: 'Record Payment' });
    await waitFor(() => expect(api.callsTo(`/trust/clients/${CLIENT}/balance`)).toHaveLength(1));
    expect(api.callsTo('/trust/accounts')).toHaveLength(1);
  });
});
