/**
 * `BillingTimeEntriesView`: the firm-wide Billing dashboard's "Time entries"
 * tab (distinct from `TimeTracking.tsx`, the matter/client detail page's
 * panel for the same feature).
 *
 * PERMISSION GATING. `POST/PUT/DELETE .../billing/time-entries` all require
 * `billing.manageTimeEntries` (`backend/src/modules/billing/timeEntries/timeEntries.routes.ts`).
 * "Add Time Entry", each row's Edit/Delete/Bill actions, and bulk-select all
 * end in one of those calls, so a viewer without the permission must not see
 * any of them - matching `ClientBillingTimeEntriesSection.tsx`'s gating of
 * the identical actions on the client detail page.
 */
const mockUseFirmTimeEntriesTable = jest.fn();

jest.mock('@/hooks/billingHooks/useFirmTimeEntriesTable', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseFirmTimeEntriesTable(...args),
}));

import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import BillingTimeEntriesView from '@/components/billingComp/BillingTimeEntriesView';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, resetPermissions } from '../../support/permissions';

const BASE_TABLE_STATE = {
  rows: [
    {
      id: 'entry-1',
      matterId: 'matter-1',
      matterName: 'Smith v. Jones',
      clientId: 'client-1',
      clientName: 'Jane Smith',
      memberName: 'Pat Attorney',
      date: '2026-09-01',
      hours: 2,
      amount: 400,
      billable: true,
      billingStatus: 'unbilled',
      context: 'matter',
    },
  ],
  total: 1,
  loading: false,
  fetching: false,
  page: 1,
  setPage: jest.fn(),
  rowsPerPage: 25,
  setRowsPerPage: jest.fn(),
  filters: {},
  setFilter: jest.fn(),
  clearFilters: jest.fn(),
  search: '',
  setSearch: jest.fn(),
  refetch: jest.fn(),
};

function renderView(canManage: boolean) {
  mockUseFirmTimeEntriesTable.mockReturnValue(BASE_TABLE_STATE);
  return renderWithProviders(
    <BillingTimeEntriesView
      lawFirmId="firm-1"
      users={[]}
      onAddTimeEntry={jest.fn()}
      onBillNow={jest.fn()}
      onBatchBillNow={jest.fn()}
      canManage={canManage}
    />,
  );
}

beforeEach(() => {
  mockUseFirmTimeEntriesTable.mockReset();
});

describe('permission gating', () => {
  it('hides Add Time Entry and every row action for a viewer without billing.manageTimeEntries', () => {
    renderView(false);

    expect(screen.queryByRole('button', { name: /Add Time Entry/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit time entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete time entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bill now' })).not.toBeInTheDocument();
    // No selection checkboxes either - bulk delete/bill would be unreachable but
    // the checkbox itself must not be offered as if it did something.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows Add Time Entry and row actions for a viewer with billing.manageTimeEntries', () => {
    renderView(true);

    expect(screen.getByRole('button', { name: /Add Time Entry/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit time entry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete time entry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bill now' })).toBeInTheDocument();
  });
});

describe('billing actions need billing.manageInvoices', () => {
  // The Bill actions open the invoice composer, which the backend refuses
  // without billing.manageInvoices, so time-entry rights alone must not offer them.
  afterEach(() => {
    resetPermissions();
  });

  it('offers neither Bill now nor the batch Bill to a viewer who can manage time entries but not invoices', () => {
    grantPermissions(['billing.manageTimeEntries']);
    renderView(true);

    expect(screen.getByRole('button', { name: /Add Time Entry/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bill now' })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(screen.getAllByText(/1 selected/).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'Bill 1' })).toHaveLength(0);
  });

  it('offers both to a viewer who holds billing.manageInvoices as well', () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageInvoices']);
    renderView(true);

    expect(screen.getByRole('button', { name: 'Bill now' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(screen.getAllByRole('button', { name: 'Bill 1' }).length).toBeGreaterThan(0);
  });
});

describe('whose entries the row actions are offered on', () => {
  const ownRow = { ...BASE_TABLE_STATE.rows[0], id: 'own-entry', userId: 'test-uid' };
  const teammateRow = { ...BASE_TABLE_STATE.rows[0], id: 'teammate-entry', userId: 'someone-else' };

  afterEach(() => resetPermissions());

  function renderWithRows() {
    mockUseFirmTimeEntriesTable.mockReturnValue({ ...BASE_TABLE_STATE, rows: [ownRow, teammateRow], total: 2 });
    return renderWithProviders(
      <BillingTimeEntriesView
        lawFirmId="firm-1"
        users={[]}
        onAddTimeEntry={jest.fn()}
        canManage
      />,
    );
  }

  it('offers Edit and Delete only on the viewer\'s own entry without billing.manageOthersTimeEntries', () => {
    grantPermissions(['billing.manageTimeEntries']);
    renderWithRows();

    expect(screen.getAllByRole('button', { name: 'Edit time entry' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete time entry' })).toHaveLength(1);
  });

  it('offers Edit and Delete on every entry with billing.manageOthersTimeEntries', () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageOthersTimeEntries']);
    renderWithRows();

    expect(screen.getAllByRole('button', { name: 'Edit time entry' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete time entry' })).toHaveLength(2);
  });
});
