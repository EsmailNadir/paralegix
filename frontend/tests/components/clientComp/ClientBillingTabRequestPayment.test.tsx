/**
 * The client Billing tab's per-invoice Request Payment button opens the one
 * Request Payment dialog, with the invoice's payment plan so the firm can
 * point the link at an installment.
 *
 * Red if the row button keeps its old "Stripe" label, if it is offered to a
 * member who cannot record payments, or if the dialog cannot target the plan.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

const mockRows: unknown[] = [];
jest.mock('@/hooks/billingHooks/useFirmInvoicesTable', () => ({
  __esModule: true,
  default: () => ({
    rows: mockRows,
    total: mockRows.length,
    statusCounts: {},
    summary: { ownedCount: mockRows.length, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
    dueGroupTotals: {},
    loading: false,
    fetching: false,
    error: null,
    page: 1,
    setPage: jest.fn(),
    rowsPerPage: 10,
    setRowsPerPage: jest.fn(),
    sortModel: [],
    handleRequestSort: jest.fn(),
    filters: {},
    setFilter: jest.fn(),
    clearFilters: jest.fn(),
    search: '',
    setSearch: jest.fn(),
    refetch: jest.fn(async () => undefined),
  }),
}));

import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ClientBillingTab from '@/components/clientComp/ClientBillingTab';
import type { Client } from '@/types';
import type { StripeStatus } from '@/hooks/billingHooks/useStripeStatus';
import { setupApiMock } from '../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';
import { renderWithProviders } from '../../support/renderWithProviders';

const FIRM = 'firm-a';
const CLIENT_ID = 'client-a';
const CLIENT = { id: CLIENT_ID, name: 'Acme Holdings' } as Client;

const api = setupApiMock();

const PLAN_INVOICE = {
  id: 'inv-1',
  invoiceName: 'May Services',
  invoiceNumber: 'INV-3001',
  invoiceDate: '2026-05-01',
  contextType: 'client',
  entityId: CLIENT_ID,
  clientId: CLIENT_ID,
  billingRelation: 'owned',
  status: 'unpaid',
  isPaid: false,
  totalAmount: 300,
  amountPaid: 0,
  remainingBalance: 300,
  payments: [],
  stripePaymentRequested: false,
  paymentPlan: {
    enabled: true,
    installmentAmount: 100,
    frequencyDays: 30,
    planStartDate: '2999-01-01',
    expectedPayments: [
      { id: 'ep-1', dueDate: '2999-01-01', amount: 100, status: 'pending' },
      { id: 'ep-2', dueDate: '2999-02-01', amount: 200, status: 'pending' },
    ],
  },
};

function renderTab(stripeStatus: StripeStatus = 'ready') {
  return renderWithProviders(
    <ClientBillingTab
      billingInvoices={[]}
      recurringRetainers={[]}
      clientMatters={[]}
      client={CLIENT}
      clientId={CLIENT_ID}
      lawFirmId={FIRM}
      navigate={jest.fn()}
      onRefreshInvoices={async () => undefined}
      stripeStatus={stripeStatus}
      companyNames={new Map()}
    />,
  );
}

beforeEach(() => {
  mockRows.splice(0, mockRows.length, PLAN_INVOICE);
  api.get('/billing/flat-fees/firm', { flatFees: [], totalItems: 0, truncated: false, summary: {} });
});

afterEach(() => {
  resetPermissions();
});

it('opens the Request Payment dialog, able to target an installment, from the row button', async () => {
  grantBaselineMember(['billing.viewInvoices', 'billing.recordPayments']);
  api.getExact(`/api/stripe/payment/${FIRM}/client/${CLIENT_ID}/inv-1/fee-quote`, {
    invoiceCents: 30_000, firmDefault: { card: false, bank: false }, emailTo: [], methods: [],
  });
  renderTab();

  await userEvent.click(await screen.findByRole('button', { name: 'Request Payment' }));

  const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
  await userEvent.click(within(dialog).getByRole('button', { name: /What is this link for\?/ }));
  expect(screen.getByRole('option', { name: /Installment 2 · \$200\.00/ })).toBeInTheDocument();
});

it('withholds the button from a member who cannot record payments', async () => {
  grantBaselineMember(['billing.viewInvoices']);
  renderTab();

  expect(await screen.findByText('May Services')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Request Payment' })).not.toBeInTheDocument();
});

it('warns that requesting again replaces the link after a failed bank attempt', async () => {
  grantBaselineMember(['billing.viewInvoices', 'billing.recordPayments']);
  mockRows.splice(0, mockRows.length, { ...PLAN_INVOICE, stripePaymentRequested: true, stripePaymentStatus: 'failed' });
  api.getExact(`/api/stripe/payment/${FIRM}/client/${CLIENT_ID}/inv-1/fee-quote`, {
    invoiceCents: 30_000, firmDefault: { card: false, bank: false }, emailTo: [], methods: [],
  });
  renderTab();
  await userEvent.click(await screen.findByRole('button', { name: 'Request Payment' }));
  const dialog = await screen.findByRole('dialog', { name: 'Request Payment via Stripe' });
  expect(within(dialog).getByText(/replaces the current payment link/)).toBeInTheDocument();
});

describe('while the firm\'s Stripe status is not ready', () => {
  const requestButton = () => screen.queryByRole('button', { name: 'Request Payment' });

  it('shows the button busy and disabled while Stripe is being checked', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.recordPayments']);
    renderTab('loading');

    expect(await screen.findByText('May Services')).toBeInTheDocument();
    expect(requestButton()).toBeDisabled();
  });

  it.each(['not_connected', 'needs_setup', 'error'] as const)('offers no Request Payment button when Stripe is %s', async (status) => {
    grantBaselineMember(['billing.viewInvoices', 'billing.recordPayments']);
    renderTab(status);

    expect(await screen.findByText('May Services')).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
    // The manual payment stays available whatever Stripe says.
    expect(screen.getByRole('button', { name: 'Pay' })).toBeInTheDocument();
  });

  it('shows no button for a member who cannot record payments', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    renderTab('loading');

    expect(await screen.findByText('May Services')).toBeInTheDocument();
    expect(requestButton()).not.toBeInTheDocument();
  });
});
