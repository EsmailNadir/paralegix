/**
 * Bulk delete on the client detail page's time-entry panel.
 *
 * This panel and the matter page's `TimeTracking` both delegate bulk delete to
 * `EntityTimeEntriesTab.confirmBulkDelete`, so the single-request and in-flight
 * properties live in `matters/TimeTrackingBulkDelete.contract.test.tsx`. What
 * stays here is what the client adapter decides for itself: the partial report
 * over its rows, and its read-only rule (`isReadOnly`), which is client-specific.
 *
 * The table hook is faked (its data path is not the subject) but `billing.service`
 * and the transport under it are REAL, so the delete urls, the `ApiError`
 * handling and the message the user ends up reading all execute here.
 *
 * WHAT BREAKS THESE: reading `deleted` instead of `failed` leaves the wrong rows
 * ticked; dropping the `errors` plumbing loses both halves of the count; and
 * skipping the read-only filter puts a billed row's id in the request, which the
 * last case catches.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

const mockUseFirmTimeEntriesTable = jest.fn();

jest.mock('@/hooks/billingHooks/useFirmTimeEntriesTable', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseFirmTimeEntriesTable(...args),
}));

jest.mock('@/contexts/BillingTimerContext', () =>
  require('../../support/fixtures/billingContext').idleBillingTimerModule());

jest.mock('@/hooks/chargeCodeHooks/useChargeCodes', () =>
  require('../../support/fixtures/billingContext').noChargeCodesModule());

jest.mock('@/hooks/useUsers', () => ({
  __esModule: true,
  useLawFirmUsers: () => ({ users: [], loading: false, error: null, refresh: jest.fn() }),
}));

jest.mock('@/hooks/useFirmMembers', () => ({
  __esModule: true,
  useFirmMembers: () => [],
}));

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ClientBillingTimeEntriesSection from '@/components/clientComp/ClientBillingTimeEntriesSection';
import type { Client, Matter } from '@/types';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { firmTimeEntriesTableState } from '../../support/fixtures/billingContext';
import {
  BULK_DELETE,
  answerBulkDelete,
  bulkDeleteIds,
  confirmEntityBulkDelete,
  timeEntryRow,
} from '../../support/fixtures/timeEntries';

const MATTER_ID = 'matter-1';
const SELECTED = 12;

const CLIENT: Client = { id: 'client-1', name: 'Jane Client', email: 'jane@example.test' } as Client;
const CLIENT_MATTERS: Matter[] = [{ id: MATTER_ID, name: 'Estate of Rivera' } as Matter];

let api: ApiMock;

/** A server row as the table hook hands it over, before the panel reshapes it. */
function entry(overrides: Record<string, unknown> = {}) {
  return timeEntryRow({
    matterId: MATTER_ID,
    matterName: 'Estate of Rivera',
    clientId: CLIENT.id,
    entityId: MATTER_ID,
    ...overrides,
  });
}

function makeRows(count: number) {
  return Array.from({ length: count }, (_, i) => entry({ id: `entry-${i}` }));
}

function renderPanel(rows: unknown[]) {
  mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState({
    rows,
    total: rows.length,
    summary: { totalHours: rows.length, totalAmount: rows.length * 200 },
    rowsPerPage: 25,
  }));

  return renderWithProviders(
    <ClientBillingTimeEntriesSection
      lawFirmId="firm-1"
      client={CLIENT}
      clientMatters={CLIENT_MATTERS}
      companyNames={new Map()}
    />,
  );
}

/** Tick every row, then run Delete from the bulk menu and confirm. */
async function selectAllRowsAndConfirmDelete(
  user: ReturnType<typeof userEvent.setup>,
  count: number,
) {
  const checkboxes = await screen.findAllByRole('checkbox', { name: 'Select row' });
  for (const box of checkboxes) await user.click(box);
  await confirmEntityBulkDelete(user, count);
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  mockUseFirmTimeEntriesTable.mockReset();
  api.restore();
});

describe('ClientBillingTimeEntriesSection bulk delete', () => {
  it('reports a partial run with both counts and keeps only the failures selected', async () => {
    const user = userEvent.setup();
    const rows = makeRows(SELECTED);
    const doomed = ['entry-1', 'entry-6', 'entry-9'];
    api.post(BULK_DELETE, answerBulkDelete(doomed));

    renderPanel(rows);
    await selectAllRowsAndConfirmDelete(user, SELECTED);

    // Twelve rows, one round trip, and none of the per-entry DELETEs.
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(api.calls('DELETE')).toHaveLength(0);
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(rows.map((r) => r.id)));

    await screen.findByText(
      `${SELECTED - doomed.length} of ${SELECTED} time entries deleted. ${doomed.length} could not be deleted and stayed selected.`,
    );
    // The nine that went are deselected. The three that failed survive the list
    // reload, which clears the selection on its own, so a retry is one more
    // click and cannot re-send a delete that already succeeded.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: `${doomed.length} selected` }).length)
        .toBeGreaterThan(0),
    );
  });

  it('still skips read-only rows, and says so alongside the failure count', async () => {
    const user = userEvent.setup();
    const rows = [
      entry({ id: 'open-1' }),
      entry({ id: 'open-2' }),
      entry({ id: 'billed-1', billingStatus: 'billed' }),
    ];
    api.post(BULK_DELETE, answerBulkDelete(['open-2']));

    renderPanel(rows);
    await selectAllRowsAndConfirmDelete(user, 3);

    // The billed row's id is never sent. Selecting it does not make it
    // deletable, and it is not counted as a failure either: it was never
    // offered.
    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(['open-1', 'open-2']));

    const notice = await screen.findByText(/read-only and was not deleted/);
    expect(notice).toHaveTextContent('1 billed entry is read-only and was not deleted.');
    // Both facts, in one place: what was skipped and what was refused.
    expect(notice).toHaveTextContent(
      '1 of 2 time entries deleted. 1 could not be deleted and stayed selected.',
    );
  });
});
