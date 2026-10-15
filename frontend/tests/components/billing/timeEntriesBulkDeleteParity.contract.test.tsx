/**
 * Bulk delete of time entries, held to one contract on the matter and client
 * panels.
 *
 * `TimeTracking` (matter) and `ClientBillingTimeEntriesSection` (client) both
 * hand bulk delete to `EntityTimeEntriesTab`, so the behaviour is meant to be
 * identical. Each has its own spec for what its adapter decides, but the shared
 * promises were asserted for the matter panel only; a change that broke them for
 * the client panel alone would have passed. Every case below runs against both.
 *
 * `billing.service` and the transport run for real. The client panel's table hook
 * is faked (its data path is not the subject); the matter panel reads through the
 * real hook, so the wrapper delegates to it unless a case installs a state.
 *
 * WHAT BREAKS THESE: a per-entry DELETE loop in either panel (no bulk POST),
 * sending a locked row's id, reading `deleted` instead of `failed`, or losing
 * the "None of the N" wording.
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

import TimeTracking from '@/components/matterComp/TimeTracking';
import ClientBillingTimeEntriesSection from '@/components/clientComp/ClientBillingTimeEntriesSection';
import type { BillingContext } from '@/types/billing';
import type { Client, Matter } from '@/types';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { resetPermissions } from '../../support/permissions';
import { firmTimeEntriesTableState } from '../../support/fixtures/billingContext';
import {
  BULK_DELETE,
  FIRM_TIME_ENTRIES,
  answerBulkDelete,
  bulkDeleteIds,
  confirmEntityBulkDelete,
  serveFirmTimeEntries,
  timeEntryRow,
} from '../../support/fixtures/timeEntries';

const CLIENT: Client = { id: 'client-1', name: 'Jane Client', email: 'jane@example.test' } as Client;
const CLIENT_MATTERS: Matter[] = [{ id: 'matter-1', name: 'Estate of Rivera' } as Matter];
const MATTER_CONTEXT: BillingContext = { type: 'matter', entityId: 'matter-1', lawFirmId: 'firm-1' };

type Row = ReturnType<typeof timeEntryRow>;

interface Panel {
  name: string;
  /** Mount the panel showing exactly these rows. */
  mount: (rows: Row[]) => void;
  /** Tick every row, then run Delete from the bulk menu and confirm. */
  deleteAll: (user: ReturnType<typeof userEvent.setup>, count: number) => Promise<void>;
}

let api: ApiMock;

const PANELS: Panel[] = [
  {
    name: 'matter Time Tracking',
    mount: (rows) => {
      mockUseFirmTimeEntriesTable.mockImplementation((...args: unknown[]) =>
        (jest.requireActual('@/hooks/billingHooks/useFirmTimeEntriesTable').default as (...a: unknown[]) => unknown)(...args));
      api.get(FIRM_TIME_ENTRIES, serveFirmTimeEntries(rows));
      renderWithProviders(
        <TimeTracking context={MATTER_CONTEXT} members={[]} users={[]} matterName="Smith v. Jones" />,
      );
    },
    deleteAll: async (user, count) => {
      await user.click(await screen.findByRole('checkbox', { name: `Select all ${count}` }));
      await confirmEntityBulkDelete(user, count);
    },
  },
  {
    name: 'client Billing time entries',
    mount: (rows) => {
      mockUseFirmTimeEntriesTable.mockReturnValue(firmTimeEntriesTableState({
        rows: rows.map((r) => ({ ...r, clientId: CLIENT.id, entityId: 'matter-1' })),
        total: rows.length,
        summary: { totalHours: rows.length, totalAmount: rows.length * 200 },
        rowsPerPage: 25,
      }));
      renderWithProviders(
        <ClientBillingTimeEntriesSection
          lawFirmId="firm-1"
          client={CLIENT}
          clientMatters={CLIENT_MATTERS}
          companyNames={new Map()}
        />,
      );
    },
    deleteAll: async (user, count) => {
      const boxes = await screen.findAllByRole('checkbox', { name: 'Select row' });
      for (const box of boxes) await user.click(box);
      await confirmEntityBulkDelete(user, count);
    },
  },
];

const rowsOf = (count: number, overrides: Record<string, unknown> = {}): Row[] =>
  Array.from({ length: count }, (_, i) => timeEntryRow({ ...overrides, id: `entry-${i}` }));

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  mockUseFirmTimeEntriesTable.mockReset();
  resetPermissions();
  api.restore();
});

describe.each(PANELS)('bulk delete on the $name panel', (panel) => {
  it('sends one request carrying every selected id', async () => {
    const user = userEvent.setup();
    const rows = rowsOf(6);
    api.post(BULK_DELETE, answerBulkDelete());

    panel.mount(rows);
    await panel.deleteAll(user, rows.length);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(api.calls('DELETE')).toHaveLength(0);
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it('reports how many went and how many were refused', async () => {
    const user = userEvent.setup();
    api.post(BULK_DELETE, answerBulkDelete(['entry-1', 'entry-4']));

    panel.mount(rowsOf(6));
    await panel.deleteAll(user, 6);

    await screen.findByText('4 of 6 time entries deleted. 2 could not be deleted and stayed selected.');
  });

  it('says plainly that nothing was deleted when every entry was refused', async () => {
    const user = userEvent.setup();
    api.post(BULK_DELETE, answerBulkDelete((ids) => ids));

    panel.mount(rowsOf(3));
    await panel.deleteAll(user, 3);

    await screen.findByText('None of the 3 time entries could be deleted.');
  });

  it('never sends a locked row, and tells the user it was skipped', async () => {
    const user = userEvent.setup();
    const rows = [
      timeEntryRow({ id: 'open-1' }),
      timeEntryRow({ id: 'open-2' }),
      timeEntryRow({ id: 'locked-1', billingStatus: 'billed' }),
    ];
    api.post(BULK_DELETE, answerBulkDelete());

    panel.mount(rows);
    await panel.deleteAll(user, rows.length);

    await waitFor(() => expect(api.callsTo(BULK_DELETE)).toHaveLength(1));
    expect(new Set(bulkDeleteIds(api))).toEqual(new Set(['open-1', 'open-2']));
    expect(await screen.findByText(/1 billed entry is read-only and was not deleted/)).toBeInTheDocument();
  });
});
