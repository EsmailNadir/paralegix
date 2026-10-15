/**
 * The client Billing tab's flat-fee section, driven through the REAL billing
 * service against a faked transport.
 *
 * Three rules, each of which fails quietly when it slips:
 *
 *   WRITES FOLLOW billing.manageInvoices. The flat-fee add, update and delete
 *   routes all require it, so a member without it is shown the fees and no way
 *   to change them (the read-only rule: no denial screen, no dead buttons).
 *
 *   A FAILED READ SAYS SO. Swallowing it renders "No direct client flat fees
 *   yet" for fees the tab never managed to read.
 *
 *   A REFUSED DELETE SAYS SO. The rejection reaches `ConfirmAction`, which keeps
 *   the confirm open with the server's reason.
 *
 * The invoice list is its own paged read with its own suite; it is stubbed to an
 * empty settled page here so the only requests are the flat-fee ones.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/billingHooks/useFirmInvoicesTable', () => ({
  __esModule: true,
  default: () => ({
    rows: [],
    total: 0,
    statusCounts: {},
    summary: { ownedCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 },
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
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ClientBillingTab from '@/components/clientComp/ClientBillingTab';
import type { Client } from '@/types';
import { setupApiMock } from '../../support/apiMock';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';
import { renderWithProviders } from '../../support/renderWithProviders';

const FIRM = 'firm-a';
const CLIENT_ID = 'client-a';
const CLIENT = { id: CLIENT_ID, name: 'Acme Holdings' } as Client;
const FIRM_FLAT_FEES = '/billing/flat-fees/firm';

const api = setupApiMock();

const DIRECT_FEE = {
  id: 'fee-direct',
  description: 'Retainer top-up',
  amount: 500,
  date: '2026-02-03',
  contextType: 'client',
  matterId: null,
  clientId: CLIENT_ID,
  isBilled: false,
};

function serveFees(fees: unknown[] = [DIRECT_FEE]) {
  api.get(FIRM_FLAT_FEES, { flatFees: fees, totalItems: fees.length, truncated: false, summary: {} });
}

const NO_MATTERS: never[] = [];
const NO_PLANS: never[] = [];
const NO_INVOICES: never[] = [];
const NO_COMPANIES = new Map<string, string>();

function renderTab() {
  return renderWithProviders(
    <ClientBillingTab
      billingInvoices={NO_INVOICES}
      recurringRetainers={NO_PLANS}
      clientMatters={NO_MATTERS}
      client={CLIENT}
      clientId={CLIENT_ID}
      lawFirmId={FIRM}
      navigate={jest.fn()}
      onRefreshInvoices={async () => undefined}
      stripeStatus="not_connected"
      companyNames={NO_COMPANIES}
    />,
  );
}

afterEach(() => {
  resetPermissions();
});

describe('flat-fee writes follow billing.manageInvoices', () => {
  // Red if: Add, Edit or Remove render without the permission every flat-fee
  // write route requires.
  it('shows a member who can only view invoices the fee with no way to change it', async () => {
    grantBaselineMember(['billing.viewInvoices']);
    serveFees();

    renderTab();

    expect(await screen.findByText('Retainer top-up')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Add Flat Fee' })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Remove flat fee' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('offers add, edit and remove to a member who can manage invoices', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.manageInvoices']);
    serveFees();

    renderTab();

    expect(await screen.findByText('Retainer top-up')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add Flat Fee' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Remove flat fee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});

describe('a failed flat-fee read', () => {
  // Red if: the read failure is swallowed and the section shows its empty state.
  it('shows the failure instead of "No direct client flat fees yet"', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.manageInvoices']);
    api.get(FIRM_FLAT_FEES, { status: 500, body: { error: 'Flat fee ledger unavailable', code: 'LEDGER_DOWN' } });

    renderTab();

    expect(await screen.findByText('Flat fee ledger unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No direct client flat fees yet/)).not.toBeInTheDocument();
  });
});

describe('a refused flat-fee delete', () => {
  it('keeps the confirm open with the server\'s reason, and the fee stays listed', async () => {
    grantBaselineMember(['billing.viewInvoices', 'billing.manageInvoices']);
    serveFees();
    api.delete(`/billing/flat-fees/client/${CLIENT_ID}/fee-direct`, {
      status: 409, body: { error: 'This flat fee is already on an invoice' },
    });

    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove flat fee' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Flat Fee' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await within(dialog).findByText('This flat fee is already on an invoice')).toBeInTheDocument();
    await waitFor(() =>
      expect(api.callsTo(`/flat-fees/client/${CLIENT_ID}/fee-direct`).filter((c) => c.method === 'DELETE')).toHaveLength(1),
    );
    expect(screen.getByText('Retainer top-up')).toBeInTheDocument();
  });
});
