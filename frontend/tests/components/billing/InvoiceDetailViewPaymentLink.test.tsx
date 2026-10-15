/**
 * The invoice page's one secure payment link: requested from the summary or
 * for one payment-plan row, shown on the row it charges, cancelled from either
 * place, and the processing fee a client paid through it shown on the payment.
 *
 * Driven through the real billing service with only the transport faked.
 * RED IF: a plan row's "Send payment link" opens the dialog on the full
 * balance; the row the open link charges does not say so or cannot cancel it;
 * a cancel goes anywhere but the invoice's one void route; the summary still
 * routes through a "whole vs installment" picker; the row menu's link actions
 * follow a different permission from the summary's request button; or a
 * client-paid processing fee is missing from the payment.
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
const TRUST = `${API}/lawfirms/${FIRM}/trust`;
const PAYMENT_BASE = `${API}/stripe/payment/${FIRM}/client/${CLIENT}/${INVOICE}`;

let api: ApiMock;

const quote = {
  invoiceCents: 5_000,
  firmDefault: { card: false, bank: false },
  emailTo: ['ap@acme.test'],
  methods: [
    { method: 'card', paidBy: 'firm', feeCents: 175, clientPaysCents: 5_000, firmReceivesCents: 4_825 },
    { method: 'bank', paidBy: 'firm', feeCents: 40, clientPaysCents: 5_000, firmReceivesCents: 4_960 },
  ],
};

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
    totalAmount: 150,
    totalHours: 3,
    flatFeesAmount: 0,
    amountPaid: 0,
    totalWrittenOff: 0,
    remainingBalance: 150,
    payments: [],
    creditNotes: [],
    timeEntries: [{ id: 'te-1', description: 'Drafted engagement letter', hours: 3, rate: 50, amount: 150 }],
    flatFees: [],
    expenses: [],
    auditLog: [],
    stripePaymentRequested: false,
    paymentPlan: {
      enabled: true,
      installmentAmount: 50,
      frequencyDays: 30,
      planStartDate: '2999-01-01',
      expectedPayments: [
        { id: 'ep-1', dueDate: '2999-01-01', amount: 50, status: 'pending', matchedPaymentIndex: null },
        { id: 'ep-2', dueDate: '2999-02-01', amount: 50, status: 'pending', matchedPaymentIndex: null },
        { id: 'ep-3', dueDate: '2999-03-01', amount: 50, status: 'pending', matchedPaymentIndex: null },
      ],
    },
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  } as Invoice;
}

/** An invoice whose open payment link charges the second installment. */
function linkOpenFor(installmentId: string): Invoice {
  return invoice({
    stripePaymentRequested: true,
    stripePaymentStatus: 'pending',
    paymentLinkUrl: 'https://app.test/pay/tok_open',
    payLinkInstallmentId: installmentId,
  });
}

function seed(seeded: Invoice) {
  api.getExact(LIST_URL, { invoices: [seeded] });
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${FIRM}/status`, { connected: true, chargesEnabled: true });
  api.get(`/clients/${CLIENT}`, { client: { id: CLIENT, name: 'Acme Co', email: 'ap@acme.test' } as Client });
  api.get('/clients/lookup', { items: [], hasMore: false });
  api.getExact(`${TRUST}/clients/${CLIENT}/balance`, { totalBalanceCents: 0, accountBalances: [] });
  api.getExact(`${TRUST}/accounts`, { accounts: [] });
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

async function openPlanTab() {
  await userEvent.click(await screen.findByRole('button', { name: /^Payment Plan/ }));
}

/** The plan table row holding a given due date. */
async function planRow(dueDate: string) {
  const cell = await screen.findByText(dueDate);
  return cell.closest('tr') as HTMLElement;
}

async function openRowMenu(dueDate: string) {
  const row = await planRow(dueDate);
  await userEvent.click(within(row).getByRole('button', { name: 'More installment actions' }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  api = installApiMock();
  grantPermissions(['billing.viewInvoices', 'billing.manageInvoices', 'billing.recordPayments']);
});

afterEach(() => {
  api.restore();
  resetPermissions();
  jest.clearAllMocks();
});

describe('requesting payment on an invoice with a plan', () => {
  it('opens the one Request Payment dialog from the summary, on the full balance', async () => {
    seed(invoice());
    api.getExact(`${PAYMENT_BASE}/fee-quote`, quote);
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Request Payment via Stripe' }));

    const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
    expect(within(dialog).getByRole('button', { name: /What is this link for\?/ })).toHaveTextContent('Full remaining balance');
    await waitFor(() => expect(api.callsTo('/fee-quote')).toHaveLength(1));
    expect(api.callsTo('/fee-quote')[0].query).toEqual({});
  });

  it("opens the dialog on a plan row's installment from that row's Send payment link", async () => {
    seed(invoice());
    api.getExact(`${PAYMENT_BASE}/fee-quote?installmentId=ep-2`, quote);
    renderView();
    await openPlanTab();

    const menu = await openRowMenu('Feb 01, 2999');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Send payment link' }));

    const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
    expect(within(dialog).getByRole('button', { name: /What is this link for\?/ })).toHaveTextContent('Installment 2 · $50.00');
    await waitFor(() => expect(api.callsTo('/fee-quote')).toHaveLength(1));
    // Breaks if the row's link is priced, and so sent, for the full balance.
    expect(api.callsTo('/fee-quote')[0].query).toEqual({ installmentId: ['ep-2'] });
    // No link is open, so nothing is being replaced.
    expect(within(dialog).queryByText(/replaces the current payment link/)).not.toBeInTheDocument();
  });

  it('warns that a link for another row replaces the open one', async () => {
    seed(linkOpenFor('ep-2'));
    api.getExact(`${PAYMENT_BASE}/fee-quote?installmentId=ep-3`, quote);
    renderView();
    await openPlanTab();

    const menu = await openRowMenu('Mar 01, 2999');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Send payment link' }));

    const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
    expect(within(dialog).getByText(/replaces the current payment link/)).toBeInTheDocument();
  });
});

describe('the row an open link charges', () => {
  it('says the link was sent and offers to cancel it, which voids the invoice request', async () => {
    seed(linkOpenFor('ep-2'));
    api.postExact(`${PAYMENT_BASE}/void`, { message: 'Voided' });
    renderView();
    await openPlanTab();

    const row = await planRow('Feb 01, 2999');
    expect(within(row).getByText('Payment link sent')).toBeInTheDocument();
    // Only the row the link charges says so.
    expect(within(await planRow('Mar 01, 2999')).queryByText('Payment link sent')).not.toBeInTheDocument();

    const menu = await openRowMenu('Feb 01, 2999');
    expect(within(menu).queryByRole('menuitem', { name: 'Send payment link' })).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Cancel payment link' }));

    const confirm = await screen.findByRole('dialog', { name: 'Cancel Payment Link' });
    expect(confirm).toHaveTextContent('The client will no longer be able to pay with the current link. You can send a new one afterward.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel Payment Link' }));

    await waitFor(() => expect(api.callsTo('/void')).toHaveLength(1));
    expect(api.callsTo('/void')[0].url).toBe(`${PAYMENT_BASE}/void`);
  });

  it('cancels from the summary with the same wording', async () => {
    seed(linkOpenFor('ep-2'));
    api.postExact(`${PAYMENT_BASE}/void`, { message: 'Voided' });
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Payment Link' }));

    const confirm = await screen.findByRole('dialog', { name: 'Cancel Payment Link' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel Payment Link' }));
    await waitFor(() => expect(api.callsTo('/void')).toHaveLength(1));
  });
});

describe('recovering a failed bank payment request', () => {
  const failedLink = () => ({ ...linkOpenFor('ep-2'), stripePaymentStatus: 'failed' } as unknown as Invoice);

  it('keeps the summary copy and cancel controls available', async () => {
    seed(failedLink());
    api.postExact(`${PAYMENT_BASE}/void`, { message: 'Voided' });
    renderView();
    expect(await screen.findByRole('button', { name: 'Copy Payment Link' })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Payment Link' }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel Payment Link' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel Payment Link' }));
    await waitFor(() => expect(api.callsTo('/void')).toHaveLength(1));
  });

  it('keeps the targeted installment link controls and replacement warning available', async () => {
    seed(failedLink());
    api.getExact(`${PAYMENT_BASE}/fee-quote?installmentId=ep-3`, quote);
    renderView();
    await openPlanTab();
    const menu = await openRowMenu('Feb 01, 2999');
    expect(within(menu).getByRole('menuitem', { name: 'Cancel payment link' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(await openRowMenu('Mar 01, 2999')).getByRole('menuitem', { name: 'Send payment link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
    expect(within(dialog).getByText(/replaces the current payment link/)).toBeInTheDocument();
  });
});

describe('correcting the billing email on the invoice page', () => {
  it.each(['pending', 'failed'])('keeps the resend step mounted through the invoice refresh for a %s request', async (status) => {
    const seeded = { ...linkOpenFor('ep-2'), stripePaymentStatus: status, isCardFeePassedOn: true } as unknown as Invoice;
    seed(seeded);
    api.getExact(LIST_URL, sequence({ invoices: [seeded] }, { body: { invoices: [seeded] }, delayMs: 50 }));
    api.put(`/invoices/client/${CLIENT}/${INVOICE}/billing-email`, { message: 'ok' });
    api.postExact(`${PAYMENT_BASE}/request`, { message: 'Payment link emailed', paymentUrl: 'https://app.test/pay/new' });
    renderView();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit billing email' }));
    const field = screen.getByRole('textbox', { name: 'Billing email' });
    await userEvent.clear(field);
    await userEvent.type(field, 'corrected@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.callsTo('/billing-email')).toHaveLength(1));
    // The real parent reloads the invoice after saving. The modal must survive it.
    await waitFor(() => expect(api.callsTo(`/invoices/client/${CLIENT}`).filter((call) => call.method === 'GET')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit billing email' })).toBeInTheDocument());
    const dialog = await screen.findByRole('dialog', { name: 'Resend payment link?' });
    expect(dialog).toHaveTextContent('corrected@acme.test');
    expect(api.callsTo('/request')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resend payment link' }));
    await waitFor(() => expect(api.callsTo('/request')).toHaveLength(1));
    expect(api.callsTo('/request')[0].body).toEqual({ isCardFeePassedOn: true, isBankFeePassedOn: false, sendEmail: true, installmentId: 'ep-2' });
  });
});

describe('who sees the row link actions', () => {
  it('offers Send payment link to a member who can record payments but not manage invoices', async () => {
    resetPermissions();
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seed(invoice());
    renderView();
    await openPlanTab();

    const menu = await openRowMenu('Feb 01, 2999');
    expect(within(menu).getByRole('menuitem', { name: 'Send payment link' })).toBeInTheDocument();
    // Rescheduling is still invoice management.
    expect(within(menu).queryByRole('menuitem', { name: 'Change due date' })).not.toBeInTheDocument();
  });

  it('withholds Send payment link from a member who cannot record payments', async () => {
    resetPermissions();
    grantPermissions(['billing.viewInvoices', 'billing.manageInvoices']);
    seed(invoice());
    renderView();
    await openPlanTab();

    const menu = await openRowMenu('Feb 01, 2999');
    expect(within(menu).getByRole('menuitem', { name: 'Change due date' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Send payment link' })).not.toBeInTheDocument();
  });
});

describe('a payment the client paid a processing fee on', () => {
  it('shows the fee under the amount on the Payments tab', async () => {
    seed(invoice({
      amountPaid: 50,
      remainingBalance: 100,
      payments: [
        { id: 'pay-1', amount: 50, date: '2026-04-10', paymentSource: 'stripe', surchargeCents: 494_000 },
        { id: 'pay-2', amount: 25, date: '2026-04-11', paymentSource: 'external', surchargeCents: 0 },
      ],
    }));
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (2)' }));

    expect(await screen.findByText('+ $4,940.00 processing fee paid by client')).toBeInTheDocument();
    // A payment with no fee says nothing about one.
    expect(screen.getAllByText(/processing fee paid by client/)).toHaveLength(1);
  });

  it('tells the firm how much card fee to refund on a credit card payment', async () => {
    seed(invoice({
      amountPaid: 50,
      remainingBalance: 50,
      payments: [
        // Taken through the card form: a PaymentIntent and no Checkout session.
        { id: 'pay-1', amount: 50, date: '2026-04-10', paymentSource: 'stripe', stripePaymentIntentId: 'pi_card_1', surchargeCents: 150 },
      ],
    }));
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (1)' }));

    expect(await screen.findByText(
      'Includes a $1.50 card fee. Refund the same share of it with any refund.',
    )).toBeInTheDocument();
  });

  it('gives no card refund guidance for a bank transfer fee taken through Checkout', async () => {
    seed(invoice({
      amountPaid: 50,
      remainingBalance: 50,
      payments: [
        { id: 'pay-1', amount: 50, date: '2026-04-10', paymentSource: 'stripe', stripeSessionId: 'cs_bank_1', stripePaymentIntentId: 'pi_bank_1', surchargeCents: 85 },
      ],
    }));
    renderView();

    await userEvent.click(await screen.findByRole('button', { name: 'Payments (1)' }));

    expect(await screen.findByText('+ $0.85 processing fee paid by client')).toBeInTheDocument();
    expect(screen.queryByText(/card fee\. Refund the same share/)).not.toBeInTheDocument();
  });
});
