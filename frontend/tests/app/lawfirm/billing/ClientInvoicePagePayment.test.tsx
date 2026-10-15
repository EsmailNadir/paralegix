/**
 * Recording, editing and deleting a payment on the standalone client-invoice
 * page, including paying from the client's trust balance.
 *
 * Every service stays real and only the transport is faked, so these assert the
 * exact request body the backend receives. The money rules worth failing on:
 * the default amount is the remaining balance, an overpayment needs an explicit
 * opt-in, and a trust payment is refused in the browser when the chosen trust
 * account holds less than the amount (compared in integer cents).
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/useUsers', () => ({
  __esModule: true,
  useLawFirmUsers: () => ({
    users: [{ uid: 'user-1', name: 'Alice Partner', email: 'alice@firm.test' }],
    loading: false,
  }),
}));

const useParamsMock = jest.fn();
const useSearchParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/lawfirm/firm-a/client-invoice/inv-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => useSearchParamsMock(),
}));

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';

import ClientInvoiceDetailPage from '@/app/lawfirm/[lawFirmId]/client-invoice/[invoiceId]/page';
import { installApiMock, type ApiMock } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../../support/permissions';
import type { Invoice } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const INVOICE_BASE = `${API}/lawfirms/${FIRM}/billing/invoices/client/${CLIENT}`;
const PAYMENT_URL = `${INVOICE_BASE}/${INVOICE}/payment`;

let api: ApiMock;

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE,
    invoiceName: 'March Retainer',
    invoiceNumber: 'INV-1001',
    invoiceDate: '2026-03-01',
    dueDate: null,
    clientId: CLIENT,
    status: 'unpaid',
    isPaid: false,
    totalAmount: 1234.5,
    flatFeesAmount: 0,
    amountPaid: 0,
    totalWrittenOff: 0,
    remainingBalance: 1234.5,
    payments: [],
    creditNotes: [],
    timeEntries: [{ id: 'te-1', name: 'Drafting', description: 'Drafted motion', hours: 5, rate: 246.9, amount: 1234.5 }],
    flatFees: [],
    expenses: [],
    auditLog: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Invoice;
}

function seed(opts: {
  invoice?: Invoice;
  trustBalance?: { totalBalanceCents: number; accountBalances: Array<{ clientId: string; trustAccountId: string; balanceCents: number }> };
  trustAccounts?: Array<{ id: string; name: string; status: string }>;
} = {}) {
  api.getExact(INVOICE_BASE, { invoices: [opts.invoice ?? invoice()] });
  api.getExact(`${API}/lawfirms/${FIRM}/clients/${CLIENT}`, { client: { id: CLIENT, name: 'Acme Holdings', email: 'billing@acme.test', clientType: 'person' } });
  api.getExact(`${API}/stripe/connect/${FIRM}/status`, { connected: false, chargesEnabled: false });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/clients/${CLIENT}/balance`, opts.trustBalance ?? { clientId: CLIENT, totalBalanceCents: 0, accountBalances: [] });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/accounts`, { accounts: opts.trustAccounts ?? [] });
}

async function renderLoaded() {
  renderWithProviders(<ClientInvoiceDetailPage />);
  await screen.findByRole('heading', { name: 'March Retainer' });
}

async function openPaymentModal() {
  await userEvent.click(screen.getByRole('button', { name: 'Record Payment' }));
  return screen.findByRole('dialog', { name: 'Record Payment' });
}

beforeEach(() => {
  api = installApiMock();
  useParamsMock.mockReturnValue({ lawFirmId: FIRM, invoiceId: INVOICE });
  useSearchParamsMock.mockReturnValue(new URLSearchParams(`clientId=${CLIENT}`));
});

afterEach(() => {
  api.restore();
  resetPermissions();
  jest.clearAllMocks();
});

describe('recording a payment', () => {
  it('prefills the remaining balance and sends it with today as the paid date', async () => {
    seed();
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    await renderLoaded();

    const dialog = await openPaymentModal();
    const amount = within(dialog).getByPlaceholderText('0.00');
    expect(amount).toHaveValue(1234.5);
    await userEvent.type(within(dialog).getByPlaceholderText('e.g. Check #1234, Wire transfer, etc.'), '  Check 881  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(1));
    expect(api.callsTo(`/${INVOICE}/payment`)[0].body).toEqual({
      paymentAmount: 1234.5,
      paidDate: dayjs().format('YYYY-MM-DD'),
      nextPaymentDate: null,
      paymentNote: 'Check 881',
    });
    // A successful save reloads the invoice so the new balance is what shows.
    await waitFor(() => expect(api.callsTo(`/billing/invoices/client/${CLIENT}`)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Record Payment' })).not.toBeInTheDocument());
  });

  // Two clicks before React re-renders the button as disabled, which is what a
  // fast double click is. Red if the second click records a second payment.
  it('records one payment when Record Payment is clicked twice at once', async () => {
    seed();
    api.putExact(PAYMENT_URL, { body: { invoice: invoice() }, delayMs: 150 });
    await renderLoaded();

    const dialog = await openPaymentModal();
    const save = within(dialog).getByRole('button', { name: 'Record Payment' });
    act(() => {
      save.click();
      save.click();
    });

    await waitFor(() => expect(api.calls('PUT')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(api.calls('PUT')).toHaveLength(1);
  });

  it('keeps Save disabled for a zero amount', async () => {
    seed();
    await renderLoaded();

    const dialog = await openPaymentModal();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '0');

    expect(within(dialog).getByRole('button', { name: 'Record Payment' })).toBeDisabled();
  });

  it('refuses an amount above the balance until overpayment is explicitly allowed', async () => {
    seed();
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    await renderLoaded();

    const dialog = await openPaymentModal();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '1500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Payment exceeds remaining balance');
    expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Allow overpayment' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(1));
    expect(api.callsTo(`/${INVOICE}/payment`)[0].body).toMatchObject({ paymentAmount: 1500, allowOverpayment: true });
  });

  // The page banner sits under the dialog's backdrop, so a refusal written
  // there is hidden while the form stays open. Red if the reason is not shown
  // inside the dialog.
  it('shows a refused payment inside the dialog and keeps the invoice on screen', async () => {
    seed();
    api.putExact(PAYMENT_URL, { status: 409, body: { error: 'Invoice was paid by another user' } });
    await renderLoaded();

    const dialog = await openPaymentModal();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Invoice was paid by another user');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
    expect(screen.queryByText('Invoice not found')).not.toBeInTheDocument();
    // The form stays open so the amount can be corrected and retried.
    expect(screen.getByRole('dialog', { name: 'Record Payment' })).toBeInTheDocument();
  });

  // Red if a refusal from an earlier attempt is still on the form when the
  // dialog is opened again.
  it('opens a fresh payment form without the previous refusal', async () => {
    seed();
    api.putExact(PAYMENT_URL, { status: 409, body: { error: 'Invoice was paid by another user' } });
    await renderLoaded();

    let dialog = await openPaymentModal();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Invoice was paid by another user');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Record Payment' })).not.toBeInTheDocument());

    dialog = await openPaymentModal();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  // The standalone invoice page has its own payment form. Red if it sends a
  // sub-cent amount.
  it('refuses 10.999 under the amount field and sends nothing', async () => {
    seed();
    await renderLoaded();

    const dialog = await openPaymentModal();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '10.999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Amounts can have at most two decimal places.',
    );
    expect(api.calls('PUT')).toHaveLength(0);
  });
});

// The page renders the same Record Payment dialog as the invoice detail view and
// the client Billing tab. Red if it goes back to a hand-built copy, which had
// drifted on every one of these.
describe('the shared Record Payment dialog', () => {
  it('puts Cancel before the Record Payment action', async () => {
    seed();
    await renderLoaded();

    const dialog = await openPaymentModal();
    const labels = within(dialog).getAllByRole('button').map((b) => b.textContent?.trim());
    expect(labels).toContain('Cancel');
    expect(labels.indexOf('Cancel')).toBeLessThan(labels.indexOf('Record Payment'));
  });

  it('warns by how much an amount overpays the balance', async () => {
    seed();
    await renderLoaded();

    const dialog = await openPaymentModal();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '1500');

    expect(within(dialog).getByText('Overpayment of $265.50')).toBeInTheDocument();
  });

  it('offers no overpayment opt-in when nothing is left to pay', async () => {
    seed({ invoice: invoice({ amountPaid: 1234.5, remainingBalance: 0 } as Partial<Invoice>) });
    await renderLoaded();

    const dialog = await openPaymentModal();
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.type(amount, '10');

    expect(amount).toHaveValue(10);
    expect(within(dialog).queryByRole('checkbox', { name: 'Allow overpayment' })).not.toBeInTheDocument();
  });

  it('sends the typed invoice number with the payment', async () => {
    seed();
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    await renderLoaded();

    const dialog = await openPaymentModal();
    await userEvent.type(within(dialog).getByLabelText('Invoice Number'), '  RCPT-77  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(1));
    expect(api.callsTo(`/${INVOICE}/payment`)[0].body).toMatchObject({ invoiceNumber: 'RCPT-77' });
  });

  it('applies the payment to the chosen unpaid installment', async () => {
    const planned = invoice({
      paymentPlan: {
        enabled: true,
        installmentAmount: 411.5,
        frequencyDays: 30,
        planStartDate: '2026-03-15',
        expectedPayments: [
          { dueDate: '2026-03-15', amount: 411.5, status: 'paid' },
          { dueDate: '2026-04-15', amount: 411.5, status: 'pending' },
          { dueDate: '2026-05-15', amount: 411.5, status: 'pending' },
        ],
      },
    } as unknown as Partial<Invoice>);
    seed({ invoice: planned });
    api.putExact(PAYMENT_URL, { invoice: planned });
    await renderLoaded();

    const dialog = await openPaymentModal();
    await userEvent.click(within(dialog).getByRole('button', { name: /Apply to/ }));
    // The paid first installment is not offered; the third is listed second.
    await userEvent.click(await screen.findByRole('option', { name: /^Installment 2 · due May 15, 2026/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(1));
    expect(api.callsTo(`/${INVOICE}/payment`)[0].body).toMatchObject({ paymentAmount: 411.5, installmentIndex: 2 });
  });
});

describe('paying from trust', () => {
  const twoAccounts = [
    { id: 'acct-1', name: 'IOLTA Main', status: 'active' },
    { id: 'acct-2', name: 'IOLTA Secondary', status: 'active' },
    { id: 'acct-3', name: 'Closed Account', status: 'closed' },
  ];

  it('shows the trust balance and that it covers the invoice', async () => {
    seed({
      invoice: invoice({ totalAmount: 100, remainingBalance: 100 } as Partial<Invoice>),
      trustBalance: { totalBalanceCents: 10000, accountBalances: [{ clientId: CLIENT, trustAccountId: 'acct-1', balanceCents: 10000 }] },
      trustAccounts: twoAccounts,
    });
    await renderLoaded();

    expect(await screen.findByText('$100.00 available')).toBeInTheDocument();
    expect(screen.getByText('Covers balance')).toBeInTheDocument();
  });

  it('does not claim a trust balance covers the invoice when it is one cent short', async () => {
    seed({
      invoice: invoice({ totalAmount: 100, remainingBalance: 100 } as Partial<Invoice>),
      trustBalance: { totalBalanceCents: 9999, accountBalances: [{ clientId: CLIENT, trustAccountId: 'acct-1', balanceCents: 9999 }] },
      trustAccounts: twoAccounts,
    });
    await renderLoaded();

    expect(await screen.findByText('$99.99 available')).toBeInTheDocument();
    expect(screen.queryByText('Covers balance')).not.toBeInTheDocument();
  });

  it('sends a trust-sourced payment against the first active account', async () => {
    seed({
      invoice: invoice({ totalAmount: 100, remainingBalance: 100 } as Partial<Invoice>),
      trustBalance: { totalBalanceCents: 10000, accountBalances: [{ clientId: CLIENT, trustAccountId: 'acct-1', balanceCents: 10000 }] },
      trustAccounts: twoAccounts,
    });
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    await renderLoaded();
    await screen.findByText('$100.00 available');

    const dialog = await openPaymentModal();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Pay from trust account/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(1));
    expect(api.callsTo(`/${INVOICE}/payment`)[0].body).toEqual({
      paymentAmount: 100,
      paidDate: dayjs().format('YYYY-MM-DD'),
      nextPaymentDate: null,
      paymentSource: 'trust',
      trustAccountId: 'acct-1',
      trustClientId: CLIENT,
      trustClientName: 'Acme Holdings',
    });
  });

  it('refuses a trust payment larger than the selected account holds, even when the total covers it', async () => {
    seed({
      invoice: invoice({ totalAmount: 100, remainingBalance: 100 } as Partial<Invoice>),
      // All of the client's trust money sits in the first account.
      trustBalance: { totalBalanceCents: 10000, accountBalances: [{ clientId: CLIENT, trustAccountId: 'acct-1', balanceCents: 10000 }] },
      trustAccounts: twoAccounts,
    });
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    await renderLoaded();
    await screen.findByText('$100.00 available');

    const dialog = await openPaymentModal();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Pay from trust account/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /IOLTA Main/ }));
    // The closed account is filtered out of the choices.
    expect(screen.queryByRole('option', { name: 'Closed Account' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'IOLTA Secondary' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Insufficient trust balance. Available: $0.00');
    expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(0);
  });

  it('refuses a trust payment one cent above the account balance', async () => {
    seed({
      invoice: invoice({ totalAmount: 100, remainingBalance: 100 } as Partial<Invoice>),
      trustBalance: { totalBalanceCents: 5000, accountBalances: [{ clientId: CLIENT, trustAccountId: 'acct-1', balanceCents: 5000 }] },
      trustAccounts: twoAccounts,
    });
    api.putExact(PAYMENT_URL, { invoice: invoice() });
    await renderLoaded();
    await screen.findByText('$50.00 available');

    const dialog = await openPaymentModal();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Pay from trust account/ }));
    const amount = within(dialog).getByPlaceholderText('0.00');
    await userEvent.clear(amount);
    await userEvent.type(amount, '50.01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Insufficient trust balance. Available: $50.00');
    expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(0);

    // Exactly the balance goes through.
    await userEvent.clear(amount);
    await userEvent.type(amount, '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));
    await waitFor(() => expect(api.callsTo(`/${INVOICE}/payment`)).toHaveLength(1));
    expect(api.callsTo(`/${INVOICE}/payment`)[0].body).toMatchObject({ paymentAmount: 50, trustAccountId: 'acct-1' });
  });
});

describe('the payment history', () => {
  const paid = () => invoice({
    amountPaid: 300,
    remainingBalance: 934.5,
    payments: [
      { date: '2026-03-05', amount: 200, note: 'Check 1', recordedBy: 'user-1', paymentSource: 'trust' },
      { date: '2026-03-06', amount: 100, note: '', recordedBy: 'stripe', paymentSource: 'stripe' },
    ],
  } as unknown as Partial<Invoice>);

  it('names who recorded each payment and totals them', async () => {
    seed({ invoice: paid() });
    await renderLoaded();

    expect(screen.getByRole('button', { name: /Payments \(2\)/ })).toHaveTextContent('Total: $300.00');
    const rows = screen.getAllByRole('row');
    const trustRow = rows.find((r) => within(r).queryByText('Check 1'))!;
    expect(within(trustRow).getByText('Alice Partner')).toBeInTheDocument();
    expect(within(trustRow).getByText('Trust')).toBeInTheDocument();
    // A Stripe-recorded payment is attributed to Stripe, not to a raw uid.
    const stripeRow = rows.find((r) => within(r).queryByText('Mar 06, 2026'))!;
    expect(within(stripeRow).getAllByText('Stripe')).toHaveLength(2);
    expect(within(stripeRow).queryByText('stripe')).not.toBeInTheDocument();
  });

  it('edits a payment with the changed amount, the original date and the note', async () => {
    seed({ invoice: paid() });
    api.patchExact(PAYMENT_URL, { invoice: paid() });
    await renderLoaded();

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit payment' })[0]);
    const amountInput = screen.getByDisplayValue('200.00');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '175.25');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(api.calls('PATCH')[0].body).toEqual({ paymentIndex: 0, amount: 175.25, date: '2026-03-05', note: 'Check 1' });
  });

  it('blocks an edit to a zero amount without calling the API', async () => {
    seed({ invoice: paid() });
    await renderLoaded();

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit payment' })[1]);
    const amountInput = screen.getByDisplayValue('100.00');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount greater than zero.');
    expect(api.calls('PATCH')).toHaveLength(0);
  });

  it('refuses an edit to 10.005 without calling the API', async () => {
    seed({ invoice: paid() });
    await renderLoaded();

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit payment' })[1]);
    const amountInput = screen.getByDisplayValue('100.00');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '10.005');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Amounts can have at most two decimal places.');
    expect(api.calls('PATCH')).toHaveLength(0);
  });

  it('shows a refused edit as a banner over the still-loaded invoice', async () => {
    seed({ invoice: paid() });
    api.patchExact(PAYMENT_URL, { status: 403, body: { error: 'You cannot edit payments' } });
    await renderLoaded();

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit payment' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot edit payments');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });

  it('deletes the chosen payment by its index after a confirm', async () => {
    seed({ invoice: paid() });
    api.deleteExact(`${PAYMENT_URL}?paymentIndex=1`, { invoice: invoice() });
    await renderLoaded();

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete payment' })[1]);
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].query).toEqual({ paymentIndex: ['1'] });
  });

  describe('when the invoice payload names each payment', () => {
    const ID_FIRST = '11111111-1111-4111-8111-111111111111';
    const ID_SECOND = '22222222-2222-4222-8222-222222222222';
    const named = () => invoice({
      amountPaid: 300,
      remainingBalance: 934.5,
      payments: [
        { id: ID_FIRST, date: '2026-03-05', amount: 200, note: 'Check 1', paymentSource: 'external' },
        { id: ID_SECOND, date: '2026-03-06', amount: 100, note: 'Check 2', paymentSource: 'external' },
      ],
    } as unknown as Partial<Invoice>);

    it('deletes by the payment id, with its position as the fallback', async () => {
      seed({ invoice: named() });
      api.delete('/payment', { invoice: invoice() });
      await renderLoaded();

      await userEvent.click(screen.getAllByRole('button', { name: 'Delete payment' })[1]);
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
      expect(api.calls('DELETE')[0].query).toEqual({ paymentIndex: ['1'], paymentId: [ID_SECOND] });
    });

    it('sends one delete when the confirm button is clicked twice at once', async () => {
      seed({ invoice: named() });
      api.delete('/payment', { body: { invoice: invoice() }, delayMs: 150 });
      await renderLoaded();

      await userEvent.click(screen.getAllByRole('button', { name: 'Delete payment' })[0]);
    expect(await screen.findByRole('dialog', { name: 'Delete Payment' })).toBeInTheDocument();
      const confirm = screen.getByRole('button', { name: 'Delete' });
      act(() => {
        confirm.click();
        confirm.click();
      });

      await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(api.calls('DELETE')).toHaveLength(1);
    });

    it('edits by the payment id', async () => {
      seed({ invoice: named() });
      api.patchExact(PAYMENT_URL, { invoice: named() });
      await renderLoaded();

      await userEvent.click(screen.getAllByRole('button', { name: 'Edit payment' })[1]);
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
      expect(api.calls('PATCH')[0].body).toMatchObject({ paymentId: ID_SECOND, paymentIndex: 1 });
    });
  });

  it('shows a refused delete as a banner over the still-loaded invoice', async () => {
    seed({ invoice: paid() });
    api.deleteExact(`${PAYMENT_URL}?paymentIndex=0`, { status: 500, body: { error: 'Ledger locked' } });
    await renderLoaded();

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete payment' })[0]);
    expect(await screen.findByRole('dialog', { name: 'Delete Payment' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ledger locked');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });
});

describe('trust reads follow trust.view', () => {
  // Red if the effect reads trust without checking trust.view: two requests the
  // backend is certain to refuse, on every invoice open.
  it('does not read trust for a member without trust.view', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seed();
    await renderLoaded();

    // The page rendered and its payment action is live, so the mount effects ran.
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeInTheDocument();
    // callsTo matches a path SUFFIX, which '/trust/' never is, so filter on the segment.
    expect(api.calls().filter((c) => c.pathname.includes('/trust/'))).toHaveLength(0);
  });

  // The paired positive case. Red if the guard also blocks members who do hold
  // trust.view.
  it('reads the client balance and accounts for a member with trust.view', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments', 'trust.view']);
    seed();
    await renderLoaded();

    await waitFor(() => expect(api.callsTo(`/trust/clients/${CLIENT}/balance`)).toHaveLength(1));
    expect(api.callsTo('/trust/accounts')).toHaveLength(1);
  });
});
