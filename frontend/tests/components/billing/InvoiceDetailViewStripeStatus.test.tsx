/**
 * The invoice page's Payment Options card in every Stripe state: checking,
 * ready, not connected, part set up, and a failed check.
 *
 * Driven through the real controller and billing service with only the
 * transport faked.
 * RED IF: the Request Payment slot is empty while Stripe is being checked (the
 * button pops in later); a failed check tells the firm to connect Stripe; a
 * member who cannot manage firm settings is sent to a settings page they
 * cannot use; "Try again" does not ask Stripe again; a cancel button is offered
 * for a link Stripe cannot cancel; or a paid invoice shows anything Stripe.
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
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import InvoiceDetailView from '@/components/billingComp/InvoiceDetailView';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { holdResponse } from '../../support/deferred';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import type { Invoice, Client } from '@/types';

const FIRM = 'firm-a';
const CLIENT = 'client-1';
const INVOICE = 'inv-1';
const API = 'http://localhost:5001/api';
const LIST_URL = `${API}/lawfirms/${FIRM}/billing/invoices/client/${CLIENT}`;
const TRUST = `${API}/lawfirms/${FIRM}/trust`;
const STATUS_URL = `${API}/stripe/connect/${FIRM}/status`;

const READY = { connected: true, chargesEnabled: true, onboardingComplete: true };
const NOT_CONNECTED = { connected: false, chargesEnabled: false, onboardingComplete: false };
const NEEDS_SETUP = { connected: true, chargesEnabled: false, onboardingComplete: false };

const RECORDER = ['billing.viewInvoices', 'billing.manageInvoices', 'billing.recordPayments'];

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
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  } as Invoice;
}

const linkOpen = () => invoice({
  stripePaymentRequested: true,
  stripePaymentStatus: 'pending',
  paymentLinkUrl: 'https://app.test/pay/tok_open',
});

function seed(seeded: Invoice, stripe: Parameters<ApiMock['getExact']>[1]) {
  api.getExact(LIST_URL, { invoices: [seeded] });
  api.get(`/invoices/${INVOICE}/sent-copies`, { sentCopies: [] });
  api.getExact(STATUS_URL, stripe);
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

const statusCalls = () => api.callsTo(`/stripe/connect/${FIRM}/status`);
const requestButton = () => screen.queryByRole('button', { name: 'Request Payment via Stripe' });
const cancelButton = () => screen.queryByRole('button', { name: 'Cancel Payment Link' });

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
  jest.clearAllMocks();
});

describe('while Stripe is being checked', () => {
  it('shows the Request Payment button busy and disabled, then enables it', async () => {
    grantPermissions(RECORDER);
    const held = holdResponse();
    seed(invoice(), held.handler);
    renderView();

    await screen.findByRole('heading', { name: 'Payment Options' });
    await held.untilRequested();
    expect(requestButton()).toBeDisabled();

    await act(async () => held.release(READY));

    await waitFor(() => expect(requestButton()).toBeEnabled());
  });

  it('shows Cancel Payment Link busy and disabled when a link is open, then enables it', async () => {
    grantPermissions(RECORDER);
    const held = holdResponse();
    seed(linkOpen(), held.handler);
    renderView();

    expect(await screen.findByRole('button', { name: 'Copy Payment Link' })).toBeInTheDocument();
    await held.untilRequested();
    expect(cancelButton()).toBeDisabled();

    await act(async () => held.release(READY));

    await waitFor(() => expect(cancelButton()).toBeEnabled());
  });
});

describe('a firm without Stripe', () => {
  it('swaps the busy button for the Connect Stripe card once the check says Stripe is off', async () => {
    grantPermissions([...RECORDER, 'settings.manageFirm']);
    const held = holdResponse();
    seed(invoice(), held.handler);
    renderView();

    await screen.findByRole('heading', { name: 'Payment Options' });
    await held.untilRequested();
    expect(requestButton()).toBeDisabled();
    expect(screen.queryByText('Online Payments')).not.toBeInTheDocument();

    await act(async () => held.release(NOT_CONNECTED));

    expect(await screen.findByText('Connect Stripe to request online payments from clients on this invoice.')).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
  });

  it('sends a member who can manage firm settings to Payment Settings', async () => {
    grantPermissions([...RECORDER, 'settings.manageFirm']);
    seed(invoice(), NOT_CONNECTED);
    renderView();

    expect(await screen.findByText('Connect Stripe to request online payments from clients on this invoice.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Payment via Stripe' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Payment Settings' }));
    expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${FIRM}/settings/payments`);
  });

  it('asks any other member to get an admin to connect it, with no settings button', async () => {
    grantPermissions(RECORDER);
    seed(invoice(), NOT_CONNECTED);
    renderView();

    expect(await screen.findByText('Ask a firm admin to connect Stripe to request online payments.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Payment Settings' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Connect Stripe to request/)).not.toBeInTheDocument();
  });

  it('keeps the copy button for an open link but offers no cancel', async () => {
    grantPermissions(RECORDER);
    seed(linkOpen(), NOT_CONNECTED);
    renderView();

    expect(await screen.findByRole('button', { name: 'Copy Payment Link' })).toBeInTheDocument();
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    await waitFor(() => expect(cancelButton()).not.toBeInTheDocument());
  });

  it('leaves out the Payment Options card when it would have nothing in it', async () => {
    // Can record payments but not set up a plan, no trust money, no Stripe.
    grantPermissions(['billing.viewInvoices', 'billing.recordPayments']);
    seed(invoice(), NOT_CONNECTED);
    renderView();

    expect(await screen.findByText('Ask a firm admin to connect Stripe to request online payments.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payment Options' })).not.toBeInTheDocument();
  });

  it('offers no payment link from a plan row', async () => {
    grantPermissions(RECORDER);
    seed(invoice({
      paymentPlan: {
        enabled: true,
        installmentAmount: 50,
        frequencyDays: 30,
        planStartDate: '2999-01-01',
        expectedPayments: [
          { id: 'ep-1', dueDate: '2999-01-01', amount: 150, status: 'pending', matchedPaymentIndex: null },
        ],
      },
    } as Partial<Invoice>), NOT_CONNECTED);
    renderView();
    await waitFor(() => expect(statusCalls()).toHaveLength(1));

    await userEvent.click(await screen.findByRole('button', { name: /^Payment Plan/ }));
    const row = (await screen.findByText('Jan 01, 2999')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'More installment actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Change due date' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Send payment link' })).not.toBeInTheDocument();
  });
});

describe('a firm part way through Stripe setup', () => {
  it('asks a member who can manage firm settings to finish it', async () => {
    grantPermissions([...RECORDER, 'settings.manageFirm']);
    seed(invoice(), NEEDS_SETUP);
    renderView();

    expect(await screen.findByText('Finish setting up Stripe to request online payments.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Payment Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Payment via Stripe' })).not.toBeInTheDocument();
  });

  it('asks any other member to get an admin to finish it', async () => {
    grantPermissions(RECORDER);
    seed(invoice(), NEEDS_SETUP);
    renderView();

    expect(await screen.findByText('Ask a firm admin to finish setting up Stripe to request online payments.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Payment Settings' })).not.toBeInTheDocument();
  });
});

describe('a failed Stripe check', () => {
  it('says so, never tells the firm to connect, and Try again asks again', async () => {
    grantPermissions([...RECORDER, 'settings.manageFirm']);
    seed(invoice(), sequence({ status: 500, body: { error: 'Stripe unavailable' } }, READY));
    renderView();

    expect(await screen.findByText("Couldn't check Stripe.")).toBeInTheDocument();
    expect(screen.queryByText('Online Payments')).not.toBeInTheDocument();
    expect(screen.queryByText(/Connect Stripe/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Payment via Stripe' })).not.toBeInTheDocument();
    expect(statusCalls()).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Request Payment via Stripe' })).toBeInTheDocument();
    expect(statusCalls()).toHaveLength(2);
    expect(screen.queryByText("Couldn't check Stripe.")).not.toBeInTheDocument();
  });
});

describe('an invoice with nothing left to collect', () => {
  it('shows nothing Stripe on a paid invoice, even while the check is pending', async () => {
    grantPermissions([...RECORDER, 'settings.manageFirm']);
    const held = holdResponse();
    seed(invoice({ status: 'paid', isPaid: true, amountPaid: 150, remainingBalance: 0 }), held.handler);
    renderView();

    await screen.findByRole('heading', { name: 'Summary' });
    await held.untilRequested();
    expect(requestButton()).not.toBeInTheDocument();

    await act(async () => held.release(NOT_CONNECTED));
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    expect(screen.queryByText('Online Payments')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Payment via Stripe' })).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't check Stripe.")).not.toBeInTheDocument();
  });

  it('shows nothing Stripe to a member who cannot record payments', async () => {
    grantPermissions(['billing.viewInvoices', 'billing.manageInvoices']);
    seed(invoice(), NOT_CONNECTED);
    renderView();

    expect(await screen.findByRole('heading', { name: 'Payment Options' })).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
    expect(screen.queryByText('Online Payments')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request Payment via Stripe' })).not.toBeInTheDocument();
  });
});
