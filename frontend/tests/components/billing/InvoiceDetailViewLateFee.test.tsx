/**
 * "Apply Late Fee" on the invoice detail view follows the firm's late-fee
 * setting: it is in the More menu of an overdue unpaid invoice when late fees
 * are on, and nothing late-fee related appears when they are off.
 *
 * Red if `canApplyLateFee` stops reading `lateFeeSettings.enabled` (the off
 * case shows the item) or the menu item is removed (the on case).
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
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';

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

function renderWithLateFees(enabled: boolean) {
  return renderWithProviders(
    <FirmSettingsProvider
      lawFirmId={FIRM}
      initialSettings={{
        billing: {
          defaultRate: null, invoicePrefix: 'INV', invoiceStartNumber: 1, eventTypeChargeCodeDefaults: {},
          lateFee: { enabled, flatAmount: 25, percent: 0, graceDays: 0, autoApply: false },
        },
      }}
    >
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

async function openMoreMenu() {
  await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

// An overdue, unpaid invoice: due thirty days ago, no late fee applied yet.
const overdue = () => invoice({ dueDate: dayjs().subtract(30, 'day').format('YYYY-MM-DD') });

it('offers Apply Late Fee on an overdue invoice when the firm has late fees on', async () => {
  seed(overdue());
  renderWithLateFees(true);
  await openMoreMenu();
  // Add Amount is always in the menu, so the menu opened.
  expect(await screen.findByRole('button', { name: 'Add Amount' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Apply Late Fee' })).toBeInTheDocument();
});

it('offers nothing late-fee related when the firm has late fees off', async () => {
  seed(overdue());
  renderWithLateFees(false);
  await openMoreMenu();
  expect(await screen.findByRole('button', { name: 'Add Amount' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Apply Late Fee' })).not.toBeInTheDocument();
});
