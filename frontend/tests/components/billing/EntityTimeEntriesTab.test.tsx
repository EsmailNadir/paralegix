/**
 * `EntityTimeEntriesTab`: the time-entry list shared by the matter page
 * (`matterComp/TimeTracking`) and the client page
 * (`clientComp/ClientBillingTimeEntriesSection`).
 *
 * The two parents differ only through the `target` adapter, so these specs
 * drive the tab with a bare adapter and pin that the adapter, not a built-in
 * default, decides each difference.
 *
 * WHAT BREAKS THESE: locking rows by `isTimeEntryLocked` (the billing status)
 * instead of `target.isLocked` leaves the held row's Edit enabled; keeping the
 * selection across a page change leaves a ticked row counted that a bulk delete
 * would not send.
 */
const mockUseFirmTimeEntriesTable = jest.fn();

jest.mock('@/hooks/billingHooks/useFirmTimeEntriesTable', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseFirmTimeEntriesTable(...args),
}));

jest.mock('@/contexts/BillingTimerContext', () =>
  require('../../support/fixtures/billingContext').idleBillingTimerModule());

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

jest.mock('@/components/billingComp/TimeEntryModal', () => ({
  __esModule: true,
  default: ({ open, onSuccess }: { open: boolean; onSuccess?: (r: unknown) => void }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSuccess?.({ shouldBillNow: true, draftItem: { timeEntryId: 'te-1', matterId: 'matter-1' } })
        }
      >
        Stub save and bill
      </button>
    ) : null,
}));

jest.mock('@/hooks/chargeCodeHooks/useChargeCodes', () =>
  require('../../support/fixtures/billingContext').noChargeCodesModule());

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import EntityTimeEntriesTab, {
  type EntityTimeEntriesTarget,
} from '@/components/billingComp/EntityTimeEntriesTab';
import type { EnrichedTimeEntry } from '@/hooks/billingHooks/useFirmTimeEntries';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import { renderWithProviders } from '../../support/renderWithProviders';
import { firmTimeEntriesTableState } from '../../support/fixtures/billingContext';

const LAW_FIRM_ID = 'firm-1';

function row(id: string): EnrichedTimeEntry {
  return {
    id,
    userName: `Member ${id}`,
    hours: 1,
    hourlyRate: 100,
    amount: 100,
    billable: true,
    billingStatus: 'unbilled',
    contextType: 'matter',
  } as unknown as EnrichedTimeEntry;
}

function target(
  overrides: Partial<EntityTimeEntriesTarget<EnrichedTimeEntry>> = {},
): EntityTimeEntriesTarget<EnrichedTimeEntry> {
  return {
    tableOptions: { initialFilters: { matterId: 'matter-1' } },
    renderRow: (entry) => ({ title: entry.userName || 'Unknown' }),
    entryIdOf: (entry) => entry.id,
    isLocked: () => false,
    deleteContextOf: () => ({ type: 'matter', lawFirmId: LAW_FIRM_ID, entityId: 'matter-1' }),
    billContextOf: () => 'matter:matter-1',
    ownsTimer: () => false,
    timerStart: { matterId: 'matter-1', targetLabel: 'Smith v. Jones' },
    showTimerNote: false,
    goToBillingLabel: 'Go to Billing',
    memberOptions: [],
    modal: { defaultTarget: 'matter:matter-1', scopeMatterId: 'matter-1', users: [] },
    ...overrides,
  };
}

beforeEach(() => {
  mockUseFirmTimeEntriesTable.mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  resetPermissions();
});

describe('without billing.viewTimeEntries', () => {
  const lastTableOptions = () =>
    mockUseFirmTimeEntriesTable.mock.calls[mockUseFirmTimeEntriesTable.mock.calls.length - 1][1];

  // The list read answers 403 without the permission and the tab shows that as an error banner.
  // Red if: the table is left enabled, so the request is sent anyway.
  it('holds the table read back', () => {
    grantPermissions(['billing.manageTimeEntries']);
    mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState());

    renderWithProviders(<EntityTimeEntriesTab lawFirmId={LAW_FIRM_ID} target={target()} />);

    expect(lastTableOptions().enabled).toBe(false);
    // The adapter's own options still reach the hook.
    expect(lastTableOptions().initialFilters).toEqual({ matterId: 'matter-1' });
  });

  it('reads the table once the member can view time entries', () => {
    grantPermissions(['billing.viewTimeEntries']);
    mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState());

    renderWithProviders(<EntityTimeEntriesTab lawFirmId={LAW_FIRM_ID} target={target()} />);

    expect(lastTableOptions().enabled).toBe(true);
  });
});

describe('row locking', () => {
  it('locks a row by the target rule even when its billing status is unbilled', () => {
    mockUseFirmTimeEntriesTable.mockReturnValue(
      firmTimeEntriesTableState({ rows: [row('held'), row('open')], total: 2 }),
    );
    renderWithProviders(
      <EntityTimeEntriesTab
        lawFirmId={LAW_FIRM_ID}
        target={target({ isLocked: (entry) => entry.id === 'held' })}
      />,
    );

    expect(screen.getByRole('button', { name: 'Invoiced time cannot be edited' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Invoiced time cannot be deleted' })).toBeDisabled();
    // The other row is untouched, and only it offers Bill.
    expect(screen.getByRole('button', { name: 'Edit' })).not.toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Bill' })).toHaveLength(1);
  });
});

describe('selection across a page change', () => {
  it('drops the selection when the list moves to another page', () => {
    const rows = [row('a'), row('b')];
    mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState({ rows, total: 20 }));
    // A fresh element per render: React skips re-rendering an identical one,
    // and the table hook has to be called again to report the new page.
    const ui = () => <EntityTimeEntriesTab lawFirmId={LAW_FIRM_ID} target={target()} />;
    const view = renderWithProviders(ui());

    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
    expect(screen.getAllByRole('button', { name: '1 selected' }).length).toBeGreaterThan(0);

    // The table moves to page 2 with the same rows still loaded, as it does
    // while the next page is being fetched.
    mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState({ rows, total: 20, page: 2 }));
    view.rerender(ui());

    expect(screen.queryByRole('button', { name: '1 selected' })).not.toBeInTheDocument();
  });
});

describe('save and bill now from the add-time modal', () => {
  async function logTimeAndBill() {
    mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState({ rows: [row('a')], total: 1 }));
    renderWithProviders(<EntityTimeEntriesTab lawFirmId={LAW_FIRM_ID} target={target()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log Time' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stub save and bill' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stub save and bill' })).not.toBeInTheDocument());
  }

  it('does not open the composer without billing.manageInvoices', async () => {
    grantPermissions(['billing.manageTimeEntries']);
    await logTimeAndBill();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens the matter composer with billing.manageInvoices', async () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageInvoices']);
    await logTimeAndBill();

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0]).toContain(`/lawfirm/${LAW_FIRM_ID}/matters/matter-1/generate-invoice`);
  });
});

describe('the row Bill action', () => {
  // Red if: Bill opens the multi-context invoice run while the modal's "bill
  // now" opens the composer, so the same intent lands on two different screens
  // depending on which button was used.
  it.each([
    ['matter:matter-1', `/lawfirm/${LAW_FIRM_ID}/matters/matter-1/generate-invoice`],
    ['client:client-7', `/lawfirm/${LAW_FIRM_ID}/clients/client-7/generate-invoice`],
  ])('opens the composer for the context the row bills through (%s)', (context, destination) => {
    grantPermissions(['billing.manageTimeEntries', 'billing.manageInvoices']);
    mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState({ rows: [row('a')], total: 1 }));
    renderWithProviders(
      <EntityTimeEntriesTab lawFirmId={LAW_FIRM_ID} target={target({ billContextOf: () => context })} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Bill' }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(destination);
  });
});
