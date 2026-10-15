/**
 * The invoice detail page: header/summary, line items, payments, and the
 * record-payment flow, driven through the REAL billing/clients services
 * against a faked transport.
 *
 * This is the last unfinished B04.3 "pages and consumers" surface besides
 * role/member settings (workspace shell, client shell, firm billing hub,
 * trust overview, matters, tasks, messages, calendar and files are already
 * covered). It is unusually large (~5,250 lines in
 * `InvoiceDetailView.tsx`), so this spec sticks to the plan's required shapes
 * rather than every button on the page: loaded content, a meaningful empty
 * state, a load failure, narrow-role behavior, a successful and a refused
 * payment, and a context change while a request is pending.
 *
 * Like the matter and task detail pages, this page loads its data with plain
 * `useState`/`useEffect` rather than React Query, so nothing but the
 * component's own code stops a slow response for an OLD invoice id from
 * landing after the viewer has already navigated to a DIFFERENT invoice
 * (browser back/forward can reuse this page instance rather than remounting
 * it). That is the specific race this file checks for.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/clients.service');
jest.unmock('@/services/requestDeduplicator');

// InvoiceDetailView imports `@react-pdf/renderer` and two PDF document
// components directly (invoice preview/download, payment receipts). It ships
// ESM and pulls in a worker Jest cannot parse; no test here opens a PDF, only
// the module graph needs to load. Mirrors `tests/components/billing/
// InvoiceDetailView.test.tsx` and `tests/app/lawfirm/trust/TrustPage.test.tsx`.
jest.mock('@react-pdf/renderer', () => ({
  pdf: jest.fn(),
  Document: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  Page: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
  View: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
  StyleSheet: { create: (s: unknown) => s },
  Image: (props: Record<string, unknown>) => React.createElement('img', props),
}));

// Name resolution for "recorded by" / audit-log rows is incidental to every
// scenario here; stubbing the hook (rather than unmocking users.service too)
// keeps the unmocked surface to what the scenarios actually exercise, the
// same choice the sibling component test for this view already made.
jest.mock('@/hooks/useUsers', () => ({
  __esModule: true,
  useLawFirmUsers: () => ({ users: [], loading: false }),
}));

const useParamsMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/clients/client-1/invoices/inv-1',
  useParams: () => useParamsMock(),
  useSearchParams: () => new URLSearchParams(),
}));

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ClientInvoiceDetailPage from '@/app/lawfirm/[lawFirmId]/clients/[clientId]/invoices/[invoiceId]/page';
import { setupApiMock, sequence } from '../../../support/apiMock';
import { renderWithProviders } from '../../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../../support/permissions';
import type { Invoice, Client } from '@/types';

const FIRM_A = 'firm-a';
const CLIENT_A = 'client-1';
const INVOICE_1 = 'inv-1';
const INVOICE_2 = 'inv-2';
const API = 'http://localhost:5001/api';

const api = setupApiMock();

function billingBase(firmId: string = FIRM_A): string {
  return `${API}/lawfirms/${firmId}/billing`;
}

function listInvoicesUrl(clientId: string = CLIENT_A, firmId: string = FIRM_A): string {
  return `${billingBase(firmId)}/invoices/client/${clientId}`;
}

function paymentUrl(invoiceId: string, clientId: string = CLIENT_A, firmId: string = FIRM_A): string {
  return `${billingBase(firmId)}/invoices/client/${clientId}/${invoiceId}/payment`;
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE_1,
    invoiceName: 'March Retainer',
    invoiceNumber: 'INV-1001',
    invoiceDate: '2026-03-01',
    // No due date: several scenarios assert the "Unpaid" status label, which
    // only holds while the invoice isn't past due. A fixed due date drifts
    // into "Overdue" as real time passes; tests that care about a due date
    // set one explicitly.
    dueDate: null,
    clientId: CLIENT_A,
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
    timeEntries: [
      { id: 'te-1', description: 'Drafted motion for summary judgment', hours: 2, rate: 50, amount: 100 },
    ],
    flatFees: [],
    expenses: [],
    auditLog: [],
    stripePaymentRequested: false,
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  } as Invoice;
}

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: CLIENT_A,
    userId: 'portal-uid-1',
    name: 'Acme Co',
    email: 'ap@acme.test',
    ...overrides,
  } as Client;
}

/** Every route the page fetches on mount unconditionally, regardless of tab. */
function seedIncidentalReads(opts: { firmId?: string; clientId?: string; invoiceId?: string } = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const clientId = opts.clientId ?? CLIENT_A;
  const invoiceId = opts.invoiceId ?? INVOICE_1;
  api.get(`/invoices/${invoiceId}/sent-copies`, { sentCopies: [] });
  api.get(`/stripe/connect/${firmId}/status`, { connected: false });
  api.get(`/clients/${clientId}`, { client: client({ id: clientId }) });
  api.get('/clients/lookup', { items: [], hasMore: false });
}

function seedInvoiceWorkspace(opts: { firmId?: string; clientId?: string; invoice?: Invoice } = {}) {
  const firmId = opts.firmId ?? FIRM_A;
  const clientId = opts.clientId ?? CLIENT_A;
  const seededInvoice = opts.invoice ?? invoice();
  api.getExact(listInvoicesUrl(clientId, firmId), { invoices: [seededInvoice] });
  seedIncidentalReads({ firmId, clientId, invoiceId: seededInvoice.id });
}

function renderInvoicePage() {
  return renderWithProviders(<ClientInvoiceDetailPage />);
}

beforeEach(() => {
  useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, clientId: CLIENT_A, invoiceId: INVOICE_1 });
});

afterEach(() => {
  resetPermissions();
  jest.clearAllMocks();
});

describe('loaded content', () => {
  it('shows the real invoice header, line items and balance', async () => {
    seedInvoiceWorkspace();

    renderInvoicePage();

    expect(await screen.findByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
    expect(screen.getByText('INV-1001')).toBeInTheDocument();
    expect(screen.getByText('Unpaid')).toBeInTheDocument();
    expect(screen.getByText('Drafted motion for summary judgment')).toBeInTheDocument();
    // "Remaining Balance" and its amount each render more than once (the
    // summary tile plus the payment rail); either proves the real total
    // reached the page rather than a placeholder.
    expect(screen.getAllByText('Remaining Balance').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$100.00').length).toBeGreaterThan(0);
  });
});

describe('a meaningful empty state', () => {
  it('says there are no line items and no payments, rather than leaving the tabs blank', async () => {
    seedInvoiceWorkspace({
      invoice: invoice({ timeEntries: [], flatFees: [], expenses: [], totalAmount: 0, remainingBalance: 0 }),
    });

    renderInvoicePage();

    await screen.findByRole('heading', { name: 'March Retainer' });
    expect(screen.getByText('No line items on this invoice.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Payments (0)' }));
    expect(screen.getByText('No payments recorded yet.')).toBeInTheDocument();
  });
});

describe('an API failure, with retry', () => {
  it('shows the real error rather than a blank page', async () => {
    seedIncidentalReads();
    api.getExact(listInvoicesUrl(), { status: 500, body: { error: 'billing service unavailable' } });

    renderInvoicePage();

    expect(await screen.findByRole('heading', { name: 'Invoice not found' })).toBeInTheDocument();
    expect(screen.getByText(/billing service unavailable/i)).toBeInTheDocument();
  });

  it('offers a way back to client billing', async () => {
    seedIncidentalReads();
    api.getExact(listInvoicesUrl(), { status: 500, body: { error: 'billing service unavailable' } });

    renderInvoicePage();

    await screen.findByRole('heading', { name: 'Invoice not found' });
    expect(screen.getByRole('button', { name: 'Back to Client Billing' })).toBeInTheDocument();
  });
});

describe('narrow role behavior', () => {
  it('shows a member explicitly granted invoice viewing the invoice read-only', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    seedInvoiceWorkspace();

    renderInvoicePage();

    expect(await screen.findByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
    // The read grant does not grant editing or recording payments.
    expect(screen.queryByRole('button', { name: 'Record Payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit invoice details' })).not.toBeInTheDocument();
    expect(screen.getByText(/You can view this invoice/i)).toBeInTheDocument();
  });
});

describe('a successful action: recording a payment', () => {
  it('records the payment and reflects the new balance', async () => {
    seedInvoiceWorkspace();
    api.putExact(paymentUrl(INVOICE_1), { invoice: invoice({ amountPaid: 50 }) });
    api.getExact(
      listInvoicesUrl(),
      sequence(
        { invoices: [invoice()] },
        { invoices: [invoice({
            amountPaid: 50,
            remainingBalance: 50,
            payments: [{ amount: 50, date: '2026-03-05', paymentMethod: 'manual' }],
          })],
        },
      ),
    );

    renderInvoicePage();

    await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    const dialog = await screen.findByRole('dialog');
    const amountInput = await within(dialog).findByPlaceholderText('0.00');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.callsTo(`/invoices/client/${CLIENT_A}/${INVOICE_1}/payment`)).toHaveLength(1);
    // The reload after the payment shows the invoice as half paid: $50 of the
    // $100 total collected, $50 still remaining, and one recorded payment row.
    await waitFor(() => expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0));
    expect(screen.getByText('1 payment · View all')).toBeInTheDocument();
  });
});

describe('a refused action: the payment is rejected', () => {
  it('tells the user the payment was not recorded, and keeps the invoice as it was', async () => {
    seedInvoiceWorkspace();
    // Simulates a race: the invoice was already settled by someone else between
    // this page's load and the submit, so the backend - not the client-side
    // "exceeds remaining balance" check - is what refuses it.
    api.putExact(paymentUrl(INVOICE_1), {
      status: 409,
      body: { error: 'Payment amount ($100.00) exceeds the remaining balance ($0.00)' },
    });

    renderInvoicePage();

    await userEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record Payment' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/exceeds the remaining balance/i);
    // Still open and still unpaid - the payment never actually landed.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThan(0);
    expect(api.callsTo(`/invoices/client/${CLIENT_A}/${INVOICE_1}/payment`)).toHaveLength(1);
  });
});

describe('an invoice switch while a request is pending', () => {
  it("never lets a slow response for the old invoice land as the new invoice's detail", async () => {
    const invoiceOne = invoice({ id: INVOICE_1, invoiceName: 'Old Slow Invoice' });
    const invoiceTwo = invoice({ id: INVOICE_2, invoiceName: 'New Fast Invoice', invoiceNumber: 'INV-1002' });
    seedIncidentalReads({ invoiceId: INVOICE_1 });
    seedIncidentalReads({ invoiceId: INVOICE_2 });
    // Both invoices live under the same client, so both loads hit the SAME
    // list endpoint. The first (slow) call answers for the page as it looked
    // when invoice 1 was open; the second (fast) call answers once the viewer
    // has already moved to invoice 2.
    api.getExact(
      listInvoicesUrl(),
      sequence(
        { delayMs: 200, body: { invoices: [invoiceOne, invoiceTwo] } },
        { invoices: [invoiceOne, invoiceTwo] },
      ),
    );

    const { rerender } = renderInvoicePage();

    // Invoice 1's slow response is still in flight when the viewer navigates to
    // invoice 2 (e.g. via browser back/forward, without a full page remount).
    useParamsMock.mockReturnValue({ lawFirmId: FIRM_A, clientId: CLIENT_A, invoiceId: INVOICE_2 });
    rerender(<ClientInvoiceDetailPage />);

    expect(await screen.findByRole('heading', { name: 'New Fast Invoice' })).toBeInTheDocument();

    // Even once invoice 1's slow response finally arrives, it must not
    // overwrite the page now showing invoice 2.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole('heading', { name: 'New Fast Invoice' })).toBeInTheDocument();
    expect(screen.queryByText('Old Slow Invoice')).not.toBeInTheDocument();
  });
});

it('retries an initial invoice load without leaving the detail page', async () => {
  seedIncidentalReads();
  api.getExact(listInvoicesUrl(), sequence(
    { status: 500, body: { error: 'billing service unavailable' } },
    { invoices: [invoice()] },
  ));
  renderInvoicePage();
  await screen.findByText(/billing service unavailable/i);
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'March Retainer' })).toBeInTheDocument();
});
