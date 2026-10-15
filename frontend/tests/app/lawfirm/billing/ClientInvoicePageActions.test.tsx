/**
 * The standalone client-invoice page beyond payments: how it loads (and fails
 * to), what the summary card derives, credit notes, payment plans, the Stripe
 * online-payment request, and deleting the invoice.
 *
 * Services stay real and only the transport is faked, so each action is
 * asserted by the request it actually sends. A refused action must leave the
 * loaded invoice on screen with a banner; only a failed LOAD may show the
 * not-found panel.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/trust.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/useUsers', () => ({
  __esModule: true,
  useLawFirmUsers: () => ({ users: [], loading: false }),
}));

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
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
import { holdResponse } from '../../../support/deferred';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../../support/permissions';
import type { Invoice } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const INVOICE_BASE = `${API}/lawfirms/${FIRM}/billing/invoices/client/${CLIENT}`;
const STRIPE_PAYMENT_BASE = `${API}/stripe/payment/${FIRM}/client/${CLIENT}/${INVOICE}`;

let api: ApiMock;

function invoice(overrides: Record<string, unknown> = {}): Invoice {
  return {
    id: INVOICE,
    invoiceName: 'March Retainer',
    invoiceNumber: 'INV-1001',
    invoiceDate: '2026-03-01',
    dueDate: null,
    clientId: CLIENT,
    status: 'unpaid',
    isPaid: false,
    totalAmount: 100,
    flatFeesAmount: 0,
    amountPaid: 0,
    totalWrittenOff: 0,
    remainingBalance: 100,
    payments: [],
    creditNotes: [],
    timeEntries: [{ id: 'te-1', name: 'Drafting', hours: 2, rate: 50, amount: 100 }],
    flatFees: [],
    expenses: [],
    auditLog: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Invoice;
}

function seed(opts: {
  invoice?: Invoice;
  invoices?: unknown;
  client?: Record<string, unknown>;
  stripe?: Parameters<ApiMock['getExact']>[1];
} = {}) {
  api.getExact(INVOICE_BASE, opts.invoices ?? { invoices: [opts.invoice ?? invoice()] });
  api.getExact(`${API}/lawfirms/${FIRM}/clients/${CLIENT}`, {
    client: opts.client ?? { id: CLIENT, name: 'Acme Holdings', email: 'billing@acme.test', clientType: 'person' },
  });
  api.getExact(`${API}/stripe/connect/${FIRM}/status`, opts.stripe ?? { connected: false, chargesEnabled: false });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/clients/${CLIENT}/balance`, { clientId: CLIENT, totalBalanceCents: 0, accountBalances: [] });
  api.getExact(`${API}/lawfirms/${FIRM}/trust/accounts`, { accounts: [] });
}

async function renderLoaded() {
  renderWithProviders(<ClientInvoiceDetailPage />);
  await screen.findByRole('heading', { name: 'March Retainer' });
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

describe('loading the invoice', () => {
  it('asks for a client before loading anything when the url has no clientId', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams(''));

    renderWithProviders(<ClientInvoiceDetailPage />);

    expect(await screen.findByText(/Client ID is required/)).toBeInTheDocument();
    expect(api.calls()).toHaveLength(0);
  });

  it('shows not-found when the client has no invoice with this id', async () => {
    seed({ invoices: { invoices: [invoice({ id: 'some-other-invoice' })] } });

    renderWithProviders(<ClientInvoiceDetailPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Invoice not found');
    expect(screen.queryByRole('heading', { name: 'March Retainer' })).not.toBeInTheDocument();
  });

  it('names the load failure rather than showing an empty invoice', async () => {
    seed({ invoices: { status: 500, body: { error: 'Billing database unavailable' } } });

    renderWithProviders(<ClientInvoiceDetailPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Billing database unavailable');
    expect(screen.getByText('Invoice not found')).toBeInTheDocument();
  });

  it('turns away a viewer without billing.viewInvoices', async () => {
    grantPermissions(['clients.view']);
    seed();

    renderWithProviders(<ClientInvoiceDetailPage />);

    expect(await screen.findByText('You do not have access to this area')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'March Retainer' })).not.toBeInTheDocument();
  });
});

describe('the summary card', () => {
  it('totals flat fees from the rendered rows, not a stale flatFeesAmount scalar', async () => {
    seed({
      invoice: invoice({
        totalAmount: 350,
        remainingBalance: 350,
        flatFeesAmount: 0,
        flatFees: [
          { id: 'ff-1', description: 'Filing fee', amount: 200 },
          { id: 'ff-2', description: 'Courier', amount: 50, allocationPercent: 50 },
        ],
      }),
    });
    await renderLoaded();

    const footer = screen.getByText('Total Flat Fees:').closest('tr')!;
    expect(within(footer).getByText('$250.00')).toBeInTheDocument();
    // A split share is labelled with its allocation.
    expect(screen.getByText('(50%)')).toBeInTheDocument();
  });

  it('shows the credit owed back to the client when payments exceed the total', async () => {
    seed({ invoice: invoice({ amountPaid: 120, remainingBalance: 0, payments: [{ date: '2026-03-02', amount: 120 }] }) });
    await renderLoaded();

    const label = screen.getByText('Credit Due');
    expect(label.parentElement).toHaveTextContent('$20.00');
    expect(screen.queryByText('Remaining Balance')).not.toBeInTheDocument();
  });

  it('shows progress against the total for a partly paid invoice', async () => {
    seed({ invoice: invoice({ amountPaid: 25, totalWrittenOff: 10, remainingBalance: 65, payments: [{ date: '2026-03-02', amount: 25 }] }) });
    await renderLoaded();

    expect(screen.getByText('35% applied')).toBeInTheDocument();
    expect(screen.getByText('$65.00 remaining')).toBeInTheDocument();
  });

  it('replaces every payment action with a paid marker once the invoice is paid', async () => {
    seed({ invoice: invoice({ status: 'paid', isPaid: true, amountPaid: 100, remainingBalance: 0, payments: [{ date: '2026-03-02', amount: 100 }] }) });
    await renderLoaded();

    expect(screen.getByText('Invoice Paid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Credit Note' })).not.toBeInTheDocument();
  });
});

describe('credit notes', () => {
  it('sends a write-off with the type as its description when none is typed', async () => {
    seed();
    api.postExact(`${INVOICE_BASE}/${INVOICE}/credit-note`, { invoice: invoice() });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '12.34');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    await waitFor(() => expect(api.callsTo('/credit-note')).toHaveLength(1));
    expect(api.callsTo('/credit-note')[0].body).toEqual({ amount: 12.34, description: 'write off', type: 'write_off' });
  });

  // The backend stores cents and answers a third decimal place with a bare 400,
  // so the dialog refuses it first, with the shared money wording.
  it('refuses 10.005 inside the dialog and sends nothing', async () => {
    seed();
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10.005');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    expect(await within(dialog).findByText('Amounts can have at most two decimal places.')).toBeInTheDocument();
    expect(api.callsTo('/credit-note')).toHaveLength(0);
  });

  // Two clicks before React re-renders the button as disabled, which is what a
  // fast double click is. Red if the second click posts a second credit.
  it('sends one credit note when Add Credit Note is clicked twice at once', async () => {
    seed();
    api.postExact(`${INVOICE_BASE}/${INVOICE}/credit-note`, { body: { invoice: invoice() }, delayMs: 150 });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '12.34');
    const save = within(dialog).getByRole('button', { name: 'Add Credit Note' });
    act(() => {
      save.click();
      save.click();
    });

    await waitFor(() => expect(api.callsTo('/credit-note')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(api.callsTo('/credit-note')).toHaveLength(1);
  });

  it('sends the chosen type and typed description', async () => {
    seed();
    api.postExact(`${INVOICE_BASE}/${INVOICE}/credit-note`, { invoice: invoice() });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Write Off/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Discount' }));
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '5');
    await userEvent.type(within(dialog).getByPlaceholderText('e.g. Courtesy discount, billing error adjustment'), 'Loyalty discount');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    await waitFor(() => expect(api.callsTo('/credit-note')).toHaveLength(1));
    expect(api.callsTo('/credit-note')[0].body).toEqual({ amount: 5, description: 'Loyalty discount', type: 'discount' });
  });

  // Red if the page's dialog drifts from the credit note dialog on the invoice
  // detail view: action order, the remaining-balance subtitle, a labelled amount.
  it('matches the invoice detail credit note dialog', async () => {
    seed();
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    expect(dialog).toHaveTextContent('Invoice: March Retainer, Remaining: $100.00');
    expect(within(dialog).getByLabelText(/^Amount/)).toBe(within(dialog).getByPlaceholderText('0.00'));
    const labels = within(dialog).getAllByRole('button').map((b) => b.textContent?.trim());
    expect(labels).toContain('Cancel');
    expect(labels.indexOf('Cancel')).toBeLessThan(labels.indexOf('Add Credit Note'));
  });

  // The page banner sits under the dialog's backdrop, so a refusal written
  // there is hidden while the form stays open. Red if the reason is not shown
  // inside the dialog.
  it('shows a refused credit note inside the dialog over the still-loaded invoice', async () => {
    seed();
    api.postExact(`${INVOICE_BASE}/${INVOICE}/credit-note`, { status: 400, body: { error: 'Credit exceeds the balance' } });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Credit exceeds the balance');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });

  // Red if a refusal from an earlier attempt is still on the form when the
  // dialog is opened again.
  it('opens a fresh credit note form without the previous refusal', async () => {
    seed();
    api.postExact(`${INVOICE_BASE}/${INVOICE}/credit-note`, { status: 400, body: { error: 'Credit exceeds the balance' } });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Credit Note' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Credit exceeds the balance');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Credit Note' })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Add Credit Note' }));
    dialog = await screen.findByRole('dialog', { name: 'Add Credit Note' });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('removes a credit note by its id and shows the credit in the summary', async () => {
    seed({
      invoice: invoice({
        totalWrittenOff: 15,
        remainingBalance: 85,
        creditNotes: [{ id: 'cn-1', amount: 15, type: 'write_off', description: 'Goodwill', createdAt: '2026-03-03T00:00:00.000Z' }],
      }),
    });
    api.deleteExact(`${INVOICE_BASE}/${INVOICE}/credit-note?creditNoteId=cn-1`, { invoice: invoice() });
    await renderLoaded();

    expect(screen.getByRole('button', { name: /Credits \/ Adjustments \(1\)/ })).toHaveTextContent('Total: $15.00');
    expect(screen.getByText('Credits / Adjustments').parentElement).toHaveTextContent('-$15.00');

    await userEvent.click(screen.getByRole('button', { name: 'Remove credit note' }));
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Credit Note' })).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].query).toEqual({ creditNoteId: ['cn-1'] });
  });

  it('shows a refused credit-note removal as a banner', async () => {
    seed({ invoice: invoice({ creditNotes: [{ id: 'cn-1', amount: 15, type: 'discount' }] }) });
    api.deleteExact(`${INVOICE_BASE}/${INVOICE}/credit-note?creditNoteId=cn-1`, { status: 403, body: { error: 'Not allowed to remove credits' } });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Remove credit note' }));
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Credit Note' })).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not allowed to remove credits');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });
});

describe('payment plans', () => {
  const PLAN_URL = `${INVOICE_BASE}/${INVOICE}/payment-plan`;

  async function openPlan() {
    await userEvent.click(screen.getByRole('button', { name: 'Setup Payment Plan' }));
    return screen.findByRole('dialog', { name: 'Set up payment plan' });
  }

  it('splits the balance into N installments whose cents add back to the balance', async () => {
    seed();
    api.postExact(PLAN_URL, { invoice: invoice() });
    await renderLoaded();

    const dialog = await openPlan();
    await userEvent.click(within(dialog).getByText('Split into N'));
    await userEvent.click(within(dialog).getByRole('button', { name: '3 payments' }));

    expect(within(dialog).getByText(/Generated Schedule Preview \(3 payments\)/)).toBeInTheDocument();
    const amounts = within(dialog).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[2].textContent);
    expect(amounts).toEqual(['$33.34', '$33.34', '$33.32']);
    expect(within(dialog).getByText('$100.00 of $100.00')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    await waitFor(() => expect(api.callsTo('/payment-plan')).toHaveLength(1));
    expect(api.callsTo('/payment-plan')[0].body).toEqual({
      installmentAmount: 33.34,
      frequencyDays: 30,
      planStartDate: dayjs().add(7, 'day').format('YYYY-MM-DD'),
    });
  });

  it('schedules a fixed installment weekly with a smaller final payment', async () => {
    seed();
    api.postExact(PLAN_URL, { invoice: invoice() });
    await renderLoaded();

    const dialog = await openPlan();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '40');
    await userEvent.click(within(dialog).getByRole('button', { name: /Monthly/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Weekly' }));

    const start = dayjs().add(7, 'day');
    const rows = within(dialog).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toEqual([
      ['Installment 1 of 3', start.format('MMM DD, YYYY'), '$40.00'],
      ['Installment 2 of 3', start.add(7, 'day').format('MMM DD, YYYY'), '$40.00'],
      ['Installment 3 of 3', start.add(14, 'day').format('MMM DD, YYYY'), '$20.00'],
    ]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    await waitFor(() => expect(api.callsTo('/payment-plan')).toHaveLength(1));
    expect(api.callsTo('/payment-plan')[0].body).toMatchObject({ installmentAmount: 40, frequencyDays: 7 });
  });

  it('creates one plan when Save plan is clicked twice at once', async () => {
    seed();
    api.postExact(PLAN_URL, { body: { invoice: invoice() }, delayMs: 150 });
    await renderLoaded();

    const dialog = await openPlan();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '40');
    const save = within(dialog).getByRole('button', { name: 'Save plan' });
    act(() => {
      save.click();
      save.click();
    });

    await waitFor(() => expect(api.callsTo('/payment-plan')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(api.callsTo('/payment-plan')).toHaveLength(1);
  });

  it('keeps Save disabled until an installment is entered', async () => {
    seed();
    await renderLoaded();

    const dialog = await openPlan();

    expect(within(dialog).getByRole('button', { name: 'Save plan' })).toBeDisabled();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '10');
    expect(within(dialog).getByRole('button', { name: 'Save plan' })).toBeEnabled();
  });

  // Red if the refusal is written to the page banner, under the dialog's
  // backdrop, instead of inside the still-open plan dialog.
  it('shows a refused plan inside the dialog over the still-loaded invoice', async () => {
    seed();
    api.postExact(PLAN_URL, { status: 400, body: { error: 'Installment too small' } });
    await renderLoaded();

    const dialog = await openPlan();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Installment too small');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });

  // Red if a refusal from an earlier attempt is still on the form when the
  // dialog is opened again.
  it('opens a fresh plan form without the previous refusal', async () => {
    seed();
    api.postExact(PLAN_URL, { status: 400, body: { error: 'Installment too small' } });
    await renderLoaded();

    let dialog = await openPlan();
    await userEvent.type(within(dialog).getByPlaceholderText('0.00'), '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Installment too small');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set up payment plan' })).not.toBeInTheDocument());

    dialog = await openPlan();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers removal instead of setup once a plan is on, and removes it', async () => {
    seed({ invoice: invoice({ paymentPlan: { enabled: true, installmentAmount: 50, frequencyDays: 30 } }) });
    api.deleteExact(PLAN_URL, { invoice: invoice() });
    await renderLoaded();

    expect(screen.queryByRole('button', { name: 'Setup Payment Plan' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Payment Plan' }));
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Payment Plan' })).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].pathname).toBe(`/api/lawfirms/${FIRM}/billing/invoices/client/${CLIENT}/${INVOICE}/payment-plan`);
  });

  it('shows a refused plan removal as a banner', async () => {
    seed({ invoice: invoice({ paymentPlan: { enabled: true, installmentAmount: 50, frequencyDays: 30 } }) });
    api.deleteExact(PLAN_URL, { status: 500, body: { error: 'Could not remove plan' } });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Payment Plan' }));
    expect(api.calls('DELETE')).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove Payment Plan' })).getByRole('button', { name: 'Remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove plan');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });
});

describe('online payment through Stripe', () => {
  const connected = { connected: true, chargesEnabled: true, directCharges: false };
  const quote = {
    invoiceCents: 50_000,
    firmDefault: { card: true, bank: true },
    emailTo: ['billing@client.example.test'],
    methods: [
      { method: 'card', paidBy: 'client', feeCents: 1_998, clientPaysCents: 51_998, firmReceivesCents: 50_000 },
      { method: 'bank', paidBy: 'client', feeCents: 864, clientPaysCents: 50_864, firmReceivesCents: 50_000 },
    ],
  };

  const requestButton = () => screen.queryByRole('button', { name: 'Request Payment via Stripe' });
  const cancelButton = () => screen.queryByRole('button', { name: 'Cancel Payment Link' });

  it('shows Request Payment busy and disabled while Stripe is checked, then enables it', async () => {
    const held = holdResponse();
    seed({ stripe: held.handler });
    await renderLoaded();
    await held.untilRequested();

    expect(requestButton()).toBeDisabled();

    await act(async () => held.release(connected));

    await waitFor(() => expect(requestButton()).toBeEnabled());
  });

  it('shows Cancel Payment Link busy and disabled for an open link while Stripe is checked', async () => {
    const held = holdResponse();
    seed({ stripe: held.handler, invoice: invoice({ stripePaymentRequested: true, stripePaymentStatus: 'pending' }) });
    await renderLoaded();
    await held.untilRequested();

    expect(cancelButton()).toBeDisabled();

    await act(async () => held.release(connected));

    await waitFor(() => expect(cancelButton()).toBeEnabled());
  });

  it('offers no payment request when the Stripe check fails', async () => {
    seed({ stripe: { status: 500, body: { error: 'Stripe unavailable' } } });
    await renderLoaded();
    await waitFor(() => expect(api.callsTo(`/stripe/connect/${FIRM}/status`)).toHaveLength(1));

    await waitFor(() => expect(requestButton()).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeInTheDocument();
  });

  it('offers no online payment when Stripe charges are not enabled', async () => {
    seed({ stripe: { connected: true, chargesEnabled: false } });
    await renderLoaded();
    await waitFor(() => expect(api.callsTo(`/stripe/connect/${FIRM}/status`)).toHaveLength(1));

    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Payment via Stripe' })).not.toBeInTheDocument();
  });

  it('sends the payment request after a confirm', async () => {
    seed({ stripe: connected });
    api.getExact(`${STRIPE_PAYMENT_BASE}/fee-quote`, quote);
    api.postExact(`${STRIPE_PAYMENT_BASE}/request`, { message: 'Payment link emailed', paymentUrl: 'https://app.test/pay/tok' });
    await renderLoaded();

    await userEvent.click(await screen.findByRole('button', { name: 'Request Payment via Stripe' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
    expect(api.callsTo('/request')).toHaveLength(0);
    // The firm sees card and bank transfer apart, and where the link goes,
    // before anything is sent.
    expect(await within(dialog).findByRole('listitem', { name: 'Card' })).toHaveTextContent('Card: Client pays the $19.98 fee. You get $500.00.');
    expect(within(dialog).getByRole('listitem', { name: 'Bank transfer' })).toHaveTextContent('Bank transfer: Client pays the $8.64 fee. You get $500.00.');
    // Emailing is the default, and the dialog says where it will go.
    expect(dialog).toHaveTextContent("We'll email it to billing@client.example.test.");
    // The box starts from the firm setting the quote reports.
    expect(within(dialog).getByRole('checkbox', { name: /^Client pays the processing fee/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Email Payment Link' }));

    await waitFor(() => expect(api.callsTo('/request')).toHaveLength(1));
    // Breaks if the request goes out without the choice shown in the dialog.
    expect(api.calls('POST').find((call) => call.url.endsWith('/request'))?.body)
      .toEqual({ isCardFeePassedOn: true, isBankFeePassedOn: true, sendEmail: true });
  });

  it('shows a refused payment request as a banner', async () => {
    seed({ stripe: connected });
    api.getExact(`${STRIPE_PAYMENT_BASE}/fee-quote`, quote);
    api.postExact(`${STRIPE_PAYMENT_BASE}/request`, { status: 400, body: { error: 'Client has no email address' } });
    await renderLoaded();

    await userEvent.click(await screen.findByRole('button', { name: 'Request Payment via Stripe' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Email Payment Link' }));

    expect(await within(dialog).findByText('Client has no email address')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });

  it('voids a pending request instead of offering a second one', async () => {
    seed({ stripe: connected, invoice: invoice({ stripePaymentRequested: true, stripePaymentStatus: 'pending' }) });
    api.postExact(`${STRIPE_PAYMENT_BASE}/void`, { message: 'voided' });
    await renderLoaded();

    expect(screen.getByText('Online payment requested')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Payment Link' }));
    expect(screen.queryByRole('button', { name: 'Request Payment via Stripe' })).not.toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Cancel Payment Link' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel Payment Link' }));

    await waitFor(() => expect(api.callsTo('/void')).toHaveLength(1));
  });

  it('says what cancelling the payment link does', async () => {
    seed({ stripe: connected, invoice: invoice({ stripePaymentRequested: true, stripePaymentStatus: 'pending' }) });
    await renderLoaded();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Payment Link' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancel Payment Link' });
    expect(dialog).toHaveTextContent('The client will no longer be able to pay with the current link. You can send a new one afterward.');
  });

  it('shows the processing fee a client paid on top of a payment', async () => {
    seed({
      invoice: invoice({
        amountPaid: 40,
        remainingBalance: 60,
        payments: [{ id: 'pay-1', amount: 40, date: '2026-03-10', paymentSource: 'stripe', surchargeCents: 186 }],
      }),
    });
    await renderLoaded();

    expect(await screen.findByText('+ $1.86 processing fee paid by client')).toBeInTheDocument();
  });

  it('tells the firm how much card fee to refund on a credit card payment', async () => {
    seed({
      invoice: invoice({
        amountPaid: 40,
        remainingBalance: 60,
        // Taken through the card form: a PaymentIntent and no Checkout session.
        payments: [{ id: 'pay-1', amount: 40, date: '2026-03-10', paymentSource: 'stripe', stripePaymentIntentId: 'pi_card_1', surchargeCents: 186 }],
      }),
    });
    await renderLoaded();

    expect(await screen.findByText('Includes a $1.86 card fee. Refund the same share of it with any refund.')).toBeInTheDocument();
  });

  it('gives no card refund guidance for a bank transfer fee taken through Checkout', async () => {
    seed({
      invoice: invoice({
        amountPaid: 40,
        remainingBalance: 60,
        payments: [{ id: 'pay-1', amount: 40, date: '2026-03-10', paymentSource: 'stripe', stripeSessionId: 'cs_bank_1', stripePaymentIntentId: 'pi_bank_1', surchargeCents: 186 }],
      }),
    });
    await renderLoaded();

    expect(await screen.findByText('+ $1.86 processing fee paid by client')).toBeInTheDocument();
    expect(screen.queryByText(/card fee\. Refund the same share/)).not.toBeInTheDocument();
  });

  it('shows a refused void as a banner', async () => {
    seed({ stripe: connected, invoice: invoice({ stripePaymentRequested: true, stripePaymentStatus: 'pending' }) });
    api.postExact(`${STRIPE_PAYMENT_BASE}/void`, { status: 409, body: { error: 'Payment already captured' } });
    await renderLoaded();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Payment Link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel Payment Link' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel Payment Link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Payment already captured');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
  });
});

describe('deleting the invoice', () => {
  const DELETE_URL = `${INVOICE_BASE}/${INVOICE}`;

  it('is not offered to a viewer without billing.manageInvoices', async () => {
    grantPermissions(['billing.viewInvoices']);
    seed();
    await renderLoaded();

    expect(screen.getByRole('button', { name: 'Download Invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Invoice' })).not.toBeInTheDocument();
  });

  it('deletes after a confirm and returns to the client', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.manageInvoices']);
    seed();
    api.deleteExact(DELETE_URL, { status: 204, text: '' });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Delete Invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Invoice' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Invoice' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/clients/${CLIENT}`));
    expect(api.calls('DELETE')).toHaveLength(1);
  });

  it('keeps the invoice on screen with a banner when the delete is refused', async () => {
    seed();
    api.deleteExact(DELETE_URL, { status: 409, body: { error: 'Invoice has recorded payments' } });
    await renderLoaded();

    await userEvent.click(screen.getByRole('button', { name: 'Delete Invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Invoice' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Invoice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invoice has recorded payments');
    expect(screen.getByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
    expect(screen.queryByText('Invoice not found')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('an organization client', () => {
  const org = { id: CLIENT, name: 'Globex Corp', email: 'ap@globex.test', clientType: 'company' };

  it('offers the member roster to a viewer who can see clients', async () => {
    seed({ client: org });
    await renderLoaded();

    expect(await screen.findByRole('button', { name: 'Globex Corp' })).toBeInTheDocument();
  });

  it('shows the name as plain text to a billing-only viewer', async () => {
    grantPermissions(['billing.viewInvoices']);
    seed({ client: org });
    await renderLoaded();

    expect(await screen.findByText('Globex Corp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Globex Corp' })).not.toBeInTheDocument();
    // Independent of how the button is named: the org name sits inside no button.
    expect(screen.getByText('Globex Corp').closest('button')).toBeNull();
  });
});
