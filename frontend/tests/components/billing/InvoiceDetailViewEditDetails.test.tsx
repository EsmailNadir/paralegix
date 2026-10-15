/**
 * Editing an invoice's details (name, number, dates, remit-to) through the REAL
 * billing transport.
 *
 *   AN ISSUED INVOICE CAN STILL BE RENAMED AND HAVE ITS DUE DATE MOVED. The
 *   number, the invoice date and the remit-to are frozen once
 *   `billingSnapshotAt` is stamped; the form shows them read-only and leaves
 *   them out of the save, so the server does not refuse the edits it allows.
 *
 *   A REMIT-TO WITH NO NAME IS NOT WIPED. Saving a draft whose remit-to has only
 *   an address must send that address back, not null.
 *
 *   A BLANK NAME SAYS WHY THE SAVE DID NOTHING.
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
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import InvoiceDetailView from '@/components/billingComp/InvoiceDetailView';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { FirmSettingsProvider } from '@/contexts/FirmSettingsContext';
import { resetPermissions } from '../../support/permissions';
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

const DETAILS_URL = `${LIST_URL}/${INVOICE}/details`;

function renderView() {
  return renderWithProviders(
    <FirmSettingsProvider lawFirmId={FIRM} initialSettings={{}}>
      <InvoiceDetailView
        lawFirmId={FIRM}
        entityId={CLIENT}
        invoiceId={INVOICE}
        contextType="client"
        backHref={`/lawfirm/${FIRM}/clients/${CLIENT}?tab=billing`}
        backLabel="Back to Client Billing"
      />
    </FirmSettingsProvider>,
  );
}

async function openEditor() {
  await userEvent.click(await screen.findByRole('button', { name: 'Edit invoice details' }));
}

function patchBody() {
  const calls = api.calls('PATCH').filter((c) => c.url === DETAILS_URL);
  expect(calls).toHaveLength(1);
  return calls[0].body as Record<string, unknown>;
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('an issued invoice', () => {
  const issued = () => invoice({
    billingSnapshotAt: '2026-04-02T12:00:00.000Z',
    remitTo: { name: 'Firm Trust', address: '1 Main St' },
  } as Partial<Invoice>);

  // Red if: the save resends the frozen number, date and remit-to, which the
  // server refuses with a 409 for an issued invoice.
  it('saves a rename without the frozen number, invoice date or remit-to', async () => {
    seed(issued());
    api.patchExact(DETAILS_URL, { message: 'ok', invoice: issued() });
    renderView();
    await openEditor();

    const name = screen.getByPlaceholderText('Invoice Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    const body = patchBody();
    expect(body.invoiceName).toBe('Renamed');
    expect(body).toHaveProperty('dueDate');
    expect(body).not.toHaveProperty('invoiceNumber');
    expect(body).not.toHaveProperty('invoiceDate');
    expect(body).not.toHaveProperty('remitTo');
  });

  it('shows the frozen fields read-only', async () => {
    seed(issued());
    renderView();
    await openEditor();

    expect(screen.getByPlaceholderText('Invoice Number')).toBeDisabled();
    expect(screen.getByPlaceholderText('Remit To Name')).toBeDisabled();
    expect(screen.getByPlaceholderText('Address (optional)')).toBeDisabled();
    expect(screen.getByPlaceholderText('Invoice Name')).not.toBeDisabled();
  });
});

describe('a draft invoice', () => {
  it('still sends the number and invoice date, which are editable before issue', async () => {
    seed(invoice());
    api.patchExact(DETAILS_URL, { message: 'ok', invoice: invoice() });
    renderView();
    await openEditor();

    const number = screen.getByPlaceholderText('Invoice Number');
    expect(number).not.toBeDisabled();
    await userEvent.clear(number);
    await userEvent.type(number, 'INV-9');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(patchBody()).toEqual(expect.objectContaining({ invoiceNumber: 'INV-9', invoiceDate: '2026-04-01' }));
  });

  // Red if: a blank remit-to name sends remitTo: null, wiping the address.
  it('keeps a remit-to address that has no name', async () => {
    const draft = invoice({ remitTo: { address: '1 Main St', city: 'Austin' } } as Partial<Invoice>);
    seed(draft);
    api.patchExact(DETAILS_URL, { message: 'ok', invoice: draft });
    renderView();
    await openEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(patchBody().remitTo).toEqual(expect.objectContaining({ address: '1 Main St', city: 'Austin' }));
  });

  it('clears the remit-to when every field of it is emptied', async () => {
    const draft = invoice({ remitTo: { name: 'Firm Trust', address: '1 Main St' } } as Partial<Invoice>);
    seed(draft);
    api.patchExact(DETAILS_URL, { message: 'ok', invoice: draft });
    renderView();
    await openEditor();

    await userEvent.clear(screen.getByPlaceholderText('Remit To Name'));
    await userEvent.clear(screen.getByPlaceholderText('Address (optional)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(patchBody().remitTo).toBeNull();
  });

  // Red if: Save with a blank name returns without a word, reading as ignored.
  it('says the name is required instead of silently not saving', async () => {
    seed(invoice());
    renderView();
    await openEditor();

    await userEvent.clear(screen.getByPlaceholderText('Invoice Name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Invoice name is required')).toBeInTheDocument();
    expect(api.calls('PATCH')).toHaveLength(0);
  });
});
