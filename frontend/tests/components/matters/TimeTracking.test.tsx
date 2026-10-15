/**
 * `TimeTracking`: the matter/client time-entry panel.
 *
 * Four rules that produce a wrong number or a wrong disclosure if they slip:
 *
 *   SCOPE. A matter context and a client context must build DIFFERENT filter
 *   shapes for the underlying table hook (`{ matterId }` vs
 *   `{ context: 'client', clientId }`). Sending the wrong one silently shows
 *   one entity's billable time under another's page.
 *
 *   TOTALS COME FROM THE SERVER SUMMARY, NEVER FROM THE VISIBLE PAGE. The
 *   header must show `summary.totalHours`/`totalAmount` even when they
 *   disagree with what a naive sum over the ten rows on screen would produce -
 *   the component's own comment calls this out as a past mistake.
 *
 *   AN INVOICED ENTRY IS LOCKED. Edit and Delete must be disabled, and Bill
 *   must not be offered, once billing has already claimed the entry.
 *
 *   THE INLINE TIMER IS GATED ON THIS MATTER. The floating timer can be
 *   running for a DIFFERENT matter than the one currently on screen; the
 *   inline widget must not surface someone else's running timer as if it
 *   belonged here.
 */
const mockUseFirmTimeEntriesTable = jest.fn();
const mockUseBillingTimer = jest.fn();

jest.mock('@/hooks/billingHooks/useFirmTimeEntriesTable', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseFirmTimeEntriesTable(...args),
}));

jest.mock('@/contexts/BillingTimerContext', () => ({
  __esModule: true,
  useBillingTimer: () => mockUseBillingTimer(),
}));

jest.mock('@/hooks/chargeCodeHooks/useChargeCodes', () =>
  require('../../support/fixtures/billingContext').noChargeCodesModule());

import React from 'react';
import { screen } from '@testing-library/react';
import TimeTracking from '@/components/matterComp/TimeTracking';
import type { BillingContext } from '@/types/billing';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantPermissions, grantReadOnly, resetPermissions } from '../../support/permissions';
import { billingTimerState, firmTimeEntriesTableState } from '../../support/fixtures/billingContext';

function renderPanel(
  context: BillingContext,
  tableOverrides: Record<string, unknown> = {},
  timerOverrides: Record<string, unknown> = {},
) {
  mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState(tableOverrides));
  mockUseBillingTimer.mockReturnValue(billingTimerState(timerOverrides));
  return renderWithProviders(
    <TimeTracking context={context} members={[]} users={[]} matterName="Estate of Rivera" />,
  );
}

beforeEach(() => {
  mockUseFirmTimeEntriesTable.mockReset();
  mockUseBillingTimer.mockReset();
});

afterEach(() => {
  resetPermissions();
});

describe('scope filter sent to the table hook', () => {
  // This panel is matter-only - the client detail page's own time entries
  // render through the sibling `ClientBillingTimeEntriesSection` instead, which
  // additionally unions in matter-attributed work the client page needs and
  // this one does not.
  it('scopes by matterId', () => {
    renderPanel({ type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' });

    const [, options] = mockUseFirmTimeEntriesTable.mock.calls[0];
    expect(options.initialFilters).toEqual({ matterId: 'matter-1' });
  });
});

describe('the header totals', () => {
  it('shows the server-computed summary, not a sum of the visible page', () => {
    // One row on screen reporting 1 hour, but the server summary (the whole
    // matching set, across every page) says 12.5 hours. If the header ever
    // reduces over `rows` instead of reading `summary`, it will show "1h"
    // here instead of "12h 30m".
    renderPanel(
      { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' },
      {
        rows: [{ id: 't1', hours: 1, hourlyRate: 100, amount: 100 }],
        total: 40,
        summary: { totalHours: 12.5, totalAmount: 987650 },
      },
    );

    expect(screen.getByText('12h 30m')).toBeInTheDocument();
    expect(screen.queryByText('1h 0m')).not.toBeInTheDocument();
  });
});

describe('an invoiced entry is locked', () => {
  it('disables Edit and Delete and does not offer Bill', () => {
    renderPanel(
      { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' },
      {
        rows: [{
          id: 'locked-1',
          userName: 'Jane Attorney',
          hours: 2,
          hourlyRate: 200,
          amount: 40000,
          billable: true,
          billingStatus: 'billed',
        }],
        total: 1,
      },
    );

    expect(screen.queryByRole('button', { name: 'Bill' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invoiced time cannot be edited' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Invoiced time cannot be deleted' })).toBeDisabled();
  });

  it('leaves an unbilled entry fully editable and offers Bill', () => {
    renderPanel(
      { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' },
      {
        rows: [{
          id: 'open-1',
          userName: 'Jane Attorney',
          hours: 2,
          hourlyRate: 200,
          amount: 40000,
          billable: true,
          billingStatus: 'unbilled',
        }],
        total: 1,
      },
    );

    expect(screen.getByRole('button', { name: 'Bill' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
  });
});

describe('time that is not on an invoice stays editable', () => {
  // The server freezes only an entry an invoice line names. Queued time (picked
  // up by a pending invoice run) and retainer-covered time are not on one, so
  // their Edit and Delete answer normally. Red if either is locked here.
  it.each(['queued', 'covered_by_retainer'])('leaves a %s entry editable and deletable', (billingStatus) => {
    renderPanel(
      { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' },
      {
        rows: [{
          id: 'pending-1',
          userName: 'Jane Attorney',
          hours: 2,
          hourlyRate: 200,
          amount: 40000,
          billable: true,
          billingStatus,
        }],
        total: 1,
      },
    );

    expect(screen.getByRole('button', { name: 'Edit' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Invoiced time cannot be edited' })).not.toBeInTheDocument();
  });
});

describe('Bill needs billing.manageInvoices', () => {
  const unbilledRow = {
    id: 'open-1',
    userName: 'Jane Attorney',
    hours: 2,
    hourlyRate: 200,
    amount: 40000,
    billable: true,
    billingStatus: 'unbilled',
  };
  const matterContext: BillingContext = { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' };

  it('hides Bill from a member who can manage time entries but not invoices', () => {
    grantPermissions(['billing.manageTimeEntries']);
    renderPanel(matterContext, { rows: [unbilledRow], total: 1 });

    expect(screen.queryByRole('button', { name: 'Bill' })).not.toBeInTheDocument();
  });

  it('shows Bill once billing.manageInvoices is held too', () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageInvoices']);
    renderPanel(matterContext, { rows: [unbilledRow], total: 1 });

    expect(screen.getByRole('button', { name: 'Bill' })).toBeInTheDocument();
  });
});

describe('the inline timer', () => {
  it('does not surface a different matter\'s running timer as if it belonged here', () => {
    renderPanel(
      { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' },
      {},
      { isActive: true, isRunning: true, matterId: 'a-different-matter', targetLabel: 'Someone else\'s matter' },
    );

    expect(screen.queryByText('Someone else\'s matter')).not.toBeInTheDocument();
  });

  it('shows the inline widget when the active timer belongs to this matter', () => {
    renderPanel(
      { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' },
      {},
      { isActive: true, isRunning: true, matterId: 'matter-1', targetLabel: 'Estate of Rivera' },
    );

    expect(screen.getByText('Estate of Rivera')).toBeInTheDocument();
  });
});

describe('permission gating', () => {
  // Mirrors `ClientBillingTimeEntriesSection`, the sibling panel for the same
  // feature on the client detail page: without `billing.manageTimeEntries`,
  // logging, timing, editing and deleting time are all unavailable, not just
  // disabled. A viewer with only baseline (view) permissions must not be shown
  // a button whose click would 403.
  it('hides Log Time, Start Timer and row actions for a viewer without billing.manageTimeEntries', () => {
    grantReadOnly();
    renderPanel(
      { type: 'matter', lawFirmId: 'firm-1', entityId: 'matter-1' },
      {
        rows: [{
          id: 'open-1',
          userName: 'Jane Attorney',
          hours: 2,
          hourlyRate: 200,
          amount: 40000,
          billable: true,
          billingStatus: 'unbilled',
        }],
        total: 1,
      },
    );

    expect(screen.queryByRole('button', { name: /Log Time/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start Timer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
